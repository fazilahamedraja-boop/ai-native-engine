import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession, runTests } from './harness.mjs'
import { copyCaptureFile, resolveOutputDir, writeJsonFile } from './evidence-output.mjs'
import { BLIND_CASES, BLIND_CASE_IDS } from './blind-cases.mjs'

/**
 * Phase 14 blind-diagnosis benchmark.
 *
 * `prepare` builds an ISOLATED copy of the observation fixture, injects one
 * controlled defect, runs the unchanged acceptance suite to record the
 * baseline failure, and writes an evidence bundle that contains no source, no
 * diff, and no answer key.
 *
 * `verify` re-runs the same acceptance suite and the same live scenario after
 * the agent's repair, and records the before/after comparison, the size of
 * the source change, and whether the diagnosis was written before the source
 * was first modified.
 *
 * `cleanup` removes the isolated fixture.
 *
 * The agent invocation itself is NOT automated: the harness has no agent-facing
 * entry point. That boundary is recorded in the Phase 14 report.
 */

const FIXTURES = path.join(HARNESS_ROOT, 'fixtures')
const STATE_FILE = 'case-state.json'

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const options = { mode: argv[0] || 'status', caseId: null, outDir: null, runner: 'blind-benchmark' }
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--case') options.caseId = argv[++i]
    else if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--runner') options.runner = argv[++i]
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!['prepare', 'verify', 'cleanup', 'status', 'list'].includes(options.mode)) {
    throw new Error('mode must be "prepare", "verify", "cleanup", "status", or "list"')
  }
  if (options.mode !== 'list' && !options.caseId) {
    throw new Error('--case is required')
  }
  if (options.caseId && !BLIND_CASES[options.caseId]) {
    throw new Error(`unknown case '${options.caseId}'. Known: ${BLIND_CASE_IDS.join(', ')}`)
  }
  return options
}

/** Copy an existing fixture into an isolated temporary directory. */
function createIsolatedFixture(sourceFixture) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `phase14-blind-${sourceFixture}-`))
  const dir = path.join(base, 'project')
  fs.cpSync(path.join(FIXTURES, sourceFixture), dir, { recursive: true })
  for (const entry of fs.readdirSync(dir)) {
    if (entry === '.godot' || entry === 'artifacts') {
      fs.rmSync(path.join(dir, entry), { recursive: true, force: true })
    }
  }
  return { base, dir }
}

/**
 * Give the isolated fixture the generic observation bridge.
 *
 * The door fixture keeps its own smaller bridge. Copying the observation
 * bridge in is the pattern the Phase 10 door-reuse test already uses, and it
 * leaves the door scene and its scripts untouched.
 */
function installObservationBridge(dir) {
  const source = path.join(FIXTURES, 'observation', 'harness', 'bridge.gd')
  const target = path.join(dir, 'harness', 'bridge.gd')
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  return { file: 'harness/bridge.gd', sha256: sha256(target) }
}

/** Apply the case's one-line defect. Exactly one occurrence must be replaced. */
function injectDefect(dir, injection) {
  const file = path.join(dir, injection.file)
  const source = fs.readFileSync(file, 'utf8')
  const count = source.split(injection.from).length - 1
  if (count !== 1) {
    throw new Error(
      `expected exactly one occurrence of the target line in ${injection.file}, found ${count}`,
    )
  }
  fs.writeFileSync(file, source.replace(injection.from, injection.to), 'utf8')
  return { file, sha256: sha256(file) }
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

const COMMON_STATE_FIELDS = [
  'step',
  'physics_frames',
  'player_position',
  'player_velocity',
  'feedback',
  'prompt',
  'hash',
  'outcome_hash',
]

/**
 * Summarise a fixture snapshot. The interesting fields differ per case - the
 * observation fixture talks about a plate and a gate, the door fixture about a
 * door - so the case supplies the list.
 */
function stateSummary(snapshot, caseDef) {
  const summary = {}
  for (const field of [...COMMON_STATE_FIELDS, ...caseDef.properties]) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) {
      summary[field] = snapshot[field]
    }
  }
  return summary
}

/**
 * Run the case's live scenario and collect the evidence the agent will see.
 * This is identical for the before and after runs, so the two are comparable.
 */
