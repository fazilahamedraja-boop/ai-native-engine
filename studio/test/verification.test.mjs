import assert from 'node:assert/strict'
import test from 'node:test'

import { applyExpectedDiagnostics } from '../server/lib/verification.mjs'

const EXPECTATION = [
  {
    pattern: '^ERROR: Parse JSON failed\\.',
    whenPassed: 'load-invalid-json-safe',
    max: 1,
  },
]

function cleanRun(overrides = {}) {
  return {
    available: true,
    ok: false,
    summary: { passed: 2, failed: 0 },
    reason: 'Godot reported ERROR lines',
    exitCode: 0,
    timedOut: false,
    results: [
      { name: 'load-invalid-json-safe', passed: true, detail: 'safe' },
      { name: 'other-case', passed: true, detail: 'ok' },
    ],
    errors: ['ERROR: Parse JSON failed. Error at line 0: Expected key'],
    warnings: [],
    ...overrides,
  }
}

test('expected diagnostics: a declared line from a passing anchor case is forgiven', () => {
  const result = applyExpectedDiagnostics(cleanRun(), EXPECTATION)
  assert.equal(result.ok, true)
  assert.deepEqual(result.expectedDiagnostics, ['ERROR: Parse JSON failed. Error at line 0: Expected key'])
  assert.deepEqual(result.unexpectedDiagnostics, [])
  assert.match(result.reason, /expected diagnostic line/)
})

test('expected diagnostics: an undeclared ERROR line always keeps the run failed', () => {
  const result = applyExpectedDiagnostics(
    cleanRun({ errors: ['ERROR: Parse JSON failed. Error at line 0: Expected key', 'ERROR: Condition "x" is true'] }),
    EXPECTATION,
  )
  assert.equal(result.ok, false)
  assert.deepEqual(result.expectedDiagnostics, ['ERROR: Parse JSON failed. Error at line 0: Expected key'])
  assert.deepEqual(result.unexpectedDiagnostics, ['ERROR: Condition "x" is true'])
})

test('expected diagnostics: the anchor case must actually have passed', () => {
  const result = applyExpectedDiagnostics(
    cleanRun({
      results: [
        { name: 'load-invalid-json-safe', passed: false, detail: 'crashed' },
        { name: 'other-case', passed: true, detail: 'ok' },
      ],
      summary: { passed: 1, failed: 1 },
    }),
    EXPECTATION,
  )
  assert.equal(result.ok, false)
  assert.equal(result.unexpectedDiagnostics.length, 1)
})

test('expected diagnostics: repeating a line beyond its max is unexpected', () => {
  const line = 'ERROR: Parse JSON failed. Error at line 0: Expected key'
  const result = applyExpectedDiagnostics(cleanRun({ errors: [line, line] }), EXPECTATION)
  assert.equal(result.ok, false)
  assert.deepEqual(result.expectedDiagnostics, [line])
  assert.deepEqual(result.unexpectedDiagnostics, [line])
})

test('expected diagnostics alone cannot rescue a run that is structurally unsound', () => {
  for (const overrides of [
    { exitCode: 7 },
    { timedOut: true },
    { summary: { passed: 1, failed: 1 } },
    { summary: { passed: 5, failed: 0 } },
    { results: [{ name: 'load-invalid-json-safe', passed: true }, { name: 'x', passed: false }], summary: { passed: 1, failed: 0 } },
  ]) {
    const result = applyExpectedDiagnostics(cleanRun(overrides), EXPECTATION)
    assert.equal(result.ok, false, JSON.stringify(overrides))
    assert.ok(result.unexpectedDiagnostics.length > 0, JSON.stringify(overrides))
  }
})

test('expected diagnostics: a run without errors or expectations is untouched', () => {
  const clean = applyExpectedDiagnostics(
    cleanRun({ ok: true, errors: [], reason: 'tests passed' }),
    EXPECTATION,
  )
  assert.equal(clean.ok, true)
  assert.deepEqual(clean.expectedDiagnostics, [])

  const noRule = applyExpectedDiagnostics(cleanRun(), [])
  assert.equal(noRule.ok, false)
  assert.equal(noRule.unexpectedDiagnostics.length, 1)

  const badPattern = applyExpectedDiagnostics(cleanRun(), [{ pattern: '([' }])
  assert.equal(badPattern.ok, false)
  assert.equal(badPattern.unexpectedDiagnostics.length, 1)
})
