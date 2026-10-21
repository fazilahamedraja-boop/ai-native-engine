import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HARNESS_ROOT = path.resolve(HERE, '..')
const DEFAULT_TIMEOUT_MS = 60000

/**
 * `godot` is a .cmd shim on this Windows install. Resolve it to the console
 * executable once instead of spawning through a shell, so project paths are
 * never interpreted by cmd.exe.
 */
function resolveGodotBinary() {
  if (process.env.GODOT_BIN) return process.env.GODOT_BIN
  if (process.platform !== 'win32') return 'godot'
  const where = spawnSync('where.exe', ['godot'], { encoding: 'utf8', windowsHide: true })
  const preferEngineProcess = (candidate) => {
    if (!candidate.toLowerCase().endsWith('_console.exe')) return candidate
    const gui = candidate.replace(/_console\.exe$/i, '.exe')
    return fs.existsSync(gui) ? gui : candidate
  }
  for (const candidate of (where.stdout || '').split(/\r?\n/).filter(Boolean)) {
    if (candidate.toLowerCase().endsWith('.exe') && fs.existsSync(candidate)) {
      return preferEngineProcess(candidate)
    }
    if (candidate.toLowerCase().endsWith('.cmd') || candidate.toLowerCase().endsWith('.bat')) {
      const shim = fs.readFileSync(candidate, 'utf8')
      const match = /"([^"]+\.exe)"/i.exec(shim)
      if (match && fs.existsSync(match[1])) return preferEngineProcess(match[1])
    }
  }
  return 'godot'
}

const GODOT_BIN = resolveGodotBinary()

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

export function resolveProject(projectArg, { allowOutsideRoot = false } = {}) {
  const project = path.resolve(HARNESS_ROOT, projectArg || 'fixtures/sentry')
  const relative = path.relative(HARNESS_ROOT, project)
  if (!allowOutsideRoot && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(
      `Project must stay inside the harness root (${HARNESS_ROOT}); ` +
        `pass --allow-outside-root for an explicit clean-copy check.`,
    )
  }
  if (!fs.existsSync(path.join(project, 'project.godot'))) {
    throw new Error(`No project.godot in ${project}`)
  }
  return project
}

export function runProcess(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut })
    })
  })
}

export function parseGodotTestOutput(stdout, stderr = '') {
  const results = []
  const errors = []
  const warnings = []
  let summary = null

  for (const rawLine of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    const pass = /^PASS ([^ ]+) (.*)$/.exec(line)
    const fail = /^FAIL ([^ ]+) (.*)$/.exec(line)
    const result = /^RESULT passed=(\d+) failed=(\d+)$/.exec(line)
    if (pass) {
      results.push({ name: pass[1], passed: true, detail: pass[2] })
    } else if (fail) {
      results.push({ name: fail[1], passed: false, detail: fail[2] })
    } else if (result) {
      summary = { passed: Number(result[1]), failed: Number(result[2]) }
    } else if (/\bERROR:|\bSCRIPT ERROR:/.test(line)) {
      errors.push(line)
    } else if (/\bWARNING:/.test(line)) {
      warnings.push(line)
    }
  }

  const countedPassed = results.filter((result) => result.passed).length
  const countedFailed = results.length - countedPassed
  const countsMatch =
    summary !== null && summary.passed === countedPassed && summary.failed === countedFailed
  const ok = summary !== null && summary.failed === 0 && countsMatch && errors.length === 0

  return {
    ok,
    results,
    summary,
    errors,
    warnings,
    reason: ok
      ? 'tests passed'
      : summary === null
        ? 'missing RESULT line'
        : !countsMatch
          ? 'RESULT counts do not match individual cases'
          : errors.length > 0
            ? 'Godot reported ERROR lines'
            : 'test cases failed',
  }
}

