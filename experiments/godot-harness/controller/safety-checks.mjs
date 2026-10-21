import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execSync } from 'node:child_process'
import { HarnessSession, runTests } from './harness.mjs'
import { resolveOutputDir, writeJsonFile } from './evidence-output.mjs'

/**
 * Phase 13 safety, lifecycle, and regression checks.
 *
 * These are the operational properties the live-observation and diagnosis
 * runners depend on. Each check is recorded with its measured result so a
 * failure is reported as a failure, not as a silent skip.
 */

const PROJECT = 'fixtures/observation'
const TEST_SCRIPT = 'res://tests/run_observation.gd'

function godotProcessCount() {
  try {
    const output = execSync('tasklist /FI "IMAGENAME eq godot.exe" /NH', {
      encoding: 'utf8',
      windowsHide: true,
    })
    return (output.match(/godot\.exe/gi) || []).length
  } catch {
    return null
  }
}

function idleInput(overrides = {}) {
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    actions: { interact: false },
    ...overrides,
    actions: { interact: false, ...(overrides.actions || {}) },
  }
}

async function checkLifecycle(outDir) {
  const cycles = []
  const before = godotProcessCount()
  for (let index = 0; index < 3; index++) {
    const session = new HarnessSession({ project: PROJECT, headless: false })
    let started = null
    let stopped = null
    let error = null
    try {
      started = await session.startProject()
    } catch (caught) {
      error = caught.message
    } finally {
      stopped = await session.stop()
    }
    cycles.push({
      index,
      started_ok: started ? started.ok : false,
      start_error: error,
      exit_code: stopped.exitCode,
      killed: stopped.killed,
      already_stopped: stopped.alreadyStopped,
      bridge_port: started ? started.port : null,
    })
  }
  const after = godotProcessCount()
  return {
    name: 'windowed startup and shutdown are reliable',
    cycles,
    all_started: cycles.every((cycle) => cycle.started_ok),
    all_exited_cleanly: cycles.every((cycle) => cycle.exit_code === 0 && !cycle.killed),
    godot_processes_before: before,
    godot_processes_after: after,
    no_leaked_processes: before !== null && after !== null ? after <= before : null,
    ok:
      cycles.every((cycle) => cycle.started_ok && cycle.exit_code === 0 && !cycle.killed) &&
      (before === null || after === null || after <= before),
  }
}

async function checkFailedStartupDetected(outDir) {
  // A project whose bridge cannot be parsed must fail to start, and the
  // failure must be reported rather than hanging.
  const broken = fs.mkdtempSync(path.join(os.tmpdir(), 'phase13-broken-bridge-'))
  fs.cpSync(path.resolve(PROJECT), broken, { recursive: true })
  const bridge = path.join(broken, 'harness', 'bridge.gd')
  const source = fs.readFileSync(bridge, 'utf8')
  fs.writeFileSync(bridge, `${source}\nfunc broken( -> void:\n\tpass\n`)

  const session = new HarnessSession({ project: broken, headless: true, allowOutsideRoot: true })
  let rejected = false
  let message = null
  const startedAt = Date.now()
  try {
    try {
      await session.startProject()
    } catch (error) {
      rejected = true
      message = error.message
    }
  } finally {
    await session.stop()
  }
  const elapsedMs = Date.now() - startedAt
  const logs = session.logTail(60)
  const stderr = logs.stderr.filter((line) => line.trim())
  const stdout = logs.stdout.filter((line) => line.trim())
  // Godot reports script parse errors on stderr, so both streams are checked.
  const revealedParseError = [...stdout, ...stderr].some((line) => line.includes('Parse Error'))
  const revealedAutoloadError = [...stdout, ...stderr].some((line) =>
    line.includes('Failed to instantiate an autoload'),
  )
  fs.rmSync(broken, { recursive: true, force: true })
  return {
    name: 'a failed startup is detected, bounded, and does not hang',
    rejected,
    error_message: message,
    elapsed_ms: elapsedMs,
    bounded: elapsedMs < 40000,
    underlying_parse_error_visible_in_logs: revealedParseError,
    underlying_autoload_error_visible_in_logs: revealedAutoloadError,
    stdout_lines: stdout,
    stderr_lines: stderr,
    note:
      'The session API surfaces the failure as a HARNESS_READY timeout. The underlying ' +
      'Godot error is present in the process logs but is not attached to the thrown ' +
      'error, so a caller must read session.logTail() to see the real cause.',
    ok: rejected && elapsedMs < 40000,
  }
}

async function checkBoundedObservationTimeout(outDir) {
  // Every bridge command must be bounded by a timeout rather than hanging.
  const session = new HarnessSession({ project: PROJECT, headless: true })
  let rejected = false
  let message = null
  const startedAt = Date.now()
  try {
    await session.startProject()
    try {
      // An unknown command makes the bridge answer with an error; the controller
      // must surface it promptly rather than waiting forever.
      await session.send('this_command_does_not_exist', {}, 3000)
    } catch (error) {
      rejected = true
      message = error.message
    }
  } finally {
    await session.stop()
  }
  const elapsedMs = Date.now() - startedAt
  return {
    name: 'an unknown bridge command is rejected within its timeout',
    rejected,
    error_message: message,
    elapsed_ms: elapsedMs,
    bounded: elapsedMs < 10000,
    ok: rejected && elapsedMs < 10000,
  }
}

