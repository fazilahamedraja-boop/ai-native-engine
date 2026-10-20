import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/door'
const EVIDENCE = path.resolve('../../docs/phase9')

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

async function advance(session, frames, overrides = {}) {
  return session.advancePhysics({ frames, input: withInput(overrides) })
}

test('windowed door run captures locked, key, and open states', { timeout: 120000 }, async () => {
  const session = new HarnessSession({ project: PROJECT, headless: false })
  const started = await session.startProject()
  try {
    assert.equal(started.ok, true)
    await session.pause()
    await session.reset()

    await advance(session, 100, { forward: 1 })
    const locked = (await advance(session, 1, { actions: { interact: true } })).final
    const lockedShot = await session.screenshot('res://artifacts/door-locked.png')
    assert.equal(locked.feedback, 'LOCKED - KEY REQUIRED')
    assert.equal(lockedShot.width, 1280)
    assert.equal(lockedShot.height, 720)
    assert.ok(lockedShot.bytes > 1000)

    await session.reset()
    await advance(session, 30, { strafe: 1 })
    const key = (await advance(session, 15, { forward: 1 })).final
    const keyShot = await session.screenshot('res://artifacts/door-key.png')
    assert.equal(key.player_has_key, true)
    assert.equal(key.key_visible, false)
    assert.ok(keyShot.bytes > 1000)

    await advance(session, 30, { strafe: -1 })
    await advance(session, 100, { forward: 1 })
    const open = (await advance(session, 1, { actions: { interact: true } })).final
    const openShot = await session.screenshot('res://artifacts/door-open.png')
    assert.equal(open.door_open, true)
    assert.equal(open.door_locked, false)
    assert.equal(open.feedback, 'UNLOCKED - DOOR OPEN')
    assert.ok(openShot.bytes > 1000)

    for (const shot of [lockedShot, keyShot, openShot]) {
      assert.match(shot.sha256, /^[0-9a-f]{64}$/)
    }
    assert.notEqual(lockedShot.sha256, keyShot.sha256)
    assert.notEqual(keyShot.sha256, openShot.sha256)
    assert.notEqual(lockedShot.sha256, openShot.sha256)

    fs.mkdirSync(EVIDENCE, { recursive: true })
    for (const [sourceName, targetName, shot] of [
      ['door-locked.png', 'stage-f-locked.png', lockedShot],
      ['door-key.png', 'stage-f-key.png', keyShot],
      ['door-open.png', 'stage-f-open.png', openShot],
    ]) {
      const source = path.join(session.project, 'artifacts', sourceName)
      const target = path.join(EVIDENCE, targetName)
      fs.copyFileSync(source, target)
      const copied = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
      assert.equal(copied, shot.sha256)
    }
  } finally {
    await session.stopProject()
  }
})
