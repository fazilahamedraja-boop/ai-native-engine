import assert from 'node:assert/strict'
import test from 'node:test'
import { HarnessSession } from '../controller/harness.mjs'

const PROJECT = 'fixtures/door'

test('capture validation rejects unsafe paths and identifiers before a bridge call', async () => {
  const session = new HarnessSession({ project: PROJECT, headless: false })
  await assert.rejects(
    () => session.captureFrame({ path: 'artifacts/frame.png' }),
    /res:\/\/ \.png path/,
  )
  await assert.rejects(
    () => session.captureFrame({ path: 'res://artifacts/frame.png', runId: 'bad id' }),
    /runId/,
  )
  await assert.rejects(
    () => session.captureFrame({ path: 'res://artifacts/frame.png', scenario: '   ' }),
    /scenario/,
  )
  await assert.rejects(
    () => session.captureFrame({ path: 'res://artifacts/frame.png', metadata: [] }),
    /metadata/,
  )
})

test('capture requires an explicit windowed, connected, paused session', async () => {
  const headless = new HarnessSession({ project: PROJECT, headless: true })
  await assert.rejects(
    () => headless.captureFrame({ path: 'res://artifacts/frame.png' }),
    /windowed session/,
  )

  const windowed = new HarnessSession({ project: PROJECT, headless: false })
  await assert.rejects(
    () => windowed.captureFrame({ path: 'res://artifacts/frame.png' }),
    /not connected/,
  )
})

test('sequence validation bounds frame count, interval, and filename prefix', async () => {
  const session = new HarnessSession({ project: PROJECT, headless: false })
  await assert.rejects(
    () => session.captureSequence({ frameCount: 0, prefix: 'ok' }),
    /frameCount/,
  )
  await assert.rejects(
    () => session.captureSequence({ frameCount: 2, everyFrames: 0, prefix: 'ok' }),
    /everyFrames/,
  )
  await assert.rejects(
    () => session.captureSequence({ frameCount: 2, prefix: '../escape' }),
    /prefix/,
  )
  await assert.rejects(
    () => session.captureSequence({ frameCount: 2, prefix: 'ok', input: { forward: 2 } }),
    /forward/,
  )
})
