#!/usr/bin/env node
/**
 * Phase 19 exported-build verification.
 *
 * Starts the shipped Windows binary, connects to its opt-in harness bridge,
 * drives the same gameplay surface used by the editor runs, captures the real
 * window, and records the PE metadata. This verifies the packaged build; it
 * does not re-run the editor acceptance suite.
 *
 * Usage:
 *   node controller/voxel-export-verify.mjs --exe voxel/build/voxel-sandbox.exe
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { DOCS_ROOT, rejectReason, writeJsonFile } from './evidence-output.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// Phase 18's capture script filters window titles containing "deflect". The
// voxel build has its own title, so use the parameterised Phase 19 copy and
// leave the shared Phase 18 evidence script untouched.
const CAPTURE_SCRIPT = path.join(HERE, 'capture-window-phase19.ps1')
const EXPORT_ROOT = path.join(DOCS_ROOT, 'phase19', 'evidence', 'export')

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

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
  const resolved = path.resolve(dir)
  const relative = path.relative(EXPORT_ROOT, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`export evidence must stay inside ${EXPORT_ROOT}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  fs.mkdirSync(resolved, { recursive: true })
  return resolved
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
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

const NEUTRAL = { forward: 0, strafe: 0, jump: false, restart: false, actions: {} }

function horizontalDistance(a, b) {
  return Math.hypot(Number(b[0]) - Number(a[0]), Number(b[2]) - Number(a[2]))
}

function lastEvent(state, type) {
  const events = Array.isArray(state.events) ? state.events : []
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i]?.type === type) return events[i]
  }
  return null
}

function captureWindow(processId, output) {
  const args = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    CAPTURE_SCRIPT,
    '-ProcessId',
    String(processId),
    '-Output',
    output,
    '-TitleMatch',
    'voxel',
  ]
  // The window is created a moment after the bridge reports ready, so allow a
  // couple of attempts before treating the capture as a failure.
  let result = null
  for (let attempt = 0; attempt < 3; attempt++) {
    result = spawnSync('powershell.exe', args, { encoding: 'utf8', timeout: 30000 })
    if (result.status === 0 && fs.existsSync(output)) break
    spawnSync('powershell.exe', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 800'], {
      encoding: 'utf8',
      timeout: 10000,
    })
  }
  return {
    ok: result.status === 0 && fs.existsSync(output),
    status: result.status,
    attempts: 3,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    file: fs.existsSync(output) ? output : null,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const exe = path.resolve(options.exe)
  if (!fs.existsSync(exe)) throw new Error(`missing exported binary: ${exe}`)
  const outDir = assertExportDir(path.join(options.outDir || EXPORT_ROOT, stamp()))

  const bytes = fs.readFileSync(exe)
  const peHeader = {
    magic: bytes.subarray(0, 2).toString('ascii'),
    pe_offset: bytes.readUInt32LE(0x3c),
    bytes: bytes.length,
  }
  const isPe =
    peHeader.magic === 'MZ' &&
    bytes.subarray(peHeader.pe_offset, peHeader.pe_offset + 4).toString('ascii') === 'PE\0\0'

  const port = await freePort()
  const child = spawn(exe, ['--', `--harness-port=${port}`], {
    cwd: path.dirname(exe),
    // A hidden start would also create a hidden game window, which cannot be
    // captured. The exported binary is a GUI build, so showing the window does
    // not spawn a console.
    windowsHide: false,
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

  const checks = []
  const check = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail })
  let failure = null
  let socket = null
  let capture = null
  let ping = null
  let packGameplay = null

  try {
    socket = await connect(port, options.timeoutMs)
    const client = makeClient(socket)
    ping = await client.send('ping')
    check('bridge-reachable', ping?.game_ready === true, `port=${port} godot=${ping?.godot}`)
    check('packaged-not-headless', ping?.headless === false, `headless=${ping?.headless}`)

    await client.send('pause')
    await client.send('harness_setup', { save_path: 'user://phase19-export-verify.json', delete_save: true })
    await client.send('reset')
    await client.send('advance_physics', { frames: 30, input: NEUTRAL })
    let state = await client.send('snapshot')
    const spawn = state.player_position
    check(
      'packaged-world-shape',
      state.world.width === 32 &&
        state.world.height === 16 &&
        state.world.depth === 32 &&
        state.world.chunk_count === 16 &&
        state.world.seed === 20261023 &&
        state.world.block_counts.grass > 0 &&
        state.world.block_counts.dirt > 0 &&
        state.world.block_counts.stone > 0 &&
        state.world.block_counts.log > 0,
      JSON.stringify(state.world.block_counts),
    )
    check('packaged-spawn-grounded', state.grounded === true, `pos=${JSON.stringify(spawn)}`)

    // Movement.
    await client.send('advance_physics', { frames: 30, input: { ...NEUTRAL, forward: 1 } })
    state = await client.send('snapshot')
    const moved = horizontalDistance(spawn, state.player_position)
    check('packaged-move-forward', moved > 0.5, `moved=${moved.toFixed(3)}`)

    // Jump.
    await client.send('reset')
    await client.send('advance_physics', { frames: 12, input: NEUTRAL })
    const beforeJump = await client.send('snapshot')
    await client.send('advance_physics', { frames: 1, input: { ...NEUTRAL, jump: true } })
    await client.send('advance_physics', { frames: 8, input: NEUTRAL })
    state = await client.send('snapshot')
    check(
      'packaged-jump',
      state.player_position[1] > beforeJump.player_position[1] + 0.2,
      `from=${beforeJump.player_position[1].toFixed(3)} to=${state.player_position[1].toFixed(3)}`,
    )

    // Targeting and mining a generated surface block.
    await client.send('reset')
    await client.send('advance_physics', { frames: 20, input: NEUTRAL })
    state = await client.send('snapshot')
    const sx = Math.floor(state.player_position[0])
    const sz = Math.floor(state.player_position[2])
    const targetY = Math.floor(state.player_position[1] + 0.05) - 1
    await client.send('harness_setup', { look_at: [sx, targetY, sz] })
    state = await client.send('snapshot')
    const target = state.target
    check(
      'packaged-targeting',
      target.hit === true && JSON.stringify(target.block) === JSON.stringify([sx, targetY, sz]),
      JSON.stringify(target),
    )
    const minedId = Number(target.block_id)
    const beforeMine = Number(state.inventory[String(minedId)] || 0)
    await client.send('advance_physics', { frames: 1, input: { ...NEUTRAL, actions: { mine: true } } })
    await client.send('advance_physics', { frames: 3, input: NEUTRAL })
    state = await client.send('snapshot')
    const minedEvent = lastEvent(state, 'block_mined')
    check(
      'packaged-mining',
      minedEvent !== null &&
        JSON.stringify(minedEvent.block) === JSON.stringify([sx, targetY, sz]) &&
        Number(state.inventory[String(minedId)] || 0) === beforeMine + 1,
      JSON.stringify(minedEvent),
    )

    // Adjacent placement into the reported previous cell.
    await client.send('reset')
    await client.send('advance_physics', { frames: 20, input: NEUTRAL })
    state = await client.send('snapshot')
    const px = Math.floor(state.player_position[0])
    const pz = Math.floor(state.player_position[2])
    const placeY = Math.floor(state.player_position[1] + 0.05) + 1
    await client.send('harness_setup', {
      blocks: [{ x: px, y: placeY, z: pz - 2, id: 3 }],
      look_at: [px, placeY, pz - 2],
      selected_slot: 1,
    })
    state = await client.send('snapshot')
    const previous = state.target.previous
    await client.send('advance_physics', { frames: 1, input: { ...NEUTRAL, actions: { place: true } } })
    await client.send('advance_physics', { frames: 3, input: NEUTRAL })
    state = await client.send('snapshot')
    const placedEvent = lastEvent(state, 'block_placed')
    check(
      'packaged-placement-adjacent',
      placedEvent !== null && JSON.stringify(placedEvent.block) === JSON.stringify(previous),
      `previous=${JSON.stringify(previous)} event=${JSON.stringify(placedEvent)}`,
    )

    // Hotbar selection.
    await client.send('advance_physics', { frames: 1, input: { ...NEUTRAL, actions: { select_3: true } } })
    state = await client.send('snapshot')
    check(
      'packaged-hotbar',
      state.selected_slot === 3 && state.selected_block === 'STONE',
      `slot=${state.selected_slot} block=${state.selected_block}`,
    )

    // Save and reload.
    await client.send('reset')
    await client.send('advance_physics', { frames: 20, input: NEUTRAL })
    state = await client.send('snapshot')
    await client.send('harness_setup', {
      blocks: [
        { x: 4, y: 4, z: 4, id: 0 },
        { x: 5, y: 5, z: 5, id: 1 },
      ],
      selected_slot: 2,
      inventory: { 1: 7, 2: 3, 3: 5, 4: 2 },
    })
    const beforeSave = await client.send('snapshot')
    await client.send('advance_physics', { frames: 1, input: { ...NEUTRAL, actions: { save: true } } })
    await client.send('reset')
    const resetHash = (await client.send('snapshot')).hash
    await client.send('advance_physics', { frames: 1, input: { ...NEUTRAL, actions: { load: true } } })
    const reloaded = await client.send('snapshot')
    check(
      'packaged-save-reload',
      resetHash !== beforeSave.hash &&
        reloaded.hash === beforeSave.hash &&
        reloaded.selected_slot === 2 &&
        Number(reloaded.inventory[String(1)] || 0) === 7,
      JSON.stringify({ reset: resetHash.slice(0, 12), saved: beforeSave.hash.slice(0, 12), loaded: reloaded.hash.slice(0, 12) }),
    )

    // Real window capture while paused on the reloaded world.
    await client.send('harness_setup', { selected_slot: 1, look_at: [px, placeY, pz - 2] })
    const capturePath = path.join(outDir, 'packaged-window.png')
    capture = captureWindow(child.pid, capturePath)
    check('packaged-window-capture', capture.ok, capture.ok ? capture.file : capture.stderr)
    if (capture.ok) capture.sha256 = sha256File(capture.file)

    packGameplay = {
      spawn,
      world: state.world,
      final_hash: reloaded.hash,
      selected_slot: reloaded.selected_slot,
    }
  } catch (error) {
    failure = error?.stack || String(error)
  } finally {
    try {
      if (socket) socket.destroy()
    } catch {
      // best effort
    }
    try {
      child.kill()
    } catch {
      // best effort
    }
  }

  const manifest = {
    schema: 'phase19.voxel-export-verify.v1',
    phase: 19,
    exported_at: new Date().toISOString(),
    exe,
    exe_name: path.basename(exe),
    exe_bytes: bytes.length,
    exe_sha256: sha256File(exe),
    pe: { ...peHeader, valid: isPe },
    ping,
    checks,
    passed: checks.filter((entry) => entry.ok).length,
    failed: checks.filter((entry) => !entry.ok).length,
    capture,
    gameplay: packGameplay,
    failure,
    stdout: stdout.slice(-4000),
    stderr: stderr.slice(-4000),
    note:
      'The packaged binary was driven through its opt-in harness bridge. ' +
      'The window capture is a real PrintWindow grab of the running build.',
  }
  writeJsonFile(outDir, 'run.json', manifest)
  console.log(`checks passed: ${manifest.passed}/${checks.length}`)
  console.log(`evidence: ${outDir}`)
  if (failure || manifest.failed > 0) {
    console.error(failure || 'one or more packaged checks failed')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
