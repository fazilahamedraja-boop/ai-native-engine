#!/usr/bin/env node
/**
 * Phase 17 exported-build probe.
 *
 * The exported game keeps the opt-in harness bridge. This probe starts the
 * shipped Windows binary, drives the dodge over the normal protocol, confirms
 * the dodge state/movement/cooldown/restart behavior, and performs one existing
 * sword hit. It does not replace the windowed acceptance run.
 *
 * Usage:
 *   node controller/phase17-export-verify.mjs --exe game/build/DeflectArena.exe \
 *     [--out-dir ../../docs/phase17/evidence/export/<run>]
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { DOCS_ROOT, rejectReason } from './evidence-output.mjs'
import { logLive, upsertTest } from './phase17-status.mjs'

function parseArgs(argv) {
  const options = { exe: null, outDir: null, timeoutMs: 45000 }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exe') options.exe = argv[++i]
    else if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!options.exe) throw new Error('--exe is required')
  return options
}

function assertExportDir(dir) {
  const root = path.join(DOCS_ROOT, 'phase17', 'evidence', 'export')
  const resolved = path.resolve(dir)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`export evidence must stay inside ${root}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  return resolved
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function idle(overrides = {}) {
  const { actions = {}, ...movement } = overrides
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    ...movement,
    actions: { attack: false, parry: false, dodge: false, ...actions },
  }
}

function distance(snapshot) {
  const player = snapshot.player_position
  const enemy = snapshot.enemy_position
  return Math.hypot(player[0] - enemy[0], player[2] - enemy[2])
}

function connect(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      socket.once('connect', () => resolve(socket))
      socket.once('error', (error) => {
        socket.destroy()
        if (Date.now() >= deadline) reject(new Error(`bridge connect failed: ${error.message}`))
        else setTimeout(attempt, 200)
      })
    }
    attempt()
  })
}

function makeClient(socket) {
  let nextId = 1
  let buffer = ''
  const pending = new Map()
  socket.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    let index
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      if (!line.trim()) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.ok) waiter.resolve(message.data)
      else waiter.reject(new Error(message.error?.message || 'bridge command failed'))
    }
  })
  return {
    send(command, args = {}) {
      const id = String(nextId++)
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        socket.write(`${JSON.stringify({ id, cmd: command, args })}\n`)
      })
    },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const exe = path.resolve(options.exe)
  if (!fs.existsSync(exe)) throw new Error(`exported binary not found: ${exe}`)
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const outDir = assertExportDir(
    options.outDir || path.join(DOCS_ROOT, 'phase17', 'evidence', 'export', `${stamp}-probe`),
  )
  fs.mkdirSync(outDir, { recursive: true })

  const port = 49000 + Math.floor(Math.random() * 2000)
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
  const child = spawn(exe, ['--', `--harness-port=${port}`], {
    cwd: path.dirname(exe),
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString('utf8')
  })
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8')
  })

  let failure = null
  let socket = null
  try {
    socket = await connect(port, options.timeoutMs)
    const client = makeClient(socket)
    const ping = await client.send('ping')
    check('bridge-reachable', ping !== null, `port=${port}`)
    await client.send('pause')
    await client.send('reset')
    let snapshot = await client.send('snapshot')
    check(
      'packaged-initial-state',
      snapshot.step === 0 &&
        snapshot.player_health === 4 &&
        snapshot.enemy_health === 5 &&
        snapshot.dodge_phase === 'idle' &&
        snapshot.dodge_cooldown === 0,
      `step=${snapshot.step} hp=${snapshot.player_health}/${snapshot.enemy_health} dodge=${snapshot.dodge_phase}`,
    )

    const start = await client.send('advance_physics', {
      frames: 1,
      input: idle({ strafe: 1, actions: { dodge: true } }),
    })
    snapshot = start.final
    check(
      'packaged-dodge-starts',
      snapshot.dodge_phase === 'active' &&
        snapshot.dodge_tick >= 0 &&
        snapshot.dodge_cooldown >= 44 &&
        snapshot.dodge_cooldown <= 45 &&
        Array.isArray(snapshot.dodge_direction) &&
        snapshot.dodge_direction[0] > 0.9,
      `phase=${snapshot.dodge_phase} tick=${snapshot.dodge_tick} cooldown=${snapshot.dodge_cooldown}`,
    )

    const beforeX = snapshot.player_position[0]
    const mid = await client.send('advance_physics', {
      frames: 8,
      input: idle(),
    })
    snapshot = mid.final
    const movedX = snapshot.player_position[0] - beforeX
    check(
      'packaged-dodge-moves-and-iframes',
      snapshot.dodge_phase === 'active' &&
        snapshot.dodge_invulnerable === true &&
        movedX > 1.0,
      `phase=${snapshot.dodge_phase} tick=${snapshot.dodge_tick} invuln=${snapshot.dodge_invulnerable} dx=${movedX.toFixed(2)}`,
    )

    let guard = 0
    while (snapshot.dodge_phase !== 'recovery' && guard < 30) {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
      guard += 1
    }
    check(
      'packaged-dodge-recovery',
      snapshot.dodge_phase === 'recovery' && snapshot.dodge_invulnerable === false,
      `phase=${snapshot.dodge_phase} tick=${snapshot.dodge_tick} invuln=${snapshot.dodge_invulnerable}`,
    )
    guard = 0
    while (snapshot.dodge_phase !== 'idle' && guard < 30) {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
      guard += 1
    }
    const cooldown = snapshot.dodge_cooldown
    const rejectedBefore = await client.send('observe', { targets: [], properties: [], since_tick: 0 })
    const blocked = await client.send('advance_physics', {
      frames: 1,
      input: idle({ actions: { dodge: true } }),
    })
    snapshot = blocked.final
    const rejectedAfter = await client.send('observe', { targets: [], properties: [], since_tick: 0 })
    const rejectedEvent = (rejectedAfter.events?.items ?? []).some(
      (event) => event.type === 'dodge_rejected' && String(event.reason || '').includes('cooldown'),
    )
    check(
      'packaged-dodge-cooldown',
      snapshot.dodge_phase === 'idle' &&
        snapshot.dodge_cooldown > 0 &&
        (rejectedAfter.events?.count ?? 0) > (rejectedBefore.events?.count ?? 0) &&
        rejectedEvent,
      `phase=${snapshot.dodge_phase} cooldown=${snapshot.dodge_cooldown} before=${cooldown} rejected=${rejectedEvent}`,
    )

    await client.send('advance_physics', { frames: 1, input: idle({ restart: true }) })
    snapshot = await client.send('snapshot')
    check(
      'packaged-restart-clears-dodge',
      snapshot.step === 0 &&
        snapshot.player_health === 4 &&
        snapshot.enemy_health === 5 &&
        snapshot.dodge_phase === 'idle' &&
        snapshot.dodge_cooldown === 0,
      `step=${snapshot.step} dodge=${snapshot.dodge_phase} cooldown=${snapshot.dodge_cooldown}`,
    )

    let frames = 0
    while (frames < 240 && distance(snapshot) > 2.2 && snapshot.outcome === 'playing') {
      snapshot = (
        await client.send('advance_physics', { frames: 1, input: idle({ forward: 1 }) })
      ).final
      frames += 1
    }
    const attack = await client.send('advance_physics', {
      frames: 24,
      input: idle({ actions: { attack: true } }),
    })
    snapshot = attack.final
    const observation = await client.send('observe', { targets: [], properties: [], since_tick: 0 })
    const eventTypes = (observation.events?.items ?? []).map((event) => event.type)
    check(
      'packaged-sword-hit',
      snapshot.enemy_health <= 4 && eventTypes.includes('player_hit_enemy'),
      `enemy_hp=${snapshot.enemy_health} events=${eventTypes.slice(-6).join(',')}`,
    )

    check('process-stayed-alive', child.exitCode === null, `exit_code=${child.exitCode}`)
  } catch (error) {
    failure = error
    check('probe-completed', false, error.stack || String(error))
  } finally {
    if (socket) socket.destroy()
    if (child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
  }

  fs.writeFileSync(path.join(outDir, 'stdout.log'), stdout, 'utf8')
  fs.writeFileSync(path.join(outDir, 'stderr.log'), stderr, 'utf8')
  const pck = exe.replace(/\.exe$/i, '.pck')
  const manifest = {
    schema: 'phase17.export-probe.v1',
    created_at: new Date().toISOString(),
    exe: {
      path: path.relative(DOCS_ROOT, exe).split(path.sep).join('/'),
      bytes: fs.statSync(exe).size,
      sha256: sha256File(exe),
    },
    pck: fs.existsSync(pck)
      ? {
          path: path.relative(DOCS_ROOT, pck).split(path.sep).join('/'),
          bytes: fs.statSync(pck).size,
          sha256: sha256File(pck),
        }
      : null,
    bridge_port: port,
    pid: child.pid,
    checks,
    summary: {
      passed: checks.filter((entry) => entry.ok).length,
      failed: checks.filter((entry) => !entry.ok).length,
    },
    failure: failure ? String(failure.stack || failure) : null,
    stdout_lines: stdout.split(/\r?\n/).filter(Boolean).length,
    stderr_lines: stderr.split(/\r?\n/).filter(Boolean).length,
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} ${entry.detail}`)
  console.log(`EVIDENCE ${outDir}`)
  upsertTest({
    id: 'export',
    label: 'Exported Windows build',
    status: manifest.summary.failed === 0 ? 'done' : 'failed',
    passed: manifest.summary.passed,
    total: checks.length,
    detail: `Dodge, cooldown, restart, and sword hit; ${manifest.summary.passed}/${checks.length}.`,
  })
  if (manifest.summary.failed === 0) logLive('Exported Windows build passed the dodge and combat probe.', 'pass')
  else logLive('Exported Windows build probe failed.', 'fail')
  if (manifest.summary.failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
