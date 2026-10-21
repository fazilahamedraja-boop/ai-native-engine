import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

// Focused test for the read-only physics space query operation.
//
// The observation fixture is used as the known scene. It contains a Gate
// StaticBody3D with a BoxShape3D of size (4.0, 2.6, 0.3) whose world centre
// is (0, 1.30, -2.5), on the default collision layer 1.
//
// Known-target geometry used by these checks:
//   GATE_ORIGIN  = (0, 1.30, -2.5)  -> inside the gate collider
//   EMPTY_ORIGIN = (0, 50, 0)       -> empty space above the scene
//   GATE_FRONT_Z = -2.35             -> the gate's +Z face (centre -2.5, half
//                                       depth 0.15)

const PROJECT = 'fixtures/observation'
const GATE_ORIGIN = [0, 1.3, -2.5]
const EMPTY_ORIGIN = [0, 50, 0]
const GATE_FRONT_Z = -2.35
const GATE_PATH = '/root/Main/Gate'

async function withSession(run) {
  const session = new HarnessSession({ project: PROJECT, headless: true })
  try {
    await session.start()
    await session.pause()
    return await run(session)
  } finally {
    await session.stop()
  }
}

test('physics query validation rejects invalid input before a bridge call', async () => {
  const session = new HarnessSession({ project: PROJECT })
  await assert.rejects(() => session.physicsQuery({}), /shape_type must be a string/)
  await assert.rejects(
    () => session.physicsQuery({ shape_type: '' }),
    /shape_type is required/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 42 }),
    /shape_type must be a string/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'tetrahedron' }),
    /shape_type must be one of: box, sphere, capsule, ray/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'box', size: [1, 1] }),
    /size must be an array of three numbers/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'box', size: [1, 1, 0] }),
    /size components must be finite numbers greater than zero/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'sphere', radius: 0 }),
    /radius must be a finite number greater than zero/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'capsule', radius: 0.5, height: -1 }),
    /height must be a finite number greater than zero/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'box', transform: { origin: [0, 0] } }),
    /transform\.origin must be an array of three numbers/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'box', transform: { bogus: [0, 0, 0] } }),
    /Unknown transform key: bogus/,
  )
  await assert.rejects(
    () => session.physicsQuery({ shape_type: 'box', collisionMask: -1 }),
    /collisionMask must be a non-negative integer/,
  )
})

test('a box query finds the known gate collider and misses empty space', async () => {
  await withSession(async (session) => {
    const hit = await session.physicsQuery({
      shape_type: 'box',
      transform: { origin: GATE_ORIGIN },
      size: [1, 1, 1],
    })
    assert.equal(hit.shape_type, 'box')
    assert.equal(hit.source, 'derived')
    assert.equal(hit.results.length, 1)
    assert.equal(hit.results[0].collider, GATE_PATH)
    assert.equal(hit.results[0].collider_type, 'StaticBody3D')
    assert.equal(hit.results[0].shape_index, 0)
    assert.equal(hit.results[0].source, 'derived')
    assert.deepEqual(hit.transform.space, 'world')
    // Godot stores the transform as 32-bit floats, so compare with tolerance.
    assert.ok(Math.abs(hit.transform.origin[1] - GATE_ORIGIN[1]) < 0.001)
    assert.ok(Math.abs(hit.transform.origin[2] - GATE_ORIGIN[2]) < 0.001)

    const miss = await session.physicsQuery({
      shape_type: 'box',
      transform: { origin: EMPTY_ORIGIN },
      size: [1, 1, 1],
    })
    assert.deepEqual(miss.results, [])
  })
})

test('a sphere query finds the known gate collider and misses empty space', async () => {
  await withSession(async (session) => {
    const hit = await session.physicsQuery({
      shape_type: 'sphere',
      transform: { origin: GATE_ORIGIN },
      radius: 0.5,
    })
    assert.equal(hit.results.length, 1)
    assert.equal(hit.results[0].collider, GATE_PATH)
    assert.equal(hit.results[0].collider_type, 'StaticBody3D')

    const miss = await session.physicsQuery({
      shape_type: 'sphere',
      transform: { origin: EMPTY_ORIGIN },
      radius: 0.5,
    })
    assert.deepEqual(miss.results, [])
  })
})

test('a capsule query finds the known gate collider and misses empty space', async () => {
  await withSession(async (session) => {
    const hit = await session.physicsQuery({
      shape_type: 'capsule',
      transform: { origin: GATE_ORIGIN },
      radius: 0.4,
      height: 1.0,
    })
    assert.equal(hit.results.length, 1)
    assert.equal(hit.results[0].collider, GATE_PATH)
    assert.equal(hit.results[0].collider_type, 'StaticBody3D')

    const miss = await session.physicsQuery({
      shape_type: 'capsule',
      transform: { origin: EMPTY_ORIGIN },
      radius: 0.4,
      height: 1.0,
    })
    assert.deepEqual(miss.results, [])
  })
})

