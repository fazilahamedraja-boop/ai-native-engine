import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession } from './harness.mjs'
import { copyCaptureFile, resolveOutputDir, writeJsonFile } from './evidence-output.mjs'

/**
 * Phase 13 live observation and controlled action runner.
 *
 * Stage A: keep a visible Godot window running while the controller collects
 *   fresh screenshots and structured observations. Every observation is tied to
 *   its frame, wall-clock timestamp, engine tick, and fixture simulation step,
 *   and every capture is checked for freshness so a stale or reused frame
 *   cannot be reported as new.
 *
 * Stage B: issue bounded actions through the existing harness input contract
 *   and verify the resulting runtime state. An action is only reported as
 *   successful when the observed state proves it, never because an input was
 *   sent.
 *
 * Every artifact is written under an explicit, configurable output directory.
 * The default is a unique directory under docs/phase13; protected Phase 8-12
 * evidence directories are refused.
 */

const PROJECT = 'fixtures/observation'
const OBSERVATION_TARGETS = [
  '/root/Main',
  '/root/Main/Player',
  '/root/Main/Plate',
  '/root/Main/Gate',
  '/root/Main/Beacon',
]
const STATE_PROPERTIES = [
  'plate_pressed',
  'gate_open',
  'gate_collision_enabled',
  'beacon_state',
  'feedback',
  'prompt',
  'goal_reached',
]
const PLAYER_SPEED = 4.0
const PHYSICS_HZ = 60

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

function parseArgs(argv) {
  const options = { outDir: null, observations: 4, interval: 45, runner: 'live-observe' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--observations') options.observations = Number(argv[++i])
    else if (argv[i] === '--interval') options.interval = Number(argv[++i])
    else if (argv[i] === '--runner') options.runner = argv[++i]
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!Number.isInteger(options.observations) || options.observations < 3) {
    throw new Error('--observations must be an integer of at least 3')
  }
  if (!Number.isInteger(options.interval) || options.interval < 1 || options.interval > 600) {
    throw new Error('--interval must be an integer between 1 and 600')
  }
  return options
}

function stateSummary(snapshot) {
  return {
    step: snapshot.step,
    physics_frames: snapshot.physics_frames,
    player_position: snapshot.player_position,
    player_velocity: snapshot.player_velocity,
    grounded: snapshot.grounded,
    plate_pressed: snapshot.plate_pressed,
    gate_open: snapshot.gate_open,
    gate_collision_enabled: snapshot.gate_collision_enabled,
    beacon_state: snapshot.beacon_state,
    goal_reached: snapshot.goal_reached,
    feedback: snapshot.feedback,
    prompt: snapshot.prompt,
    interaction_count: snapshot.interaction_count,
    hash: snapshot.hash,
    outcome_hash: snapshot.outcome_hash,
  }
}

function distance3(a, b) {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}

/**
 * Collect one observation: advance the running game, pause for a fresh frame,
 * capture it, and read the structured state that goes with it.
 */
async function collectObservation(session, { index, frames, input, runId, outDir }) {
  const advance = await session.advancePhysics({ frames, input })
  await session.pause()
  const capture = await session.captureFrame({
    path: `res://artifacts/phase13-live-${String(index).padStart(3, '0')}.png`,
    scenario: `phase 13 live observation ${index}`,
    runId,
    metadata: { stage: 'phase13-a', index, frames, input },
  })
  const observation = await session.observe({
    targets: OBSERVATION_TARGETS,
    properties: STATE_PROPERTIES,
    descendants: 0,
    sinceTick: 0,
  })
  const snapshot = await session.snapshot()
  const evidence = copyCaptureFile(outDir, path.join('frames', `frame-${String(index).padStart(3, '0')}.png`), capture)

  const observedPlayer = observation.nodes.find((node) => node.path === '/root/Main/Player')
  const observedMain = observation.nodes.find((node) => node.path === '/root/Main')
  return {
    index,
    captured_at: capture.captured_at,
    capture_duration_ms: capture.duration_ms,
    engine_tick: capture.tick,
    simulation_step: capture.simulation_step,
    physics_frames_before: capture.physics_frames_before,
    physics_frames_after: capture.physics_frames_after,
    sim_time_seconds: capture.sim_time_seconds,
    paused_during_capture: capture.paused,
    advance: { frames: advance.frames, duration_ms: advance.duration_ms },
    screenshot: evidence,
    state: stateSummary(snapshot),
    observation: {
      engine_tick: observation.runtime.tick,
      node_count: observation.nodes.length,
      event_count: observation.events.count,
      event_types: [...new Set(observation.events.items.map((event) => event.type))],
      player_world_origin: observedPlayer ? observedPlayer.global_transform.origin : null,
      main_properties: observedMain ? observedMain.properties.values : null,
    },
  }
}