async function checkFailedCaptureDoesNotReuseStaleEvidence(outDir) {
  const session = new HarnessSession({ project: PROJECT, headless: false })
  let first = null
  let second = null
  let rejected = false
  let message = null
  try {
    await session.startProject()
    await session.pause()
    first = await session.captureFrame({
      path: 'res://artifacts/phase13-safety-first.png',
      scenario: 'first good capture',
      runId: 'phase13-safety',
    })
    try {
      // The tree is paused here, so a capture is valid. Now resume the tree and
      // try again: the capture must fail rather than return the previous frame.
      await session.resume()
      await session.captureFrame({
        path: 'res://artifacts/phase13-safety-second.png',
        scenario: 'capture while running',
        runId: 'phase13-safety',
      })
    } catch (error) {
      rejected = true
      message = error.message
    }
    await session.pause()
    second = await session.captureFrame({
      path: 'res://artifacts/phase13-safety-second.png',
      scenario: 'second good capture after pausing again',
      runId: 'phase13-safety',
    })
  } finally {
    // The session must always be stopped. A windowed Godot left running would
    // keep the parent's stdout pipe open and stall any shell that reads it.
    await session.stop()
  }
  return {
    name: 'a failed capture is reported and never returns a stale frame',
    first_sha256: first.screenshot.sha256,
    second_sha256: second.screenshot.sha256,
    failed_capture_rejected: rejected,
    failed_capture_message: message,
    frames_distinct: first.screenshot.sha256 !== second.screenshot.sha256,
    ok: rejected && first.screenshot.sha256 !== second.screenshot.sha256,
  }
}

async function checkRepeatedObservationsReproducible(outDir) {
  // The same fixed input sequence must produce the same measured state twice.
  const runs = []
  for (let index = 0; index < 2; index++) {
    const session = new HarnessSession({ project: PROJECT, headless: true })
    let snapshot = null
    try {
      await session.startProject()
      await session.pause()
      await session.reset()
      await session.advancePhysics({ frames: 3, input: idleInput() })
      await session.advancePhysics({ frames: 60, input: idleInput({ forward: 1 }) })
      await session.pause()
      snapshot = await session.snapshot()
    } finally {
      await session.stop()
    }
    runs.push({
      index,
      hash: snapshot.hash,
      outcome_hash: snapshot.outcome_hash,
      player_position: snapshot.player_position,
      plate_pressed: snapshot.plate_pressed,
      gate_open: snapshot.gate_open,
      step: snapshot.step,
    })
  }
  return {
    name: 'repeated observations and actions reproduce the same measured state',
    runs,
    state_hash_equal: runs[0].hash === runs[1].hash,
    outcome_hash_equal: runs[0].outcome_hash === runs[1].outcome_hash,
    position_equal:
      JSON.stringify(runs[0].player_position) === JSON.stringify(runs[1].player_position),
    ok:
      runs[0].hash === runs[1].hash &&
      runs[0].outcome_hash === runs[1].outcome_hash &&
      JSON.stringify(runs[0].player_position) === JSON.stringify(runs[1].player_position),
    note:
      'This is a repeatability result for this fixture and this fixed input sequence on ' +
      'one machine and one Godot build. It is not a general Godot physics determinism claim.',
  }
}

async function checkRegressionSuites(outDir) {
  const suites = []
  for (const [name, project, script, expected] of [
    ['character-audit', 'fixtures/character-audit', 'res://tests/run_character_audit.gd', 4],
    ['combat', 'fixtures/combat', 'res://tests/run_combat.gd', 3],
    ['observation', 'fixtures/observation', 'res://tests/run_observation.gd', 8],
    ['door', 'fixtures/door', 'res://tests/run_door.gd', 7],
    ['physics', 'fixtures/physics', 'res://tests/run_physics.gd', 9],
    ['sentry', 'fixtures/sentry', 'res://tests/run_tests.gd', 7],
    ['phase13-defect', 'fixtures/phase13-defect', 'res://tests/run_observation.gd', 8],
  ]) {
    const result = await runTests({ project, script, timeoutMs: 60000 })
    process.stderr.write(`[safety]   suite ${name} ok=${result.ok} (${result.durationMs} ms)\n`)
    suites.push({
      name,
      project,
      script,
      exit_code: result.exitCode,
      ok: result.ok,
      passed: result.summary ? result.summary.passed : null,
      failed: result.summary ? result.summary.failed : null,
      expected_total: expected,
      matches_expectation:
        result.ok &&
        result.summary !== null &&
        result.summary.passed === expected &&
        result.summary.failed === 0,
    })
  }
  return {
    name: 'all Phase 8-13 fixture suites pass unchanged',
    suites,
    ok: suites.every((suite) => suite.matches_expectation),
  }
}

async function main() {
  const outDir = resolveOutputDir({
    runner: 'safety-checks',
    stamp: new Date().toISOString().replace(/[:.]/g, '-'),
  })
  const checks = []
  for (const check of [
    checkLifecycle,
    checkFailedStartupDetected,
    checkBoundedObservationTimeout,
    checkFailedCaptureDoesNotReuseStaleEvidence,
    checkRepeatedObservationsReproducible,
    checkRegressionSuites,
  ]) {
    const startedAt = Date.now()
    process.stderr.write(`[safety] running: ${check.name}\n`)
    try {
      checks.push(await check(outDir))
    } catch (error) {
      checks.push({
        name: check.name,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    process.stderr.write(`[safety] done: ${check.name} (${Date.now() - startedAt} ms)\n`)
  }
  const report = {
    operation: 'phase13_safety_checks',
    ok: checks.every((check) => check.ok),
    output_dir: outDir,
    generated_at: new Date().toISOString(),
    godot: '4.7.2-stable (official)',
    checks,
  }
  writeJsonFile(outDir, 'safety-report.json', report)
  console.log(
    JSON.stringify(
      {
        ok: report.ok,
        output_dir: outDir,
        checks: checks.map((check) => ({
          name: check.name,
          ok: check.ok,
          error: check.error || null,
        })),
      },
      null,
      2,
    ),
  )
  if (!report.ok) process.exitCode = 1
}

await main()
