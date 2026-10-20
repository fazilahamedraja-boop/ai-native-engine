import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/physics'
const SPAWN = [0, 0.850000023841858, 0]

let session

function closeTo(actual, expected, tolerance = 0.01) {
  assert.equal(
    Math.abs(actual - expected) <= tolerance,
    true,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

test.before(async () => {
  session = new HarnessSession({ project: PROJECT, headless: true })
  await session.startProject()
  await session.pause()
})

test.after(async () => {
  await session?.stopProject()
})

test('real physics advances through the generic harness operation', { timeout: 120000 }, async () => {
  await session.reset()

  const moved = await session.advancePhysics({ frames: 30, input: { forward: 1 } })
  assert.equal(moved.frames, 30)
  assert.equal(moved.paused, true)
  assert.equal(moved.final.step, 30)
  assert.equal(moved.final.grounded, true)
  assert.ok(moved.final.player_position[2] < -1.5, `z=${moved.final.player_position[2]}`)
  assert.ok(Math.abs(moved.final.player_position[0]) < 0.05)

  const wall = await session.advancePhysics({ frames: 90, input: { forward: 1 } })
  assert.equal(wall.final.step, 120)
  assert.equal(wall.final.wall_contact, true)
  closeTo(wall.final.player_position[2], -3.35, 0.06)
  assert.ok(wall.final.wall_clearance >= -0.02)
  assert.ok(Math.abs(wall.final.player_motion[2]) < 0.01)

  const slide = await session.advancePhysics({
    frames: 30,
    input: { forward: 1, strafe: 1 },
  })
  assert.ok(slide.final.player_position[0] > 0.8, `x=${slide.final.player_position[0]}`)
  closeTo(slide.final.player_position[2], -3.35, 0.06)
  assert.equal(slide.final.wall_contact, true)
  assert.ok(slide.final.player_motion[0] > 0)
})

test('jump and reset use the same real physics path', { timeout: 120000 }, async () => {
  await session.reset()
  const settled = await session.advancePhysics({ frames: 3 })
  assert.equal(settled.final.grounded, true)
  closeTo(settled.final.player_position[1], SPAWN[1], 0.02)

  const takeoff = await session.advancePhysics({ frames: 1, input: { jump: true } })
  assert.equal(takeoff.final.grounded, false)
  assert.ok(takeoff.final.player_position[1] > SPAWN[1] + 0.05)

  const air = await session.advancePhysics({ frames: 10 })
  assert.ok(air.final.player_position[1] > SPAWN[1] + 0.4, `y=${air.final.player_position[1]}`)

  const land = await session.advancePhysics({ frames: 80 })
  assert.equal(land.final.grounded, true)
  closeTo(land.final.player_position[1], SPAWN[1], 0.03)

  const reset = await session.reset()
  assert.equal(reset.snapshot.step, 0)
  assert.equal(reset.snapshot.grounded, true)
  assert.deepEqual(reset.snapshot.player_position, SPAWN)
  assert.deepEqual(reset.snapshot.player_velocity, [0, 0, 0])
})