/**
 * Detect a stale or reused frame. A fresh observation must have a new
 * screenshot hash and a forward-moving tick.
 */
function checkFreshness(records) {
  const stale = []
  for (let i = 1; i < records.length; i++) {
    const previous = records[i - 1]
    const current = records[i]
    if (current.screenshot.sha256 === previous.screenshot.sha256) {
      stale.push({
        index: current.index,
        reason: 'screenshot hash is identical to the previous frame',
        sha256: current.screenshot.sha256,
      })
    }
    if (current.engine_tick <= previous.engine_tick) {
      stale.push({
        index: current.index,
        reason: 'engine tick did not advance',
        previous_tick: previous.engine_tick,
        engine_tick: current.engine_tick,
      })
    }
    if (current.simulation_step <= previous.simulation_step) {
      stale.push({
        index: current.index,
        reason: 'simulation step did not advance',
        previous_step: previous.simulation_step,
        simulation_step: current.simulation_step,
      })
    }
  }
  const hashes = new Set(records.map((record) => record.screenshot.sha256))
  return {
    unique_screenshot_hashes: hashes.size,
    total_frames: records.length,
    all_frames_distinct: hashes.size === records.length,
    stale_suspects: stale,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const outDir = resolveOutputDir({
    outDir: options.outDir,
    runner: options.runner,
    stamp: new Date().toISOString().replace(/[:.]/g, '-'),
  })
  const runId = `phase13-${crypto.randomUUID()}`
  const session = new HarnessSession({ project: PROJECT, headless: false })
  const report = {
    operation: 'phase13_live_observation_and_action',
    ok: false,
    run_id: runId,
    project: PROJECT,
    windowed: true,
    output_dir: outDir,
    started_at: new Date().toISOString(),
    finished_at: null,
    options: { observations: options.observations, interval: options.interval },
    godot: null,
    stage_a: null,
    stage_b: null,
    stop: null,
    error: null,
  }

  try {
    const started = await session.startProject()
    assert.equal(started.ok, true)
    report.godot = started.ping.godot
    report.pid = started.pid
    report.bridge_port = started.port
    report.renderer = session.logTail(20).stdout.find((line) => line.includes('Vulkan')) || null
    await session.pause()
    await session.reset()

    // ---- Stage A: fresh live observations while the game runs ----
    const records = []
    for (let index = 0; index < options.observations; index++) {
      records.push(
        await collectObservation(session, {
          index,
          frames: options.interval,
          input: idleInput({ forward: index === 0 ? 0 : 1 }),
          runId,
          outDir,
        }),
      )
    }
    const freshness = checkFreshness(records)
    const movement = distance3(
      records[0].state.player_position,
      records[records.length - 1].state.player_position,
    )
    report.stage_a = {
      observations: records.length,
      freshness,
      first_state: records[0].state,
      last_state: records[records.length - 1].state,
      player_travelled_metres: movement,
      runtime_change_observed: movement > 0.01,
      events_seen: [
        ...new Set(records.flatMap((record) => record.observation.event_types)),
      ],
    }
    writeJsonFile(outDir, 'observations.json', records)

    // ---- Stage B: controlled action, verified by resulting state ----
    await session.pause()
    await session.reset()
    await session.advancePhysics({ frames: 3, input: idleInput() })
    await session.pause()

    const before = await session.snapshot()
    const beforeCapture = await session.captureFrame({
      path: 'res://artifacts/phase13-action-before.png',
      scenario: 'phase 13 action: state before moving',
      runId,
      metadata: { stage: 'phase13-b', checkpoint: 'before' },
    })
    const beforeEvidence = copyCaptureFile(outDir, 'action-before.png', beforeCapture)

    // Action 1: bounded forward movement.
    const moveFrames = 45
    const advance = await session.advancePhysics({
      frames: moveFrames,
      input: idleInput({ forward: 1 }),
    })
    await session.pause()
    const after = await session.snapshot()
    const afterCapture = await session.captureFrame({
      path: 'res://artifacts/phase13-action-after.png',
      scenario: 'phase 13 action: state after moving forward',
      runId,
      metadata: { stage: 'phase13-b', checkpoint: 'after' },
    })
    const afterEvidence = copyCaptureFile(outDir, 'action-after.png', afterCapture)

    const expectedDistance = (PLAYER_SPEED * moveFrames) / PHYSICS_HZ
    const actualDistance = distance3(before.player_position, after.player_position)
    const movedTowardsNegativeZ = after.player_position[2] < before.player_position[2]
    const actionVerified =
      movedTowardsNegativeZ &&
      actualDistance > expectedDistance * 0.5 &&
      actualDistance <= expectedDistance * 1.5 &&
      after.player_position[1] > 0.5 // the player did not fall through the floor

    // Action 2: the fixture's own bounded action, verified by its counter.
    const interactBefore = after.interaction_count
    await session.advancePhysics({
      frames: 2,
      input: idleInput({ actions: { interact: true } }),
    })
    await session.pause()
    const afterInteract = await session.snapshot()

    report.stage_b = {
      action_1_move_forward: {
        input: { forward: 1 },
        frames: moveFrames,
        advance_duration_ms: advance.duration_ms,
        before: {
          state: stateSummary(before),
          screenshot: beforeEvidence,
          captured_at: beforeCapture.captured_at,
          engine_tick: beforeCapture.tick,
        },
        after: {
          state: stateSummary(after),
          screenshot: afterEvidence,
          captured_at: afterCapture.captured_at,
          engine_tick: afterCapture.tick,
        },
        expected_distance_metres: expectedDistance,
        actual_distance_metres: actualDistance,
        distance_ratio: actualDistance / expectedDistance,
        moved_towards_negative_z: movedTowardsNegativeZ,
        verified_by_state: actionVerified,
      },
      action_2_interact: {
        input: { actions: { interact: true } },
        interaction_count_before: interactBefore,
        interaction_count_after: afterInteract.interaction_count,
        verified_by_state: afterInteract.interaction_count === interactBefore + 1,
      },
    }
    writeJsonFile(outDir, 'action-results.json', report.stage_b)

    const manifest = {
      run_id: runId,
      project: PROJECT,
      windowed: true,
      output_dir: outDir,
      started_at: report.started_at,
      finished_at: new Date().toISOString(),
      frames: records.map((record) => ({
        index: record.index,
        file: record.screenshot.path,
        sha256: record.screenshot.sha256,
        captured_at: record.captured_at,
        engine_tick: record.engine_tick,
        simulation_step: record.simulation_step,
        physics_frames_before: record.physics_frames_before,
        physics_frames_after: record.physics_frames_after,
        sim_time_seconds: record.sim_time_seconds,
        player_position: record.state.player_position,
        plate_pressed: record.state.plate_pressed,
        gate_open: record.state.gate_open,
        beacon_state: record.state.beacon_state,
        feedback: record.state.feedback,
        state_hash: record.state.hash,
        event_count: record.observation.event_count,
        event_types: record.observation.event_types,
      })),
      action_frames: {
        before: {
          file: beforeEvidence.path,
          sha256: beforeEvidence.sha256,
          captured_at: beforeCapture.captured_at,
          engine_tick: beforeCapture.tick,
          player_position: before.player_position,
        },
        after: {
          file: afterEvidence.path,
          sha256: afterEvidence.sha256,
          captured_at: afterCapture.captured_at,
          engine_tick: afterCapture.tick,
          player_position: after.player_position,
        },
      },
    }
    writeJsonFile(outDir, 'manifest.json', manifest)

    const bridgeLogs = await session.bridgeLogs()
    report.bridge_events = bridgeLogs.events

    // Acceptance checks for this stage.
    assert.equal(records.length, options.observations)
    assert.ok(records.length >= 3, 'at least three observations are required')
    assert.equal(freshness.stale_suspects.length, 0, 'no observation may be stale')
    assert.equal(freshness.all_frames_distinct, true, 'every frame must be distinct')
    assert.ok(report.stage_a.runtime_change_observed, 'the sequence must show runtime change')
    assert.ok(actionVerified, 'the movement action must be verified by the resulting state')
    assert.equal(report.stage_b.action_2_interact.verified_by_state, true)

    report.ok = true
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          output_dir: outDir,
          observations: records.length,
          unique_frames: freshness.unique_screenshot_hashes,
          stale_suspects: freshness.stale_suspects.length,
          player_travelled_metres: Number(movement.toFixed(4)),
          move_verified: actionVerified,
          distance_ratio: Number((actualDistance / expectedDistance).toFixed(4)),
          interact_verified: report.stage_b.action_2_interact.verified_by_state,
        },
        null,
        2,
      ),
    )
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    console.error(`LIVE OBSERVE FAILED: ${report.error}`)
    process.exitCode = 1
  } finally {
    report.finished_at = new Date().toISOString()
    report.stop = await session.stop()
    writeJsonFile(outDir, 'report.json', report)
  }
}

await main()
