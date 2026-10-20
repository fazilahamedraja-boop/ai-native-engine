import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/door'
const SPAWN = [0, 0.85, 5.5]
const EVIDENCE = path.resolve('../../docs/phase9')

let session

function idleInput() {
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    actions: { interact: false },
  }
}

function closeTo(actual, expected, tolerance = 0.001) {
  assert.equal(
    Math.abs(actual - expected) <= tolerance,
    true,
    `expected ${actual} to be within ${tolerance} of ${expected}`,
  )
}

function withInput(overrides = {}) {
  return {
    ...idleInput(),
    ...overrides,
    actions: { ...idleInput().actions, ...(overrides.actions || {}) },
  }
}

async function advance(frames, overrides = {}) {
  return session.advancePhysics({ frames, input: withInput(overrides) })
}

test.before(async () => {
  session = new HarnessSession({ project: PROJECT, headless: true })
  await session.startProject()
  await session.pause()
})

test.after(async () => {
  await session?.stopProject()
})

test('locked door blocks, key unlocks it, and reset restores every surface', { timeout: 120000 }, async () => {
  await session.reset()
  let snap = (await advance(3)).final
  const baseline = snap
  assert.equal(snap.door_locked, true)
  assert.equal(snap.door_open, false)
  assert.equal(snap.key_available, true)
  assert.equal(snap.player_has_key, false)
  assert.equal(snap.prompt, 'APPROACH THE DOOR')

  const inspected = await session.inspectState()
  assert.equal(inspected.ok, true)
  assert.equal(inspected.snapshot.door_locked, true)
  assert.match(JSON.stringify(inspected.scene_tree), /"name":"Door"/)
  assert.match(JSON.stringify(inspected.scene_tree), /"name":"Key"/)
  assert.match(JSON.stringify(inspected.scene_tree), /"name":"Player"/)
  const lockedProperty = await session.property('/root/Main/Door', 'locked')
  assert.equal(lockedProperty.value, true)
  const openProperty = await session.property('/root/Main/Door', 'open')
  assert.equal(openProperty.value, false)
  const record = {
    fixture: 'door',
    scenario: 'locked-door-key-live-inspection',
    initial: {
      snapshot: snap,
      locked_property: lockedProperty.value,
      open_property: openProperty.value,
    },
    locked: null,
    key: null,
    open: null,
    reset: null,
    scene_tree: inspected.scene_tree,
  }

  snap = (await advance(100, { forward: 1 })).final
  assert.ok(snap.player_position[2] > 0.4, `z=${snap.player_position[2]}`)
  assert.equal(snap.prompt, 'PRESS E TO TRY THE DOOR')

  snap = (await advance(1, { actions: { interact: true } })).final
  assert.equal(snap.feedback, 'LOCKED - KEY REQUIRED')
  assert.equal(snap.door_locked, true)
  assert.equal(snap.door_open, false)
  assert.equal(snap.locked_attempts, 1)
  const lockedAfterAttempt = await session.property('/root/Main/Door', 'locked')
  assert.equal(lockedAfterAttempt.value, true)

  const blocked = (await advance(30, { forward: 1 })).final
  assert.ok(blocked.player_position[2] > 0.4, `z=${blocked.player_position[2]}`)
  assert.equal(blocked.door_open, false)
  record.locked = {
    attempt: snap,
    blocked,
    locked_property: lockedAfterAttempt.value,
  }

  await session.reset()
  snap = (await advance(3)).final
  snap = (await advance(30, { strafe: 1 })).final
  snap = (await advance(15, { forward: 1 })).final
  assert.equal(snap.player_has_key, true)
  assert.equal(snap.key_available, false)
  assert.equal(snap.key_visible, false)
  assert.equal(snap.feedback, 'KEY ACQUIRED')
  const keyVisible = await session.property('/root/Main/Key', 'visible')
  assert.equal(keyVisible.value, false)
  record.key = { snapshot: snap, visible_property: keyVisible.value }

  snap = (await advance(30, { strafe: -1 })).final
  snap = (await advance(100, { forward: 1 })).final
  assert.equal(snap.prompt, 'PRESS E TO UNLOCK')
  snap = (await advance(1, { actions: { interact: true } })).final
  assert.equal(snap.feedback, 'UNLOCKED - DOOR OPEN')
  assert.equal(snap.door_locked, false)
  assert.equal(snap.door_open, true)
  assert.equal(snap.door_collision_enabled, false)
  assert.equal(snap.open_count, 1)
  assert.ok(Math.abs(snap.door_rotation_degrees - 100) < 0.01)

  const openPropertyAfter = await session.property('/root/Main/Door', 'open')
  assert.equal(openPropertyAfter.value, true)
  const lockedPropertyAfter = await session.property('/root/Main/Door', 'locked')
  assert.equal(lockedPropertyAfter.value, false)

  snap = (await advance(60, { forward: 1 })).final
  assert.ok(snap.player_position[2] < -1.0, `z=${snap.player_position[2]}`)
  const collisionDisabled = await session.property('/root/Main/Door/Collision', 'disabled')
  assert.equal(collisionDisabled.value, true)
  record.open = {
    snapshot: snap,
    open_property: openPropertyAfter.value,
    locked_property: lockedPropertyAfter.value,
    collision_disabled: collisionDisabled.value,
  }

  const reset = await session.reset()
  assert.equal(reset.snapshot.step, 0)
  for (const [index, expected] of SPAWN.entries()) {
    closeTo(reset.snapshot.player_position[index], expected, 0.001)
  }
  assert.equal(reset.snapshot.door_locked, true)
  assert.equal(reset.snapshot.door_open, false)
  assert.equal(reset.snapshot.door_collision_enabled, true)
  assert.equal(reset.snapshot.player_has_key, false)
  assert.equal(reset.snapshot.key_available, true)
  assert.equal(reset.snapshot.key_visible, true)
  assert.equal(reset.snapshot.locked_attempts, 0)
  assert.equal(reset.snapshot.open_count, 0)
  assert.equal(reset.snapshot.interaction_count, 0)
  assert.equal(reset.snapshot.feedback, 'LOCKED - FIND THE KEY')
  assert.ok(Math.abs(reset.snapshot.door_rotation_degrees) < 0.01)

  snap = (await advance(3)).final
  assert.equal(snap.hash, baseline.hash, 'reset should return to the same settled hash')
  assert.equal(snap.outcome_hash, baseline.outcome_hash)
  const collisionEnabledAfterReset = await session.property('/root/Main/Door/Collision', 'disabled')
  assert.equal(collisionEnabledAfterReset.value, false)
  const keyVisibleAfterReset = await session.property('/root/Main/Key', 'visible')
  assert.equal(keyVisibleAfterReset.value, true)
  record.reset = {
    immediate: reset.snapshot,
    settled: snap,
    collision_disabled: collisionEnabledAfterReset.value,
    key_visible: keyVisibleAfterReset.value,
  }

  fs.mkdirSync(EVIDENCE, { recursive: true })
  fs.writeFileSync(
    path.join(EVIDENCE, 'stage-f-inspect.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  )
})