export async function runTests({
  project,
  script = 'res://tests/run_tests.gd',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowOutsideRoot = false,
} = {}) {
  const resolvedProject = resolveProject(project, { allowOutsideRoot })
  if (!script.startsWith('res://') || !script.endsWith('.gd')) {
    throw new Error('Test script must be a res:// .gd path')
  }
  const startedAt = Date.now()
  const processResult = await runProcess(
    GODOT_BIN,
    ['--headless', '--path', resolvedProject, '-s', script],
    { cwd: resolvedProject, timeoutMs },
  )
  const parsed = parseGodotTestOutput(processResult.stdout, processResult.stderr)
  return {
    operation: 'run_tests',
    project: resolvedProject,
    script,
    exitCode: processResult.code,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    durationMs: Date.now() - startedAt,
    ok: parsed.ok && processResult.code === 0 && !processResult.timedOut,
    ...parsed,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function validateHarnessInput(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('input must be an object')
  }
  const allowed = new Set(['forward', 'strafe', 'jump', 'restart', 'actions'])
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) throw new Error(`Unknown input key: ${key}`)
  }
  for (const key of ['forward', 'strafe']) {
    if (key in input && (!Number.isFinite(input[key]) || input[key] < -1 || input[key] > 1)) {
      throw new Error(`${key} must be a finite number between -1 and 1`)
    }
  }
  for (const key of ['jump', 'restart']) {
    if (key in input && typeof input[key] !== 'boolean') {
      throw new Error(`${key} must be a boolean`)
    }
  }
  if ('actions' in input) {
    const actions = input.actions
    if (actions === null || typeof actions !== 'object' || Array.isArray(actions)) {
      throw new Error('actions must be an object of boolean action names')
    }
    for (const [name, value] of Object.entries(actions)) {
      if (!/^[a-z][a-z0-9_]{0,31}$/.test(name)) {
        throw new Error('action names must match [a-z][a-z0-9_]{0,31}')
      }
      if (typeof value !== 'boolean') {
        throw new Error(`action ${name} must be a boolean`)
      }
    }
  }
}

function isProjectResPath(value, extension) {
  if (typeof value !== 'string' || !value.startsWith('res://')) return false
  const segments = value.slice('res://'.length).split('/')
  if (segments.some((segment) => segment === '..' || segment === '.' || segment === '')) {
    return false
  }
  return value.endsWith(extension)
}

function isRootNodePath(value) {
  if (typeof value !== 'string' || !value.startsWith('/root/') || value.includes(':')) {
    return false
  }
  return value
    .slice(1)
    .split('/')
    .every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
}

function validateRunId(runId) {
  if (typeof runId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(runId)) {
    throw new Error('runId must match [A-Za-z0-9._:-]{1,128}')
  }
  return runId
}

function validateScenario(scenario) {
  if (typeof scenario !== 'string' || scenario.trim().length === 0 || scenario.length > 256) {
    throw new Error('scenario must be a non-empty string of at most 256 characters')
  }
  return scenario.trim()
}

function validateMetadata(metadata) {
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('metadata must be an object')
  }
  return metadata
}

/**
 * One controller-owned Godot process and one loopback JSON connection.
 *
 * `start` only returns once the project bridge and the game scene are ready.
 * `stop` only ever terminates `this.child`; it never searches for, or signals,
 * another Godot process by name or PID.
 */
export class HarnessSession {
  constructor({ project, headless = true, scene = null, timeoutMs = 20000, allowOutsideRoot = false } = {}) {
    this.project = resolveProject(project, { allowOutsideRoot })
    this.headless = headless
    this.scene = scene
    this.timeoutMs = timeoutMs
    this.child = null
    this.pid = null
    this.socket = null
    this.port = null
    this.stdoutLines = []
    this.stderrLines = []
    this.nextId = 1
    this.pending = new Map()
    this.socketBuffer = ''
    this.exited = null
    this.exitPromise = null
    this.stopRequested = false
  }

