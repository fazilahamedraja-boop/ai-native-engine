import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { runTests } from '../controller/harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HARNESS = path.resolve(HERE, '..')
const SOURCE = path.join(HARNESS, 'fixtures', 'door')
const ARTIFACT = path.join(HARNESS, 'artifacts', 'door-defect')
const EVIDENCE = path.resolve(HARNESS, '..', '..', 'docs', 'phase9')
const SCRIPT = 'res://tests/run_door.gd'
const ORIGINAL = '\t\tif player_has_key:'
const DEFECT = '\t\tif true:'

function copyFixture() {
  fs.rmSync(ARTIFACT, { recursive: true, force: true })
  fs.cpSync(SOURCE, ARTIFACT, {
    recursive: true,
    filter(sourcePath) {
      const relative = path.relative(SOURCE, sourcePath)
      return !relative.split(path.sep).some((part) => part === '.godot' || part === 'artifacts')
    },
  })
}

function summarize(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    reason: result.reason,
    summary: result.summary,
    cases: result.results.map((item) => ({
      name: item.name,
      passed: item.passed,
      detail: item.detail,
    })),
    failingCases: result.results
      .filter((item) => !item.passed)
      .map((item) => ({ name: item.name, detail: item.detail })),
    errors: result.errors,
    warnings: result.warnings,
  }
}

function caseLog(result) {
  const lines = result.results.map(
    (item) => `${item.passed ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`,
  )
  lines.push(
    `RESULT passed=${result.summary?.passed ?? 0} failed=${result.summary?.failed ?? 0} ` +
      `exit=${result.exitCode} ok=${result.ok}`,
  )
  return `${lines.join('\n')}\n`
}

async function timedRun(project) {
  const started = Date.now()
  const result = await runTests({ project, script: SCRIPT, timeoutMs: 120000 })
  return { result, elapsedMs: Date.now() - started }
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  copyFixture()

  const doorScript = path.join(ARTIFACT, 'scripts', 'door.gd')
  const originalText = fs.readFileSync(doorScript, 'utf8')
  assert.equal(originalText.split(ORIGINAL).length - 1, 1, 'expected one key check to patch')
  fs.writeFileSync(doorScript, originalText.replace(ORIGINAL, DEFECT), 'utf8')

  const before = await timedRun('artifacts/door-defect')
  fs.writeFileSync(path.join(EVIDENCE, 'stage-f-repair-before.log'), caseLog(before.result))
  assert.equal(before.result.ok, false, 'defect must make the suite fail')
  const lockedCase = before.result.results.find((item) => item.name === 'door-locked-no-key')
  assert.ok(lockedCase, 'the locked-door case must run')
  assert.equal(lockedCase.passed, false, 'the locked-door case must catch the defect')
  assert.match(lockedCase.detail, /feedback=UNLOCKED - DOOR OPEN/)
  assert.match(lockedCase.detail, /attempts=0/)

  const repairedText = fs.readFileSync(doorScript, 'utf8')
  assert.equal(repairedText.split(DEFECT).length - 1, 1, 'expected one defective check to repair')
  fs.writeFileSync(doorScript, repairedText.replace(DEFECT, ORIGINAL), 'utf8')

  const after = await timedRun('artifacts/door-defect')
  fs.writeFileSync(path.join(EVIDENCE, 'stage-f-repair-after.log'), caseLog(after.result))
  assert.equal(after.result.ok, true, 'same suite must pass after repair')
  assert.equal(after.result.summary.failed, 0)
  assert.equal(after.result.results.every((item) => item.passed), true)

  const record = {
    fixture: 'door',
    defect: {
      file: 'scripts/door.gd',
      description: 'The key check was replaced with an unconditional true branch.',
      original: ORIGINAL.trim(),
      introduced: DEFECT.trim(),
      project_copy: 'artifacts/door-defect',
    },
    before: {
      elapsed_ms: before.elapsedMs,
      ...summarize(before.result),
    },
    after: {
      elapsed_ms: after.elapsedMs,
      ...summarize(after.result),
    },
    repaired: true,
    command: 'node repair/door-repair.mjs',
  }
  fs.writeFileSync(
    path.join(EVIDENCE, 'stage-f-repair.json'),
    `${JSON.stringify(record, null, 2)}\n`,
  )
  process.stdout.write(
    `REPAIR before_ok=${before.result.ok} before_failed=${before.result.summary.failed} ` +
      `after_ok=${after.result.ok} after_failed=${after.result.summary.failed}\n`,
  )
}

try {
  await main()
} finally {
  fs.rmSync(ARTIFACT, { recursive: true, force: true })
}