async function collectLiveEvidence(session, { caseDef, outDir, label, runId }) {
  await session.pause()
  await session.reset()
  for (const phase of caseDef.scenario.phases) {
    await session.advancePhysics({ frames: phase.frames, input: idleInput(phase.input) })
  }
  await session.pause()

  const snapshot = await session.snapshot()
  const observation = await session.observe({
    targets: caseDef.targets,
    properties: caseDef.properties,
    descendants: 0,
    sinceTick: 0,
  })
  const capture = await session.captureFrame({
    path: `res://artifacts/phase14-blind-${label}.png`,
    scenario: `phase 14 blind benchmark: ${label}`,
    runId,
    metadata: { stage: 'phase14-c', label },
  })
  const screenshot = copyCaptureFile(outDir, `${label}.png`, capture)

  const queries = []
  for (const query of caseDef.physicsQueries) {
    const result = await session.physicsQuery({
      shape_type: query.shape_type,
      transform: query.transform,
      size: query.size,
      radius: query.radius,
      height: query.height,
    })
    queries.push({
      name: query.name,
      description: query.description,
      shape_type: query.shape_type,
      collision_mask: result.collision_mask,
      results: result.results,
    })
  }

  const observed = {}
  for (const node of observation.nodes) {
    observed[node.path] = {
      class: node.class,
      global_transform: node.global_transform,
      properties: node.properties ? node.properties.values : null,
      collision: node.collision ?? null,
      collision_shapes: node.collision_shapes ?? null,
    }
  }

  return {
    label,
    captured_at: capture.captured_at,
    engine_tick: capture.tick,
    simulation_step: capture.simulation_step,
    screenshot,
    state: stateSummary(snapshot, caseDef),
    observation: {
      engine_tick: observation.runtime.tick,
      node_count: observation.nodes.length,
      event_count: observation.events.count,
      event_types: [...new Set(observation.events.items.map((event) => event.type))],
      event_items: observation.events.items,
      nodes: observed,
    },
    physics_queries: queries,
  }
}

function taskDescription(caseDef, outDir, state) {
  return `# Phase 14 blind diagnosis task

A Godot game scene is failing its acceptance suite. You are given the failing
test output, a fresh screenshot of the running game, the structured runtime
state, the recorded event stream, and physics-space query results.

Your job:

1. State a **falsifiable diagnosis** supported by the collected evidence. Name
   the specific contradiction you can see in the data.
2. Identify the **smallest proposed correction**.
3. Implement that correction in the isolated fixture.
4. Run the **same acceptance test** that failed before the repair and show it
   now passes.
5. Verify the expected runtime change.

## What you may read

Only the evidence files in this directory:

- \`${outDir}/evidence/test-output.txt\` - the failing acceptance test output
- \`${outDir}/evidence/observation.json\` - structured runtime state and events
- \`${outDir}/evidence/physics-queries.json\` - physics-space query results
- \`${outDir}/evidence/state.json\` - the fixture snapshot at that moment
- \`${outDir}/evidence/${state.label}.png\` - a fresh screenshot of the running game

## What you must not read before diagnosing

- The fixture source under \`${state.fixture_dir}\` contains the defect.
  **Do not open it until you have written your diagnosis.**
- \`experiments/godot-harness/controller/blind-cases.mjs\` is the answer key.
  **Do not open it at all.**

Write your evidence-only diagnosis to:

- \`${outDir}/diagnosis.md\`

That file must start with the H1 title "# Phase 14 blind diagnosis" and must contain:

- **Failure** - what failed, quoting the specific evidence values
- **Contradiction** - the falsifiable claim, and which two observations conflict
- **Hypotheses ruled out** - alternatives and the evidence that excludes them
- **Proposed correction** - the smallest change you intend to make
- **Confidence** - and what extra evidence would raise it

Only after \`diagnosis.md\` exists may you read the fixture source, locate the
defect, apply the fix, and re-run the test.

## The isolated fixture

- fixture directory: \`${state.fixture_dir}\`
- the one file that differs from the pristine observation fixture:
  \`${state.injected_file_relative}\`
- the acceptance script \`${state.test_script}\` is the oracle and **must not be
  modified**. It is byte-identical to the pristine one.

## Commands

\`\`\`powershell
cd ${HARNESS_ROOT}
node controller/harness.mjs test --project "${state.fixture_dir}" --script ${state.test_script} --json --allow-outside-root
\`\`\`

## Recording your work

- Diagnosis: \`${outDir}/diagnosis.md\`
- Repair record: \`${outDir}/repair.md\` - the exact line changed before and
  after, why it is the smallest correct correction, and the before/after test
  results.
`
}

