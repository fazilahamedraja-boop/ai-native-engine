import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession } from './harness.mjs'

const PROJECT = 'fixtures/observation'
const DOOR_PROJECT = 'fixtures/door'
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase10', 'stage-c')
const OBSERVATION_TARGETS = [
  '/root/Main',
  '/root/Main/Player',
  '/root/Main/Plate',
  '/root/Main/Gate',
  '/root/Main/Beacon',
  '/root/Main/Crate',
  '/root/Main/Humanoid',
  '/root/Main/Humanoid/ProbeSkeleton',
]
const STATE_PROPERTIES = [
  'plate_pressed',
  'gate_open',
  'gate_collision_enabled',
  'beacon_state',
]
const scenarioLog = []

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
  return { path: name, bytes: fs.statSync(target).size, sha256: hash }
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
    humanoid_mesh_count: snapshot.humanoid_mesh_count,
    events_count: snapshot.events_count,
    last_event_type: snapshot.last_event_type,
    hash: snapshot.hash,
  }
}

function stateMatchesObservation(snapshot, observation, screenshot) {
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
      screenshot && Number.isFinite(screenshot.tick)
        ? screenshot.tick - snapshot.physics_frames
        : null,
    note:
      'Paused state comparison; engine ticks can advance during sampling and screenshot rendering without changing the paused simulation step.',
  }
}

function nodeByPath(observation, nodePath) {
  return observation.nodes.find((node) => node.path === nodePath)
}

function flattenNodes(node, result = []) {
  result.push(node)
  for (const child of Array.isArray(node?.children) ? node.children : []) {
    flattenNodes(child, result)
  }
  return result
}

async function loggedReset(session) {
  const result = await session.reset()
  scenarioLog.push({ type: 'reset', snapshot_step: result.snapshot.step })
  return result
}

async function loggedAdvance(session, frames, overrides = {}) {
  const input = withInput(overrides)
  const result = await session.advancePhysics({ frames, input })
  scenarioLog.push({
    type: 'advance_physics',
    frames,
    input,
    final_step: result.final.step,
    final_tick: result.final.physics_frames,
  })
  return result
}

async function observeHumanoid(session, runId) {
  const humanoid = await session.observe({
    targets: ['/root/Main/Humanoid'],
    descendants: 3,
  })
  const skeleton = await session.observe({
    targets: ['/root/Main/Humanoid/ProbeSkeleton'],
  })
  const modelObservation = humanoid.nodes[0]
  const model = modelObservation.children.find((node) => node.name === 'Model')
  const characterRoot = model.children.find((node) => node.name === 'character_root')
  const skeletonObservation = skeleton.nodes[0]
  const summary = {
    model_path: modelObservation.path,
    model_part_count: characterRoot.children.length,
    mesh_instance_count: flattenNodes(characterRoot).filter(
      (node) => node.class === 'MeshInstance3D',
    ).length,
    probe_marker_present: flattenNodes(modelObservation).some((node) => node.name === 'Marker'),
    skeleton: {
      path: skeletonObservation.path,
      bone_count: skeletonObservation.skeleton.bone_count,
      bones: skeletonObservation.skeleton.bones.map((bone) => bone.name),
      global_transform: skeletonObservation.skeleton.global_transform,
      bone_source: skeletonObservation.skeleton.bones[0].global_pose.source,
      bone_space: skeletonObservation.skeleton.bones[0].global_pose.space,
      derived_world_source: skeletonObservation.skeleton.bones[0].derived_world_pose.source,
    },
  }
  const evidence = {
    run_id: `${runId}-humanoid`,
    humanoid,
    skeleton,
    summary,
    note:
      'glTF meshes are inspected separately from the fixture probe skeleton; the imported glTF did not expose a Skeleton3D in this fixture.',
  }
  return {
    evidence: writeJson('stage-c-humanoid.json', evidence),
    summary,
  }
}

