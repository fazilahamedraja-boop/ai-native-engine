import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/sentry'

test('start, inspect, property, pause/resume, and stop one project', async () => {
  const session = new HarnessSession({ project: PROJECT, headless: true, scene: 'res://main.tscn' })
  const started = await session.start()
  try {
    assert.equal(started.ok, true)
    assert.equal(started.pid, started.ready.pid)
    assert.equal(started.scene, 'res://main.tscn')

    await session.pause()
    const state = await session.inspectState()
    assert.equal(state.ok, true)
    assert.equal(state.paused, true)
    assert.equal(state.snapshot.phase, 'active')
    assert.equal(state.snapshot.paused, true)
    assert.ok(Math.abs(state.snapshot.player_position[0]) < 0.01)
    assert.ok(Math.abs(state.snapshot.player_position[1] - 0.85) < 0.01)
    assert.equal(state.scene_tree.path, '/root')

    const property = await session.property('/root/Main/Player', 'global_position')
    assert.equal(property.node_path, '/root/Main/Player')
    assert.equal(property.property, 'global_position')
    assert.equal(property.value.length, 3)

    await session.resume()
    const resumed = await session.ping()
    assert.equal(resumed.paused, false)

    const missing = await session
      .property('/root/Main/Player', 'not_a_property')
      .then(() => null)
      .catch((error) => error)
    assert.equal(missing?.code, 'PROPERTY_NOT_FOUND')
  } finally {
    const stopped = await session.stop()
    assert.equal(stopped.ok, true)
    assert.equal(stopped.pid, started.pid)
    assert.notEqual(stopped.exitCode, null)
    assert.equal(session.exited?.code, stopped.exitCode)
  }
})

test('stopping one session does not terminate another session it did not start', async () => {
  const first = new HarnessSession({ project: PROJECT, headless: true })
  const second = new HarnessSession({ project: PROJECT, headless: true })
  const firstStart = await first.start()
  let secondStart
  try {
    secondStart = await second.start()
    const firstStop = await first.stop()
    assert.equal(firstStop.ok, true)
    assert.equal(firstStop.pid, firstStart.pid)

    const secondPing = await second.ping()
    assert.equal(secondPing.pid, secondStart.pid)
    assert.equal(secondPing.game_ready, true)
  } finally {
    await first.stop()
    await second.stop()
  }
})
