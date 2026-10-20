import assert from 'node:assert/strict'
import test from 'node:test'
import { parseGodotTestOutput } from '../controller/harness.mjs'

const PASS_OUTPUT = `
Godot Engine v4.7.2
PASS sentry-initial phase=active detection=0.000000 seen=[]
PASS sentry-detection-rise phase=active detection=0.666667 percent=67 seen=["guard-a"]
RESULT passed=2 failed=0
`

test('parses a passing suite', () => {
  const parsed = parseGodotTestOutput(PASS_OUTPUT)
  assert.equal(parsed.ok, true)
  assert.deepEqual(parsed.summary, { passed: 2, failed: 0 })
  assert.equal(parsed.results.length, 2)
  assert.equal(parsed.results[1].name, 'sentry-detection-rise')
  assert.equal(parsed.errors.length, 0)
})

test('a failing case makes the result fail', () => {
  const parsed = parseGodotTestOutput(`
FAIL sentry-loss lost=active/0.000000
RESULT passed=0 failed=1
`)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'test cases failed')
  assert.equal(parsed.summary.failed, 1)
})

test('a summary mismatch is not accepted', () => {
  const parsed = parseGodotTestOutput(`
PASS one value
RESULT passed=2 failed=0
`)
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'RESULT counts do not match individual cases')
})

test('a missing RESULT line is not accepted', () => {
  const parsed = parseGodotTestOutput('PASS one value\n')
  assert.equal(parsed.ok, false)
  assert.equal(parsed.reason, 'missing RESULT line')
})

test('Godot ERROR lines fail an otherwise matching suite', () => {
  const parsed = parseGodotTestOutput(
    'PASS one value\nRESULT passed=1 failed=0\n',
    'SCRIPT ERROR: Invalid call. Nonexistent function "x".\n',
  )
  assert.equal(parsed.ok, false)
  assert.equal(parsed.errors.length, 1)
  assert.equal(parsed.reason, 'Godot reported ERROR lines')
})
