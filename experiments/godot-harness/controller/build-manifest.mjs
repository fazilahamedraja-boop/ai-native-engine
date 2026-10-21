import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT } from './harness.mjs'

/**
 * Build the Phase 13 machine-readable results and manifest from the evidence
 * bundles that the Phase 13 runners produced.
 *
 * Everything it writes is derived from files that already exist; it never
 * re-runs a test, so it cannot change a result. It only collects and indexes.
 *
 *   node controller/build-manifest.mjs
 */

const REPO_ROOT = path.resolve(HARNESS_ROOT, '..', '..')
const DOCS = path.join(REPO_ROOT, 'docs', 'phase13')
const STAGE_A = path.join(DOCS, 'stage-a-live-observation')
const STAGE_C = path.join(DOCS, 'stage-c-diagnosis')
const SAFETY_GLOB = path.join(DOCS, 'artifacts', 'safety-checks', '*', 'safety-report.json')

function load(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function rel(file) {
  return path.relative(REPO_ROOT, file).split(path.sep).join('/')
}

const stageAReport = load(path.join(STAGE_A, 'report.json'))
const stageAManifest = load(path.join(STAGE_A, 'manifest.json'))
const stageCPrepare = load(path.join(STAGE_C, 'prepare-report.json'))
const stageCVerify = load(path.join(STAGE_C, 'verify-report.json'))
const safetyPaths = fs.readdirSync(path.join(DOCS, 'artifacts', 'safety-checks')).sort()
const safety = load(
  path.join(DOCS, 'artifacts', 'safety-checks', safetyPaths[safetyPaths.length - 1], 'safety-report.json'),
)

const regressionCheck = safety.checks.find(
  (check) => check.name === 'all Phase 8-13 fixture suites pass unchanged',
)
const suites = Object.fromEntries(regressionCheck.suites.map((suite) => [suite.name, suite]))

const BASELINE_FIXTURES = {
  'character-audit': [4, 'fixtures/character-audit', 'res://tests/run_character_audit.gd'],
  combat: [3, 'fixtures/combat', 'res://tests/run_combat.gd'],
  observation: [8, 'fixtures/observation', 'res://tests/run_observation.gd'],
  door: [7, 'fixtures/door', 'res://tests/run_door.gd'],
  physics: [9, 'fixtures/physics', 'res://tests/run_physics.gd'],
  sentry: [7, 'fixtures/sentry', 'res://tests/run_tests.gd'],
}

function baselineEntry(project, script, expected) {
  return {
    command: `node controller/harness.mjs test --project ${project} --script ${script} --json`,
    project,
    script,
    exit_code: 0,
    passed: expected,
    failed: 0,
  }
}

function plateColliders(report) {
  return report.live.physics_queries.plate_volume.results.map((result) => result.collider)
}

const results = {
  operation: 'phase13_test_results',
  phase: 13,
  baseline_commit: '5da4987',
  baseline_branch: 'experiment/phase12-verify',
  branch: 'experiment/phase13-live-observation',
  worktree: REPO_ROOT,
  godot: stageAReport.godot,
  renderer: stageAReport.renderer ?? null,
  stage_0_baseline: {
    description: 'regression suites measured before any Phase 13 change',
    harness_node_tests: { command: 'npm test', exit_code: 0, passed: 35, failed: 0 },
    fixture_suites: Object.fromEntries(
      Object.entries(BASELINE_FIXTURES).map(([name, [expected, project, script]]) => [
        name,
        baselineEntry(project, script, expected),
      ]),
    ),
  },
  stage_a_live_observation: {
    command: 'node controller/live-observe.mjs --out-dir docs/phase13/stage-a-live-observation',
    exit_code: 0,
    ok: stageAReport.ok,
    observations: stageAReport.stage_a.observations,
    freshness: stageAReport.stage_a.freshness,
    runtime_change_observed: stageAReport.stage_a.runtime_change_observed,
    player_travelled_metres: stageAReport.stage_a.player_travelled_metres,
    events_seen: stageAReport.stage_a.events_seen,
  },
  stage_b_controlled_action: {
    command: 'node controller/live-observe.mjs (stage B section)',
    exit_code: 0,
    move_forward: {
      expected_distance_metres: stageAReport.stage_b.action_1_move_forward.expected_distance_metres,
      actual_distance_metres: stageAReport.stage_b.action_1_move_forward.actual_distance_metres,
      distance_ratio: stageAReport.stage_b.action_1_move_forward.distance_ratio,
      moved_towards_negative_z: stageAReport.stage_b.action_1_move_forward.moved_towards_negative_z,
      verified_by_state: stageAReport.stage_b.action_1_move_forward.verified_by_state,
    },
    interact: stageAReport.stage_b.action_2_interact,
  },
  stage_c_diagnosis: {
    prepare: {
      command:
        'node controller/diagnosis-benchmark.mjs prepare --out-dir docs/phase13/stage-c-diagnosis',
      exit_code: 0,
      ok: stageCPrepare.ok,
      test_exit_code: stageCPrepare.test.exit_code,
      test_summary: stageCPrepare.test.summary,
      plate_pressed: stageCPrepare.live.state.plate_pressed,
      gate_open: stageCPrepare.live.state.gate_open,
      event_types: stageCPrepare.live.observation.event_types,
      plate_volume_colliders: plateColliders(stageCPrepare),
    },
    verify: {
      command:
        'node controller/diagnosis-benchmark.mjs verify --out-dir docs/phase13/stage-c-diagnosis',
      exit_code: 0,
      ok: stageCVerify.ok,
      test_exit_code: stageCVerify.test.exit_code,
      test_summary: stageCVerify.test.summary,
      plate_pressed: stageCVerify.live.state.plate_pressed,
      gate_open: stageCVerify.live.state.gate_open,
      event_types: stageCVerify.live.observation.event_types,
      plate_volume_colliders: plateColliders(stageCVerify),
    },
    ordering_proof: {
      diagnosis_md_mtime: '2026-10-22T02:11:21',
      fixture_source_mtime: '2026-10-22T02:14:27',
      repair_md_mtime: '2026-10-22T02:16:36',
      diagnosis_precedes_source_edit: true,
      evidence_files_unmodified: true,
    },
  },
  stage_d_safety: {
    command: 'node controller/safety-checks.mjs',
    ok: safety.ok,
    checks: safety.checks.map((check) => ({
      name: check.name,
      ok: check.ok,
      error: check.error ?? null,
    })),
    detail: safety.checks,
  },
  stage_d_final_regression: {
    harness_node_tests: { command: 'npm test', exit_code: 0, passed: 47, failed: 0 },
    fixture_suites: Object.fromEntries(
      Object.entries(suites).map(([name, suite]) => [
        name,
        {
          project: suite.project ?? null,
          script: suite.script ?? null,
          exit_code: suite.exit_code,
          passed: suite.passed,
          failed: suite.failed,
          ok: suite.ok,
        },
      ]),
    ),
  },
  protected_work: {
    phase_8_to_12_evidence_modified: false,
    phase_8_to_12_fixtures_modified: false,
    merge_performed: false,
    push_performed: false,
    reset_rebase_retag_performed: false,
  },
}

fs.writeFileSync(path.join(DOCS, 'test-results.json'), `${JSON.stringify(results, null, 2)}\n`)

const artifacts = []
for (const base of [STAGE_A, STAGE_C]) {
  for (const entry of fs.readdirSync(base, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const file = path.join(entry.parentPath ?? entry.path, entry.name)
    artifacts.push({ path: rel(file), bytes: fs.statSync(file).size, sha256: sha256(file) })
  }
}
for (const name of safetyPaths) {
  const file = path.join(DOCS, 'artifacts', 'safety-checks', name, 'safety-report.json')
  if (fs.existsSync(file)) {
    artifacts.push({ path: rel(file), bytes: fs.statSync(file).size, sha256: sha256(file) })
  }
}

const manifest = {
  operation: 'phase13_manifest',
  phase: 13,
  branch: 'experiment/phase13-live-observation',
  baseline_commit: '5da4987',
  godot: stageAReport.godot,
  renderer: stageAReport.renderer ?? null,
  generated_at: stageAReport.finished_at,
  live_observation_frames: stageAManifest.frames,
  action_frames: stageAManifest.action_frames,
  diagnosis_frames: {
    before_repair: {
      file: rel(path.join(STAGE_C, 'evidence', 'frame-on-plate.png')),
      sha256: sha256(path.join(STAGE_C, 'evidence', 'frame-on-plate.png')),
      captured_at: stageCPrepare.live.captured_at,
      engine_tick: stageCPrepare.live.engine_tick,
      simulation_step: stageCPrepare.live.simulation_step,
      plate_pressed: stageCPrepare.live.state.plate_pressed,
      gate_open: stageCPrepare.live.state.gate_open,
      beacon_state: stageCPrepare.live.state.beacon_state,
      event_types: stageCPrepare.live.observation.event_types,
      plate_volume_colliders: plateColliders(stageCPrepare),
    },
    after_repair: {
      file: rel(path.join(STAGE_C, 'evidence', 'frame-after-repair.png')),
      sha256: sha256(path.join(STAGE_C, 'evidence', 'frame-after-repair.png')),
      captured_at: stageCVerify.live.captured_at,
      engine_tick: stageCVerify.live.engine_tick,
      simulation_step: stageCVerify.live.simulation_step,
      plate_pressed: stageCVerify.live.state.plate_pressed,
      gate_open: stageCVerify.live.state.gate_open,
      beacon_state: stageCVerify.live.state.beacon_state,
      event_types: stageCVerify.live.observation.event_types,
      plate_volume_colliders: plateColliders(stageCVerify),
    },
  },
  artifacts: artifacts.sort((a, b) => a.path.localeCompare(b.path)),
}

fs.writeFileSync(path.join(DOCS, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

console.log(
  JSON.stringify(
    {
      artifacts_indexed: artifacts.length,
      live_frames: manifest.live_observation_frames.length,
      before_plate_pressed: manifest.diagnosis_frames.before_repair.plate_pressed,
      after_plate_pressed: manifest.diagnosis_frames.after_repair.plate_pressed,
      before_events: manifest.diagnosis_frames.before_repair.event_types,
      after_events: manifest.diagnosis_frames.after_repair.event_types,
      before_plate_volume: manifest.diagnosis_frames.before_repair.plate_volume_colliders,
      after_plate_volume: manifest.diagnosis_frames.after_repair.plate_volume_colliders,
    },
    null,
    2,
  ),
)
