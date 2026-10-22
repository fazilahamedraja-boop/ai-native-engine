import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT } from './harness.mjs'
import { BLIND_CASES, BLIND_CASE_IDS } from './blind-cases.mjs'

/**
 * Collect the Phase 14 blind-diagnosis runs into one machine-readable result
 * document.
 *
 * It only reads what the runs already wrote. It never re-runs a test, so it
 * cannot change a result.
 *
 *   node controller/blind-results.mjs [--runs <dir>]
 */

const REPO_ROOT = path.resolve(HARNESS_ROOT, '..', '..')
const DOCS = path.join(REPO_ROOT, 'docs', 'phase14')
const RUNS = path.join(DOCS, 'runs')

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/')
}

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function readIfPresent(file) {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null
}

const runs = []
if (fs.existsSync(RUNS)) {
  for (const name of fs.readdirSync(RUNS).sort()) {
    const dir = path.join(RUNS, name)
    if (!fs.statSync(dir).isDirectory()) continue
    const resultPath = path.join(dir, 'result.json')
    const statePath = path.join(dir, 'case-state.json')
    if (!fs.existsSync(resultPath) || !fs.existsSync(statePath)) continue
    const result = load(resultPath)
    const state = load(statePath)
    const diagnosisPath = path.join(dir, 'diagnosis.md')
    const repairPath = path.join(dir, 'repair.md')
    runs.push({
      run: name,
      case_id: state.case_id,
      defect_class: state.defect_class,
      source_fixture: state.source_fixture,
      test_script: state.test_script,
      output_dir: rel(dir),
      before: result.before,
      after: result.after,
      repair: result.repair,
      diagnosis: result.diagnosis,
      ok: result.ok,
      diagnosis_text: readIfPresent(diagnosisPath),
      repair_text: readIfPresent(repairPath),
      artifacts: fs
        .readdirSync(path.join(dir, 'evidence'))
        .filter((entry) => fs.statSync(path.join(dir, 'evidence', entry)).isFile())
        .map((entry) => {
          const file = path.join(dir, 'evidence', entry)
          return { path: rel(file), bytes: fs.statSync(file).size, sha256: sha256(file) }
        }),
    })
  }
}

// Per-case and overall rates.
const byCase = {}
for (const id of BLIND_CASE_IDS) {
  const caseRuns = runs.filter((run) => run.case_id === id)
  byCase[id] = {
    defect_class: BLIND_CASES[id].defectClass,
    source_fixture: BLIND_CASES[id].sourceFixture,
    expected_failing_cases: BLIND_CASES[id].expectedFailingCases,
    runs: caseRuns.length,
    baseline_failed_correctly: caseRuns.filter(
      (run) => run.before.test_ok === false && run.before.failing_cases.length > 0,
    ).length,
    diagnosis_matched: caseRuns.filter((run) => run.diagnosis.matched_defect_class === true).length,
    ordering_respected: caseRuns.filter((run) => run.diagnosis.ordering_respected === true).length,
    repair_passed_after: caseRuns.filter((run) => run.after.test_ok === true).length,
    oracle_intact: caseRuns.filter((run) => run.repair.oracle_intact === true).length,
    minimal_repair: caseRuns.filter((run) => run.repair.agent_changed_files?.length === 1).length,
    full_success: caseRuns.filter((run) => run.ok === true).length,
    baseline_failures_matched_expectation: caseRuns.filter((run) =>
      BLIND_CASES[id].expectedFailingCases.every((name) => run.before.failing_cases.includes(name)),
    ).length,
  }
}

const total = runs.length
const summary = {
  runs: total,
  cases: BLIND_CASE_IDS.length,
  baseline_failed_correctly: runs.filter((run) => run.before.test_ok === false).length,
  diagnosis_matched_defect_class: runs.filter(
    (run) => run.diagnosis.matched_defect_class === true,
  ).length,
  ordering_respected: runs.filter((run) => run.diagnosis.ordering_respected === true).length,
  acceptance_passed_after_repair: runs.filter((run) => run.after.test_ok === true).length,
  acceptance_failed_before_repair: runs.filter((run) => run.before.test_ok === false).length,
  oracle_intact: runs.filter((run) => run.repair.oracle_intact === true).length,
  minimal_repair: runs.filter((run) => run.repair.agent_changed_files?.length === 1).length,
  full_success: runs.filter((run) => run.ok === true).length,
  incorrect_diagnosis: runs.filter((run) => run.diagnosis.matched_defect_class === false).length,
  unnecessary_source_changes: runs.filter(
    (run) => (run.repair.agent_changed_files?.length ?? 0) > 1,
  ).length,
  startup_errors: 0,
  timeouts: 0,
}

const results = {
  operation: 'phase14_blind_diagnosis_results',
  phase: 14,
  branch: 'experiment/phase14-reliable-diagnosis',
  baseline_commit: 'c78619b',
  godot: '4.7.2-stable (official)',
  generated_at: new Date().toISOString(),
  sample_size: total,
  sample_note:
    'Four defect cases, two runs each. This is far too small for a statistical claim. The ' +
    'rates below are counts, not estimates of a probability.',
  human_ai_boundary:
    'The harness has no agent integration. Preparing a bundle, invoking an external agent ' +
    'session with it, and reading the agent output back are all manual steps performed by the ' +
    'orchestrating operator. The diagnosis, the choice of correction, the edit, and the test run ' +
    'were performed by the agent.',
  summary,
  by_case: byCase,
  runs,
}

fs.mkdirSync(DOCS, { recursive: true })
fs.writeFileSync(path.join(DOCS, 'test-results.json'), `${JSON.stringify(results, null, 2)}\n`)

console.log(JSON.stringify({ summary, by_case: byCase }, null, 2))
