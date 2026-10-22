/**
 * Phase 15 agent adapter.
 *
 * Drives a real OpenCode session (noninteractive `opencode run`) through the
 * Phase 14 controlled-defect loop:
 *
 *   prepare -> diagnosis (evidence only) -> validate diagnosis -> grant source
 *   -> repair -> verify with the Godot harness -> cleanup
 *
 * The agent never sees the answer key (`blind-cases.mjs`), the defective source
 * before it has produced a diagnosis, the original repository, or any directory
 * outside its per-run sandbox. Isolation is enforced by OpenCode's own
 * permission engine with a private config root and a private server per run;
 * see docs/phase15/isolation-design.md for the verified mechanism and limits.
 *
 * This runner is deliberately fail-safe: a nonzero exit, a timeout, a missing
 * or implausible diagnosis, a modified test oracle, or a failed acceptance run
 * ends the run with status "failed" and a recorded reason. It never retries
 * with a different model and never fabricates a diagnosis.
 */

import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { BLIND_CASES, BLIND_CASE_IDS } from './blind-cases.mjs'
import { HARNESS_ROOT, runTests } from './harness.mjs'
import { REPO_ROOT, sha256, writeJsonFile } from './evidence-output.mjs'

const PHASE15_RUNS = path.join(REPO_ROOT, 'docs', 'phase15', 'runs')
const SANDBOX_CONFIG_SOURCE = path.join(HARNESS_ROOT, 'controller', 'agent-sandbox', 'opencode.json')
const SANDBOX_CONFIG_RELATIVE = path.join('opencode', 'opencode.json')
const BLIND_BENCHMARK = path.join(HARNESS_ROOT, 'controller', 'blind-benchmark.mjs')
const DEFAULT_TIMEOUT_MS = 300000

const PROTECTED_PHASE_DIRS = [
  'contact-sheets',
  'phase3',
  'phase4',
  'phase5',
  'phase8',
  'phase9',
  'phase10',
  'phase11',
  'phase12',
  'phase12-verification',
  'phase13',
  'phase14',
]

const REQUIRED_DIAGNOSIS_SECTIONS = [
  'Failure',
  'Contradiction',
  'Hypotheses ruled out',
  'Proposed correction',
  'Confidence',
]

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const command = argv[0] || 'list'
  const options = {
    command,
    caseId: null,
    model: null,
    label: 'run',
    outDir: null,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--case') options.caseId = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--label') options.label = argv[++i]
    else if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!['list', 'run'].includes(options.command)) {
    throw new Error('command must be "run" or "list"')
  }
  if (options.command === 'run') {
    if (!options.caseId || !BLIND_CASES[options.caseId]) {
      throw new Error(`--case must be one of: ${BLIND_CASE_IDS.join(', ')}`)
    }
    if (!options.model) throw new Error('--model provider/model is required (no default is assumed)')
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
      throw new Error('--timeout-ms must be a positive number')
    }
  }
  return options
}

function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Evidence from earlier phases is read-only for this runner. Refuse to write
 * anywhere except docs/phase15/runs.
 */
function assertPhase15OutputDir(dir) {
  const resolved = path.resolve(dir)
  if (!isInside(resolved, PHASE15_RUNS)) {
    throw new Error(`output directory must be inside ${PHASE15_RUNS}`)
  }
  for (const phase of PROTECTED_PHASE_DIRS) {
    if (isInside(resolved, path.join(REPO_ROOT, 'docs', phase))) {
      throw new Error(`output directory must not be inside protected evidence docs/${phase}`)
    }
  }
  return resolved
}

function resolveOpencodeBin() {
  if (process.env.OPENCODE_BIN) return process.env.OPENCODE_BIN
  const candidates = [
    path.join(process.env.APPDATA || '', 'npm', 'node_modules', '@opencode', 'cli', 'bin', 'opencode.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'opencode', 'bin', 'opencode.exe'),
  ]
  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) return candidate
  }
  const where = spawnSync('where', ['opencode'], { encoding: 'utf8', windowsHide: true })
  const first = (where.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.toLowerCase().endsWith('.exe'))
  if (first && fs.existsSync(first)) return first
  throw new Error('could not locate an opencode executable; set OPENCODE_BIN')
}

function killTree(pid) {
  if (!pid) return
  try {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore',
    })
  } catch {
    // Best effort: the process may already be gone.
  }
}