async function prepare(options) {
  const caseDef = BLIND_CASES[options.caseId]
  const outDir = resolveOutputDir({
    outDir: options.outDir,
    runner: options.runner,
    stamp: `${options.caseId}-${nowStamp()}`,
  })
  const evidenceDir = path.join(outDir, 'evidence')
  fs.mkdirSync(evidenceDir, { recursive: true })
  const runId = `phase14-${options.caseId}-${crypto.randomUUID()}`

  const { base, dir } = createIsolatedFixture(caseDef.sourceFixture)
  const bridge = caseDef.bridgeSource ? installObservationBridge(dir) : null
  const injected = injectDefect(dir, caseDef.injection)
  const pristine = path.join(FIXTURES, caseDef.sourceFixture, caseDef.injection.file)

  const test = await runTests({
    project: dir,
    script: caseDef.testScript,
    timeoutMs: 60000,
    allowOutsideRoot: true,
  })
  fs.writeFileSync(
    path.join(evidenceDir, 'test-output.txt'),
    `${test.stdout}\n${test.stderr}`,
    'utf8',
  )
  writeJsonFile(evidenceDir, 'test-result.json', {
    exit_code: test.exitCode,
    ok: test.ok,
    summary: test.summary,
    results: test.results,
    reason: test.reason,
  })

  const session = new HarnessSession({
    project: dir,
    headless: false,
    allowOutsideRoot: true,
  })
  let live = null
  try {
    await session.startProject()
    live = await collectLiveEvidence(session, {
      caseDef,
      outDir: evidenceDir,
      label: 'before',
      runId,
    })
  } finally {
    await session.stop()
  }

  writeJsonFile(evidenceDir, 'observation.json', live.observation)
  writeJsonFile(evidenceDir, 'physics-queries.json', live.physics_queries)
  writeJsonFile(evidenceDir, 'state.json', live.state)

  const state = {
    case_id: options.caseId,
    defect_class: caseDef.defectClass,
    source_fixture: caseDef.sourceFixture,
    test_script: caseDef.testScript,
    bridge_replaced: bridge,
    fixture_dir: dir,
    fixture_base: base,
    injected_file_relative: caseDef.injection.file,
    injected_file: injected.file,
    injected_file_sha256: injected.sha256,
    pristine_file_sha256: sha256(pristine),
    source_modified_at_prepare: fs.statSync(injected.file).mtimeMs,
    label: 'before',
    test_summary: test.summary,
    test_ok: test.ok,
    failing_cases: test.results.filter((result) => !result.passed).map((result) => result.name),
    expected_failing_cases: caseDef.expectedFailingCases,
    output_dir: outDir,
  }
  writeJsonFile(outDir, STATE_FILE, state)
  fs.writeFileSync(path.join(outDir, 'task.md'), taskDescription(caseDef, outDir, state), 'utf8')

  // The defect must actually break the suite, otherwise the benchmark measures
  // nothing.
  assert.equal(test.ok, false, 'the defective fixture must fail its acceptance test')
  assert.ok(state.failing_cases.length > 0, 'at least one case must fail before the repair')

  return { state, live }
}

