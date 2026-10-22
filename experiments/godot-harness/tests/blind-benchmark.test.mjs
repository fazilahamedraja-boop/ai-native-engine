import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { BLIND_CASES, BLIND_CASE_IDS } from '../controller/blind-cases.mjs'

/**
 * The benchmark runner's own contract:
 *
 *   - the case definitions are well formed and genuinely distinct
 *   - a prepared bundle contains no source, no diff, and no answer key
 *   - the output directory is configurable and protected directories are refused
 *   - an unrepaired fixture is reported as a failure, not as a success
 *
 * These tests do not judge an agent. They check that the benchmark measures
 * what it claims to measure.
 */

const HARNESS = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\//, ''), '..')
const RUNNER = path.join(HARNESS, 'controller', 'blind-benchmark.mjs')
const REPO_ROOT = path.resolve(HARNESS, '..', '..')
// The output directory must stay inside the repository and outside every
// protected evidence directory, so a scratch directory under docs/phase14 is
// used rather than the system temp directory.
const SCRATCH = path.join(REPO_ROOT, 'docs', 'phase14', 'artifacts', 'test-scratch')

function scratchDir(label) {
  const dir = path.join(SCRATCH, `${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Remove the scratch output directory and the temporary fixture copy the
 * benchmark created inside it. A run that leaves a Godot fixture behind in the
 * system temp directory would be a cleanup failure, not a test artefact.
 */
function removeRun(outDir, caseId) {
  runBenchmark(['cleanup', '--case', caseId, '--out-dir', outDir])
  fs.rmSync(outDir, { recursive: true, force: true })
}

function runBenchmark(args, cwd = HARNESS) {
  try {
    const stdout = execFileSync('node', [RUNNER, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: 300000,
    })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

test('the case definitions are well formed and distinct', () => {
  assert.ok(BLIND_CASE_IDS.length >= 3, 'at least three cases are required')
  const classes = new Set()
  const files = new Set()
  for (const id of BLIND_CASE_IDS) {
    const caseDef = BLIND_CASES[id]
    assert.equal(caseDef.id, id)
    assert.ok(caseDef.defectClass, `${id} needs a defect class`)
    assert.ok(!classes.has(caseDef.defectClass), `${id} must have its own defect class`)
    classes.add(caseDef.defectClass)
    assert.ok(caseDef.injection.from.length > 0, `${id} needs an injection source line`)
    assert.ok(caseDef.injection.to.length > 0, `${id} needs an injection target line`)
    assert.ok(caseDef.scenario.phases.length > 0, `${id} needs a scenario`)
    assert.ok(caseDef.physicsQueries.length > 0, `${id} needs a physics query`)
    assert.ok(caseDef.expectedFailingCases.length > 0, `${id} needs an expected failure`)
    assert.ok(caseDef.diagnosisKeywords.length > 0, `${id} needs diagnosis keywords`)
    files.add(`${caseDef.sourceFixture}/${caseDef.injection.file}`)
  }
  assert.ok(classes.size === BLIND_CASE_IDS.length, 'every case needs a distinct defect class')
})

test('a prepared bundle contains no source, no diff, and no answer key', () => {
  const outDir = scratchDir('bundle')
  try {
    const prepared = runBenchmark([
      'prepare',
      '--case',
      'plate-never-registers',
      '--out-dir',
      outDir,
    ])
    assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout)

    const evidence = path.join(outDir, 'evidence')
    const files = fs.readdirSync(evidence)
    for (const file of files) {
      const text = fs.readFileSync(path.join(evidence, file), 'utf8')
      // No GDScript source, no injected line, no case definition.
      assert.doesNotMatch(text, /func _on_plate_body_entered/, `${file} leaks source`)
      assert.doesNotMatch(text, /body == player/, `${file} leaks the injected line`)
      assert.doesNotMatch(text, /defectClass|diagnosisKeywords/, `${file} leaks the answer key`)
    }

    // The task file names the answer key so the agent cannot open it by accident.
    const task = fs.readFileSync(path.join(outDir, 'task.md'), 'utf8')
    assert.match(task, /blind-cases\.mjs/)
    assert.match(task, /Do not open it at all/)

    // The defect really did break the suite.
    const result = JSON.parse(fs.readFileSync(path.join(evidence, 'test-result.json'), 'utf8'))
    assert.equal(result.ok, false)
    assert.ok(result.results.some((entry) => !entry.passed))
  } finally {
    removeRun(outDir, 'plate-never-registers')
  }
})

test('an unrepaired fixture is reported as a failure, not a success', () => {
  const outDir = scratchDir('unrepaired')
  try {
    const prepared = runBenchmark([
      'prepare',
      '--case',
      'plate-never-registers',
      '--out-dir',
      outDir,
    ])
    assert.equal(prepared.code, 0, prepared.stderr || prepared.stdout)

    const verified = runBenchmark([
      'verify',
      '--case',
      'plate-never-registers',
      '--out-dir',
      outDir,
    ])
    assert.notEqual(verified.code, 0, 'verify must fail for an unrepaired fixture')
    const result = JSON.parse(fs.readFileSync(path.join(outDir, 'result.json'), 'utf8'))
    assert.equal(result.ok, false)
    assert.equal(result.after.test_ok, false, 'the suite must still be failing')
    assert.equal(result.diagnosis.exists, false, 'no diagnosis was written')
    assert.equal(result.diagnosis.ordering_respected, false)
    assert.equal(result.repair.oracle_intact, true, 'the oracle must be intact')
  } finally {
    removeRun(outDir, 'plate-never-registers')
  }
})

test('the benchmark refuses to write into a protected evidence directory', () => {
  const protectedDir = path.join(REPO_ROOT, 'docs', 'phase11', 'stage-c')
  const prepared = runBenchmark([
    'prepare',
    '--case',
    'plate-never-registers',
    '--out-dir',
    protectedDir,
  ])
  assert.notEqual(prepared.code, 0, 'prepare must refuse a protected directory')
  assert.match(prepared.stderr, /protected evidence directory/)
})
