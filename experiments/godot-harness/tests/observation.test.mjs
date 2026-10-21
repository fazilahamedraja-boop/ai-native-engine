import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { HarnessSession } from '../controller/harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const PROJECT = 'fixtures/observation'
const DOOR_PROJECT = 'fixtures/door'
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

function childrenOf(node) {
  return Array.isArray(node?.children) ? node.children : []
}

function flatten(node, result = []) {
  result.push(node)
  for (const child of childrenOf(node)) flatten(child, result)
  return result
}

function byPath(observation) {
  return new Map(observation.nodes.map((node) => [node.path, node]))
}

test('observation validates paths, properties, bounds, and scenarios before a bridge call', async () => {
  const session = new HarnessSession({ project: PROJECT, headless: true })
  await assert.rejects(
    () => session.observe({ targets: ['Main'] }),
    /absolute \/root\/\.\.\. node paths/,
  )
  await assert.rejects(
    () => session.observe({ targets: ['/root/Main/../Gate'] }),
    /absolute \/root\/\.\.\. node paths/,
  )
  await assert.rejects(
    () => session.observe({ targets: ['/root/Main'], properties: ['bad-name'] }),
    /properties must contain simple identifiers/,
  )
  await assert.rejects(
    () => session.observe({ targets: ['/root/Main'], descendants: 4 }),
    /descendants must be an integer between 0 and 3/,
  )
  await assert.rejects(
    () => session.observeTimeline({ frames: 120, everyFrames: 1 }),
    /more than 60 samples/,
  )
  await assert.rejects(
    () => session.observeTimeline({ frames: 1, everyFrames: 1, input: { forward: 2 } }),
    /forward/,
  )
  await assert.rejects(
    () => session.observeTimeline({ frames: 1, everyFrames: 1, scenario: '   ' }),
    /scenario/,
  )
  await assert.rejects(
    () => session.observeTimeline({ frames: 1, everyFrames: 1, targets: ['../../Main'] }),
    /absolute \/root\/\.\.\. node paths/,
  )
})

test('observe reports measured runtime, character, collision, animation, and event data', async () => {
  const session = new HarnessSession({ project: PROJECT, headless: true })
  const started = await session.start()
  try {
    assert.equal(started.ok, true)
    await session.pause()
    await session.reset()
    const advance = await session.advancePhysics({ frames: 85, input: { forward: 1.0 } })
    assert.equal(advance.frames, 85)
    assert.equal(advance.final.plate_pressed, true)
    assert.equal(advance.final.gate_open, true)

    const observation = await session.observe({
      targets: OBSERVATION_TARGETS,
      properties: ['plate_pressed', 'gate_open', 'gate_collision_enabled', 'beacon_state'],
      descendants: 1,
      sinceTick: 0,
    })
    assert.equal(observation.runtime.source, 'measured')
    assert.equal(observation.runtime.sim_time_seconds_source, 'derived')
    assert.equal(observation.runtime.paused, true)
    assert.equal(observation.runtime.physics_ticks_per_second, 60)
    assert.equal(observation.runtime.units.position, 'm')
    assert.equal(observation.runtime.units.velocity, 'm/s')
    assert.match(observation.runtime.captured_at, /^\d{4}-\d{2}-\d{2}T/)
    assert.ok(observation.runtime.tick >= 85)
    assert.equal(observation.nodes.length, OBSERVATION_TARGETS.length)

    const nodes = byPath(observation)
    const world = nodes.get('/root/Main')
    assert.deepEqual(world.properties.values, {
      plate_pressed: true,
      gate_open: true,
      gate_collision_enabled: false,
      beacon_state: 'green',
    })
    assert.deepEqual(world.properties.missing, [])
    assert.equal(world.global_transform.source, 'measured')
    assert.equal(world.global_transform.space, 'world')

    const player = nodes.get('/root/Main/Player')
    assert.equal(player.class, 'CharacterBody3D')
    assert.equal(player.character.source, 'measured')
    assert.equal(player.character.is_on_floor, true)
    assert.ok(player.character.velocity[2] < -3.9)
    assert.equal(player.character.derived.horizontal_speed, 4)
    assert.equal(player.character.slide_collisions[0].collider, '/root/Main/Ground')
    assert.equal(player.collision_shapes.length, 1)
    assert.equal(player.collision_shapes[0].shape_class, 'CapsuleShape3D')
    assert.ok(Math.abs(player.collision_shapes[0].shape.radius - 0.4) < 0.001)

    const gate = nodes.get('/root/Main/Gate')
    assert.ok(gate.global_transform.origin[1] > 4)
    assert.equal(gate.collision_shapes.length, 1)
    assert.equal(gate.collision_shapes[0].disabled, true)
    assert.equal(gate.collision_shapes[0].shape_class, 'BoxShape3D')

    const beacon = nodes.get('/root/Main/Beacon')
    assert.equal(beacon.animations.length, 1)
    assert.equal(beacon.animations[0].current_animation, 'pulse')
    assert.equal(beacon.animations[0].is_playing, true)
    assert.equal(beacon.animations[0].source, 'measured')

    const crate = nodes.get('/root/Main/Crate')
    assert.equal(crate.class, 'RigidBody3D')
    assert.equal(crate.rigid_body.source, 'measured')
    assert.equal(crate.rigid_body.sleeping, true)
    assert.equal(crate.rigid_body.mass, 1)
    assert.ok(Math.abs(crate.global_transform.origin[1] - 0.3472) < 0.01)

    const eventTypes = observation.events.items.map((event) => event.type)
    assert.equal(observation.events.source, 'fixture_recorded')
    assert.ok(eventTypes.includes('plate_entered'))
    assert.ok(eventTypes.includes('gate_open'))
    assert.ok(eventTypes.includes('crate_collision_start'))
    let lastSequence = 0
    let lastTick = -1
    for (const event of observation.events.items) {
      assert.ok(event.sequence > lastSequence)
      assert.ok(event.tick >= lastTick)
      assert.equal(event.source, 'fixture_recorded')
      assert.ok(Number.isFinite(event.simulation_step))
      assert.ok(Number.isFinite(event.simulation_time_seconds))
      lastSequence = event.sequence
      lastTick = event.tick
    }
  } finally {
    await session.stop()
  }
})