async function verify(options) {
  const outDir = options.outDir
  if (!outDir) throw new Error('--out-dir is required for verify')
  const statePath = path.join(outDir, STATE_FILE)
  if (!fs.existsSync(statePath)) {
    throw new Error(`no prepared case state at ${statePath}. Run prepare first.`)
  }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  const caseDef = BLIND_CASES[state.case_id]
  const dir = state.fixture_dir

  const test = await runTests({
    project: dir,
    script: caseDef.testScript,
    timeoutMs: 60000,
    allowOutsideRoot: true,
  })

  const session = new HarnessSession({
    project: dir,
    headless: false,
    allowOutsideRoot: true,
  })
  let live = null
  try {
    await session.startProject()
    live = await collectLiveEvidence(session, {
      caseDef,
      outDir: path.join(outDir, 'evidence'),
      label: 'after',
      runId: `phase14-${state.case_id}-${crypto.randomUUID()}`,
    })
  } finally {
    await session.stop()
  }

  // The size of the source change, measured against the pristine fixture.
  const changed = []
  const pristineRoot = path.join(FIXTURES, caseDef.sourceFixture)
  const walk = (relative) => {
    const file = path.join(dir, relative)
    if (!fs.existsSync(file)) return
    const pristineFile = path.join(pristineRoot, relative)
    if (!fs.existsSync(pristineFile)) {
      changed.push({ file: relative, kind: 'added' })
      return
    }
    if (sha256(file) !== sha256(pristineFile)) {
      changed.push({ file: relative, kind: 'modified' })
    }
  }
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (!entry.isFile()) continue
    const relative = path
      .relative(dir, path.join(entry.parentPath ?? entry.path, entry.name))
      .split(path.sep)
      .join('/')
    if (relative.startsWith('artifacts') || relative.startsWith('.godot')) continue
    walk(relative)
  }
  // The observation bridge copy is an expected part of the setup, not a change
  // the agent made.
  const expectedSetupChanges = caseDef.bridgeSource
    ? changed.filter((change) => change.file === 'harness/bridge.gd')
    : []
  const agentChanges = changed.filter(
    (change) => !expectedSetupChanges.some((expected) => expected.file === change.file),
  )

  // The acceptance script must be untouched.
  const oraclePath = path.join(dir, 'tests', path.basename(caseDef.testScript))
  const oraclePristine = path.join(pristineRoot, 'tests', path.basename(caseDef.testScript))
  const oracleIntact = sha256(oraclePath) === sha256(oraclePristine)

  // The diagnosis must have been written before the source was modified.
  const diagnosisPath = path.join(outDir, 'diagnosis.md')
  const diagnosisExists = fs.existsSync(diagnosisPath)
  const diagnosisMtime = diagnosisExists ? fs.statSync(diagnosisPath).mtimeMs : null
  const sourceMtime = fs.statSync(state.injected_file).mtimeMs
  const orderingRespected =
    diagnosisExists && diagnosisMtime <= sourceMtime

  // Did the stated diagnosis match the actual defect class?
  let diagnosisMatched = null
  if (diagnosisExists) {
    const text = fs.readFileSync(diagnosisPath, 'utf8').toLowerCase()
    diagnosisMatched = caseDef.diagnosisKeywords.some((keyword) => text.includes(keyword.toLowerCase()))
  }

  const result = {
    case_id: state.case_id,
    defect_class: caseDef.defectClass,
    output_dir: outDir,
    fixture_dir: dir,
    before: {
      test_ok: state.test_ok,
      test_summary: state.test_summary,
      failing_cases: state.failing_cases,
    },
    after: {
      test_ok: test.ok,
      test_exit_code: test.exitCode,
      test_summary: test.summary,
      failing_cases: test.results.filter((result) => !result.passed).map((result) => result.name),
    },
    repair: {
      changed_files: changed,
      agent_changed_files: agentChanges.map((change) => change.file),
      changed_file_count: agentChanges.length,
      setup_changed_files: expectedSetupChanges.map((change) => change.file),
      oracle_intact: oracleIntact,
    },
    diagnosis: {
      exists: diagnosisExists,
      mtime: diagnosisMtime,
      source_mtime: sourceMtime,
      ordering_respected: orderingRespected,
      matched_defect_class: diagnosisMatched,
    },
    runtime_change: {
      before_state: null,
      after_state: live.state,
    },
    ok:
      test.ok &&
      oracleIntact &&
      agentChanges.length === 1 &&
      agentChanges[0].file === state.injected_file_relative &&
      diagnosisExists &&
      orderingRespected,
  }
  // The before state is read from the recorded prepare manifest.
  const prepareStatePath = path.join(outDir, 'evidence', 'state.json')
  if (fs.existsSync(prepareStatePath)) {
    result.runtime_change.before_state = JSON.parse(fs.readFileSync(prepareStatePath, 'utf8'))
  }
  delete result.runtime_change.before

  writeJsonFile(outDir, 'result.json', result)
  return result
}

async function cleanup(options) {
  if (!options.outDir) throw new Error('--out-dir is required for cleanup')
  const statePath = path.join(options.outDir, STATE_FILE)
  if (!fs.existsSync(statePath)) return { removed: false }
  const state = JSON.parse(fs.readFileSync(statePath, 'utf8'))
  fs.rmSync(state.fixture_base, { recursive: true, force: true })
  return { removed: true, fixture_base: state.fixture_base }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.mode === 'list') {
    console.log(
      JSON.stringify(
        BLIND_CASE_IDS.map((id) => ({
          id,
          defect_class: BLIND_CASES[id].defectClass,
          summary: BLIND_CASES[id].summary,
        })),
        null,
        2,
      ),
    )
    return
  }
  if (options.mode === 'status') {
    const outDir = options.outDir
    const statePath = path.join(outDir, STATE_FILE)
    console.log(
      JSON.stringify(
        fs.existsSync(statePath)
          ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
          : { error: 'no prepared case at this out-dir' },
        null,
        2,
      ),
    )
    return
  }
  if (options.mode === 'prepare') {
    const { state } = await prepare(options)
    console.log(
      JSON.stringify(
        {
          ok: true,
          case_id: state.case_id,
          defect_class: state.defect_class,
          output_dir: state.output_dir,
          fixture_dir: state.fixture_dir,
          test_ok: state.test_ok,
          test_summary: state.test_summary,
          failing_cases: state.failing_cases,
        },
        null,
        2,
      ),
    )
    return
  }
  if (options.mode === 'verify') {
    const result = await verify(options)
    console.log(JSON.stringify(result, null, 2))
    if (!result.ok) process.exitCode = 1
    return
  }
  const removed = await cleanup(options)
  console.log(JSON.stringify({ ok: true, ...removed }, null, 2))
}

await main()
