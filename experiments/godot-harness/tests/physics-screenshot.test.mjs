import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/physics'
const EVIDENCE = path.resolve('../../docs/phase9')

test('windowed real-physics run captures wall contact and jump states', { timeout: 120000 }, async () => {
  const session = new HarnessSession({ project: PROJECT, headless: false })
  const started = await session.startProject()
  try {
    assert.equal(started.ok, true)
    await session.pause()
    await session.reset()

    const wall = await session.advancePhysics({ frames: 120, input: { forward: 1 } })
    const wallShot = await session.screenshot('res://artifacts/physics-wall.png')
    assert.equal(wall.final.wall_contact, true)
    assert.equal(wallShot.width, 1280)
    assert.equal(wallShot.height, 720)
    assert.ok(wallShot.bytes > 1000)

    await session.reset()
    await session.advancePhysics({ frames: 1, input: { jump: true } })
    const air = await session.advancePhysics({ frames: 10 })
    const airShot = await session.screenshot('res://artifacts/physics-air.png')
    assert.equal(air.final.grounded, false)
    assert.ok(air.final.player_position[1] > 1.2)
    assert.ok(airShot.bytes > 1000)
    assert.match(wallShot.sha256, /^[0-9a-f]{64}$/)
    assert.match(airShot.sha256, /^[0-9a-f]{64}$/)
    assert.notEqual(wallShot.sha256, airShot.sha256)

    fs.mkdirSync(EVIDENCE, { recursive: true })
    for (const [name, shot] of [
      ['stage-e-wall.png', wallShot],
      ['stage-e-air.png', airShot],
    ]) {
      const source = path.join(session.project, 'artifacts', name.replace('stage-e-', 'physics-'))
      const target = path.join(EVIDENCE, name)
      fs.copyFileSync(source, target)
      const copied = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
      assert.equal(copied, shot.sha256)
    }
  } finally {
    await session.stopProject()
  }
})