test('a ray query reports the contact point and normal on the known gate', async () => {
  await withSession(async (session) => {
    // A ray at y = 1.30 travelling in -Z meets the gate's +Z face.
    const hit = await session.physicsQuery({
      shape_type: 'ray',
      transform: { origin: [0, 1.3, 0], rotation_degrees: [0, 180, 0] },
    })
    assert.equal(hit.results.length, 1)
    assert.equal(hit.results[0].collider, GATE_PATH)
    assert.equal(hit.results[0].collider_type, 'StaticBody3D')
    assert.equal(hit.results[0].hit_point.length, 3)
    assert.equal(hit.results[0].hit_normal.length, 3)
    // The contact point is on the gate's front face, and the normal faces the ray.
    assert.ok(
      Math.abs(hit.results[0].hit_point[2] - GATE_FRONT_Z) < 0.01,
      `expected contact z near ${GATE_FRONT_Z}, got ${hit.results[0].hit_point[2]}`,
    )
    assert.ok(
      Math.abs(hit.results[0].hit_normal[2] - 1) < 0.01,
      `expected a +Z normal, got ${hit.results[0].hit_normal[2]}`,
    )

    // A ray fired straight up from empty space hits nothing.
    const miss = await session.physicsQuery({
      shape_type: 'ray',
      transform: { origin: EMPTY_ORIGIN, rotation_degrees: [0, 0, 0] },
    })
    assert.deepEqual(miss.results, [])
  })
})

test('a physics query honours the collision mask', async () => {
  await withSession(async (session) => {
    // The gate is on the default layer 1, so a mask of 2 cannot see it.
    const excluded = await session.physicsQuery({
      shape_type: 'box',
      transform: { origin: GATE_ORIGIN },
      size: [1, 1, 1],
      collisionMask: 2,
    })
    assert.deepEqual(excluded.results, [])
    assert.equal(excluded.collision_mask, 2)

    const included = await session.physicsQuery({
      shape_type: 'box',
      transform: { origin: GATE_ORIGIN },
      size: [1, 1, 1],
      collisionMask: 1,
    })
    assert.equal(included.results.length, 1)
    assert.equal(included.results[0].collider, GATE_PATH)
  })
})

test('a physics query does not mutate scene state', async () => {
  await withSession(async (session) => {
    const before = await session.snapshot()
    const beforeObservation = await session.observe({
      targets: ['/root/Main/Gate', '/root/Main/Ground'],
    })

    await session.physicsQuery({
      shape_type: 'box',
      transform: { origin: GATE_ORIGIN },
      size: [1, 1, 1],
    })
    await session.physicsQuery({
      shape_type: 'ray',
      transform: { origin: [0, 1.3, 0], rotation_degrees: [0, 180, 0] },
    })

    const after = await session.snapshot()
    const afterObservation = await session.observe({
      targets: ['/root/Main/Gate', '/root/Main/Ground'],
    })

    // The simulation did not advance and the state hash is unchanged.
    assert.equal(after.step, before.step)
    assert.equal(after.hash, before.hash)
    assert.equal(after.outcome_hash, before.outcome_hash)

    // Every observed transform and collision property is identical.
    assert.deepEqual(
      afterObservation.nodes.map((node) => node.global_transform),
      beforeObservation.nodes.map((node) => node.global_transform),
    )
    assert.deepEqual(
      afterObservation.nodes.map((node) => node.collision),
      beforeObservation.nodes.map((node) => node.collision),
    )
  })
})

test('observe publishes the collision layer and mask for collision objects', async () => {
  await withSession(async (session) => {
    const observation = await session.observe({
      targets: ['/root/Main/Gate', '/root/Main/Plate'],
    })
    const gate = observation.nodes.find((node) => node.path === GATE_PATH)
    assert.ok(gate, 'gate node was not observed')
    assert.equal(gate.collision.collision_layer, 1)
    assert.equal(gate.collision.collision_mask, 1)
    assert.equal(gate.collision.source, 'measured')

    const plate = observation.nodes.find((node) => node.path === '/root/Main/Plate')
    assert.ok(plate, 'plate node was not observed')
    assert.equal(typeof plate.collision.monitoring, 'boolean')
    assert.equal(typeof plate.collision.monitorable, 'boolean')
  })
})