test('observe inspects the humanoid model and skeleton with explicit transform spaces', async () => {
  const session = new HarnessSession({ project: PROJECT, headless: true })
  const started = await session.start()
  try {
    assert.equal(started.ok, true)
    await session.pause()
    await session.reset()

    const modelObservation = await session.observe({
      targets: ['/root/Main/Humanoid'],
      descendants: 3,
    })
    const humanoid = modelObservation.nodes[0]
    const model = childrenOf(humanoid).find((node) => node.name === 'Model')
    assert.ok(model)
    const characterRoot = childrenOf(model).find((node) => node.name === 'character_root')
    assert.ok(characterRoot)
    assert.equal(characterRoot.children.length, 25)
    const partNames = characterRoot.children.map((node) => node.name)
    for (const required of ['head', 'chest', 'hand_l', 'hand_r', 'thigh_l', 'shin_r']) {
      assert.ok(partNames.includes(required), `missing humanoid part ${required}`)
    }
    const meshParts = flatten(characterRoot).filter((node) => node.class === 'MeshInstance3D')
    assert.equal(meshParts.length, 22)
    assert.equal(humanoid.descendant_truncated, false)

    const skeletonObservation = await session.observe({
      targets: ['/root/Main/Humanoid/ProbeSkeleton'],
    })
    const skeletonNode = skeletonObservation.nodes[0]
    assert.equal(skeletonNode.class, 'Skeleton3D')
    assert.equal(skeletonNode.skeleton.source, 'measured')
    assert.equal(skeletonNode.skeleton.bone_count, 4)
    assert.deepEqual(
      skeletonNode.skeleton.bones.map((bone) => bone.name),
      ['root', 'spine', 'chest', 'head'],
    )
    for (const bone of skeletonNode.skeleton.bones) {
      assert.equal(bone.global_pose.space, 'skeleton')
      assert.equal(bone.global_pose.source, 'measured')
      assert.equal(bone.derived_world_pose.space, 'world')
      assert.equal(bone.derived_world_pose.source, 'derived')
    }
    const head = skeletonNode.skeleton.bones.find((bone) => bone.name === 'head')
    assert.ok(Math.abs(head.derived_world_pose.origin[1] - 1.1) < 0.01)
    assert.equal(skeletonNode.skeleton.global_transform.space, 'world')
  } finally {
    await session.stop()
  }
})

