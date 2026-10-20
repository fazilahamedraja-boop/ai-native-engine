import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/sentry'
const SPAWN = [0, 0.850000023841858, 0]

let session

function closeTo(actual, expected, tolerance = 0.01) {
  assert.equal(
    Math.abs(actual - expected) <= tolerance,
    true,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

async function resetAndStep(steps, input = {}) {
  const reset = await session.reset()
  const result = await session.step({ steps, input })
  return { reset: reset.snapshot, result: result.final }
}

test.before(async () => {
  session = new HarnessSession({ project: PROJECT, headless: true })
  await session.startProject()
  await session.pause()
})

test.after(async () => {
  await session?.stopProject()
})

test('movement advances the live scene with fixed input', async () => {
  const { reset, result } = await resetAndStep(80, { forward: 1 })
  assert.equal(reset.step, 0)
  assert.equal(result.step, 80)
  assert.equal(result.phase, 'active')
  closeTo(result.player_position[0], 0, 0.01)
  closeTo(result.player_position[2], -6.0, 0.02)
  assert.equal(result.grounded, true)
  assert.deepEqual(result.seen_by, ['guard-a'])
  assert.ok(result.detection > 0.6, `detection was ${result.detection}`)
})

test('detection rises inside a cone and decays after leaving it', async () => {
  const reset = await session.reset()
  const rise = await session.step({ steps: 80, input: { forward: 1 } })
  const moved = await session.step({ steps: 30, input: { forward: 0, strafe: 1 } })
  const decay = await session.step({ steps: 60, input: { forward: 0, strafe: 0 } })

  assert.equal(reset.snapshot.phase, 'active')
  assert.ok(rise.final.detection > 0.6)
  assert.deepEqual(rise.final.seen_by, ['guard-a'])
  assert.deepEqual(decay.final.seen_by, [])
  assert.equal(decay.final.phase, 'active')
  assert.ok(
    decay.final.detection < rise.final.detection,
    `detection did not decay: rise=${rise.final.detection} decay=${decay.final.detection}`,
  )
  assert.ok(decay.final.detection > 0)
  assert.ok(moved.final.player_position[0] > 2.0)
})

test('leaving the cones and reaching the beacon wins', async () => {
  await session.reset()
  const right = await session.step({ steps: 100, input: { forward: 0, strafe: 1 } })
  const forward = await session.step({ steps: 240, input: { forward: 1, strafe: 0 } })
  const left = await session.step({ steps: 100, input: { forward: 0, strafe: -1 } })

  assert.equal(right.final.phase, 'active')
  assert.deepEqual(right.final.seen_by, [])
  assert.equal(forward.final.phase, 'active')
  assert.equal(left.final.phase, 'won')
  assert.ok(left.final.exit_distance <= 0.01)
  closeTo(left.final.player_position[0], 0, 0.01)
  closeTo(left.final.player_position[2], -18, 0.02)
  assert.match(left.final.hud, /ESCAPED/)
})

test('standing in a cone reaches a terminal loss', async () => {
  await session.reset()
  const approach = await session.step({ steps: 80, input: { forward: 1 } })
  const lost = await session.step({ steps: 30, input: { forward: 0, strafe: 0 } })

  assert.equal(approach.final.phase, 'active')
  assert.equal(lost.final.phase, 'lost')
  assert.equal(lost.final.detection, 1)
  assert.match(lost.final.hud, /DETECTED/)
})

test('reset returns every selected simulation field to the baseline', async () => {
  await session.reset()
  const baseline = await session.step({ steps: 0 })
  await session.step({ steps: 80, input: { forward: 1 } })
  await session.step({ steps: 30, input: { forward: 0, strafe: 0 } })
  const lost = await session.snapshot()
  assert.equal(lost.phase, 'lost')

  const reset = await session.reset()
  const after = await session.step({ steps: 0 })
  assert.equal(reset.snapshot.phase, 'active')
  assert.equal(reset.snapshot.detection, 0)
  assert.equal(reset.snapshot.step, 0)
  assert.deepEqual(reset.snapshot.player_position, SPAWN)
  assert.equal(after.final.hash, baseline.final.hash)
  assert.equal(after.final.hash, reset.snapshot.hash)
})

test('jump is edge-triggered and the player returns to the ground', async () => {
  await session.reset()
  const takeoff = await session.step({ steps: 1, input: { jump: true } })
  const air = await session.step({ steps: 20, input: { jump: false } })
  const landed = await session.step({ steps: 80, input: { jump: false } })

  assert.equal(takeoff.final.grounded, false)
  assert.ok(takeoff.final.player_position[1] > 0.9)
  assert.ok(takeoff.final.player_velocity[1] > 0)
  assert.ok(air.final.player_position[1] > 1.0)
  assert.equal(landed.final.grounded, true)
  closeTo(landed.final.player_position[1], SPAWN[1], 0.01)
})

test('the same fixed sequence has the same hash after reset', async () => {
  const run = async () => {
    await session.reset()
    await session.step({ steps: 80, input: { forward: 1 } })
    await session.step({ steps: 30, input: { strafe: 1 } })
    const result = await session.step({ steps: 20, input: { forward: 0, strafe: 0 } })
    return result.final
  }
  const first = await run()
  const second = await run()
  assert.equal(second.hash, first.hash)
  assert.deepEqual(second.player_position, first.player_position)
  assert.equal(second.step, first.step)
})

test('a fresh process reproduces the same scenario hash', async () => {
  const scenario = async (target) => {
    await target.reset()
    await target.step({ steps: 80, input: { forward: 1 } })
    await target.step({ steps: 30, input: { strafe: 1 } })
    const result = await target.step({ steps: 20, input: { forward: 0, strafe: 0 } })
    return result.final
  }
  const first = await scenario(session)

  const secondSession = new HarnessSession({ project: PROJECT, headless: true })
  try {
    await secondSession.startProject()
    await secondSession.pause()
    const second = await scenario(secondSession)
    assert.equal(second.hash, first.hash)
    assert.deepEqual(second.player_position, first.player_position)
  } finally {
    await secondSession.stopProject()
  }
})