/**
 * Run one noninteractive OpenCode session with a hard wall-clock bound.
 * The whole process tree is killed on timeout, not just the shim.
 */
function runOpencode({ bin, args, cwd, env, timeoutMs, pids }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(bin, args, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (pids) pids.push(child.pid)
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      killTree(child.pid)
    }, timeoutMs)
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({
        code: null,
        signal: null,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr: `${stderr}\nspawn error: ${error.message}`,
      })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      if (timedOut) killTree(child.pid)
      resolve({
        code,
        signal,
        timedOut,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
      })
    })
  })
}

function runBlindPrepare({ caseId, outDir }) {
  const result = spawnSync(
    process.execPath,
    [BLIND_BENCHMARK, 'prepare', '--case', caseId, '--out-dir', outDir],
    { cwd: HARNESS_ROOT, encoding: 'utf8', windowsHide: true, timeout: 240000 },
  )
  if (result.status !== 0) {
    throw new Error(
      `blind-benchmark prepare failed (exit ${result.status}): ${(result.stderr || '').slice(0, 2000)}`,
    )
  }
  const statePath = path.join(outDir, 'case-state.json')
  if (!fs.existsSync(statePath)) throw new Error(`prepare did not write ${statePath}`)
  return JSON.parse(fs.readFileSync(statePath, 'utf8'))
}

function runBlindCleanup({ outDir }) {
  spawnSync(process.execPath, [BLIND_BENCHMARK, 'cleanup', '--out-dir', outDir], {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  })
}

function copyDir(source, target, { skip = [] } = {}) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyDir(from, to)
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

function listFiles(root, relative = '') {
  const out = []
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const rel = path.join(relative, entry.name)
    if (entry.isDirectory()) out.push(...listFiles(root, rel))
    else if (entry.isFile()) out.push(rel.split(path.sep).join('/'))
  }
  return out
}

/**
 * The agent is given a *copy* of the defective fixture. Everything it may
 * change is inside that copy; the oracle scripts must come back byte-identical.
 */
function copyFixtureForAgent(state, sandboxDir) {
  const target = path.join(sandboxDir, 'project')
  copyDir(state.fixture_dir, target, { skip: ['.godot', 'artifacts'] })
  return target
}

function hashTreeOfTests(dir) {
  const testsRoot = path.join(dir, 'tests')
  if (!fs.existsSync(testsRoot)) return {}
  const hashes = {}
  for (const rel of listFiles(testsRoot)) hashes[`tests/${rel}`] = sha256(path.join(testsRoot, rel))
  return hashes
}

function diffAgainstGiven({ defectiveDir, agentDir }) {
  const isGenerated = (rel) => rel.startsWith('artifacts/') || rel.startsWith('.godot/')
  const before = listFiles(defectiveDir).filter((rel) => !isGenerated(rel))
  const after = listFiles(agentDir).filter((rel) => !isGenerated(rel))
  const changed = []
  for (const rel of after) {
    const a = path.join(defectiveDir, rel)
    const b = path.join(agentDir, rel)
    const beforeHash = before.includes(rel) ? sha256(a) : null
    const afterHash = sha256(b)
    if (beforeHash !== afterHash) changed.push({ file: rel, before_sha256: beforeHash, after_sha256: afterHash })
  }
  for (const rel of before) {
    if (!after.includes(rel)) changed.push({ file: rel, deleted: true })
  }
  return changed
}

/** Unified-ish diff of the first differing region; enough to audit a one-line repair. */
function describeChange(beforeText, afterText) {
  const a = beforeText.split(/\r?\n/)
  const b = afterText.split(/\r?\n/)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) start++
  let endA = a.length - 1
  let endB = b.length - 1
  while (endA >= start && endB >= start && a[endA] === b[endB]) {
    endA--
    endB--
  }
  const removed = a.slice(start, endA + 1)
  const added = b.slice(start, endB + 1)
  const lines = [`@@ line ${start + 1} @@`]
  for (const line of removed) lines.push(`-${line}`)
  for (const line of added) lines.push(`+${line}`)
  return { first_changed_line: start + 1, removed, added, patch: lines.join('\n') }
}

