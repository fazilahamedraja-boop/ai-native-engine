import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, runTests } from './harness.mjs'

const PROJECT = 'fixtures/physics'
const SCRIPT = 'res://tests/run_physics.gd'
const RUN_COUNT = 5
const EVIDENCE_DIR = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase9')
const REPO_ROOT = path.resolve(HARNESS_ROOT, '..', '..')

function parsePhysicsSummary(stdout) {
  const line = stdout
    .split(/\r?\n/)
    .find((candidate) => candidate.startsWith('PHYSICS_SUMMARY '))
  if (!line) throw new Error('physics suite did not emit PHYSICS_SUMMARY')
  return JSON.parse(line.slice('PHYSICS_SUMMARY '.length))
}

function selected(snapshot) {
  if (!snapshot) return null
  return {
    step: snapshot.step,
    player_position: snapshot.player_position,
    player_velocity: snapshot.player_velocity,
    player_motion: snapshot.player_motion,
    grounded: snapshot.grounded,
    wall_contact: snapshot.wall_contact,
    wall_clearance: snapshot.wall_clearance,
    wall_collision_enabled: snapshot.wall_collision_enabled,
    last_delta: snapshot.last_delta,
    exact_hash: snapshot.hash,
    outcome_hash: snapshot.outcome_hash,
    hud: snapshot.hud,
  }
}

function compactScenarios(trace) {
  return {
    wall: selected(trace.wall),
    no_pass_through: selected(trace.no_pass_through),
    slide: selected(trace.slide),
    jump: {
      takeoff: selected(trace.jump?.takeoff),
      air: selected(trace.jump?.air),
      land: selected(trace.jump?.land),
    },
    reset: {
      immediate: selected(trace.reset?.immediate),
      settled: selected(trace.reset?.settled),
    },
    missing_collision: selected(trace.missing_collision),
    same_process_repeatability: trace.repeatability
      ? {
          exact_hash_match: trace.repeatability.exact_hash_match,
          outcome_hash_match: trace.repeatability.outcome_hash_match,
          position_delta: trace.repeatability.position_delta,
          first: selected(trace.repeatability.first),
          second: selected(trace.repeatability.second),
        }
      : null,
  }
}

function outcomeHashes(scenarios) {
  return {
    wall: scenarios.wall?.outcome_hash,
    no_pass_through: scenarios.no_pass_through?.outcome_hash,
    slide: scenarios.slide?.outcome_hash,
    jump_land: scenarios.jump.land?.outcome_hash,
    reset_settled: scenarios.reset.settled?.outcome_hash,
    missing_collision: scenarios.missing_collision?.outcome_hash,
  }
}

function exactHashes(scenarios) {
  return {
    wall: scenarios.wall?.exact_hash,
    no_pass_through: scenarios.no_pass_through?.exact_hash,
    slide: scenarios.slide?.exact_hash,
    jump_land: scenarios.jump.land?.exact_hash,
    reset_settled: scenarios.reset.settled?.exact_hash,
    missing_collision: scenarios.missing_collision?.exact_hash,
  }
}

function allEqual(values) {
  return values.length > 0 && values.every((value) => value === values[0])
}

function maxPositionDelta(runs, pathParts) {
  const first = pathParts.reduce((value, key) => value?.[key], runs[0].scenarios)
  if (!first?.player_position) return null
  let max = 0
  for (const run of runs.slice(1)) {
    const current = pathParts.reduce((value, key) => value?.[key], run.scenarios)
    if (!current?.player_position) return null
    for (let index = 0; index < 3; index++) {
      max = Math.max(max, Math.abs(current.player_position[index] - first.player_position[index]))
    }
  }
  return max
}

function readCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

