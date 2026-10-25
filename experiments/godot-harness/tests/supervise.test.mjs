import assert from 'node:assert/strict'
import test from 'node:test'
import { supervise } from '../controller/supervise.mjs'

/**
 * `supervise` is the live half of process diagnosis: it streams a run and
 * reports hangs. These tests use `process.execPath` with `-e` so they are fast
 * and do not need Godot or a game window.
 */

test('a clean run resolves with code 0 and every stdout line', async () => {
  const events = []
  const summary = await supervise({
    command: [process.execPath, '-e', "console.log('ready'); console.log('done')"],
    onEvent: (event) => events.push(event),
  })
  assert.equal(summary.code, 0)
  assert.equal(summary.classification, 'clean')
  assert.deepEqual(summary.stdout, ['ready', 'done'])
  assert.equal(events[0].event, 'start')
  assert.equal(events.at(-1).event, 'exit')
})

test('a failing run keeps its exit code and stderr', async () => {
  const summary = await supervise({
    command: [process.execPath, '-e', "console.error('boom'); process.exit(3)"],
  })
  assert.equal(summary.code, 3)
  assert.equal(summary.classification, 'failed')
  assert.deepEqual(summary.stderr, ['boom'])
})

test('Godot engine errors are extracted from a failed run', async () => {
  const summary = await supervise({
    command: [
      process.execPath,
      '-e',
      "console.error('SCRIPT ERROR: Parse Error: Unexpected token'); process.exit(1)",
    ],
  })
  assert.equal(summary.classification, 'failed')
  assert.equal(summary.engineErrors.length, 1)
  assert.match(summary.engineErrors[0], /SCRIPT ERROR/)
})

test('silence past the threshold emits a hang event exactly once', async () => {
  const events = []
  const summary = await supervise({
    command: [process.execPath, '-e', 'setTimeout(() => {}, 5000)'],
    hangAfterMs: 300,
    timeoutMs: 1200,
    onEvent: (event) => events.push(event),
  })
  const hangs = events.filter((event) => event.event === 'hang')
  assert.equal(hangs.length, 1)
  assert.ok(hangs[0].silenceMs >= 300)
  assert.equal(summary.classification, 'timeout')
  assert.equal(summary.code, 124)
})

test('output resets the silence clock', async () => {
  const events = []
  // The run lasts ~2 s with a line every 100 ms, against a 600 ms threshold: if
  // the clock were not reset, a hang would fire at 600 ms. The 6x margin over
  // the tick interval keeps this stable when the suite runs in parallel.
  const script =
    'let n = 0; const t = setInterval(() => { console.log(`tick ${++n}`); if (n === 20) clearInterval(t); }, 100)'
  const summary = await supervise({
    command: [process.execPath, '-e', script],
    hangAfterMs: 600,
    timeoutMs: 8000,
    onEvent: (event) => events.push(event),
  })
  assert.equal(summary.classification, 'clean')
  assert.equal(summary.stdout.length, 20)
  assert.equal(events.filter((event) => event.event === 'hang').length, 0)
})

test('a command that cannot be spawned reports spawn_failed with code 125', async () => {
  const summary = await supervise({ command: ['definitely-not-a-real-executable-xyz'] })
  assert.equal(summary.classification, 'spawn_failed')
  assert.equal(summary.code, 125)
})

test('supervise rejects an empty command', () => {
  assert.throws(() => supervise({ command: [] }), /needs a command array/)
})