function validateDiagnosis({ text, caseDef, evidenceText }) {
  const problems = []
  const trimmed = text.trim()
  if (!trimmed) problems.push('diagnosis file is empty')
  if (trimmed.length < 200) problems.push(`diagnosis is too short (${trimmed.length} chars)`)
  if (!/^#\s+\S/m.test(trimmed)) problems.push('diagnosis has no H1 title')
  for (const section of REQUIRED_DIAGNOSIS_SECTIONS) {
    if (!new RegExp(`^#{1,6}\\s*${section}`, 'im').test(trimmed)) {
      problems.push(`missing section: ${section}`)
    }
  }
  const lower = trimmed.toLowerCase()
  const keywordHits = caseDef.diagnosisKeywords.filter((word) => lower.includes(word.toLowerCase()))
  if (keywordHits.length < 2) {
    problems.push(
      `diagnosis does not name the defect (matched ${keywordHits.length} of the case keywords)`,
    )
  }
  const namedFailingCase = caseDef.expectedFailingCases.some((name) =>
    lower.includes(name.toLowerCase()),
  )
  if (!namedFailingCase) {
    problems.push('diagnosis does not name the failing acceptance case it explains')
  }
  // Evidence grounding: a diagnosis that quotes no value from the evidence is
  // an assertion, not a diagnosis. Require at least one decimal number that
  // appears in the collected evidence.
  const decimals = trimmed.match(/-?\d+\.\d+/g) || []
  const groundedValues = decimals.filter((value) => evidenceText.includes(value))
  if (groundedValues.length === 0) {
    problems.push('diagnosis quotes no numeric value from the evidence')
  }
  return {
    ok: problems.length === 0,
    problems,
    keyword_hits: keywordHits,
    grounded_values: [...new Set(groundedValues)].slice(0, 10),
  }
}

export function diagnosisTask({ caseDef, sandboxDir }) {
  return `# Phase 15 agent repair task: diagnose from evidence only

A Godot game scene is failing its acceptance suite. This sandbox contains the
failing test output, a screenshot of the running game, structured runtime
state, the recorded event stream, and physics-space query results. It does not
contain the game source: you cannot read it yet, and you are not expected to.

Your job in this step is **diagnosis only**.

## Write this file

\`diagnosis.md\` in the current directory. It must start with the H1 title
\`# Phase 15 diagnosis\` and contain these exact sections:

- **Failure** - what failed, quoting the specific evidence values
- **Contradiction** - the falsifiable claim, and which two observations conflict
- **Hypotheses ruled out** - alternatives and the evidence that excludes them
- **Proposed correction** - the smallest change you would make
- **Confidence** - and what extra evidence would raise it

Rules:

- Use only files under \`evidence/\`. Do not guess a file path for the source.
- Name the failing acceptance case explicitly.
- Do not write any other file.

## Evidence available

- \`evidence/test-output.txt\` - the failing acceptance test output
- \`evidence/test-result.json\` - the parsed result of that run
- \`evidence/observation.json\` - structured runtime state and events
- \`evidence/physics-queries.json\` - physics-space query results
- \`evidence/state.json\` - the fixture snapshot at the end of the scenario
- \`evidence/before.png\` - a screenshot of the running game

Sandbox directory: ${sandboxDir}
`
}

export function repairTask({ caseDef, sandboxDir }) {
  return `# Phase 15 agent repair task: implement the diagnosis

Your diagnosis was accepted and the defective project is now available at
\`project/\` inside this sandbox. It is a copy; nothing outside this sandbox is
reachable and no shell is available.

Your job:

1. Re-read \`diagnosis.md\`.
2. Locate the defect in \`project/\` and apply the **smallest correct correction**.
3. Do not modify anything under \`project/tests/\`. Those scripts are the oracle
   and must stay byte-identical.
4. Do not modify \`project/scenes/\` unless the diagnosis proves the defect is
   there.
5. Write \`repair.md\` describing the exact change you made and why it is the
   smallest correct correction.

Verification is performed by the harness outside the sandbox after you finish.
You cannot run Godot yourself, so reason carefully from the source and the
evidence you already have.

Acceptance script that must pass afterwards: \`${caseDef.testScript}\`
Sandbox directory: ${sandboxDir}
`
}

function jsonLinesSummary(file) {
  if (!fs.existsSync(file)) return { events: 0, tools: {}, final_text_bytes: 0 }
  const tools = {}
  let events = 0
  let finalText = ''
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    events++
    if (event.type === 'tool_use' && event.part?.tool) {
      const name = event.part.tool
      const status = event.part.state?.status || 'unknown'
      tools[name] = tools[name] || {}
      tools[name][status] = (tools[name][status] || 0) + 1
    }
    if (event.type === 'text' && event.part?.text) finalText = event.part.text
  }
  return { events, tools, final_text_bytes: finalText.length }
}

