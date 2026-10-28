import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession, runTests } from './harness.mjs'
import { copyCaptureFile, resolveOutputDir, writeJsonFile } from './evidence-output.mjs'

/**
 * Phase 13 evidence-driven diagnosis benchmark.
 *
 * `prepare` runs the dedicated Phase 13 fixture, records the failing
 * acceptance test and a live evidence bundle, and writes the task description
 * for the diagnosing agent. The bundle deliberately contains NO source code,
 * NO diff, and NO answer key: only the failing test output, fresh visual
 * observations, structured runtime state and events, and physics-query results.
 *
 * `verify` re-runs the same acceptance test and the same live scenario after
 * the repair, and records the before/after comparison.
 *
 * The agent is expected to write its diagnosis to `diagnosis.md` before it
 * looks at the fixture source, so the diagnosis can be checked against the
 * evidence rather than against the answer.
 */

const PROJECT = 'fixtures/phase13-defect'
const TEST_SCRIPT = 'res://tests/run_observation.gd'
const PLATE_CENTER = [0, 0.1, -1.1]
const PLATE_SIZE = [1.8, 0.2, 2.2]
const GATE_CENTER = [0, 1.3, -2.5]
const APPROACH_FRAMES = 85
const OBSERVATION_TARGETS = ['/root/Main', '/root/Main/Player', '/root/Main/Plate', '/root/Main/Gate']
const STATE_PROPERTIES = [
  'plate_pressed',
  'gate_open',
  'gate_collision_enabled',
  'beacon_state',
  'feedback',
  'prompt',
  'goal_reached',
]

// The controlled defect, and the line that repairs it. The committed state of
// the fixture is repaired; `inject` puts the defect back so the benchmark can
// be reproduced from a clean checkout.
const WORLD_FILE = path.join(
  path.resolve(HARNESS_ROOT, PROJECT),
  'scripts',
  'observation_world.gd',
)
const DEFECTIVE_LINE = '\tif not is_instance_valid(player) or body == player or plate_pressed:'
const REPAIRED_LINE = '\tif not is_instance_valid(player) or body != player or plate_pressed:'

/**
 * Set the fixture's plate-handler line to the defective or the repaired form.
 * Exactly one occurrence must be present, so a silent no-op is impossible.
 */
function setDefectState(defective) {
  const source = fs.readFileSync(WORLD_FILE, 'utf8')
  const from = defective ? REPAIRED_LINE : DEFECTIVE_LINE
  const to = defective ? DEFECTIVE_LINE : REPAIRED_LINE
  const count = source.split(from).length - 1
  if (count !== 1) {
    throw new Error(
      `expected exactly one occurrence of the ${defective ? 'repaired' : 'defective'} line, ` +
        `found ${count} in ${WORLD_FILE}`,
    )
  }
  fs.writeFileSync(WORLD_FILE, source.replace(from, to))
  return { file: path.relative(path.resolve(HARNESS_ROOT, '..', '..'), WORLD_FILE), defective }
}

function idleInput(overrides = {}) {
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    actions: { interact: false },
    ...overrides,
    actions: { interact: false, ...(overrides.actions || {}) },
  }
}

function parseArgs(argv) {
  const options = { mode: argv[0] || 'prepare', outDir: null, runner: 'diagnosis-benchmark' }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--runner') options.runner = argv[++i]
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!['prepare', 'verify', 'inject', 'repair', 'status'].includes(options.mode)) {
    throw new Error('mode must be "prepare", "verify", "inject", "repair", or "status"')
  }
  return options
}

function stateSummary(snapshot) {
  return {
    step: snapshot.step,
    physics_frames: snapshot.physics_frames,
    player_position: snapshot.player_position,
    plate_pressed: snapshot.plate_pressed,
    gate_open: snapshot.gate_open,
    gate_collision_enabled: snapshot.gate_collision_enabled,
    beacon_state: snapshot.beacon_state,
    goal_reached: snapshot.goal_reached,
    feedback: snapshot.feedback,
    prompt: snapshot.prompt,
    event_count: snapshot.events_count,
    event_types: snapshot.events_count ? [snapshot.last_event_type] : [],
    hash: snapshot.hash,
    outcome_hash: snapshot.outcome_hash,
  }
}

/**
 * Run the same live scenario every time: walk the player onto the pressure
 * plate, then observe the resulting state, the recorded events, and what the
 * physics space says is actually standing on the plate.
 */
