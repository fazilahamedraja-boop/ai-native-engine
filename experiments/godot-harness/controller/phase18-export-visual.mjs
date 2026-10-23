#!/usr/bin/env node
/**
 * Phase 18 exported-build visual probe.
 *
 * Starts the shipped Windows binary (not the editor project), uses the same
 * public harness bridge and frozen encounter as the windowed acceptance run,
 * captures seven real frames from the exported process, then runs the same
 * independent pixel/state checker against those frames.
 *
 * This proves the visual repair is present in the packaged build. It is
 * separate from the editor-windowed capture and from the Windows gameplay
 * probe.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { DOCS_ROOT, rejectReason, sha256 } from './evidence-output.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PHASE18_DIR = path.join(DOCS_ROOT, 'phase18')

function parseArgs(argv) {
  const options = {
    exe: null,
    outDir: null,
    baselineDir: null,
    timeoutMs: 60000,
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--exe') options.exe = argv[++i]
    else if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--baseline-dir') options.baselineDir = argv[++i]
    else if (argv[i] === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!options.exe) throw new Error('--exe is required')
  if (!options.baselineDir) throw new Error('--baseline-dir is required')
  return options
}

function assertExportDir(dir) {
  const root = path.join(PHASE18_DIR, 'evidence', 'export')
  const resolved = path.resolve(dir)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`export evidence must stay inside ${root}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  return resolved
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function pngSize(file) {
  const buffer = fs.readFileSync(file)
  if (buffer.length < 24 || buffer.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error(`not a PNG: ${file}`)
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function captureWindow(pid, target) {
  const script = path.join(HERE, 'capture-window.ps1')
  const result = spawnSync('powershell', [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', script,
    '-ProcessId', String(pid),
    '-Output', target,
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(target)) {
    throw new Error(`window capture failed: ${result.stderr || result.stdout || 'no output'}`)
  }
  return pngSize(target)
}

async function capture(client, pid, outDir, name, scenario, runId) {
  await client.send('pause')
  const before = await client.send('snapshot')
  const observation = await client.send('observe', { targets: [], properties: [], since_tick: 0 })
  // The exported bridge's res:// write guard rejects the PCK root, so capture
  // the real client area of the shipped window with the OS instead.
  await sleep(150)
  const target = path.join(outDir, `${name}.png`)
  const size = captureWindow(pid, target)
  const after = await client.send('snapshot')
  if (before.hash !== after.hash) {
    throw new Error(`capture ${name} changed simulation state (${before.hash} -> ${after.hash})`)
  }
  return {
    name,
    scenario,
    image: {
      path: `${name}.png`,
      sha256: sha256(target),
      width: size.width,
      height: size.height,
    },
    screenshot: {
      path: `${name}.png`,
      sha256: sha256(target),
      width: size.width,
      height: size.height,
    },
    captured_at: new Date().toISOString(),
    engine_tick: before.physics_frames ?? before.step,
    simulation_step: before.step,
    paused: before.paused,
    state: before,
    state_after: after,
    events: {
      available: observation.events?.available ?? true,
      count: observation.events?.count ?? 0,
      items: (observation.events?.items ?? []).slice(-40),
    },
    capture_metadata: { phase: 'phase18-export', stage: name, run_id: runId },
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const exe = path.resolve(options.exe)
  if (!fs.existsSync(exe)) throw new Error(`exported binary not found: ${exe}`)
  const exeDir = path.dirname(exe)
  const runId = `phase18-export-${stamp()}`
  const outDir = assertExportDir(
    options.outDir || path.join(PHASE18_DIR, 'evidence', 'export', runId),
  )
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true })
  const baselineDir = path.resolve(options.baselineDir)

  const port = 49000 + Math.floor(Math.random() * 2000)
  const captures = []
  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
  const child = spawn(exe, ['--', `--harness-port=${port}`], {
    cwd: exeDir,
    // Keep the real game window visible; this is a windowed capture probe,
    // not a hidden/headless session.
    windowsHide: false,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8') })
  let failure = null
  let socket = null
  try {
    socket = await connect(port, options.timeoutMs)
    const client = makeClient(socket)
    const ping = await client.send('ping')
    check('exported-bridge-reachable', ping !== null, `port=${port}`)
    await client.send('pause')
    await client.send('reset')
    let snapshot = await client.send('snapshot')
    check(
      'exported-spawn-clean',
      snapshot.step === 0 &&
        snapshot.player_health === 4 &&
        snapshot.enemy_health === 5 &&
        snapshot.outcome === 'playing',
      `step=${snapshot.step} hp=${snapshot.player_health}/${snapshot.enemy_health}`,
    )

    await client.send('reset')
    const idleSetup = await client.send('harness_setup', {
      player_position: [0, 0.02, 2.6],
      enemy_position: [0, 0.02, 0.8],
      player_rotation_deg: 0,
      enemy_ai_enabled: false,
      player_health: 4,
      enemy_health: 5,
    })
    snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
    check(
      'exported-idle-scenario',
      snapshot.enemy_phase === 'idle' && snapshot.enemy_ai_enabled === false,
      `phase=${snapshot.enemy_phase} ai=${snapshot.enemy_ai_enabled}`,
    )
    captures.push(await capture(client, child.pid, outDir, 'idle', 'control: enemy idle at attack distance; AI frozen', runId))

    await client.send('reset')
    await client.send('harness_setup', {
      player_position: [0, 0.02, 2.6],
      enemy_position: [0, 0.02, 0.8],
      player_rotation_deg: 0,
      enemy_ai_enabled: true,
      player_health: 4,
      enemy_health: 5,
    })
    snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
    let guard = 0
    while (!(snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 18) && guard < 120) {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
      guard += 1
    }
    check(
      'exported-windup-early-reached',
      snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 18,
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick} guard=${guard}`,
    )
    captures.push(await capture(client, child.pid, outDir, 'windup-early', 'enemy windup: early warning window', runId))

    guard = 0
    while (snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick < 22 && guard < 30) {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
      guard += 1
    }
    check(
      'exported-windup-mid-reached',
      snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 21,
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick} guard=${guard}`,
    )
    captures.push(await capture(client, child.pid, outDir, 'windup-mid', 'enemy windup: middle warning window', runId))

    guard = 0
    while (snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick < 26 && guard < 60) {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
      guard += 1
    }
    check(
      'exported-windup-late-reached',
      snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 24,
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick} guard=${guard}`,
    )
    captures.push(await capture(client, child.pid, outDir, 'windup-late', 'enemy windup: late warning window', runId))

    guard = 0
    while (snapshot.enemy_phase === 'windup' && guard < 20) {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
      guard += 1
    }
    if (snapshot.enemy_phase === 'active') {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
    }
    check(
      'exported-active-reached',
      snapshot.enemy_phase === 'active',
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick}`,
    )
    captures.push(await capture(client, child.pid, outDir, 'active', 'enemy attack active window', runId))

    guard = 0
    while (snapshot.enemy_phase !== 'recover' && guard < 30) {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
      guard += 1
    }
    if (snapshot.enemy_phase === 'recover') {
      snapshot = (await client.send('advance_physics', { frames: 1, input: idle() })).final
    }
    check(
      'exported-recovery-reached',
      snapshot.enemy_phase === 'recover',
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick}`,
    )
    captures.push(await capture(client, child.pid, outDir, 'recovery', 'enemy recovery: warning should be gone', runId))

    snapshot = (await client.send('advance_physics', { frames: 1, input: idle({ restart: true }) })).final
    check(
      'exported-restart-clean',
      snapshot.step === 0 &&
        snapshot.player_health === 4 &&
        snapshot.enemy_health === 5 &&
        snapshot.outcome === 'playing',
      `step=${snapshot.step} hp=${snapshot.player_health}/${snapshot.enemy_health}`,
    )
    captures.push(await capture(client, child.pid, outDir, 'restart', 'restart restores a clean duel', runId))

    check('exported-process-stayed-alive', child.exitCode === null, `exit_code=${child.exitCode}`)
  } catch (error) {
    failure = error
    check('exported-visual-probe-completed', false, error.stack || String(error))
  } finally {
    if (socket) socket.destroy()
    if (child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true })
    }
  }

  fs.writeFileSync(path.join(outDir, 'logs', 'exported.stdout.txt'), stdout, 'utf8')
  fs.writeFileSync(path.join(outDir, 'logs', 'exported.stderr.txt'), stderr, 'utf8')
  fs.writeFileSync(
    path.join(outDir, 'captures.json'),
    JSON.stringify({ schema: 'phase18.capture-set.v1', run_id: runId, captures }, null, 2) + '\n',
    'utf8',
  )

  let acceptance = { exit_code: null, stdout: '', stderr: '', path: null, passed: false, checks: 0, failed_checks: [] }
  if (!failure && captures.length === 7) {
    const acceptancePath = path.join(outDir, 'visual-acceptance.json')
    const result = spawnSync('python', [
      path.join(HERE, 'phase18_visual_acceptance.py'),
      '--run-dir', outDir,
      '--out', acceptancePath,
      '--baseline-dir', baselineDir,
    ], { cwd: path.join(HERE, '..'), encoding: 'utf8', timeout: 120000, windowsHide: true })
    fs.writeFileSync(path.join(outDir, 'logs', 'visual-acceptance.stdout.txt'), result.stdout || '', 'utf8')
    fs.writeFileSync(path.join(outDir, 'logs', 'visual-acceptance.stderr.txt'), result.stderr || '', 'utf8')
    acceptance.exit_code = result.status
    acceptance.stdout = result.stdout
    acceptance.stderr = result.stderr
    acceptance.path = path.join(outDir, 'visual-acceptance.json')
    if (fs.existsSync(acceptancePath)) {
      const report = JSON.parse(fs.readFileSync(acceptancePath, 'utf8'))
      acceptance.passed = report.passed === true
      acceptance.checks = report.checks?.length ?? 0
      acceptance.failed_checks = (report.checks ?? []).filter((entry) => !entry.ok).map((entry) => entry.name)
      acceptance.sha256 = sha256(acceptancePath)
    }
  }

  const exePck = exe.replace(/\.exe$/i, '.pck')
  const manifest = {
    schema: 'phase18.export-visual.v1',
    run_id: runId,
    created_at: new Date().toISOString(),
    exe: {
      path: path.relative(DOCS_ROOT, exe).split(path.sep).join('/'),
      bytes: fs.statSync(exe).size,
      sha256: sha256(exe),
    },
    pck: fs.existsSync(exePck)
      ? {
          path: path.relative(DOCS_ROOT, exePck).split(path.sep).join('/'),
          bytes: fs.statSync(exePck).size,
          sha256: sha256(exePck),
        }
      : null,
    baseline_dir: baselineDir,
    bridge_port: port,
    pid: child.pid,
    windowed: true,
    captures: captures.length,
    checks,
    visual_acceptance: acceptance,
    failure: failure ? String(failure.stack || failure) : null,
    stdout_lines: stdout.split(/\r?\n/).filter(Boolean).length,
    stderr_lines: stderr.split(/\r?\n/).filter(Boolean).length,
  }
  fs.writeFileSync(path.join(outDir, 'run.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  for (const entry of checks) console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} ${entry.detail}`)
  console.log(`VISUAL_ACCEPTANCE ${JSON.stringify(acceptance)}`)
  console.log(`EVIDENCE ${outDir}`)
  if (failure || !acceptance.passed) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
