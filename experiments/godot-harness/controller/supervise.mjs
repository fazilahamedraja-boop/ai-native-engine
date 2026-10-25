#!/usr/bin/env node
/**
 * Run a command and turn its output into structured lifecycle events.
 *
 * `controller/startup-diagnostics.mjs` answers "why did this process fail to
 * become ready" after the fact, from arrays of output the harness collected.
 * It cannot answer the other half: a run that is still going, silent for two
 * minutes, or streaming forever. This wrapper covers that:
 *
 *   node controller/supervise.mjs -- node controller/voxel-web.mjs --no-export
 *   node controller/supervise.mjs --json --hang-after 5000 -- <command>
 *   node controller/supervise.mjs --timeout 120000 -- godot --headless --export-release ...
 *
 * Events, one per line:
 *   start    pid, command, cwd
 *   stdout   line
 *   stderr   line
 *   hang     silenceMs            (only with --hang-after)
 *   timeout  timeoutMs
 *   exit     code, signal, durationMs, classification, engineErrors
 *
 * Exit codes mirror the child (0 clean, its own code otherwise), plus 124 for a
 * timeout and 125 when the command could not be spawned, so this is usable in a
 * pipeline without parsing the events.
 *
 * Silence is not the same as a hang for a server that is simply idle: pass
 * `--hang-after 0` (the default) to disable it, or a value longer than any
 * legitimate quiet period. Godot runs and exports, which print as they work,
 * are what the heuristic is for.
 */

import fs from 'node:fs'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { collectEngineErrors } from './startup-diagnostics.mjs'

const TAIL_LIMIT = 400

function toList(value) {
  return value == null ? [] : Array.isArray(value) ? value : [value]
}

/**
 * Spawn `command`, stream its output as events, and resolve with a summary.
 *
 * `onEvent` is called for every event as it happens, which is what makes this
 * useful for a long run: a caller can react to the first error line instead of
 * waiting for the process to finish.
 */
export function supervise({
  command,
  cwd = process.cwd(),
  hangAfterMs = 0,
  timeoutMs = 0,
  env = process.env,
  onEvent = () => {},
  now = () => Date.now(),
} = {}) {
  if (!command?.length) throw new Error('supervise needs a command array')

  const startedAt = now()
  const tail = { stdout: [], stderr: [] }
  const keep = (stream, line) => {
    const list = tail[stream]
    list.push(line)
    if (list.length > TAIL_LIMIT) list.shift()
  }

  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command[0], command.slice(1), {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      onEvent({ event: 'exit', at: new Date().toISOString(), code: 125, signal: null, classification: 'spawn_failed', error: error.message })
      resolve({ code: 125, classification: 'spawn_failed', error: error.message, stdout: [], stderr: [] })
      return
    }

    onEvent({
      event: 'start',
      at: new Date().toISOString(),
      pid: child.pid ?? null,
      command,
      cwd,
    })

    let lastActivity = now()
    let hangReported = false
    let timedOut = false
    let spawnError = null

    const emitter = (stream) => {
      const interface_ = readline.createInterface({ input: child[stream], crlfDelay: Infinity })
      interface_.on('line', (line) => {
        lastActivity = now()
        hangReported = false
        keep(stream, line)
        onEvent({ event: stream, at: new Date().toISOString(), line })
      })
    }
    emitter('stdout')
    emitter('stderr')

    child.on('error', (error) => {
      spawnError = error
    })

    const tickMs = Math.max(100, Math.min(500, hangAfterMs ? hangAfterMs / 4 : 500))
    const watchdog = setInterval(() => {
      if (timeoutMs && now() - startedAt >= timeoutMs && !timedOut) {
        timedOut = true
        onEvent({ event: 'timeout', at: new Date().toISOString(), timeoutMs })
        child.kill()
        return
      }
      if (!hangAfterMs || hangReported || child.exitCode !== null) return
      const silenceMs = now() - lastActivity
      if (silenceMs >= hangAfterMs) {
        hangReported = true
        onEvent({ event: 'hang', at: new Date().toISOString(), silenceMs })
      }
    }, tickMs)
    watchdog.unref?.()

    const forward = (signal) => () => child.kill(signal)
    const onInt = forward('SIGINT')
    const onTerm = forward('SIGTERM')
    process.on('SIGINT', onInt)
    process.on('SIGTERM', onTerm)

    child.on('close', (code, signal) => {
      clearInterval(watchdog)
      process.off('SIGINT', onInt)
      process.off('SIGTERM', onTerm)

      const engineErrors = collectEngineErrors({ stdout: tail.stdout, stderr: tail.stderr })
      const classification = timedOut
        ? 'timeout'
        : spawnError
          ? 'spawn_failed'
          : signal
            ? 'signalled'
            : code === 0
              ? 'clean'
              : 'failed'

      const summary = {
        code: spawnError ? 125 : timedOut ? 124 : (code ?? null),
        signal: signal ?? null,
        classification,
        durationMs: now() - startedAt,
        engineErrors,
        stdout: tail.stdout,
        stderr: tail.stderr,
      }
      onEvent({
        event: 'exit',
        at: new Date().toISOString(),
        code: summary.code,
        signal: summary.signal,
        durationMs: summary.durationMs,
        classification,
        engineErrors,
      })
      resolve(summary)
    })
  })
}

function argValue(args, name, fallback) {
  const index = args.indexOf(name)
  return index >= 0 && args[index + 1] && !args[index + 1].startsWith('--') ? args[index + 1] : fallback
}

async function main() {
  const separator = process.argv.indexOf('--')
  if (separator < 0 || separator === process.argv.length - 1) {
    console.error('usage: node controller/supervise.mjs [options] -- <command> [args...]')
    return 125
  }
  const options = process.argv.slice(2, separator)
  const command = process.argv.slice(separator + 1)
  const json = options.includes('--json')
  const hangAfterMs = Number(argValue(options, '--hang-after', '0'))
  const timeoutMs = Number(argValue(options, '--timeout', '0'))
  const cwd = path.resolve(argValue(options, '--cwd', process.cwd()))
  if (!fs.existsSync(cwd)) {
    console.error(`[supervise] no such directory: ${cwd}`)
    return 125
  }

  const summary = await supervise({
    command,
    cwd,
    hangAfterMs,
    timeoutMs,
    onEvent: (event) => {
      if (json) {
        console.log(JSON.stringify(event))
        return
      }
      if (event.event === 'start') console.log(`[supervise] start pid=${event.pid} ${command.join(' ')}`)
      else if (event.event === 'stdout') console.log(`  out | ${event.line}`)
      else if (event.event === 'stderr') console.log(`  err | ${event.line}`)
      else if (event.event === 'hang') console.log(`[supervise] HANG: no output for ${event.silenceMs} ms`)
      else if (event.event === 'timeout') console.log(`[supervise] TIMEOUT after ${event.timeoutMs} ms`)
      else if (event.event === 'exit') {
        console.log(
          `[supervise] exit code=${event.code} signal=${event.signal} class=${event.classification} in ${event.durationMs} ms`,
        )
        for (const line of event.engineErrors) console.log(`  engine | ${line}`)
      }
    },
  })

  return summary.code ?? (summary.classification === 'timeout' ? 124 : 1)}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[supervise] ${error.message}`)
      process.exit(125)
    },
  )
}
