import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = process.env.HARNESS_PROJECT || 'fixtures/sentry'

test('repair fixture: forward movement and the escape route', { timeout: 120000 }, async () => {
  const session = new HarnessSession({ project: PROJECT, headless: true })
  try {
    await session.startProject()
    await session.pause()

    await session.reset()
    const forward = await session.step({ steps: 80, input: { forward: 1, strafe: 0 } })
    assert.equal(forward.final.phase, 'active')
    assert.ok(
      forward.final.player_position[2] < -5.9,
      `forward input moved z to ${forward.final.player_position[2]}, expected approximately -6`,
    )
    assert.deepEqual(forward.final.seen_by, ['guard-a'])

    await session.reset()
    await session.step({ steps: 100, input: { forward: 0, strafe: 1 } })
    await session.step({ steps: 240, input: { forward: 1, strafe: 0 } })
    const win = await session.step({ steps: 100, input: { forward: 0, strafe: -1 } })
    assert.equal(win.final.phase, 'won')
    assert.ok(win.final.exit_distance <= 0.01)
  } finally {
    await session.stopProject()
  }
})