function processExists(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function runAdapter(options) {
  const caseDef = BLIND_CASES[options.caseId]
  const bin = resolveOpencodeBin()
  const startedAt = Date.now()

  const stamp = `${nowStamp()}-${options.caseId}-${options.label}`
  const outDir = assertPhase15OutputDir(
    options.outDir || path.join(PHASE15_RUNS, stamp),
  )
  fs.mkdirSync(outDir, { recursive: true })

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase15-agent-'))
  const sandboxDir = path.join(sandboxRoot, 'sandbox')
  const configDir = path.join(sandboxRoot, 'config')
  const logsDir = path.join(outDir, 'logs')
  fs.mkdirSync(sandboxDir, { recursive: true })
  fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
  fs.mkdirSync(logsDir, { recursive: true })
  fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, SANDBOX_CONFIG_RELATIVE))

  const manifest = {
    schema: 'phase15.agent-adapter.manifest.v1',
    run_id: path.basename(outDir),
    case_id: options.caseId,
    defect_class: caseDef.defectClass,
    model_spec: options.model,
    opencode_bin: bin,
    ordering: [],
    timings: {},
    status: 'failed',
    failure_reason: null,
    diagnosis: null,
    repair: null,
    acceptance: null,
    verification: null,
    logs: [],
    cleanup: null,
  }

  const env = { ...process.env, XDG_CONFIG_HOME: configDir }
  const spawnedPids = []
  const stage = (name) => {
    manifest.ordering.push(name)
  }

  try {
    // ---- 1. Prepare a fresh controlled defect and its evidence bundle -------
    stage('prepare')
    const preparedDir = path.join(outDir, 'prepared')
    const prepareStarted = Date.now()
    const state = runBlindPrepare({ caseId: options.caseId, outDir: preparedDir })
    manifest.timings.prepare_ms = Date.now() - prepareStarted
    manifest.prepared = {
      fixture_dir: state.fixture_dir,
      injected_file_relative: state.injected_file_relative,
      injected_file_sha256: state.injected_file_sha256,
      pristine_file_sha256: state.pristine_file_sha256,
      failing_cases: state.failing_cases,
      test_summary: state.test_summary,
    }

    // ---- 2. Sandbox with evidence only (no source, no answer key) ----------
    stage('sandbox-evidence')
    copyDir(path.join(preparedDir, 'evidence'), path.join(sandboxDir, 'evidence'))
    const evidenceText = fs.readFileSync(path.join(sandboxDir, 'evidence', 'test-output.txt'), 'utf8')
    const diagTaskText = diagnosisTask({ caseDef, sandboxDir })
    fs.writeFileSync(path.join(sandboxDir, 'task-diagnosis.md'), diagTaskText)
    fs.writeFileSync(path.join(outDir, 'task-diagnosis.md'), diagTaskText)
    manifest.tasks = ['task-diagnosis.md']

    // ---- 3. Diagnosis run --------------------------------------------------
    stage('diagnosis-run')
    const diagJsonl = path.join(logsDir, 'diagnosis.jsonl')
    const diagStarted = Date.now()
    const diag = await runOpencode({
      bin,
      args: [
        'run',
        '--standalone',
        '--format',
        'json',
        '--model',
        options.model,
        '--auto',
        '--title',
        `phase15 diagnosis ${options.caseId}`,
        'Read ./task-diagnosis.md and carry out the task. Follow it exactly.',
      ],
      cwd: sandboxDir,
      env,
      timeoutMs: options.timeoutMs,
      pids: spawnedPids,
    })
    manifest.timings.diagnosis_ms = Date.now() - diagStarted
    fs.writeFileSync(diagJsonl, diag.stdout, 'utf8')
    fs.writeFileSync(path.join(logsDir, 'diagnosis.stderr.txt'), diag.stderr, 'utf8')
    manifest.logs.push('logs/diagnosis.jsonl', 'logs/diagnosis.stderr.txt')
    manifest.diagnosis = {
      exit_code: diag.code,
      timed_out: diag.timedOut,
      events: jsonLinesSummary(diagJsonl),
      path: null,
      sha256: null,
      bytes: 0,
    }
    if (diag.timedOut) throw new Error(`diagnosis run timed out after ${options.timeoutMs} ms`)
    if (diag.code !== 0) throw new Error(`diagnosis run exited with code ${diag.code}`)

    const diagnosisPath = path.join(sandboxDir, 'diagnosis.md')
    if (!fs.existsSync(diagnosisPath)) throw new Error('the agent did not write diagnosis.md')
    const diagnosisText = fs.readFileSync(diagnosisPath, 'utf8')
    const validation = validateDiagnosis({ text: diagnosisText, caseDef, evidenceText })
    fs.copyFileSync(diagnosisPath, path.join(outDir, 'diagnosis.md'))
    manifest.diagnosis.path = 'diagnosis.md'
    manifest.diagnosis.sha256 = sha256(path.join(outDir, 'diagnosis.md'))
    manifest.diagnosis.bytes = fs.statSync(path.join(outDir, 'diagnosis.md')).size
    manifest.diagnosis.validation = validation
    if (!validation.ok) {
      throw new Error(`diagnosis rejected: ${validation.problems.join('; ')}`)
    }

    // ---- 4. Grant source access (a copy of the defective fixture) ----------
    stage('source-grant')
    const projectDir = copyFixtureForAgent(state, sandboxDir)
    const oracleBefore = hashTreeOfTests(projectDir)
    const repairTaskText = repairTask({ caseDef, sandboxDir })
    fs.writeFileSync(path.join(sandboxDir, 'task-repair.md'), repairTaskText)
    fs.writeFileSync(path.join(outDir, 'task-repair.md'), repairTaskText)
    manifest.tasks.push('task-repair.md')

    // ---- 5. Repair run -----------------------------------------------------
    stage('repair-run')
    const repairJsonl = path.join(logsDir, 'repair.jsonl')
    const repairStarted = Date.now()
    const repair = await runOpencode({
      bin,
      args: [
        'run',
        '--standalone',
        '--format',
        'json',
        '--model',
        options.model,
        '--auto',
        '--title',
        `phase15 repair ${options.caseId}`,
        'Read ./task-repair.md and carry out the task. Follow it exactly.',
      ],
      cwd: sandboxDir,
      env,
      timeoutMs: options.timeoutMs,
      pids: spawnedPids,
    })
    manifest.timings.repair_ms = Date.now() - repairStarted
    fs.writeFileSync(repairJsonl, repair.stdout, 'utf8')
    fs.writeFileSync(path.join(logsDir, 'repair.stderr.txt'), repair.stderr, 'utf8')
    manifest.logs.push('logs/repair.jsonl', 'logs/repair.stderr.txt')
    manifest.repair = {
      exit_code: repair.code,
      timed_out: repair.timedOut,
      events: jsonLinesSummary(repairJsonl),
      changed_files: [],
      diff: null,
    }
    if (repair.timedOut) throw new Error(`repair run timed out after ${options.timeoutMs} ms`)
    if (repair.code !== 0) throw new Error(`repair run exited with code ${repair.code}`)

    // ---- 6. Validate the change before running anything -------------------
    stage('change-validation')
    const oracleAfter = hashTreeOfTests(projectDir)
    const oracleChanged = Object.keys({ ...oracleBefore, ...oracleAfter }).filter(
      (key) => oracleBefore[key] !== oracleAfter[key],
    )
    if (oracleChanged.length > 0) {
      throw new Error(`the agent modified the test oracle: ${oracleChanged.join(', ')}`)
    }
    const changed = diffAgainstGiven({ defectiveDir: state.fixture_dir, agentDir: projectDir })
    manifest.repair.changed_files = changed
    if (changed.length === 0) throw new Error('the agent made no change to the project')
    if (changed.some((entry) => entry.deleted)) {
      throw new Error('the agent deleted a project file')
    }

    const diffParts = []
    for (const entry of changed) {
      const beforePath = path.join(state.fixture_dir, entry.file)
      const afterPath = path.join(projectDir, entry.file)
      const beforeText = fs.existsSync(beforePath) ? fs.readFileSync(beforePath, 'utf8') : ''
      const afterText = fs.readFileSync(afterPath, 'utf8')
      const described = describeChange(beforeText, afterText)
      diffParts.push(`=== ${entry.file} ===\n${described.patch}`)
      entry.change = described
      entry.touches_injected_file = entry.file === state.injected_file_relative
    }
    fs.writeFileSync(path.join(outDir, 'repair.diff'), `${diffParts.join('\n\n')}\n`, 'utf8')
    manifest.repair.diff = 'repair.diff'
    const touched = changed.filter((entry) => entry.touches_injected_file)
    manifest.repair.matches_intended_location = touched.length === changed.length
    manifest.repair.matches_pristine_file =
      touched.length === 1 && touched[0].after_sha256 === state.pristine_file_sha256

    // ---- 7. Verify with the real Godot harness ----------------------------
    stage('verification')
    const verifyStarted = Date.now()
    const test = await runTests({
      project: projectDir,
      script: caseDef.testScript,
      timeoutMs: 90000,
      allowOutsideRoot: true,
    })
    manifest.timings.verification_ms = Date.now() - verifyStarted
    const failingAfter = (test.results || []).filter((r) => !r.passed).map((r) => r.name)
    manifest.acceptance = {
      script: caseDef.testScript,
      ok: test.ok,
      exit_code: test.exitCode,
      summary: test.summary,
      failing_after: failingAfter,
      failing_before: state.failing_cases,
    }
    manifest.verification = {
      status: test.ok && failingAfter.length === 0 ? 'passed' : 'failed',
      duration_ms: test.durationMs,
      acceptance_cases_expected: caseDef.expectedFailingCases,
      acceptance_cases_now_passing: caseDef.expectedFailingCases.filter(
        (name) => !failingAfter.includes(name),
      ),
    }
    fs.writeFileSync(
      path.join(outDir, 'verification-test-output.txt'),
      `${test.stdout}\n${test.stderr}`,
      'utf8',
    )
    manifest.logs.push('verification-test-output.txt')

    if (!test.ok || failingAfter.length > 0) {
      throw new Error(
        `verification failed (exit ${test.exitCode}); still failing: ${failingAfter.join(', ') || 'none reported'}`,
      )
    }

    if (!fs.existsSync(path.join(sandboxDir, 'repair.md'))) {
      manifest.repair.note = 'the agent did not write repair.md (not required for acceptance)'
    } else {
      fs.copyFileSync(path.join(sandboxDir, 'repair.md'), path.join(outDir, 'repair.md'))
      manifest.repair.repair_note = 'repair.md'
    }

    manifest.status = 'passed'
  } catch (error) {
    manifest.failure_reason = error.message
    manifest.status = 'failed'
  } finally {
    // ---- 8. Cleanup: sandbox, temp fixture, leftover processes ------------
    stage('cleanup')
    const cleanup = { sandbox_removed: false, fixture_base_removed: false, orphans: [] }
    try {
      fs.rmSync(sandboxRoot, { recursive: true, force: true })
      cleanup.sandbox_removed = !fs.existsSync(sandboxRoot)
    } catch (error) {
      cleanup.sandbox_error = error.message
    }
    try {
      runBlindCleanup({ outDir: path.join(outDir, 'prepared') })
      cleanup.fixture_base_removed = true
    } catch (error) {
      cleanup.fixture_cleanup_error = error.message
    }
    for (const pid of spawnedPids) {
      if (processExists(pid)) cleanup.orphans.push(pid)
    }
    cleanup.orphan_check = 'every opencode process spawned by this run was reaped'
    manifest.cleanup = cleanup
    manifest.timings.total_ms = Date.now() - startedAt
    manifest.sandbox = {
      path: sandboxDir,
      config_source: path.relative(REPO_ROOT, SANDBOX_CONFIG_SOURCE).split(path.sep).join('/'),
      removed: cleanup.sandbox_removed,
    }
    writeJsonFile(outDir, 'manifest.json', manifest)
  }

  return { outDir, manifest }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'list') {
    console.log(
      JSON.stringify(
        BLIND_CASE_IDS.map((id) => ({
          id,
          defect_class: BLIND_CASES[id].defectClass,
          expected_failing_cases: BLIND_CASES[id].expectedFailingCases,
        })),
        null,
        2,
      ),
    )
    return
  }
  const { outDir, manifest } = await runAdapter(options)
  console.log(
    JSON.stringify(
      {
        ok: manifest.status === 'passed',
        run: path.relative(REPO_ROOT, outDir).split(path.sep).join('/'),
        case_id: manifest.case_id,
        model_spec: manifest.model_spec,
        status: manifest.status,
        failure_reason: manifest.failure_reason,
        diagnosis: manifest.diagnosis?.path || null,
        verification: manifest.verification,
        timings: manifest.timings,
      },
      null,
      2,
    ),
  )
  if (manifest.status !== 'passed') process.exitCode = 1
}

// Importable for its task builders (used to regenerate the task text of a
// recorded run); only runs the adapter when executed directly.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) await main()