async function main() {
  const startedAt = new Date()
  const runs = []

  for (let index = 1; index <= RUN_COUNT; index++) {
    const command = `node controller/harness.mjs test --project ${PROJECT} --script ${SCRIPT}`
    const result = await runTests({
      project: PROJECT,
      script: SCRIPT,
      timeoutMs: 120000,
    })
    const summary = parsePhysicsSummary(result.stdout)
    const scenarios = compactScenarios(summary.trace)
    const logName = `stage-e-run-${index}.log`
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
    fs.writeFileSync(
      path.join(EVIDENCE_DIR, logName),
      [
        `command: ${command}`,
        `started_at: ${new Date().toISOString()}`,
        `exit_code: ${result.exitCode}`,
        `duration_ms: ${result.durationMs}`,
        '',
        result.stdout,
        result.stderr ? `\nSTDERR:\n${result.stderr}` : '',
      ].join('\n'),
    )

    runs.push({
      index,
      command,
      ok: result.ok,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
      timedOut: result.timedOut,
      summary: result.summary,
      errors: result.errors,
      warnings: result.warnings,
      cases: summary.cases,
      physics_ticks_per_second: summary.physics_ticks_per_second,
      godot: summary.godot,
      scenarios,
      outcome_hashes: outcomeHashes(scenarios),
      exact_hashes: exactHashes(scenarios),
      log: path.join('docs', 'phase9', logName),
    })
  }

  const allCasesOk = runs.every((run) => run.ok && run.cases.every((item) => item.ok))
  const outcomeKeys = Object.keys(runs[0].outcome_hashes)
  const outcomeHashesRepeatable = Object.fromEntries(
    outcomeKeys.map((key) => [key, allEqual(runs.map((run) => run.outcome_hashes[key]))]),
  )
  const exactHashesRepeatable = Object.fromEntries(
    outcomeKeys.map((key) => [key, allEqual(runs.map((run) => run.exact_hashes[key]))]),
  )
  const positionDeltas = {
    wall_z: maxPositionDelta(runs, ['wall']),
    slide_x: maxPositionDelta(runs, ['slide']),
    jump_air_y: maxPositionDelta(runs, ['jump', 'air']),
    missing_wall_z: maxPositionDelta(runs, ['missing_collision']),
  }
  const maxPositionDeltaValue = Math.max(
    ...Object.values(positionDeltas).filter((value) => value !== null),
  )
  const gameplayOutcomesRepeatable = Object.values(outcomeHashesRepeatable).every(Boolean)
  const selectedFieldsRepeatable = maxPositionDeltaValue <= 0.001
  const exactHashesRepeatableAll = Object.values(exactHashesRepeatable).every(Boolean)

  const evidence = {
    operation: 'stage_e_physics_repeatability',
    ok: allCasesOk && gameplayOutcomesRepeatable && selectedFieldsRepeatable,
    baseline_commit: readCommit(),
    project: PROJECT,
    script: SCRIPT,
    command: `node controller/harness.mjs test --project ${PROJECT} --script ${SCRIPT}`,
    run_count: RUN_COUNT,
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    godot: runs[0].godot,
    physics_ticks_per_second: runs[0].physics_ticks_per_second,
    execution: 'fresh Godot process per run; normal fixed 60 Hz physics; no paused manual step',
    claims: {
      gameplay_outcomes_repeatable: gameplayOutcomesRepeatable,
      selected_state_fields_repeatable_within_1mm: selectedFieldsRepeatable,
      exact_state_hashes_repeatable: exactHashesRepeatableAll,
      general_physics_determinism: false,
    },
    outcome_hashes_repeatable: outcomeHashesRepeatable,
    exact_hashes_repeatable: exactHashesRepeatable,
    position_deltas: positionDeltas,
    max_position_delta: maxPositionDeltaValue,
    runs,
    limitations: [
      'The fixture exercises one capsule CharacterBody3D, one flat ground box, one wall box, and move_and_slide() at the engine default 60 Hz.',
      'Exact floating-point state hashes are recorded as diagnostics and are not the repeatability claim. Outcome hashes quantize positions and velocities to 0.001.',
      'This does not establish general Godot physics determinism, other collision shapes, moving platforms, multiple bodies, or different tick rates.',
      'The bridge remains a loopback, unauthenticated local control surface.',
      'Real physics advance waits for engine ticks and therefore runs in wall-clock time; elapsed time is not a performance benchmark.',
    ],
  }

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(EVIDENCE_DIR, 'stage-e-physics.json'),
    `${JSON.stringify(evidence, null, 2)}\n`,
  )

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: evidence.ok,
        claims: evidence.claims,
        outcome_hashes_repeatable: outcomeHashesRepeatable,
        exact_hashes_repeatable: exactHashesRepeatable,
        position_deltas: positionDeltas,
        evidence: path.join(EVIDENCE_DIR, 'stage-e-physics.json'),
      },
      null,
      2,
    )}\n`,
  )
  process.exitCode = evidence.ok ? 0 : 1
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 2
})