  async start() {
    if (this.child) throw new Error('Session is already started')
    if (this.scene !== null) {
      if (!this.scene.startsWith('res://') || !/\.(tscn|scn)$/.test(this.scene)) {
        throw new Error('Scene must be a res:// .tscn or .scn path')
      }
    }

    const args = ['--path', this.project]
    if (this.headless) args.push('--headless')
    if (this.scene) args.push(this.scene)
    args.push('--', '--harness-port=0')

    const startedAt = Date.now()
    this.child = spawn(GODOT_BIN, args, {
      cwd: this.project,
      windowsHide: true,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.pid = this.child.pid

    let stdoutBuffer = ''
    let stderrBuffer = ''
    let readyResolve
    let readyReject
    const readyPromise = new Promise((resolve, reject) => {
      readyResolve = resolve
      readyReject = reject
    })

    const consumeLines = (buffer, chunk, target, onLine) => {
      let next = buffer + chunk
      while (next.includes('\n')) {
        const index = next.indexOf('\n')
        const line = next.slice(0, index).replace(/\r$/, '')
        next = next.slice(index + 1)
        target.push(line)
        onLine(line)
      }
      return next
    }

    this.child.stdout.setEncoding('utf8')
    this.child.stderr.setEncoding('utf8')
    this.child.stdout.on('data', (chunk) => {
      stdoutBuffer = consumeLines(stdoutBuffer, chunk, this.stdoutLines, (line) => {
        if (line.startsWith('HARNESS_READY ')) {
          try {
            const ready = JSON.parse(line.slice('HARNESS_READY '.length))
            if (ready.protocol !== 1) throw new Error(`Unsupported protocol ${ready.protocol}`)
            readyResolve(ready)
          } catch (error) {
            readyReject(error)
          }
        }
      })
    })
    this.child.stderr.on('data', (chunk) => {
      stderrBuffer = consumeLines(stderrBuffer, chunk, this.stderrLines, () => {})
    })

    this.exitPromise = new Promise((resolve) => {
      this.child.on('close', (code, signal) => {
        this.exited = { code, signal }
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`Godot process exited (code=${code}, signal=${signal})`))
        }
        this.pending.clear()
        resolve(this.exited)
      })
    })
    this.child.on('error', (error) => {
      readyReject(error)
    })

    let ready
    try {
      ready = await Promise.race([
        readyPromise,
        sleep(this.timeoutMs).then(() => {
          throw new Error(`Timed out waiting for HARNESS_READY after ${this.timeoutMs} ms`)
        }),
        this.exitPromise.then((exit) => {
          throw new Error(
            `Godot exited before HARNESS_READY (code=${exit.code}, signal=${exit.signal})`,
          )
        }),
      ])
    } catch (error) {
      await this.stop()
      throw error
    }

    if (ready.pid !== this.pid) {
      await this.stop()
      throw new Error(`Bridge PID ${ready.pid} does not match controller PID ${this.pid}`)
    }
    this.port = ready.port

