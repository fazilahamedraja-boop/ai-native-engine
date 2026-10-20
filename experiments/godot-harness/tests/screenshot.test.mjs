import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/sentry'
const EVIDENCE = path.resolve('../../docs/phase8')

test('windowed run captures detection and win frames', { timeout: 120000 }, async () => {
  const session = new HarnessSession({ project: PROJECT, headless: false })
  const started = await session.startProject()
  try {
    assert.equal(started.ok, true)
    await session.pause()
    await session.reset()
    const detection = await session.step({ steps: 80, input: { forward: 1, strafe: 0 } })
    const detectionShot = await session.screenshot('res://artifacts/live-detection.png')

    await session.reset()
    await session.step({ steps: 100, input: { forward: 0, strafe: 1 } })
    await session.step({ steps: 240, input: { forward: 1, strafe: 0 } })
    const win = await session.step({ steps: 100, input: { forward: 0, strafe: -1 } })
    const winShot = await session.screenshot('res://artifacts/live-win.png')

    assert.equal(detection.final.phase, 'active')
    assert.equal(win.final.phase, 'won')
    assert.equal(detectionShot.width, 1280)
    assert.equal(detectionShot.height, 720)
    assert.ok(detectionShot.bytes > 1000)
    assert.ok(winShot.bytes > 1000)
    assert.match(detectionShot.sha256, /^[0-9a-f]{64}$/)
    assert.match(winShot.sha256, /^[0-9a-f]{64}$/)
    assert.notEqual(detectionShot.sha256, winShot.sha256)

    fs.mkdirSync(EVIDENCE, { recursive: true })
    for (const [name, shot] of [
      ['live-detection.png', detectionShot],
      ['live-win.png', winShot],
    ]) {
      const source = path.join(session.project, 'artifacts', name)
      const target = path.join(EVIDENCE, name)
      fs.copyFileSync(source, target)
      const copied = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
      assert.equal(copied, shot.sha256)
    }
  } finally {
    await session.stopProject()
  }
})