async function collectLiveEvidence(session, { runId, outDir, label }) {
  await session.pause()
  await session.reset()
  await session.advancePhysics({ frames: 3, input: idleInput() })
  await session.advancePhysics({ frames: APPROACH_FRAMES, input: idleInput({ forward: 1 }) })
  await session.pause()

  const snapshot = await session.snapshot()
  const observation = await session.observe({
    targets: OBSERVATION_TARGETS,
    properties: STATE_PROPERTIES,
    descendants: 0,
    sinceTick: 0,
  })
  const capture = await session.captureFrame({
    path: `res://artifacts/phase13-${label}.png`,
    scenario: `phase 13 diagnosis benchmark: ${label}`,
    runId,
    metadata: { stage: 'phase13-c', checkpoint: label },
  })
  const screenshot = copyCaptureFile(outDir, `${label}.png`, capture)

  // Physics-space facts about the plate and the gate.
  const plateQuery = await session.physicsQuery({
    shape_type: 'box',
    transform: { origin: PLATE_CENTER },
    size: PLATE_SIZE,
  })
  const gateQuery = await session.physicsQuery({
    shape_type: 'box',
    transform: { origin: GATE_CENTER },
    size: [4, 2.6, 0.3],
  })

  const observedPlayer = observation.nodes.find((node) => node.path === '/root/Main/Player')
  const observedPlate = observation.nodes.find((node) => node.path === '/root/Main/Plate')
  const observedGate = observation.nodes.find((node) => node.path === '/root/Main/Gate')

  return {
    label,
    captured_at: capture.captured_at,
    engine_tick: capture.tick,
    simulation_step: capture.simulation_step,
    screenshot,
    state: stateSummary(snapshot),
    observation: {
      engine_tick: observation.runtime.tick,
      node_count: observation.nodes.length,
      event_count: observation.events.count,
      event_types: [...new Set(observation.events.items.map((event) => event.type))],
      event_items: observation.events.items,
      player_world_origin: observedPlayer ? observedPlayer.global_transform.origin : null,
      player_colliders: observedPlayer
        ? (observedPlayer.collision_shapes || []).map((shape) => shape.shape_class)
        : null,
      main_properties: observation.nodes[0].properties.values,
      plate_collision: observedPlate ? observedPlate.collision : null,
      gate_collision: observedGate ? observedGate.collision : null,
    },
    physics_queries: {
      plate_volume: {
        description: 'box query covering the pressure plate volume at (0, 0.10, -1.1)',
        shape_type: plateQuery.shape_type,
        collision_mask: plateQuery.collision_mask,
        results: plateQuery.results,
      },
      gate_volume: {
        description: 'box query covering the closed gate at (0, 1.30, -2.5)',
        shape_type: gateQuery.shape_type,
        collision_mask: gateQuery.collision_mask,
        results: gateQuery.results,
      },
    },
  }
}

function taskDescription(outDir) {
  return `# Phase 13 diagnosis task

A Godot game scene is failing its acceptance suite. You are given the failing
test output, fresh screenshots of the running game, the structured runtime
state, the recorded event stream, and physics-space query results.

Your job:

1. State a **falsifiable diagnosis** that is supported by the collected
   evidence. Name the specific contradiction you can see in the data.
2. Identify the **smallest proposed correction**.
3. Implement that correction in the isolated worktree.
4. Run the **same acceptance test** that failed before the repair and show it
   now passes.
5. Verify the expected runtime change.

## What you may read

Only the evidence files in this directory:

- \`${outDir}/evidence/test-output.txt\` - the failing acceptance test output
- \`${outDir}/evidence/observation.json\` - structured runtime state and events
- \`${outDir}/evidence/physics-queries.json\` - physics-space query results
- \`${outDir}/evidence/frame-on-plate.png\` - a fresh screenshot of the running game
- \`${outDir}/evidence/state.json\` - the fixture snapshot at that moment

## What you must not read before diagnosing

The fixture source under \`experiments/godot-harness/fixtures/phase13-defect/\`
contains the defect. **Do not open it until you have written your diagnosis.**

Write your evidence-only diagnosis to:

- \`${outDir}/diagnosis.md\`

That file must start with the H1 title "# Phase 13 diagnosis" and must contain:

- **Failure** - what failed, quoting the specific evidence values
- **Contradiction** - the falsifiable claim, and which two observations conflict
- **Hypotheses ruled out** - alternatives and the evidence that excludes them
- **Proposed correction** - the smallest change you intend to make
- **Confidence** - and what extra evidence would raise it

Only after \`diagnosis.md\` exists may you read the fixture source, locate the
defect, apply the fix, and re-run the test.

## Commands

\`\`\`powershell
cd C:\\Users\\<user>\\ai-native-engine-phase13\\experiments\\godot-harness
node controller/harness.mjs test --project fixtures/phase13-defect --script res://tests/run_observation.gd --json
\`\`\`

The fixture is \`fixtures/phase13-defect\`. The acceptance script is
\`res://tests/run_observation.gd\` and must not be modified.
`
}