    try {
      this.socket = await this._connect(ready.port)
      const ping = await this._waitForGame(5000)
      return {
        operation: 'start_project',
        ok: true,
        pid: this.pid,
        port: ready.port,
        project: this.project,
        scene: this.scene,
        headless: this.headless,
        durationMs: Date.now() - startedAt,
        ready,
        ping,
        logs: this.logTail(12),
      }
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  _connect(port) {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection({ host: '127.0.0.1', port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`Timed out connecting to bridge on 127.0.0.1:${port}`))
      }, 5000)
      socket.setEncoding('utf8')
      socket.once('connect', () => {
        clearTimeout(timer)
        resolve(socket)
      })
      socket.once('error', (error) => {
        clearTimeout(timer)
        reject(error)
      })
      socket.on('data', (chunk) => this._onSocketData(chunk))
      socket.on('error', (error) => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`Bridge connection error: ${error.message}`))
        }
        this.pending.clear()
      })
      socket.on('close', () => {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Bridge connection closed'))
        }
        this.pending.clear()
      })
    })
  }

  _onSocketData(chunk) {
    this.socketBuffer += chunk
    while (this.socketBuffer.includes('\n')) {
      const index = this.socketBuffer.indexOf('\n')
      const line = this.socketBuffer.slice(0, index).trim()
      this.socketBuffer = this.socketBuffer.slice(index + 1)
      if (!line) continue
      let response
      try {
        response = JSON.parse(line)
      } catch (error) {
        for (const pending of this.pending.values()) {
          clearTimeout(pending.timer)
          pending.reject(new Error(`Invalid JSON from bridge: ${error.message}`))
        }
        this.pending.clear()
        continue
      }
      const pending = this.pending.get(response.id)
      if (!pending) continue
      clearTimeout(pending.timer)
      this.pending.delete(response.id)
      if (response.ok) pending.resolve(response.data)
      else {
        const error = new Error(response.error?.message || 'Bridge command failed')
        error.code = response.error?.code || 'BRIDGE_ERROR'
        pending.reject(error)
      }
    }
  }

  async _waitForGame(timeoutMs) {
    const deadline = Date.now() + timeoutMs
    let last
    while (Date.now() < deadline) {
      last = await this.send('ping', {}, 2000)
      if (last.game_ready) return last
      await sleep(50)
    }
    throw new Error(`Game scene did not become ready: ${JSON.stringify(last)}`)
  }

  async send(cmd, args = {}, timeoutMs = 5000) {
    if (!this.socket || this.socket.destroyed) throw new Error('Session is not connected')
    const id = String(this.nextId++)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Bridge command '${cmd}' timed out after ${timeoutMs} ms`))
      }, timeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      this.socket.write(`${JSON.stringify({ id, cmd, args })}\n`)
    })
  }

  async startProject() {
    return this.start()
  }

  async stopProject() {
    return this.stop()
  }

  async ping() {
    return this.send('ping')
  }

  async pause() {
    return this.send('pause')
  }

  async resume() {
    return this.send('resume')
  }

  async setInput(input) {
    validateHarnessInput(input)
    return this.send('set_input', input)
  }

  async step({ steps = 1, delta = 1 / 60, input = null, recordEvery = 0 } = {}) {
    if (!Number.isInteger(steps) || steps < 0 || steps > 100000) {
      throw new Error('steps must be an integer between 0 and 100000')
    }
    if (!Number.isFinite(delta) || delta < 0.0001 || delta > 0.25) {
      throw new Error('delta must be between 0.0001 and 0.25')
    }
    if (input !== null) validateHarnessInput(input)
    const args = { steps, delta }
    if (input !== null) args.input = input
    if (recordEvery) {
      if (!Number.isInteger(recordEvery) || recordEvery < 0 || recordEvery > steps) {
        throw new Error('recordEvery must be between 0 and steps')
      }
      args.record_every = recordEvery
    }
    return this.send('step', args, 120000)
  }

  /**
   * Read-only physics space query through the bridge.
   * Runs PhysicsDirectSpaceState3D.intersect_shape / intersect_ray
   * at a supplied world transform and returns collider information.
   */
  async physicsQuery({ shape_type, transform, size, radius, height } = {}) {
    if (typeof shape_type !== 'string') {
      throw new Error('shape_type must be a string')
    }
    if (!shape_type) {
      throw new Error('shape_type is required')
    }
    const validShapes = ['box', 'sphere', 'capsule', 'ray']
    if (!validShapes.includes(shape_type)) {
      throw new Error('shape_type must be one of: ' + validShapes.join(', ') + '')
    }
    // Build the query arguments for the bridge
    const args = { shape_type }
    if (shape_type === 'box' && size) {
      args.size = size
    }
    if (shape_type === 'sphere' && radius !== undefined) {
      args.radius = radius
    }
    if (shape_type === 'capsule' && radius !== undefined && height !== undefined) {
      args.radius = radius
      args.height = height
    }
    if (transform) {
      args.transform = transform
    }
    return this.send('physics_query', args, 10000)
  }
  /**
   * Advance real Godot physics frames instead of calling a manual step.
   * The selected project's bridge must implement `advance_physics`; the game
   * node must expose `set_harness_input()` and `snapshot()`.
   */
  async advancePhysics({ frames = 1, input = null } = {}) {
    if (!Number.isInteger(frames) || frames < 0 || frames > 100000) {
      throw new Error('frames must be an integer between 0 and 100000')
    }
    if (input !== null) validateHarnessInput(input)
    const args = { frames }
    if (input !== null) args.input = input
    return this.send('advance_physics', args, 120000)
  }

  async reset() {
    return this.send('reset')
  }

  async screenshot(path = 'res://artifacts/harness.png') {
    if (!isProjectResPath(path, '.png')) {
      throw new Error('screenshot path must be a res:// .png path without .. segments')
    }
    // Give the renderer a frame after a step or camera move before reading the
    // viewport. This is a rendering wait, not a simulation advance.
    await sleep(120)
    return this.send('screenshot', { path }, 10000)
  }

  /**
   * Capture one actual windowed frame together with the paused runtime state.
   * The caller owns persistence; this method returns a manifest-ready record.
   */
  async captureFrame({
    path = 'res://artifacts/harness.png',
    scenario = 'frame',
    runId = null,
    metadata = {},
  } = {}) {
    if (!isProjectResPath(path, '.png')) {
      throw new Error('capture path must be a res:// .png path without .. segments')
    }
    const resolvedScenario = validateScenario(scenario)
    const resolvedRunId = validateRunId(runId ?? crypto.randomUUID())
    const resolvedMetadata = validateMetadata(metadata)
    if (this.headless) {
      throw new Error('captureFrame requires a windowed session; run without --headless')
    }
    if (!this.socket || this.socket.destroyed) throw new Error('Session is not connected')

    const before = await this.snapshot()
    if (!before.paused) {
      throw new Error('captureFrame requires a paused tree; call pause() before capture')
    }
    const startedAt = new Date()
    const captureStarted = Date.now()
    const screenshot = await this.screenshot(path)
    const captureDurationMs = Date.now() - captureStarted
    const after = await this.snapshot()

    const beforeStep = before.step
    const afterStep = after.step
    if (beforeStep !== undefined && afterStep !== undefined && beforeStep !== afterStep) {
      throw new Error(
        `capture advanced fixture simulation state (${beforeStep} -> ${afterStep}); keep the tree paused`,
      )
    }

    return {
      operation: 'capture_frame',
      ok: true,
      run_id: resolvedRunId,
      scenario: resolvedScenario,
      project: this.project,
      headless: this.headless,
      pid: this.pid,
      captured_at: new Date().toISOString(),
      capture_started_at: startedAt.toISOString(),
      duration_ms: captureDurationMs,
      tick: before.physics_frames ?? beforeStep ?? null,
      simulation_step: beforeStep ?? null,
      physics_frames_before: before.physics_frames ?? null,
      physics_frames_after: after.physics_frames ?? null,
      sim_time_seconds:
        before.physics_ticks_per_second && before.physics_frames !== undefined
          ? before.physics_frames / before.physics_ticks_per_second
          : null,
      paused: before.paused,
      screenshot,
      state_before: before,
      state_after: after,
      metadata: resolvedMetadata,
    }
  }

  /**
   * Capture a bounded sequence of actual frames. Frame 0 is the current paused
   * state; later frames are separated by real fixed physics ticks. This is a
   * sampled frame sequence, not a real-time video capture.
   */
  async captureSequence({
    scenario = 'sequence',
    prefix = 'sequence',
    frameCount = 6,
    everyFrames = 10,
    input = null,
    runId = null,
    metadata = {},
  } = {}) {
    const resolvedScenario = validateScenario(scenario)
    const resolvedRunId = validateRunId(runId ?? crypto.randomUUID())
    const resolvedMetadata = validateMetadata(metadata)
    if (typeof prefix !== 'string' || !/^[A-Za-z0-9._-]{1,80}$/.test(prefix)) {
      throw new Error('prefix must match [A-Za-z0-9._-]{1,80}')
    }
    if (!Number.isInteger(frameCount) || frameCount < 1 || frameCount > 60) {
      throw new Error('frameCount must be an integer between 1 and 60')
    }
    if (!Number.isInteger(everyFrames) || everyFrames < 1 || everyFrames > 10000) {
      throw new Error('everyFrames must be an integer between 1 and 10000')
    }
    if (input !== null) validateHarnessInput(input)
    if (this.headless) {
      throw new Error('captureSequence requires a windowed session; run without --headless')
    }
    if (!this.socket || this.socket.destroyed) throw new Error('Session is not connected')

    await this.pause()
    if (input !== null) await this.setInput(input)

    const startedAt = new Date()
    const wallStarted = Date.now()
    const frames = []
    for (let index = 0; index < frameCount; index++) {
      if (index > 0) await this.advancePhysics({ frames: everyFrames, input })
      frames.push(
        await this.captureFrame({
          path: `res://artifacts/${prefix}-${String(index).padStart(3, '0')}.png`,
          scenario: `${resolvedScenario} frame ${index}`,
          runId: resolvedRunId,
          metadata: {
            ...resolvedMetadata,
            frame_index: index,
            every_frames: everyFrames,
          },
        }),
      )
    }

    return {
      operation: 'capture_sequence',
      ok: true,
      run_id: resolvedRunId,
      scenario: resolvedScenario,
      project: this.project,
      headless: this.headless,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - wallStarted,
      frame_count: frameCount,
      every_frames: everyFrames,
      input,
      frames,
      note:
        'Frames are captured after real fixed physics ticks and are not a real-time video claim.',
    }
  }

  /**
   * Read a bounded set of node observations through the bridge's generic
   * `observe` contract. This is a read-only runtime inspection operation.
   */
  async observe({ targets = [], properties = [], descendants = 0, sinceTick = 0 } = {}) {
    if (!Array.isArray(targets)) throw new Error('targets must be an array')
    if (targets.length > 32) throw new Error('targets must contain at most 32 node paths')
    for (const target of targets) {
      if (!isRootNodePath(target)) {
        throw new Error(`targets must be absolute /root/... node paths: ${String(target)}`)
      }
    }
    if (!Array.isArray(properties)) throw new Error('properties must be an array')
    if (properties.length > 32) throw new Error('properties must contain at most 32 names')
    for (const property of properties) {
      if (typeof property !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(property)) {
        throw new Error(`properties must contain simple identifiers: ${String(property)}`)
      }
    }
    if (!Number.isInteger(descendants) || descendants < 0 || descendants > 3) {
      throw new Error('descendants must be an integer between 0 and 3')
    }
    if (!Number.isInteger(sinceTick) || sinceTick < 0) {
      throw new Error('sinceTick must be a non-negative integer')
    }
    return this.send(
      'observe',
      { targets, properties, descendants, since_tick: sinceTick },
      15000,
    )
  }

  /**
   * Sample structured observations across real fixed-physics advances. Each
   * sample is bounded; events are de-duplicated by the fixture sequence number.
   */
  async observeTimeline({
    frames = 1,
    everyFrames = 10,
    input = null,
    targets = [],
    properties = [],
    descendants = 0,
    sinceTick = 0,
    scenario = 'observation timeline',
    runId = null,
  } = {}) {
    if (!Number.isInteger(frames) || frames < 0 || frames > 100000) {
      throw new Error('frames must be an integer between 0 and 100000')
    }
    if (!Number.isInteger(everyFrames) || everyFrames < 1 || everyFrames > 10000) {
      throw new Error('everyFrames must be an integer between 1 and 10000')
    }
    const sampleCount = frames === 0 ? 1 : Math.ceil(frames / everyFrames) + 1
    if (sampleCount > 60) {
      throw new Error('timeline would produce more than 60 samples; increase everyFrames')
    }
    if (input !== null) validateHarnessInput(input)
    if (!Array.isArray(targets) || targets.length > 32) {
      throw new Error('targets must be an array of at most 32 node paths')
    }
    for (const target of targets) {
      if (!isRootNodePath(target)) {
        throw new Error(`targets must be absolute /root/... node paths: ${String(target)}`)
      }
    }
    if (!Array.isArray(properties) || properties.length > 32) {
      throw new Error('properties must be an array of at most 32 names')
    }
    for (const property of properties) {
      if (typeof property !== 'string' || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(property)) {
        throw new Error(`properties must contain simple identifiers: ${String(property)}`)
      }
    }
    if (!Number.isInteger(descendants) || descendants < 0 || descendants > 3) {
      throw new Error('descendants must be an integer between 0 and 3')
    }
    if (!Number.isInteger(sinceTick) || sinceTick < 0) {
      throw new Error('sinceTick must be a non-negative integer')
    }
    const resolvedScenario = validateScenario(scenario)
    const resolvedRunId = validateRunId(runId ?? crypto.randomUUID())
    const startedAt = new Date()
    const wallStarted = Date.now()

    await this.pause()
    const observeArgs = { targets, properties, descendants, sinceTick }
    const samples = []
    const events = []
    const eventKeys = new Set()
    const collectEvents = (observation) => {
      const items = observation?.events?.items
      if (!Array.isArray(items)) return
      for (const event of items) {
        const key =
          event && Number.isInteger(event.sequence)
            ? `sequence:${event.sequence}`
            : JSON.stringify(event)
        if (eventKeys.has(key)) continue
        eventKeys.add(key)
        events.push(event)
      }
    }

    const first = await this.observe(observeArgs)
    collectEvents(first)
    samples.push({
      index: 0,
      frames_advanced: 0,
      tick: first?.runtime?.tick ?? null,
      engine_tick: first?.runtime?.tick ?? null,
      sim_time_seconds: first?.runtime?.sim_time_seconds ?? null,
      engine_time_seconds: first?.runtime?.sim_time_seconds ?? null,
      simulation_step: null,
      simulation_time_seconds: null,
      observation: first,
    })

    let remaining = frames
    let index = 0
    while (remaining > 0) {
      const chunk = Math.min(everyFrames, remaining)
      const advance = await this.advancePhysics({ frames: chunk, input })
      const observation = await this.observe(observeArgs)
      collectEvents(observation)
      index += 1
      const simulationStep = Number.isFinite(advance?.final?.step)
        ? advance.final.step
        : null
      const ticksPerSecond = Number.isFinite(advance?.final?.physics_ticks_per_second)
        ? advance.final.physics_ticks_per_second
        : null
      samples.push({
        index,
        frames_advanced: chunk,
        tick: observation?.runtime?.tick ?? null,
        engine_tick: observation?.runtime?.tick ?? null,
        sim_time_seconds: observation?.runtime?.sim_time_seconds ?? null,
        engine_time_seconds: observation?.runtime?.sim_time_seconds ?? null,
        simulation_step: simulationStep,
        simulation_time_seconds:
          simulationStep !== null && ticksPerSecond !== null
            ? simulationStep / ticksPerSecond
            : null,
        advance: {
          frames: advance.frames,
          duration_ms: advance.duration_ms,
          final: advance.final,
        },
        observation,
      })
      remaining -= chunk
    }

    await this.pause()
    const final = samples[samples.length - 1].observation
    return {
      operation: 'observe_timeline',
      ok: true,
      run_id: resolvedRunId,
      scenario: resolvedScenario,
      project: this.project,
      headless: this.headless,
      started_at: startedAt.toISOString(),
      finished_at: new Date().toISOString(),
      duration_ms: Date.now() - wallStarted,
      frames,
      every_frames: everyFrames,
      sample_count: samples.length,
      input,
      targets,
      properties,
      descendants,
      since_tick: sinceTick,
      samples,
      events,
      event_count: events.length,
      final,
      timing: {
        engine_tick:
          'Engine.get_physics_frames(); rendering/pause overhead can advance it between samples',
        simulation_step:
          'fixture snapshot step after each fixed advance when the game exposes a numeric step',
        simulation_time_seconds:
          'derived from simulation_step / fixture physics_ticks_per_second',
        event_ticks:
          'fixture-recorded; this fixture records engine tick and simulation step in each event',
      },
      note:
        'Each sample is a read-only observe after real fixed physics frames; it is not a video claim.',
    }
  }

  async snapshot() {
    return this.send('snapshot')
  }

  async sceneTree() {
    return this.send('scene_tree')
  }

  async property(nodePath, property) {
    return this.send('property', { node_path: nodePath, property })
  }

  async bridgeLogs() {
    return this.send('logs')
  }

  async inspectState() {
    const [snapshot, tree, bridgeLogs] = await Promise.all([
      this.snapshot(),
      this.sceneTree(),
      this.bridgeLogs(),
    ])
    return {
      operation: 'inspect_state',
      ok: true,
      pid: this.pid,
      paused: snapshot.paused,
      snapshot,
      scene_tree: tree.tree,
      bridge_logs: bridgeLogs,
      process_logs: this.logTail(80),
    }
  }

  logTail(count = 80) {
    return {
      stdout: this.stdoutLines.slice(-count),
      stderr: this.stderrLines.slice(-count),
    }
  }

  async stop() {
    if (!this.child) {
      return { operation: 'stop_project', ok: true, alreadyStopped: true, pid: null, exitCode: null, killed: false }
    }
    this.stopRequested = true
    let killed = false
    try {
      if (this.socket && !this.socket.destroyed) await this.send('quit', {}, 2000)
    } catch {
      // The process may already be gone; the exit wait below is authoritative.
    }

    let exit = this.exited
    if (!exit) {
      exit = await Promise.race([this.exitPromise, sleep(5000).then(() => null)])
    }
    if (!exit) {
      killed = true
      this.child.kill()
      exit = await Promise.race([this.exitPromise, sleep(3000).then(() => null)])
    }
    if (this.socket) {
      this.socket.destroy()
      this.socket = null
    }
    const result = {
      operation: 'stop_project',
      ok: exit !== null,
      alreadyStopped: false,
      pid: this.pid,
      exitCode: exit?.code ?? null,
      signal: exit?.signal ?? null,
      killed,
      logs: this.logTail(40),
    }
    this.child = null
    return result
  }
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = { command, json: false, allowOutsideRoot: false, windowed: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--json') options.json = true
    else if (arg === '--allow-outside-root') options.allowOutsideRoot = true
    else if (arg === '--windowed') options.windowed = true
    else if (arg === '--project') options.project = rest[++i]
    else if (arg === '--script') options.script = rest[++i]
    else if (arg === '--scene') options.scene = rest[++i]
    else if (arg === '--out') options.out = rest[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(rest[++i])
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function usage() {
  return `godot-harness

Usage:
  node controller/harness.mjs test --project fixtures/sentry [--json] [--out result.json]
  node controller/harness.mjs inspect --project fixtures/sentry [--json] [--out result.json]

Options:
  --project <path>          Project root, relative to ${HARNESS_ROOT}
  --script <res://...>      Test entry script (default res://tests/run_tests.gd)
  --scene <res://...>       Explicit scene to launch (default: project main scene)
  --windowed                Launch with a window instead of --headless (inspect only)
  --json                    Print the structured result
  --out <path>              Write the structured result to a file
  --allow-outside-root      Allow an explicit project outside the harness root
  --timeout-ms <number>     Process startup timeout (default 60000 for tests, 20000 for inspect)
`
}

function writeResult(result, options) {
  if (options.out) {
    fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
    fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`)
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  }
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.command === 'help' || options.command === '--help') {
      process.stdout.write(usage())
      return 0
    }

    if (options.command === 'test') {
      const result = await runTests(options)
      if (!options.json) {
        for (const caseResult of result.results) {
          process.stdout.write(
            `${caseResult.passed ? 'PASS' : 'FAIL'} ${caseResult.name} ${caseResult.detail}\n`,
          )
        }
        process.stdout.write(
          `RESULT passed=${result.summary?.passed ?? 0} failed=${result.summary?.failed ?? 0} ` +
            `exit=${result.exitCode} ok=${result.ok}\n`,
        )
      }
      writeResult(result, options)
      return result.ok ? 0 : 1
    }

    if (options.command === 'inspect') {
      const session = new HarnessSession({
        project: options.project,
        headless: !options.windowed,
        scene: options.scene || null,
        allowOutsideRoot: options.allowOutsideRoot,
        timeoutMs: options.timeoutMs || 20000,
      })
      let start
      let state
      let stop
      let failure = null
      try {
        start = await session.startProject()
        await session.pause()
        state = await session.inspectState()
      } catch (error) {
        failure = { message: error.message, code: error.code || 'INSPECT_FAILED' }
      } finally {
        stop = await session.stopProject()
      }
      const result = {
        operation: 'inspect_project',
        ok: failure === null && Boolean(start?.ok && state?.ok && stop?.ok),
        error: failure,
        start,
        state,
        stop,
        logs: session.logTail(120),
      }
      if (!options.json) {
        process.stdout.write(
          `START pid=${result.start?.pid} port=${result.start?.port} ok=${result.start?.ok}\n`,
        )
        process.stdout.write(
          `INSPECT phase=${result.state?.snapshot?.phase} ` +
            `paused=${result.state?.snapshot?.paused} ok=${result.state?.ok}\n`,
        )
        process.stdout.write(
          `STOP pid=${result.stop?.pid} exit=${result.stop?.exitCode} ` +
            `killed=${result.stop?.killed} ok=${result.stop?.ok}\n`,
        )
      }
      writeResult(result, options)
      return result.ok ? 0 : 1
    }

    throw new Error(`Unknown command: ${options.command}`)
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`)
    return 2
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main()
}
