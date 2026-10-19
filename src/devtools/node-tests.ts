/**
 * A tiny Node-side suite runner.
 *
 * Deliberately the same report shape as the browser runTests(): name, passed,
 * detail. One way to read test output, whichever side of the boundary it ran on.
 */
export interface NodeTestResult {
  name: string
  passed: boolean
  detail: string
}

export interface NodeTestSuite {
  name: string
  passed: boolean
  results: NodeTestResult[]
  durationMs: number
}

export interface NodeTestCase {
  name: string
  /** Returns a short detail string on success; throws on failure. */
  run: () => string
}

export function expect(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

export function expectEqual<T>(actual: T, expected: T, label: string): void {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
  }
}

export function expectClose(actual: number, expected: number, label: string, tolerance = 1e-9): void {
  if (!(Math.abs(actual - expected) <= tolerance)) {
    throw new Error(`${label}: expected ${expected} +/- ${tolerance}, got ${actual}`)
  }
}

export function runSuite(name: string, cases: readonly NodeTestCase[]): NodeTestSuite {
  const started = performance.now()

  const results = cases.map((testCase) => {
    const caseStart = performance.now()
    try {
      const detail = testCase.run()
      const elapsed = (performance.now() - caseStart).toFixed(2)
      return { name: testCase.name, passed: true, detail: `${detail} (${elapsed} ms)` }
    } catch (error) {
      return { name: testCase.name, passed: false, detail: error instanceof Error ? error.message : String(error) }
    }
  })

  return {
    name,
    passed: results.every((result) => result.passed),
    results,
    durationMs: performance.now() - started,
  }
}

export function printSuite(suite: NodeTestSuite): void {
  console.log(suite.name)
  for (const result of suite.results) {
    console.log(`  ${result.passed ? 'PASS' : 'FAIL'}  ${result.name.padEnd(36)} ${result.detail}`)
  }
  const failed = suite.results.filter((result) => !result.passed).length
  console.log('')
  console.log(`${suite.results.length - failed} passed, ${failed} failed (${suite.durationMs.toFixed(1)} ms)`)
}
