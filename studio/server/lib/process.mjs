import { spawn, spawnSync } from 'node:child_process'

/**
 * Fixed-command process runner.
 *
 * The caller supplies an executable and an argument array that it derived from
 * the registry. No string is ever handed to a shell. Output is streamed line by
 * line so the UI can show progress, and every buffer is bounded.
 */

const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

function killTree(pid) {
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      // Best effort; the timeout path below still reports timedOut.
    }
    return
  }
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // Already gone.
    }
  }
}

function splitLines(state, chunk, target, onLine) {
  state.buffer += chunk
  while (state.buffer.includes('\n')) {
    const index = state.buffer.indexOf('\n')
    const line = state.buffer.slice(0, index).replace(/\r$/, '')
    state.buffer = state.buffer.slice(index + 1)
    target.push(line)
    if (target.length > 4000) target.splice(0, target.length - 4000)
    onLine?.(line)
  }
}

export function runFixed({
  file,
  args = [],
  cwd,
  timeoutMs = 120000,
  env = process.env,
  signal = null,
  onLine = null,
  maxBytes = DEFAULT_MAX_BYTES,
  windowsHide = true,
} = {}) {
  if (typeof file !== 'string' || file.length === 0) {
    return Promise.reject(new Error('runFixed requires an executable'))
  }
  if (!Array.isArray(args) || args.some((arg) => typeof arg !== 'string')) {
    return Promise.reject(new Error('runFixed args must be an array of strings'))
  }
  if (signal?.aborted) {
    return Promise.resolve({
      code: null,
      signal: null,
      timedOut: false,
      aborted: true,
      durationMs: 0,
      stdout: '',
      stderr: '',
      stdoutLines: [],
      stderrLines: [],
    })
  }

  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(file, args, {
        cwd,
        env,
        windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      })
    } catch (error) {
      resolve({
        code: null,
        signal: null,
        timedOut: false,
        aborted: false,
        durationMs: Date.now() - startedAt,
        stdout: '',
        stderr: `spawn error: ${error.message}`,
        stdoutLines: [],
        stderrLines: [],
        spawnError: error.message,
      })
      return
    }

    const stdoutLines = []
    const stderrLines = []
    const stdoutState = { buffer: '' }
    const stderrState = { buffer: '' }
    let stdoutBytes = 0
    let stderrBytes = 0
    let truncated = false
    let timedOut = false
    let aborted = false
    let settled = false

    const finish = (code, processSignal, spawnError = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener?.('abort', onAbort)
      resolve({
        code,
        signal: processSignal ?? null,
        timedOut,
        aborted,
        durationMs: Date.now() - startedAt,
        stdout: stdoutLines.join('\n'),
        stderr: stderrLines.join('\n'),
        stdoutLines,
        stderrLines,
        truncated,
        ...(spawnError ? { spawnError } : {}),
      })
    }

    const onAbort = () => {
      aborted = true
      killTree(child.pid)
    }

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      if (stdoutBytes >= maxBytes) {
        truncated = true
        return
      }
      stdoutBytes += Buffer.byteLength(chunk)
      splitLines(stdoutState, chunk, stdoutLines, (line) => onLine?.(line, 'stdout'))
    })
    child.stderr.on('data', (chunk) => {
      if (stderrBytes >= maxBytes) {
        truncated = true
        return
      }
      stderrBytes += Buffer.byteLength(chunk)
      splitLines(stderrState, chunk, stderrLines, (line) => onLine?.(line, 'stderr'))
    })
    child.on('error', (error) => finish(null, null, error.message))
    child.on('close', (code, processSignal) => {
      if (stdoutState.buffer) stdoutLines.push(stdoutState.buffer)
      if (stderrState.buffer) stderrLines.push(stderrState.buffer)
      finish(code, processSignal)
    })

    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, Math.max(1000, timeoutMs))

    if (signal) signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Small helper for one-shot JSON-producing commands, still array-based. */
export function runFixedJson(options) {
  return runFixed(options).then((result) => {
    let parsed = null
    try {
      parsed = JSON.parse(result.stdout)
    } catch {
      parsed = null
    }
    return { ...result, parsed }
  })
}