async function runDoorReuse(runId) {
  const temporaryProject = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-stage-c-door-'))
  const source = path.resolve(HARNESS_ROOT, 'fixtures', 'door')
  const scenePath = path.join(source, 'main.tscn')
  const worldPath = path.join(source, 'scripts', 'door_world.gd')
  const playerPath = path.join(source, 'scripts', 'door_player.gd')
  const bridgePath = path.resolve(HARNESS_ROOT, 'fixtures', 'observation', 'harness', 'bridge.gd')
  const before = {
    scene: sha256(scenePath),
    world: sha256(worldPath),
    player: sha256(playerPath),
  }
  fs.cpSync(source, temporaryProject, { recursive: true })
  fs.copyFileSync(bridgePath, path.join(temporaryProject, 'harness', 'bridge.gd'))
  const unchanged = {
    scene: sha256(scenePath) === before.scene,
    world: sha256(worldPath) === before.world,
    player: sha256(playerPath) === before.player,
  }
  assert.deepEqual(unchanged, { scene: true, world: true, player: true })

  const session = new HarnessSession({
    project: temporaryProject,
    headless: true,
    allowOutsideRoot: true,
  })
  try {
    const started = await session.start()
    assert.equal(started.ok, true)
    await session.pause()
    const sceneObservation = await session.observe({
      targets: ['/root/Main'],
      properties: ['key_available', 'feedback'],
    })
    const doorObservation = await session.observe({
      targets: ['/root/Main/Door'],
      properties: ['locked', 'open', 'collision_enabled', 'open_count'],
      descendants: 1,
    })
    const playerObservation = await session.observe({
      targets: ['/root/Main/Player'],
    })
    const main = sceneObservation.nodes[0]
    const door = doorObservation.nodes[0]
    const player = playerObservation.nodes[0]
    assert.equal(main.properties.values.key_available, true)
    assert.equal(door.properties.values.locked, true)
    assert.equal(door.properties.values.open, false)
    assert.equal(player.character.source, 'measured')
    const evidence = {
      run_id: `${runId}-door-reuse`,
      project_source: DOOR_PROJECT,
      bridge_source: 'fixtures/observation/harness/bridge.gd',
      bridge_replaced_in_temporary_copy_only: true,
      temporary_project: true,
      source_file_sha256: before,
      unchanged,
      scene: {
        properties: main.properties,
        global_transform: main.global_transform,
      },
      door: {
        properties: door.properties,
        global_transform: door.global_transform,
        collision_shapes: door.collision_shapes,
      },
      player: {
        character: player.character,
        global_transform: player.global_transform,
        collision_shapes: player.collision_shapes,
      },
      note:
        'The door scene and scripts were copied unchanged; only the temporary copy bridge implemented observe.',
    }
    return {
      evidence: writeJson('stage-c-door-reuse.json', evidence),
      summary: {
        key_available: main.properties.values.key_available,
        door_locked: door.properties.values.locked,
        door_open: door.properties.values.open,
        player_on_floor: player.character.is_on_floor,
        unchanged,
      },
    }
  } finally {
    await session.stop()
    fs.rmSync(temporaryProject, { recursive: true, force: true })
  }
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const runId = `stage-c-${crypto.randomUUID()}`
  const startedAt = new Date().toISOString()
  const session = new HarnessSession({ project: PROJECT, headless: false })
  const manifest = {
    operation: 'stage_c_observation_evidence',
    ok: false,
    run_id: runId,
    project: PROJECT,
    headless: false,
    started_at: startedAt,
    finished_at: null,
    requirements: {
      windowed: true,
      structured_observation: 'generic observe command through the project bridge',
      timeline: 'fixed physics advances with bounded samples and de-duplicated events',
      distinction: 'measured values, derived values, and unavailable event sources are explicit',
    },
    godot: null,
    captures: {},
    observations: {},
    timeline: null,
    humanoid: null,
    door_reuse: null,
    scenario: {
      description:
        'reset; capture closed state; inspect humanoid; reset; sample 90 fixed ticks forward; capture plate/gate open state; reuse observe on a copied door scene',
      steps: [],
    },
    stop: null,
    error: null,
  }

  try {
    const started = await session.startProject()
    assert.equal(started.ok, true)
    manifest.godot = started.ping.godot
    manifest.pid = started.pid
    manifest.port = started.port
    await session.pause()

    await loggedReset(session)
    const initialObservation = await session.observe({
      targets: OBSERVATION_TARGETS,
      properties: STATE_PROPERTIES,
      descendants: 1,
      sinceTick: 0,
    })
    const initialCapture = await session.captureFrame({
      path: 'res://artifacts/stage-c-initial.png',
      scenario: 'observation fixture closed gate before approach',
      runId,
      metadata: { fixture: 'observation', stage: 'phase10-c', state: 'initial' },
    })
    assert.equal(initialCapture.screenshot.width, 1280)
    assert.equal(initialCapture.screenshot.height, 720)
    assert.equal(initialCapture.state_before.plate_pressed, false)
    assert.equal(initialCapture.state_before.gate_open, false)
    manifest.observations.initial = {
      ...writeJson('stage-c-initial.json', initialObservation),
      state: stateSummary(initialCapture.state_before),
      state_match: stateMatchesObservation(
        initialCapture.state_before,
        initialObservation,
        initialCapture.screenshot,
      ),
      node_count: initialObservation.nodes.length,
      event_count: initialObservation.events.count,
    }
    manifest.captures.initial = {
      capture: {
        run_id: initialCapture.run_id,
        scenario: initialCapture.scenario,
        captured_at: initialCapture.captured_at,
        tick: initialCapture.tick,
        sim_time_seconds: initialCapture.sim_time_seconds,
        screenshot: initialCapture.screenshot,
        state: stateSummary(initialCapture.state_before),
      },
      evidence: copyScreenshot(initialCapture, 'stage-c-initial.png'),
    }
    scenarioLog.push({
      type: 'capture_frame',
      run_id: initialCapture.run_id,
      tick: initialCapture.tick,
      checkpoint: 'initial',
    })

    const humanoid = await observeHumanoid(session, runId)
    manifest.humanoid = {
      evidence: humanoid.evidence,
      summary: humanoid.summary,
    }

    await loggedReset(session)
    const timeline = await session.observeTimeline({
      frames: 90,
      everyFrames: 30,
      input: withInput({ forward: 1 }),
      targets: ['/root/Main'],
      properties: STATE_PROPERTIES,
      sinceTick: 0,
      scenario: 'approach the pressure plate for ninety fixed physics ticks',
      runId: `${runId}-timeline`,
    })
    assert.equal(timeline.sample_count, 4)
    assert.equal(timeline.final.nodes[0].properties.values.plate_pressed, true)
    assert.equal(timeline.final.nodes[0].properties.values.gate_open, true)
    assert.equal(timeline.final.nodes[0].properties.values.beacon_state, 'green')
    manifest.timeline = {
      evidence: writeJson('stage-c-timeline.json', timeline),
      run_id: timeline.run_id,
      scenario: timeline.scenario,
      frames: timeline.frames,
      every_frames: timeline.every_frames,
      sample_count: timeline.sample_count,
      event_count: timeline.event_count,
      event_types: [...new Set(timeline.events.map((event) => event.type))],
      event_timing: timeline.events.map((event) => ({
        sequence: event.sequence,
        type: event.type,
        engine_tick: event.tick,
        simulation_step: event.simulation_step,
        simulation_time_seconds: event.simulation_time_seconds,
        engine_time_seconds: event.sim_time_seconds,
      })),
      timing: timeline.timing,
      samples: timeline.samples.map((sample) => ({
        index: sample.index,
        tick: sample.tick,
        engine_tick: sample.engine_tick,
        sim_time_seconds: sample.sim_time_seconds,
        simulation_step: sample.simulation_step,
        simulation_time_seconds: sample.simulation_time_seconds,
        frames_advanced: sample.frames_advanced,
        state: sample.observation.nodes[0].properties.values,
      })),
    }
    scenarioLog.push({
      type: 'observe_timeline',
      run_id: timeline.run_id,
      frames: timeline.frames,
      every_frames: timeline.every_frames,
      sample_count: timeline.sample_count,
    })

    const openCapture = await session.captureFrame({
      path: 'res://artifacts/stage-c-open.png',
      scenario: 'observation fixture plate pressed and gate open',
      runId,
      metadata: { fixture: 'observation', stage: 'phase10-c', state: 'plate-open' },
    })
    assert.equal(openCapture.state_before.plate_pressed, true)
    assert.equal(openCapture.state_before.gate_open, true)
    assert.equal(openCapture.screenshot.width, 1280)
    assert.equal(openCapture.screenshot.height, 720)
    const openObservation = await session.observe({
      targets: OBSERVATION_TARGETS,
      properties: STATE_PROPERTIES,
      descendants: 1,
      sinceTick: 0,
    })
    manifest.observations.open = {
      ...writeJson('stage-c-open.json', openObservation),
      state: stateSummary(openCapture.state_before),
      state_match: stateMatchesObservation(
        openCapture.state_before,
        openObservation,
        openCapture.screenshot,
      ),
      node_count: openObservation.nodes.length,
      event_count: openObservation.events.count,
    }
    manifest.captures.open = {
      capture: {
        run_id: openCapture.run_id,
        scenario: openCapture.scenario,
        captured_at: openCapture.captured_at,
        tick: openCapture.tick,
        sim_time_seconds: openCapture.sim_time_seconds,
        screenshot: openCapture.screenshot,
        state: stateSummary(openCapture.state_before),
      },
      evidence: copyScreenshot(openCapture, 'stage-c-open.png'),
    }
    scenarioLog.push({
      type: 'capture_frame',
      run_id: openCapture.run_id,
      tick: openCapture.tick,
      checkpoint: 'plate-open',
    })

    manifest.door_reuse = await runDoorReuse(runId)
    manifest.ok = true
  } catch (error) {
    manifest.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
    throw error
  } finally {
    try {
      manifest.stop = await session.stopProject()
    } finally {
      manifest.finished_at = new Date().toISOString()
      manifest.scenario.steps = scenarioLog
      fs.writeFileSync(
        path.join(EVIDENCE, 'stage-c-observations.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