test('observeTimeline samples fixed physics advances and de-duplicates events', async () => {
  const session = new HarnessSession({ project: PROJECT, headless: true })
  const started = await session.start()
  try {
    assert.equal(started.ok, true)
    await session.pause()
    await session.reset()
    const timeline = await session.observeTimeline({
      frames: 90,
      everyFrames: 30,
      input: { forward: 1.0 },
      targets: ['/root/Main'],
      properties: ['plate_pressed', 'gate_open', 'beacon_state'],
      sinceTick: 0,
      scenario: 'stage-c timeline test',
      runId: 'stage-c-timeline-test',
    })
    assert.equal(timeline.operation, 'observe_timeline')
    assert.equal(timeline.ok, true)
    assert.equal(timeline.run_id, 'stage-c-timeline-test')
    assert.equal(timeline.scenario, 'stage-c timeline test')
    assert.equal(timeline.frames, 90)
    assert.equal(timeline.every_frames, 30)
    assert.equal(timeline.sample_count, 4)
    assert.equal(timeline.samples.length, 4)
    assert.equal(timeline.samples.reduce((sum, sample) => sum + sample.frames_advanced, 0), 90)
    assert.deepEqual(timeline.samples.map((sample) => sample.frames_advanced), [0, 30, 30, 30])
    assert.deepEqual(
      timeline.samples.map((sample) => sample.simulation_step),
      [null, 30, 60, 90],
    )
    assert.deepEqual(
      timeline.samples.slice(1).map((sample) => sample.simulation_time_seconds),
      [0.5, 1, 1.5],
    )
    assert.match(timeline.timing.engine_tick, /rendering\/pause overhead/)
    for (let index = 1; index < timeline.samples.length; index += 1) {
      assert.ok(timeline.samples[index].tick > timeline.samples[index - 1].tick)
      assert.ok(
        timeline.samples[index].simulation_step >
          timeline.samples[index - 1].simulation_step,
      )
    }
    const finalState = timeline.final.nodes[0].properties.values
    assert.equal(finalState.plate_pressed, true)
    assert.equal(finalState.gate_open, true)
    assert.equal(finalState.beacon_state, 'green')
    assert.equal(timeline.final, timeline.samples.at(-1).observation)
    const eventTypes = timeline.events.map((event) => event.type)
    assert.ok(eventTypes.includes('plate_entered'))
    assert.ok(eventTypes.includes('gate_open'))
    const sequences = timeline.events.map((event) => event.sequence)
    assert.equal(new Set(sequences).size, sequences.length)
    assert.equal(timeline.event_count, timeline.events.length)
    const ping = await session.ping()
    assert.equal(ping.paused, true)
  } finally {
    await session.stop()
  }
})

test('observe reuses an unmodified door scene through the generic observation bridge', async () => {
  const temporaryProject = fs.mkdtempSync(path.join(os.tmpdir(), 'phase10-door-observe-'))
  const doorSource = path.resolve(ROOT, DOOR_PROJECT)
  const doorScene = path.join(doorSource, 'main.tscn')
  const doorWorld = path.join(doorSource, 'scripts', 'door_world.gd')
  const beforeScene = fs.readFileSync(doorScene)
  const beforeWorld = fs.readFileSync(doorWorld)
  fs.cpSync(doorSource, temporaryProject, { recursive: true })
  fs.copyFileSync(
    path.resolve(ROOT, PROJECT, 'harness', 'bridge.gd'),
    path.join(temporaryProject, 'harness', 'bridge.gd'),
  )
  assert.deepEqual(fs.readFileSync(doorScene), beforeScene)
  assert.deepEqual(fs.readFileSync(doorWorld), beforeWorld)
  assert.deepEqual(fs.readFileSync(path.join(temporaryProject, 'main.tscn')), beforeScene)
  assert.deepEqual(
    fs.readFileSync(path.join(temporaryProject, 'scripts', 'door_world.gd')),
    beforeWorld,
  )

  const session = new HarnessSession({
    project: temporaryProject,
    headless: true,
    allowOutsideRoot: true,
  })
  let started = null
  try {
    started = await session.start()
    assert.equal(started.ok, true)
    await session.pause()
    const sceneObservation = await session.observe({
      targets: ['/root/Main'],
      properties: ['key_available', 'feedback'],
    })
    const main = sceneObservation.nodes[0]
    assert.equal(main.properties.values.key_available, true)
    assert.equal(main.properties.values.feedback, 'LOCKED - FIND THE KEY')

    const doorObservation = await session.observe({
      targets: ['/root/Main/Door'],
      properties: ['locked', 'open', 'collision_enabled', 'open_count'],
      descendants: 1,
    })
    const door = doorObservation.nodes[0]
    assert.equal(door.properties.values.locked, true)
    assert.equal(door.properties.values.open, false)
    assert.equal(door.properties.values.collision_enabled, true)
    assert.equal(door.properties.values.open_count, 0)
    assert.equal(door.global_transform.space, 'world')
    assert.equal(door.collision_shapes.length, 1)
    assert.equal(door.collision_shapes[0].shape_class, 'BoxShape3D')
    assert.equal(door.collision_shapes[0].disabled, false)

    const playerObservation = await session.observe({ targets: ['/root/Main/Player'] })
    const player = playerObservation.nodes[0]
    assert.equal(player.class, 'CharacterBody3D')
    assert.equal(player.character.is_on_floor, true)
    assert.equal(player.character.source, 'measured')
  } finally {
    if (started !== null) await session.stop()
    fs.rmSync(temporaryProject, { recursive: true, force: true })
  }
})
