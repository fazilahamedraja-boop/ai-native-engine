import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession, runTests } from './harness.mjs'

const SOURCE_PROJECT = 'fixtures/observation'
const SOURCE_WORLD = 'scripts/observation_world.gd'
const TEST_SCRIPT = 'res://tests/run_observation.gd'
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase10', 'stage-d')
const CORRECT_GATE_LINE = '\tif plate_pressed == gate_open:\n'
const DEFECT_GATE_LINE = '\tif plate_pressed != gate_open:\n'
const OBSERVATION_TARGETS = [
  '/root/Main',
  '/root/Main/Player',
  '/root/Main/Plate',
  '/root/Main/Gate',
  '/root/Main/Beacon',
  '/root/Main/Crate',
]
const STATE_PROPERTIES = [
  'plate_pressed',
  'gate_open',
  'gate_collision_enabled',
  'beacon_state',
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeJson(name, value) {
  const target = path.join(EVIDENCE, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
  return {
    path: name,
    bytes: fs.statSync(target).size,
    sha256: sha256(target),
  }
}

function copyScreenshot(capture, name) {
  const target = path.join(EVIDENCE, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(capture.screenshot.absolute_path, target)
  const hash = sha256(target)
  assert.equal(hash, capture.screenshot.sha256, `${name} hash should match the bridge capture`)
  return {
    path: name,
    bytes: fs.statSync(target).size,
    sha256: hash,
  }
}

function idleInput() {
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    actions: { interact: false },
  }
}

function withInput(overrides = {}) {
  return {
    ...idleInput(),
    ...overrides,
    actions: { ...idleInput().actions, ...(overrides.actions || {}) },
  }
}

function nodeByPath(observation, nodePath) {
  return observation.nodes.find((node) => node.path === nodePath)
}

function stateSummary(snapshot) {
  return {
    step: snapshot.step,
    physics_frames: snapshot.physics_frames,
    physics_ticks_per_second: snapshot.physics_ticks_per_second,
    player_position: snapshot.player_position,
    player_velocity: snapshot.player_velocity,
    grounded: snapshot.grounded,
    plate_pressed: snapshot.plate_pressed,
    gate_open: snapshot.gate_open,
    gate_collision_enabled: snapshot.gate_collision_enabled,
    beacon_state: snapshot.beacon_state,
    goal_reached: snapshot.goal_reached,
    crate_position: snapshot.crate_position,
    crate_sleeping: snapshot.crate_sleeping,
    feedback: snapshot.feedback,
    prompt: snapshot.prompt,
    hash: snapshot.hash,
  }
}

function stateMatchesObservation(snapshot, observation, capture) {
  const state = nodeByPath(observation, '/root/Main').properties.values
  return {
    plate_pressed: state.plate_pressed === snapshot.plate_pressed,
    gate_open: state.gate_open === snapshot.gate_open,
    gate_collision_enabled: state.gate_collision_enabled === snapshot.gate_collision_enabled,
    beacon_state: state.beacon_state === snapshot.beacon_state,
    simulation_step: snapshot.step,
    engine_tick_at_state: snapshot.physics_frames,
    engine_tick_at_observation: observation.runtime.tick,
    engine_tick_delta: observation.runtime.tick - snapshot.physics_frames,
    screenshot_tick_delta:
      capture && Number.isFinite(capture.screenshot?.tick)
        ? capture.screenshot.tick - snapshot.physics_frames
        : null,
    note:
      'Paused state comparison; rendering can advance engine ticks without changing the fixture simulation step.',
  }
}

function compactTest(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    reason: result.reason,
    summary: result.summary,
    results: result.results,
    errors: result.errors,
  }
}

function screenshotSummary(capture, stored) {
  return {
    run_id: capture.run_id,
    scenario: capture.scenario,
    captured_at: capture.captured_at,
    tick: capture.tick,
    simulation_step: capture.simulation_step,
    sim_time_seconds: capture.sim_time_seconds,
    screenshot: {
      width: capture.screenshot.width,
      height: capture.screenshot.height,
      bytes: capture.screenshot.bytes,
      sha256: capture.screenshot.sha256,
      tick: capture.screenshot.tick,
      headless: capture.screenshot.headless,
    },
    stored,
  }
}

function observationSummary(observation) {
  const main = nodeByPath(observation, '/root/Main')
  const player = nodeByPath(observation, '/root/Main/Player')
  const gate = nodeByPath(observation, '/root/Main/Gate')
  const events = observation.events.items
  return {
    runtime: observation.runtime,
    state: main.properties.values,
    player: {
      position: player.global_transform.origin,
      velocity: player.character.velocity,
      is_on_floor: player.character.is_on_floor,
      is_on_wall: player.character.is_on_wall,
      slide_collision_count: player.character.slide_collision_count,
    },
    gate: {
      position: gate.global_transform.origin,
      collision_shapes: gate.collision_shapes,
    },
    event_count: observation.events.count,
    event_types: events.map((event) => event.type),
    gate_events: events.filter(
      (event) =>
        event.type === 'plate_entered' ||
        event.type === 'plate_exited' ||
        event.type === 'gate_open' ||
        event.type === 'gate_close' ||
        (event.type === 'player_collision_start' && event.collider?.includes('/Gate')),
    ),
  }
}

async function captureCheckpoint(session, { runId, prefix, scenario, metadata }) {
  const capture = await session.captureFrame({
    path: `res://artifacts/${prefix}.png`,
    scenario,
    runId,
    metadata,
  })
  const observation = await session.observe({
    targets: OBSERVATION_TARGETS,
    properties: STATE_PROPERTIES,
    descendants: 1,
    sinceTick: 0,
  })
  const state = stateSummary(capture.state_before)
  const summary = observationSummary(observation)
  const match = stateMatchesObservation(capture.state_before, observation, capture)
  assert.equal(match.plate_pressed, true, `${prefix} plate state should match`)
  assert.equal(match.gate_open, true, `${prefix} gate state should match`)
  assert.equal(match.gate_collision_enabled, true, `${prefix} collision state should match`)
  assert.equal(match.beacon_state, true, `${prefix} beacon state should match`)

  const screenshot = copyScreenshot(capture, `${prefix}.png`)
  const captureEvidence = screenshotSummary(capture, screenshot)
  const observationEvidence = writeJson(`${prefix}-observation.json`, {
    project_source: SOURCE_PROJECT,
    temporary_copy: true,
    observation,
    capture: {
      run_id: capture.run_id,
      scenario: capture.scenario,
      captured_at: capture.captured_at,
      tick: capture.tick,
      simulation_step: capture.simulation_step,
      screenshot: captureEvidence.screenshot,
      stored_screenshot: screenshot,
      state: capture.state_before,
    },
    state_match: match,
  })
  return {
    capture: captureEvidence,
    observation: {
      ...observationEvidence,
      summary,
      state_match: match,
    },
    state,
    match,
    summary,
  }
}

async function runWindowedScenario(project, runId, variant) {
  const session = new HarnessSession({
    project,
    headless: false,
    allowOutsideRoot: true,
  })
  const log = []
  let result = null
  let stop = null
  try {
    const started = await session.start()
    assert.equal(started.ok, true, `${variant} project should start`)
    log.push({ type: 'start_project', pid: started.pid, port: started.port })
    await session.pause()
    const reset = await session.reset()
    log.push({ type: 'reset', step: reset.snapshot.step })
    await session.advancePhysics({ frames: 3, input: withInput() })
    await session.advancePhysics({ frames: 85, input: withInput({ forward: 1 }) })
    log.push({ type: 'advance_physics', frames: 85, input: 'forward=1', checkpoint: 'plate' })

    const plate = await captureCheckpoint(session, {
      runId: `${runId}-${variant}-plate`,
      prefix: `stage-d-${variant}-plate`,
      scenario:
        variant === 'defect'
          ? 'defect: player on pressure plate, gate remains closed'
          : 'repaired: player on pressure plate, gate open',
      metadata: {
        stage: 'phase10-d',
        fixture: 'observation-copy',
        variant,
        checkpoint: 'plate-pressed',
      },
    })

    await session.advancePhysics({ frames: 100, input: withInput({ forward: 1 }) })
    log.push({ type: 'advance_physics', frames: 100, input: 'forward=1', checkpoint: 'exit' })

    const exit = await captureCheckpoint(session, {
      runId: `${runId}-${variant}-exit`,
      prefix: `stage-d-${variant}-exit`,
      scenario:
        variant === 'defect'
          ? 'defect: player blocked by closed gate while plate is pressed'
          : 'repaired: player passes the gate and reaches the goal',
      metadata: {
        stage: 'phase10-d',
        fixture: 'observation-copy',
        variant,
        checkpoint: 'gate-exit',
      },
    })

    result = {
      godot: started.godot,
      pid: started.pid,
      port: started.port,
      log,
      plate,
      exit,
    }
  } finally {
    stop = await session.stop()
    log.push({ type: 'stop_project', ...stop })
  }
  return { ...result, stop }
}

function prepareDefectCopy() {
  const temporaryProject = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-phase10-stage-d-'))
  const source = path.resolve(HARNESS_ROOT, 'fixtures', 'observation')
  const sourceWorld = path.join(source, SOURCE_WORLD)
  const sourceTest = path.join(source, 'tests', 'run_observation.gd')
  const sourceHashes = {
    world: sha256(sourceWorld),
    test: sha256(sourceTest),
  }
  fs.cpSync(source, temporaryProject, {
    recursive: true,
    filter: (sourcePath) => {
      const relative = path.relative(source, sourcePath)
      return (
        relative !== 'artifacts' &&
        !relative.startsWith(`artifacts${path.sep}`) &&
        relative !== '.godot' &&
        !relative.startsWith(`.godot${path.sep}`)
      )
    },
  })
  const temporaryWorld = path.join(temporaryProject, SOURCE_WORLD)
  const temporaryTest = path.join(temporaryProject, 'tests', 'run_observation.gd')
  const original = fs.readFileSync(temporaryWorld, 'utf8')
  const occurrences = original.split(CORRECT_GATE_LINE).length - 1
  assert.equal(occurrences, 1, 'the correct gate condition should occur exactly once')
  fs.writeFileSync(temporaryWorld, original.replace(CORRECT_GATE_LINE, DEFECT_GATE_LINE))
  assert.notEqual(sha256(temporaryWorld), sourceHashes.world)
  assert.equal(sha256(temporaryTest), sourceHashes.test, 'the acceptance test must be copied unchanged')
  return {
    temporaryProject,
    source,
    sourceHashes,
    temporaryWorld,
    temporaryTest,
    defectHash: sha256(temporaryWorld),
  }
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const runId = `stage-d-${crypto.randomUUID()}`
  const startedAt = new Date().toISOString()
  const copy = prepareDefectCopy()
  const manifest = {
    operation: 'stage_d_defect_repair_evidence',
    stage: 'phase10-d',
    run_id: runId,
    started_at: startedAt,
    finished_at: null,
    project_source: SOURCE_PROJECT,
    temporary_copy: true,
    defect: {
      id: 'inverted-gate-condition',
      file: SOURCE_WORLD,
      correct_line: CORRECT_GATE_LINE.trimEnd(),
      defect_line: DEFECT_GATE_LINE.trimEnd(),
      replacement_count: 1,
      source_sha256: copy.sourceHashes.world,
      defect_sha256: copy.defectHash,
      repaired_sha256: null,
      repaired_matches_source: null,
    },
    test: {
      script: TEST_SCRIPT,
      script_sha256: copy.sourceHashes.test,
      same_script_before_and_after: false,
      before: null,
      after: null,
    },
    scenarios: {},
    ok: false,
  }

  try {
    const before = await runTests({
      project: copy.temporaryProject,
      script: TEST_SCRIPT,
      timeoutMs: 30000,
      allowOutsideRoot: true,
    })
    const beforeSummary = compactTest(before)
    assert.equal(beforeSummary.ok, false, 'the defect copy should fail the acceptance suite')
    assert.equal(beforeSummary.summary.failed, 2, 'two behavior-level cases should fail')
    assert.ok(
      beforeSummary.results.some(
        (result) => result.name === 'observation-plate-opens-gate' && !result.passed,
      ),
      'plate-opens-gate should fail before repair',
    )
    assert.ok(
      beforeSummary.results.some(
        (result) => result.name === 'observation-gate-passable-after-plate' && !result.passed,
      ),
      'gate-passable-after-plate should fail before repair',
    )
    manifest.test.before = {
      ...writeJson('stage-d-test-before.json', beforeSummary),
      ...beforeSummary,
    }

    manifest.scenarios.defect = await runWindowedScenario(copy.temporaryProject, runId, 'defect')
    const defectPlateState = manifest.scenarios.defect.plate.state
    const defectPlateSummary = manifest.scenarios.defect.plate.summary
    const defectExitState = manifest.scenarios.defect.exit.state
    const defectExitSummary = manifest.scenarios.defect.exit.summary
    assert.equal(defectPlateState.plate_pressed, true)
    assert.equal(defectPlateState.gate_open, false)
    assert.equal(defectPlateState.gate_collision_enabled, true)
    assert.equal(defectPlateState.beacon_state, 'red')
    assert.equal(defectPlateSummary.event_types.includes('plate_entered'), true)
    assert.equal(defectPlateSummary.event_types.includes('gate_open'), false)
    assert.equal(defectExitState.goal_reached, false)
    assert.equal(defectExitState.gate_open, false)
    assert.ok(defectExitState.player_position[2] > -2.2, 'defect player should be blocked at the gate')
    assert.equal(
      defectExitSummary.gate_events.some(
        (event) => event.type === 'player_collision_start' && event.collider?.includes('/Gate'),
      ),
      true,
      'the blocked player should have a gate collision event',
    )

    const repaired = fs.readFileSync(copy.temporaryWorld, 'utf8')
    assert.equal(repaired.split(DEFECT_GATE_LINE).length - 1, 1)
    fs.writeFileSync(copy.temporaryWorld, repaired.replace(DEFECT_GATE_LINE, CORRECT_GATE_LINE))
    const repairedHash = sha256(copy.temporaryWorld)
    manifest.defect.repaired_sha256 = repairedHash
    manifest.defect.repaired_matches_source = repairedHash === copy.sourceHashes.world
    assert.equal(manifest.defect.repaired_matches_source, true, 'repair should restore the source file')
    assert.equal(sha256(copy.temporaryTest), copy.sourceHashes.test)

    const after = await runTests({
      project: copy.temporaryProject,
      script: TEST_SCRIPT,
      timeoutMs: 30000,
      allowOutsideRoot: true,
    })
    const afterSummary = compactTest(after)
    assert.equal(afterSummary.ok, true, 'the repaired copy should pass the acceptance suite')
    assert.equal(afterSummary.summary.failed, 0)
    assert.equal(afterSummary.summary.passed, 8)
    manifest.test.after = {
      ...writeJson('stage-d-test-after.json', afterSummary),
      ...afterSummary,
    }
    manifest.test.same_script_before_and_after =
      beforeSummary.results.map((result) => result.name).join(',') ===
      afterSummary.results.map((result) => result.name).join(',')

    manifest.scenarios.repaired = await runWindowedScenario(
      copy.temporaryProject,
      runId,
      'repaired',
    )
    const repairedPlateState = manifest.scenarios.repaired.plate.state
    const repairedPlateSummary = manifest.scenarios.repaired.plate.summary
    const repairedExitState = manifest.scenarios.repaired.exit.state
    assert.equal(repairedPlateState.plate_pressed, true)
    assert.equal(repairedPlateState.gate_open, true)
    assert.equal(repairedPlateState.gate_collision_enabled, false)
    assert.equal(repairedPlateState.beacon_state, 'green')
    assert.equal(repairedPlateSummary.event_types.includes('gate_open'), true)
    assert.equal(repairedExitState.goal_reached, true)
    assert.equal(repairedExitState.gate_open, false)
    assert.ok(repairedExitState.player_position[2] < -4.0, 'repaired player should reach the goal')

    manifest.comparison = {
      same_checkpoint: 'player on plate after 85 forward physics frames',
      defect: {
        plate_pressed: defectPlateState.plate_pressed,
        gate_open: defectPlateState.gate_open,
        gate_collision_enabled: defectPlateState.gate_collision_enabled,
        beacon_state: defectPlateState.beacon_state,
        goal_reached: defectExitState.goal_reached,
        gate_collision_event: defectExitSummary.gate_events.some(
          (event) => event.type === 'player_collision_start' && event.collider?.includes('/Gate'),
        ),
      },
      repaired: {
        plate_pressed: repairedPlateState.plate_pressed,
        gate_open: repairedPlateState.gate_open,
        gate_collision_enabled: repairedPlateState.gate_collision_enabled,
        beacon_state: repairedPlateState.beacon_state,
        goal_reached: repairedExitState.goal_reached,
      },
    }
    manifest.diagnosis = {
      observation:
        'The plate reports pressed, but the gate remains closed, collision remains enabled, the beacon stays red, and the player is blocked at the gate.',
      hypothesis:
        'The gate state update is skipped when the plate and gate differ, so the gate never follows the plate.',
      testable_prediction:
        'Reversing the single inverted relation should make the gate open, disable its collision, turn the beacon green, and allow the unchanged acceptance suite to pass.',
      repair:
        'Replace the single inverted relation with the correct equality relation; no observer or test logic changes.',
      verification:
        'The repaired copy has the same source hash as the original fixture; the identical acceptance script reports 8/8.',
    }
    manifest.ok = true
  } catch (error) {
    manifest.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
    throw error
  } finally {
    fs.rmSync(copy.temporaryProject, { recursive: true, force: true })
    manifest.finished_at = new Date().toISOString()
    fs.writeFileSync(
      path.join(EVIDENCE, 'stage-d-observations.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
    )
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
