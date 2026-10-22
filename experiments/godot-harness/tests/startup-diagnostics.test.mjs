import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import {
  HarnessSession,
  stopAllSessions,
  withSession,
} from '../controller/harness.mjs'
import {
  StartupFailure,
  classifyStartupFailure,
  collectEngineErrors,
  startupError,
} from '../controller/startup-diagnostics.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OBSERVATION_PROJECT = path.join(ROOT, 'fixtures', 'observation')

/**
 * A startup failure must be reported as a startup failure with an actionable
 * cause, not as a generic timeout. These tests build the failure in isolated
 * temporary projects so no protected fixture is modified.
 */

function tempProject(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase14-${label}-`))
}

const DEFAULT_MAIN = 'extends Node\n\nfunc _ready() -> void:\n\tpass\n'

function writeProject(dir, { bridge, mainScript = DEFAULT_MAIN }) {
  fs.mkdirSync(path.join(dir, 'harness'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'harness', 'bridge.gd'), bridge, 'utf8')
  fs.writeFileSync(path.join(dir, 'main.gd'), mainScript, 'utf8')
  fs.writeFileSync(
    path.join(dir, 'main.tscn'),
    [
      '[gd_scene load_steps=1 format=3]',
      '[ext_resource type="Script" path="res://main.gd" id="1"]',
      '[node name="Main" type="Node"]',
      'script = ExtResource("1")',
      '',
    ].join('\n'),
    'utf8',
  )
  fs.writeFileSync(
    path.join(dir, 'project.godot'),
    [
      'config_version=5',
      '',
      '[application]',
      '',
      `config/name="phase14-${path.basename(dir)}"`,
      'run/main_scene="res://main.tscn"',
      'config/features=PackedStringArray("4.7")',
      '',
      '[autoload]',
      '',
      'HarnessBridge="*res://harness/bridge.gd"',
      '',
    ].join('\n'),
    'utf8',
  )
  return dir
}

function godotProcessCount() {
  try {
    const { execSync } = require('node:child_process')
    const output = execSync('tasklist /FI "IMAGENAME eq godot.exe" /NH', {
      encoding: 'utf8',
      windowsHide: true,
    })
    return (output.match(/godot\.exe/gi) || []).length
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Unit level: the classification itself
// ---------------------------------------------------------------------------

test('a script error is classified from the engine output', () => {
  const code = classifyStartupFailure({
    stdout: ['Godot Engine v4.7.2'],
    stderr: [
      'SCRIPT ERROR: Parse Error: Expected end of statement after expression, found ":" instead.',
      '   at: GDScript::reload (res://harness/bridge.gd:389)',
    ],
  })
  assert.equal(code, StartupFailure.SCRIPT_ERROR)
})

test('an autoload failure is classified separately from a plain script error', () => {
  const code = classifyStartupFailure({
    stderr: [
      'ERROR: Failed to load script "res://harness/bridge.gd" with error "Parse error".',
      "ERROR: Failed to instantiate an autoload, script 'res://harness/bridge.gd' does not inherit from 'Node'.",
    ],
  })
  assert.equal(code, StartupFailure.AUTOLOAD_ERROR)
})

test('a process that exited is classified as an exit, not as a script error', () => {
  const code = classifyStartupFailure({
    stderr: ['SCRIPT ERROR: Parse Error: something'],
    exited: { code: 3, signal: null },
  })
  assert.equal(code, StartupFailure.PROCESS_EXITED)
})

test('a live process with no engine error is a slow startup, not a failure', () => {
  const code = classifyStartupFailure({ stdout: ['Godot Engine v4.7.2'], stderr: [] })
  assert.equal(code, StartupFailure.SLOW_STARTUP)
})

test('connection and game phases are distinguishable from startup', () => {
  assert.equal(classifyStartupFailure({ phase: 'connect' }), StartupFailure.CONNECTION_FAILED)
  assert.equal(classifyStartupFailure({ phase: 'game' }), StartupFailure.GAME_NOT_READY)
  assert.equal(classifyStartupFailure({ phase: 'protocol' }), StartupFailure.PROTOCOL_ERROR)
  assert.equal(classifyStartupFailure({ phase: 'ready', spawnError: new Error('x') }), StartupFailure.SPAWN_FAILED)
})

test('the engine error collector keeps the "at:" continuation line', () => {
  const errors = collectEngineErrors({
    stderr: [
      'SCRIPT ERROR: Parse Error: Expected end of statement after expression, found ":" instead.',
      '   at: GDScript::reload (res://harness/bridge.gd:389)',
      'some unrelated line',
    ],
  })
  assert.equal(errors.length, 2)
  assert.match(errors[0], /Parse Error/)
  assert.match(errors[1], /bridge\.gd:389/)
})

test('the reported error carries the code and structured diagnostics', () => {
  const error = startupError({
    phase: 'ready',
    project: 'fixtures/x',
    stderr: ['SCRIPT ERROR: Parse Error: boom', '   at: GDScript::reload (res://harness/bridge.gd:1)'],
    elapsedMs: 2000,
    timeoutMs: 20000,
  })
  assert.equal(error.code, StartupFailure.SCRIPT_ERROR)
  assert.equal(error.diagnostics.code, StartupFailure.SCRIPT_ERROR)
  assert.equal(error.diagnostics.project, 'fixtures/x')
  assert.equal(error.diagnostics.elapsed_ms, 2000)
  assert.match(error.message, /Godot startup failed: script_error/)
  assert.match(error.message, /Parse Error: boom/)
  assert.match(error.message, /bridge\.gd:1/)
  assert.match(error.message, /readiness limit 20000 ms/)
})

// ---------------------------------------------------------------------------
// Integration level: real Godot processes
// ---------------------------------------------------------------------------

test('a valid project starts normally', async () => {
  const before = godotProcessCount()
  const session = new HarnessSession({ project: 'fixtures/observation', headless: true })
  try {
    const started = await session.start()
    assert.equal(started.ok, true)
    assert.equal(started.ping.game_ready, true)
  } finally {
    await session.stop()
  }
  const after = godotProcessCount()
  if (before !== null && after !== null) assert.ok(after <= before, 'no godot process leaked')
})

test('an invalid GDScript bridge is reported as a script failure with the parse error', async () => {
  const dir = tempProject('parse-error')
  fs.cpSync(OBSERVATION_PROJECT, dir, { recursive: true })
  const bridge = path.join(dir, 'harness', 'bridge.gd')
  fs.writeFileSync(bridge, `${fs.readFileSync(bridge, 'utf8')}\nfunc broken( -> void:\n\tpass\n`, 'utf8')
  const before = godotProcessCount()
  const session = new HarnessSession({
    project: dir,
    headless: true,
    timeoutMs: 3000,
    allowOutsideRoot: true,
  })
  let error = null
  try {
    await session.start()
  } catch (caught) {
    error = caught
  } finally {
    await session.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.ok(error, 'the startup must fail')
  assert.ok(
    error.code === StartupFailure.SCRIPT_ERROR || error.code === StartupFailure.AUTOLOAD_ERROR,
    `expected a script/autoload failure, got ${error.code}`,
  )
  assert.match(error.message, /Parse Error/)
  assert.match(error.message, /bridge\.gd/)
  // The error must not be a bare timeout any more.
  assert.doesNotMatch(error.message, /^Timed out waiting for HARNESS_READY/)
  const after = godotProcessCount()
  if (before !== null && after !== null) assert.ok(after <= before, 'no godot process leaked')
})

test('a project that exits before readiness is reported as a process exit', async () => {
  const dir = tempProject('exit-before-ready')
  writeProject(dir, {
    bridge: 'extends Node\n\nfunc _ready() -> void:\n\tget_tree().quit(3)\n',
  })
  const before = godotProcessCount()
  const session = new HarnessSession({
    project: dir,
    headless: true,
    timeoutMs: 8000,
    allowOutsideRoot: true,
  })
  let error = null
  try {
    await session.start()
  } catch (caught) {
    error = caught
  } finally {
    await session.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.ok(error, 'the startup must fail')
  assert.equal(error.code, StartupFailure.PROCESS_EXITED)
  assert.equal(error.diagnostics.exit_code, 3)
  assert.match(error.message, /exited \(code=3/)
})

test('a process that starts but never signals readiness is reported as a slow startup', async () => {
  const dir = tempProject('never-ready')
  writeProject(dir, {
    bridge: 'extends Node\n\nfunc _ready() -> void:\n\tpass\n',
    mainScript: 'extends Node\n\nfunc _ready() -> void:\n\tpass\n',
  })
  const before = godotProcessCount()
  const session = new HarnessSession({
    project: dir,
    headless: true,
    timeoutMs: 2000,
    allowOutsideRoot: true,
  })
  let error = null
  try {
    await session.start()
  } catch (caught) {
    error = caught
  } finally {
    await session.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.ok(error, 'the startup must fail')
  assert.equal(error.code, StartupFailure.SLOW_STARTUP)
  assert.match(error.message, /never signalled readiness/)
  assert.equal(error.diagnostics.exit_code, null)
  const after = godotProcessCount()
  if (before !== null && after !== null) assert.ok(after <= before, 'no godot process leaked')
})

test('a genuinely slow startup is distinguishable from a failed one', async () => {
  // The real observation bridge is delayed before it publishes readiness. With a
  // short limit the controller must report a slow startup, and with a long
  // limit the same project must start normally.
  const dir = tempProject('slow-but-eventually-ready')
  fs.cpSync(OBSERVATION_PROJECT, dir, { recursive: true })
  const bridge = path.join(dir, 'harness', 'bridge.gd')
  const source = fs.readFileSync(bridge, 'utf8')
  // The checked-in file uses CRLF, so the insertion is done line by line
  // rather than by matching a "\n" terminated marker.
  const lines = source.split(/\r?\n/)
  const readyIndex = lines.findIndex((line) => line.startsWith('func _ready()'))
  assert.ok(readyIndex >= 0, 'the observation bridge must have a _ready method')
  lines.splice(readyIndex + 1, 0, '\tawait get_tree().create_timer(3.0).timeout')
  fs.writeFileSync(bridge, lines.join('\n'), 'utf8')

  const slow = new HarnessSession({
    project: dir,
    headless: true,
    timeoutMs: 1200,
    allowOutsideRoot: true,
  })
  let slowError = null
  try {
    await slow.start()
  } catch (caught) {
    slowError = caught
  } finally {
    await slow.stop()
  }
  assert.ok(slowError, 'the short-limit start must fail')
  assert.equal(slowError.code, StartupFailure.SLOW_STARTUP)
  assert.equal(slowError.diagnostics.exit_code, null, 'the process was still alive')
  assert.deepEqual(slowError.diagnostics.engine_errors, [], 'no engine error was reported')

  const patient = new HarnessSession({
    project: dir,
    headless: true,
    timeoutMs: 20000,
    allowOutsideRoot: true,
  })
  try {
    const started = await patient.start()
    assert.equal(started.ok, true)
  } finally {
    await patient.stop()
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('stopAllSessions cleans up a session that was left running', async () => {
  const before = godotProcessCount()
  const session = new HarnessSession({ project: 'fixtures/observation', headless: true })
  await session.start()
  // Deliberately do not call session.stop() here.
  const results = await stopAllSessions()
  assert.ok(results.length >= 1)
  assert.ok(results.every((result) => result.ok))
  const after = godotProcessCount()
  if (before !== null && after !== null) assert.ok(after <= before, 'no godot process leaked')
})

test('withSession stops the session even when the body throws', async () => {
  const before = godotProcessCount()
  const session = new HarnessSession({ project: 'fixtures/observation', headless: true })
  await assert.rejects(
    () =>
      withSession(session, async () => {
        throw new Error('body failed')
      }),
    /body failed/,
  )
  const after = godotProcessCount()
  if (before !== null && after !== null) assert.ok(after <= before, 'no godot process leaked')
})