async function main() {
  const options = parseArgs(process.argv.slice(2))

  // The inject / repair / status modes manage the controlled defect itself and
  // do not collect evidence.
  if (['inject', 'repair', 'status'].includes(options.mode)) {
    const source = fs.readFileSync(WORLD_FILE, 'utf8')
    const state = source.includes(DEFECTIVE_LINE)
      ? 'defective'
      : source.includes(REPAIRED_LINE)
        ? 'repaired'
        : 'unknown'
    if (options.mode === 'status') {
      console.log(JSON.stringify({ state, file: WORLD_FILE }, null, 2))
      return
    }
    const changed = setDefectState(options.mode === 'inject')
    const test = await runTests({ project: PROJECT, script: TEST_SCRIPT, timeoutMs: 60000 })
    console.log(
      JSON.stringify(
        {
          mode: options.mode,
          file: changed.file,
          previous_state: state,
          new_state: changed.defective ? 'defective' : 'repaired',
          test_exit_code: test.exitCode,
          test_ok: test.ok,
          test_summary: test.summary,
        },
        null,
        2,
      ),
    )
    if (options.mode === 'inject' && test.ok) {
      console.error('the injected defect did not break the acceptance suite')
      process.exitCode = 1
    }
    if (options.mode === 'repair' && !test.ok) {
      console.error('the repaired fixture still fails its acceptance suite')
      process.exitCode = 1
    }
    return
  }

  const outDir = resolveOutputDir({
    outDir: options.outDir,
    runner: options.runner,
    stamp: new Date().toISOString().replace(/[:.]/g, '-'),
  })
  const evidenceDir = path.join(outDir, 'evidence')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const runId = `phase13-${crypto.randomUUID()}`
  const report = {
    operation: `phase13_diagnosis_${options.mode}`,
    mode: options.mode,
    ok: false,
    run_id: runId,
    project: PROJECT,
    test_script: TEST_SCRIPT,
    output_dir: outDir,
    started_at: new Date().toISOString(),
    finished_at: null,
    test: null,
    live: null,
    stop: null,
    error: null,
  }

  const session = new HarnessSession({ project: PROJECT, headless: false })
  try {
    const test = await runTests({ project: PROJECT, script: TEST_SCRIPT, timeoutMs: 60000 })
    report.test = {
      exit_code: test.exitCode,
      ok: test.ok,
      summary: test.summary,
      results: test.results,
      reason: test.reason,
    }
    fs.writeFileSync(
      path.join(evidenceDir, 'test-output.txt'),
      `${test.stdout}\n${test.stderr}`,
      'utf8',
    )
    writeJsonFile(evidenceDir, 'test-result.json', report.test)

    const started = await session.startProject()
    assert.equal(started.ok, true)
    report.godot = started.ping.godot
    report.pid = started.pid

    const live = await collectLiveEvidence(session, {
      runId,
      outDir: evidenceDir,
      label: options.mode === 'prepare' ? 'frame-on-plate' : 'frame-after-repair',
    })
    report.live = live
    writeJsonFile(evidenceDir, 'observation.json', live.observation)
    writeJsonFile(evidenceDir, 'physics-queries.json', live.physics_queries)
    writeJsonFile(evidenceDir, 'state.json', live.state)

    if (options.mode === 'prepare') {
      fs.writeFileSync(path.join(outDir, 'task.md'), taskDescription(outDir), 'utf8')
      // The defect must actually break the suite, otherwise the benchmark is
      // measuring nothing.
      assert.equal(test.ok, false, 'the defective fixture must fail its acceptance test')
      assert.ok(
        test.results.some((result) => !result.passed),
        'at least one acceptance case must fail before the repair',
      )
    } else {
      assert.equal(test.ok, true, 'the repaired fixture must pass its acceptance test')
      assert.equal(
        test.summary.failed,
        0,
        `the repaired fixture must have no failing case, got ${test.summary.failed}`,
      )
    }

    report.ok = true
    console.log(
      JSON.stringify(
        {
          ok: report.ok,
          mode: options.mode,
          output_dir: outDir,
          test_ok: test.ok,
          test_summary: test.summary,
          plate_pressed: live.state.plate_pressed,
          gate_open: live.state.gate_open,
          event_types: live.observation.event_types,
          plate_volume_colliders: live.physics_queries.plate_volume.results.map(
            (result) => result.collider,
          ),
        },
        null,
        2,
      ),
    )
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    console.error(`DIAGNOSIS BENCHMARK (${options.mode}) FAILED: ${report.error}`)
    process.exitCode = 1
  } finally {
    report.finished_at = new Date().toISOString()
    report.stop = await session.stop()
    writeJsonFile(outDir, `${options.mode}-report.json`, report)
  }
}

await main()
