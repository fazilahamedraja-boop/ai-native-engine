#!/usr/bin/env node
/**
 * Phase 17 agent-task runner.
 *
 * This is a small, documented extension of the Phase 16 `game-task.mjs`
 * runner. It deliberately reuses the Phase 15 adapter helpers and sandbox
 * policy instead of creating a second agent execution path.
 *
 * Two modes:
 *
 *   feature  Copy the game, remove the runner-owned dodge suite from the
 *            sandbox, prove the suite is red, let the agent implement the
 *            feature, then verify both the existing 18 checks and the hidden
 *            dodge suite. A bounded number of repair attempts is allowed.
 *
 *   repair   Copy the implemented game, inject a controlled defect from a JSON
 *            spec into the copy only, reproduce the expected failing tests,
 *            give the agent the failure evidence (never the test source), and
 *            allow a bounded repair. The canonical source is never touched.
 *
 * The hidden dodge suite (`game/tests/run_dodge_tests.gd`) is only copied into
 * the sandbox while the runner is executing it, then removed before the agent
 * receives control. Test files are hashed before and after every attempt; any
 * oracle change rejects the run.
 *
 * Usage:
 *   node controller/phase17-agent.mjs --mode feature [--model ...]
 *   node controller/phase17-agent.mjs --mode repair \
 *     --defect ../../docs/phase17/agent-tasks/dodge-cooldown-defect.json \
 *     [--task ../../docs/phase17/agent-tasks/dodge-cooldown-repair.md]
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { GODOT_BIN, HARNESS_ROOT, runTests } from './harness.mjs'
import {
  SANDBOX_CONFIG_SOURCE,
  copyDir,
  describeChange,
  diffAgainstGiven,
  hashTreeOfTests,
  nowStamp,
  processExists,
  resolveOpencodeBin,
  runOpencode,
} from './agent-adapter.mjs'
import { DOCS_ROOT, rejectReason, sha256, writeJsonFile } from './evidence-output.mjs'
import {
  logLive,
  setAgent,
  updateLive,
  upsertStep,
  upsertTest,
} from './phase17-status.mjs'

const GAME_SOURCE = path.join(HARNESS_ROOT, 'game')
const HIDDEN_TEST = path.join(GAME_SOURCE, 'tests', 'run_dodge_tests.gd')
const HIDDEN_TEST_REL = 'tests/run_dodge_tests.gd'
const EXISTING_SCRIPT = 'res://tests/run_game_tests.gd'
const DODGE_SCRIPT = 'res://tests/run_dodge_tests.gd'
const AGENT_RUNS_DIR = path.join(DOCS_ROOT, 'phase17', 'agent-runs')
const DEFAULT_FEATURE_TASK = path.join(DOCS_ROOT, 'phase17', 'feature-spec.md')
const DEFAULT_REPAIR_TASK = path.join(DOCS_ROOT, 'phase17', 'agent-tasks', 'dodge-cooldown-repair.md')
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free'

function parseArgs(argv) {
  const options = {
    mode: 'feature',
    task: null,
    defect: null,
    source: GAME_SOURCE,
    outDir: null,
    model: process.env.PHASE17_AGENT_MODEL || DEFAULT_MODEL,
    timeoutMs: 600000,
    maxAttempts: 3,
    keepSandbox: false,
    live: true,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--mode') options.mode = argv[++i]
    else if (arg === '--task') options.task = argv[++i]
    else if (arg === '--defect') options.defect = argv[++i]
    else if (arg === '--source') options.source = argv[++i]
    else if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg === '--max-attempts') options.maxAttempts = Number(argv[++i])
    else if (arg === '--keep-sandbox') options.keepSandbox = true
    else if (arg === '--no-live') options.live = false
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!['feature', 'repair'].includes(options.mode)) {
    throw new Error('--mode must be feature or repair')
  }
  if (!options.task) {
    options.task = options.mode === 'repair' ? DEFAULT_REPAIR_TASK : DEFAULT_FEATURE_TASK
  }
  if (options.mode === 'repair' && !options.defect) {
    throw new Error('--defect is required in repair mode')
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 30000) {
    throw new Error('--timeout-ms must be a number >= 30000')
  }
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 4) {
    throw new Error('--max-attempts must be an integer from 1 to 4')
  }
  if (!fs.existsSync(HIDDEN_TEST)) throw new Error(`hidden dodge test missing: ${HIDDEN_TEST}`)
  return options
}

function assertRunDir(dir) {
  const resolved = path.resolve(dir)
  const relative = path.relative(AGENT_RUNS_DIR, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`agent evidence must stay inside ${AGENT_RUNS_DIR}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  fs.mkdirSync(resolved, { recursive: true })
  return resolved
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function failingNames(result) {
  return (result.results || []).filter((entry) => !entry.passed).map((entry) => entry.name)
}

function testSummary(result) {
  const results = result.results || []
  return {
    ok: Boolean(result.ok) && results.length > 0 && results.every((entry) => entry.passed),
    passed: results.filter((entry) => entry.passed).length,
    total: results.length,
    failing: failingNames(result),
    duration_ms: result.durationMs,
    timed_out: Boolean(result.timedOut),
    exit_code: result.exitCode,
    errors: result.errors || [],
    reason: result.reason || null,
  }
}

function summarizeJsonl(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
  const byType = {}
  const tools = new Set()
  let parseErrors = 0
  for (const line of lines) {
    try {
      const event = JSON.parse(line)
      const type = String(event.type ?? 'unknown')
      byType[type] = (byType[type] ?? 0) + 1
      const part = event.part && typeof event.part === 'object' ? event.part : event
      if (type.includes('tool') && part.tool) tools.add(String(part.tool))
      if (type.includes('tool') && part.name) tools.add(String(part.name))
    } catch {
      parseErrors += 1
    }
  }
  return { lines: lines.length, parse_errors: parseErrors, by_type: byType, tools: [...tools].sort() }
}

function ensureImported(projectDir) {
  const result = spawnSync(GODOT_BIN, ['--headless', '--path', projectDir, '--import'], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  })
  return {
    command: `${GODOT_BIN} --headless --path <sandbox>/game --import`,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }
}

function installHiddenTest(projectDir) {
  const target = path.join(projectDir, HIDDEN_TEST_REL)
  fs.copyFileSync(HIDDEN_TEST, target)
}

function removeHiddenTest(projectDir) {
  fs.rmSync(path.join(projectDir, HIDDEN_TEST_REL), { force: true })
}

async function runSuite(projectDir, script, outFile, label) {
  const result = await runTests({
    project: projectDir,
    script,
    timeoutMs: 120000,
    allowOutsideRoot: true,
  })
  const summary = testSummary(result)
  fs.writeFileSync(
    outFile,
    `${label}\nscript=${script}\nduration_ms=${result.durationMs}\n` +
      `stdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}\n`,
    'utf8',
  )
  writeJsonFile(path.dirname(outFile), `${path.basename(outFile)}.json`, {
    ...summary,
    results: result.results || [],
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  })
  return { result, summary, outFile }
}

async function verifyBoth(projectDir, logsDir, prefix) {
  installHiddenTest(projectDir)
  const dodge = await runSuite(
    projectDir,
    DODGE_SCRIPT,
    path.join(logsDir, `${prefix}-dodge.txt`),
    'phase17 dodge acceptance',
  )
  removeHiddenTest(projectDir)
  const existing = await runSuite(
    projectDir,
    EXISTING_SCRIPT,
    path.join(logsDir, `${prefix}-existing.txt`),
    'phase16 regression acceptance',
  )
  return { dodge, existing }
}

function failureBrief({ dodge, existing, attemptLabel, mode }) {
  const details = []
  for (const item of dodge.result.results || []) {
    if (!item.passed) details.push(`- ${item.name}: ${item.detail}`)
  }
  for (const item of existing.result.results || []) {
    if (!item.passed) details.push(`- existing/${item.name}: ${item.detail}`)
  }
  const stderrTail = String(dodge.result.stderr || '')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-30)
    .join('\n')
  return `# Verification failure after ${attemptLabel}\n\n` +
    `Mode: ${mode}\n\n` +
    `The independent runner executed the real Godot game. The game did not meet the feature contract.\n` +
    `The hidden test source is not in this workspace and is not provided. Use the failing behavior\n` +
    `and the source code to repair the implementation.\n\n` +
    `## Failing checks\n\n${details.join('\n') || '- (no individual checks were parsed)'}\n\n` +
    `## Runner summary\n\n` +
    `- dodge: ${dodge.summary.passed}/${dodge.summary.total} passed, exit ${dodge.summary.exit_code}, ${dodge.summary.duration_ms} ms\n` +
    `- existing: ${existing.summary.passed}/${existing.summary.total} passed, exit ${existing.summary.exit_code}, ${existing.summary.duration_ms} ms\n` +
    `- total failing: ${dodge.summary.failing.length + existing.summary.failing.length}\n\n` +
    `## Runtime error tail\n\n\`\`\`\n${stderrTail || '(none)'}\n\`\`\`\n\n` +
    `## Rules\n\n- Do not edit anything under game/tests/.\n- Do not modify game/harness/.\n- Repair the game source in this disposable copy only.\n`
}

function makeAttemptRecord({ label, mode, status, startedAt, durationMs, changedFiles, summary, failure }) {
  return {
    label,
    mode,
    status,
    started_at: startedAt,
    duration_ms: durationMs,
    changed_files: changedFiles,
    summary,
    failure,
  }
}

function liveAttempts(manifest) {
  return manifest.attempts.map((attempt) => ({
    label: attempt.label,
    mode: attempt.mode,
    status: attempt.status,
    summary: attempt.summary,
    failure: attempt.failure,
    changed_files: attempt.changed_files,
  }))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const taskText = fs.readFileSync(options.task, 'utf8')
  const spec = options.mode === 'repair' ? readJson(options.defect) : null
  if (spec) {
    for (const key of ['id', 'file', 'find', 'replace', 'expected_failing']) {
      if (!(key in spec)) throw new Error(`defect spec is missing ${key}`)
    }
    if (!Array.isArray(spec.expected_failing) || spec.expected_failing.length === 0) {
      throw new Error('defect spec expected_failing must be a non-empty array')
    }
  }

  const runId = `${nowStamp()}-${options.mode}-${spec?.id || 'dodge'}`
  const outDir = assertRunDir(options.outDir || path.join(AGENT_RUNS_DIR, runId))
  const logsDir = path.join(outDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase17-agent-'))
  const sandboxDir = path.join(sandboxRoot, 'sandbox')
  const projectDir = path.join(sandboxDir, 'game')
  const baselineDir = path.join(sandboxRoot, 'baseline', 'game')
  const configDir = path.join(sandboxRoot, 'config')
  fs.mkdirSync(sandboxDir, { recursive: true })
  fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
  fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, 'opencode', 'opencode.json'))

  const bin = resolveOpencodeBin()
  const versionRun = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 20000,
    windowsHide: true,
  })

  const manifest = {
    schema: 'phase17.agent-task.manifest.v1',
    run_id: path.basename(outDir),
    created_at: new Date().toISOString(),
    status: 'failed',
    failure_reason: null,
    mode: options.mode,
    model_spec: options.model,
    source: path.relative(GAME_SOURCE, path.resolve(options.source)).split(path.sep).join('/'),
    task: {
      path: path.relative(DOCS_ROOT, path.resolve(options.task)).split(path.sep).join('/'),
      sha256: sha256(options.task),
      bytes: fs.statSync(options.task).size,
    },
    hidden_test: {
      path: path.relative(GAME_SOURCE, HIDDEN_TEST).split(path.sep).join('/'),
      sha256: sha256(HIDDEN_TEST),
      copied_into_agent_workspace: false,
    },
    agent: {
      bin,
      version: String(versionRun.stdout || versionRun.stderr || '').trim(),
      version_exit_code: versionRun.status,
      standalone: true,
      invocation: 'opencode run --standalone --format json --auto',
      sandbox_config: {
        path: path.relative(path.resolve(HARNESS_ROOT, '..', '..'), SANDBOX_CONFIG_SOURCE)
          .split(path.sep)
          .join('/'),
        sha256: sha256(SANDBOX_CONFIG_SOURCE),
      },
      denied: ['shell', 'webfetch', 'websearch', 'execute', 'question', 'skill', 'subagent'],
      requested_model: options.model,
      events: null,
      exit_code: null,
      timed_out: false,
      duration_ms: null,
    },
    before: null,
    defect: spec
      ? {
          spec_path: path.relative(DOCS_ROOT, path.resolve(options.defect)).split(path.sep).join('/'),
          spec_sha256: sha256(options.defect),
          id: spec.id,
          description: spec.description ?? '',
          file: spec.file,
          pristine_sha256: null,
          injected_sha256: null,
          expected_failing: spec.expected_failing,
        }
      : null,
    attempts: [],
    final: null,
    changed_files: [],
    diff: null,
    import: null,
    cleanup: null,
  }
  const spawnedPids = []
  let failure = null

  if (options.live) {
    setAgent({ model: options.model, status: 'running', attempts: [] })
    upsertStep({
      id: options.mode === 'repair' ? 'agent-repair' : 'agent-impl',
      label: options.mode === 'repair' ? 'Controlled defect repair' : 'Agent implementation',
      status: 'running',
      detail:
        options.mode === 'repair'
          ? 'Injecting a disposable defect and giving the agent failure evidence.'
          : 'Agent is reading the feature contract and implementing in the sandbox.',
    })
    logLive(
      options.mode === 'repair'
        ? 'Starting controlled repair run in an isolated copy.'
        : 'Starting greenfield dodge implementation in the Phase 15 sandbox.',
    )
  }

  try {
    // ---- 1. Isolated copy --------------------------------------------------
    copyDir(path.resolve(options.source), projectDir, { skip: ['.godot', 'artifacts'] })
    removeHiddenTest(projectDir)
    fs.copyFileSync(options.task, path.join(outDir, 'TASK.md'))
    fs.copyFileSync(options.task, path.join(sandboxDir, 'TASK.md'))

    if (options.mode === 'repair') {
      const targetRelative = spec.file.replace(/^game[\\/]/, '')
      const targetPath = path.join(projectDir, targetRelative)
      if (!fs.existsSync(targetPath)) throw new Error(`defect target does not exist: ${spec.file}`)
      const pristine = fs.readFileSync(targetPath, 'utf8')
      const occurrences = pristine.split(spec.find).length - 1
      if (occurrences !== 1) {
        throw new Error(`defect find string must occur exactly once (found ${occurrences})`)
      }
      fs.writeFileSync(targetPath, pristine.replace(spec.find, spec.replace), 'utf8')
      manifest.defect.pristine_sha256 = sha256Text(pristine)
      manifest.defect.injected_sha256 = sha256(targetPath)
      fs.copyFileSync(options.defect, path.join(outDir, 'defect.json'))
      updateLive({
        progress: 74,
        current: {
          id: 'agent-repair',
          label: 'Controlled defect repair',
          detail: 'A disposable copy contains one injected regression.',
        },
      })
    } else {
      updateLive({
        progress: 24,
        current: {
          id: 'agent-impl',
          label: 'Agent implementation',
          detail: 'Sandbox prepared; proving the hidden suite is red before the agent starts.',
        },
      })
    }

    // ---- 2. Import and baseline -------------------------------------------
    copyDir(projectDir, baselineDir)
    const testsBefore = hashTreeOfTests(projectDir)
    manifest.import = ensureImported(projectDir)
    fs.writeFileSync(
      path.join(logsDir, 'import.txt'),
      `${manifest.import.command}\nexit=${manifest.import.status}\n${manifest.import.stdout}\n${manifest.import.stderr}`,
      'utf8',
    )
    if (manifest.import.error || manifest.import.status !== 0) {
      throw new Error(`Godot import failed: ${manifest.import.error || `exit ${manifest.import.status}`}`)
    }

    const baselineExisting = await runSuite(
      projectDir,
      EXISTING_SCRIPT,
      path.join(logsDir, 'baseline-existing.txt'),
      'phase16 regression acceptance',
    )
    if (!baselineExisting.summary.ok) {
      throw new Error(
        `existing suite failed in the sandbox before the agent: ${baselineExisting.summary.failing.join(', ') || 'unknown'}`,
      )
    }

    if (options.mode === 'feature') {
      installHiddenTest(projectDir)
      const red = await runSuite(
        projectDir,
        DODGE_SCRIPT,
        path.join(logsDir, 'baseline-dodge-red.txt'),
        'phase17 dodge acceptance (expected red)',
      )
      removeHiddenTest(projectDir)
      manifest.before = {
        existing: baselineExisting.summary,
        dodge_red: red.summary,
        expected_red: true,
      }
      if (red.summary.ok) {
        throw new Error('the hidden dodge suite passed before the feature was implemented')
      }
      if (red.summary.failing.length < 6) {
        throw new Error(
          `expected the red baseline to exercise the feature; only ${red.summary.failing.length} checks failed`,
        )
      }
    } else {
      installHiddenTest(projectDir)
      const before = await runSuite(
        projectDir,
        DODGE_SCRIPT,
        path.join(logsDir, 'baseline-defect.txt'),
        'phase17 dodge acceptance after controlled defect',
      )
      removeHiddenTest(projectDir)
      const missed = spec.expected_failing.filter((name) => !before.summary.failing.includes(name))
      if (before.summary.ok || missed.length > 0) {
        throw new Error(
          `injected defect did not reproduce: ${missed.join(', ') || 'suite unexpectedly passed'}`,
        )
      }
      manifest.before = {
        existing: baselineExisting.summary,
        dodge_defect: before.summary,
        expected_failing: spec.expected_failing,
        reproduced: true,
      }
    }

    if (options.live) {
      upsertTest({
        id: options.mode === 'repair' ? 'repair' : 'dodge',
        label: options.mode === 'repair' ? 'Controlled repair' : 'Dodge acceptance',
        status: 'running',
        passed: 0,
        total: options.mode === 'repair' ? 0 : 12,
        detail:
          options.mode === 'repair'
            ? 'Defect reproduced; awaiting agent repair.'
            : 'Hidden suite red before implementation; awaiting agent.',
      })
      logLive(
        options.mode === 'repair'
          ? `Defect reproduced: ${manifest.before.dodge_defect.failing.join(', ')}`
          : `Red baseline confirmed: ${manifest.before.dodge_red.failing.length} checks failing.`,
        options.mode === 'repair' ? 'warn' : 'info',
      )
    }

    // ---- 3. Bounded agent attempts ---------------------------------------
    let final = null
    for (let attemptIndex = 0; attemptIndex < options.maxAttempts; attemptIndex++) {
      const attemptNumber = attemptIndex + 1
      const label = `${options.mode}-${attemptNumber}`
      const startedAt = new Date().toISOString()
      const attemptStart = Date.now()
      const jsonl = path.join(logsDir, `opencode-${attemptNumber}.jsonl`)
      const failurePath = path.join(sandboxDir, 'FAILURE.md')
      if (attemptIndex === 0) fs.rmSync(failurePath, { force: true })

      const prompt =
        attemptIndex === 0
          ? 'Read ./TASK.md and carry out the task. Follow it exactly.'
          : 'Read ./TASK.md and ./FAILURE.md. Diagnose the failing behavior and repair the game source in this disposable copy. Do not edit tests or the harness.'

      let run
      try {
        run = await runOpencode({
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
            `phase17 ${options.mode} attempt ${attemptNumber}`,
            prompt,
          ],
          cwd: sandboxDir,
          env: { ...process.env, XDG_CONFIG_HOME: configDir },
          timeoutMs: options.timeoutMs,
          pids: spawnedPids,
        })
        fs.writeFileSync(jsonl, run.stdout, 'utf8')
        fs.writeFileSync(
          path.join(logsDir, `opencode-${attemptNumber}.stderr.txt`),
          run.stderr,
          'utf8',
        )
      } catch (error) {
        run = { code: -1, timedOut: false, durationMs: Date.now() - attemptStart, stdout: '', stderr: error.message }
        fs.writeFileSync(jsonl, '', 'utf8')
      }
      const agentSummary = summarizeJsonl(jsonl)
      manifest.agent.events = agentSummary
      manifest.agent.exit_code = run.code
      manifest.agent.timed_out = run.timedOut
      manifest.agent.duration_ms = (manifest.agent.duration_ms || 0) + run.durationMs

      if (run.timedOut) {
        const record = makeAttemptRecord({
          label,
          mode: options.mode,
          status: 'failed',
          startedAt,
          durationMs: run.durationMs,
          changedFiles: [],
          summary: 'Agent timed out.',
          failure: `timeout after ${options.timeoutMs} ms`,
        })
        manifest.attempts.push(record)
        if (options.live) setAgent({ status: 'running', attempts: liveAttempts(manifest) })
        throw new Error(`agent attempt ${attemptNumber} timed out after ${options.timeoutMs} ms`)
      }
      if (run.code !== 0) {
        const record = makeAttemptRecord({
          label,
          mode: options.mode,
          status: 'failed',
          startedAt,
          durationMs: run.durationMs,
          changedFiles: [],
          summary: `Agent exited with code ${run.code}.`,
          failure: String(run.stderr || '').slice(-800),
        })
        manifest.attempts.push(record)
        if (options.live) setAgent({ status: 'running', attempts: liveAttempts(manifest) })
        throw new Error(`agent attempt ${attemptNumber} exited with code ${run.code}`)
      }

      // Reject oracle or harness changes before the next verification run.
      const testsAfter = hashTreeOfTests(projectDir)
      const oracleChanged = Object.keys({ ...testsBefore, ...testsAfter }).filter(
        (key) => testsBefore[key] !== testsAfter[key],
      )
      const changed = diffAgainstGiven({ defectiveDir: baselineDir, agentDir: projectDir })
      const changedFiles = changed.map((entry) => entry.file)
      const diffParts = []
      for (const entry of changed) {
        if (entry.deleted) {
          diffParts.push(`=== ${entry.file} ===\n(deleted)`)
          continue
        }
        const beforePath = path.join(baselineDir, entry.file)
        const afterPath = path.join(projectDir, entry.file)
        const beforeText = fs.existsSync(beforePath) ? fs.readFileSync(beforePath, 'utf8') : ''
        const afterText = fs.readFileSync(afterPath, 'utf8')
        const described = describeChange(beforeText, afterText)
        entry.change = described
        diffParts.push(`=== ${entry.file} ===\n${described.patch}`)
      }
      fs.writeFileSync(
        path.join(outDir, `attempt-${attemptNumber}.diff`),
        `${diffParts.join('\n\n')}\n`,
        'utf8',
      )

      const harnessChanged = changedFiles.filter(
        (file) => file.startsWith('harness/') || file.startsWith('harness\\'),
      )
      if (oracleChanged.length > 0) {
        throw new Error(`the agent modified the test oracle: ${oracleChanged.join(', ')}`)
      }
      if (harnessChanged.length > 0) {
        throw new Error(`the agent modified the harness: ${harnessChanged.join(', ')}`)
      }
      if (changed.length === 0) {
        throw new Error(`agent attempt ${attemptNumber} made no change to the project`)
      }
      if (changed.some((entry) => entry.deleted)) {
        throw new Error(`agent attempt ${attemptNumber} deleted a project file`)
      }

      // ---- 4. Real-runner verification -----------------------------------
      const verified = await verifyBoth(projectDir, logsDir, `attempt-${attemptNumber}`)
      const passed =
        verified.dodge.summary.ok &&
        verified.existing.summary.ok &&
        verified.dodge.summary.failing.length === 0 &&
        verified.existing.summary.failing.length === 0
      const summaryText =
        `dodge ${verified.dodge.summary.passed}/${verified.dodge.summary.total}, ` +
        `existing ${verified.existing.summary.passed}/${verified.existing.summary.total}`
      const record = makeAttemptRecord({
        label,
        mode: options.mode,
        status: passed ? 'passed' : 'failed',
        startedAt,
        durationMs: Date.now() - attemptStart,
        changedFiles,
        summary: summaryText,
        failure: passed
          ? null
          : [...verified.dodge.summary.failing, ...verified.existing.summary.failing].join(', '),
      })
      manifest.attempts.push(record)
      manifest.final = {
        attempt: attemptNumber,
        dodge: verified.dodge.summary,
        existing: verified.existing.summary,
        status: passed ? 'passed' : 'failed',
      }
      manifest.changed_files = changedFiles
      if (options.live) {
        setAgent({ status: passed ? 'passed' : 'running', attempts: liveAttempts(manifest) })
        upsertTest({
          id: options.mode === 'repair' ? 'repair' : 'dodge',
          label: options.mode === 'repair' ? 'Controlled repair' : 'Dodge acceptance',
          status: passed ? 'done' : 'failed',
          passed: verified.dodge.summary.passed,
          total: verified.dodge.summary.total,
          duration: verified.dodge.summary.duration_ms,
          detail: summaryText,
        })
        upsertTest({
          id: 'acceptance-existing',
          label: 'Phase 16 acceptance',
          status: verified.existing.summary.ok ? 'done' : 'failed',
          passed: verified.existing.summary.passed,
          total: verified.existing.summary.total,
          duration: verified.existing.summary.duration_ms,
          detail: 'Existing attack/deflect/posture/victory/defeat/restart checks.',
        })
        logLive(
          `Attempt ${attemptNumber}: ${summaryText}`,
          passed ? 'pass' : 'fail',
        )
      }
      if (passed) {
        final = verified
        break
      }

      if (attemptIndex + 1 < options.maxAttempts) {
        fs.writeFileSync(
          failurePath,
          failureBrief({
            dodge: verified.dodge,
            existing: verified.existing,
            attemptLabel: `attempt ${attemptNumber}`,
            mode: options.mode,
          }),
          'utf8',
        )
        fs.copyFileSync(failurePath, path.join(outDir, `FAILURE-${attemptNumber}.md`))
      } else {
        fs.copyFileSync(
          path.join(logsDir, `attempt-${attemptNumber}-dodge.txt`),
          path.join(outDir, `FINAL-FAILURE-${attemptNumber}.txt`),
        )
      }
    }

    if (!final) {
      throw new Error(
        `verification did not pass after ${options.maxAttempts} attempt(s): ` +
          `${manifest.final?.dodge?.failing?.join(', ') || 'unknown'}`,
      )
    }

    manifest.status = 'passed'
    if (options.live) {
      updateLive({
        state: 'passed',
        progress: options.mode === 'repair' ? 92 : 66,
        current: {
          id: options.mode === 'repair' ? 'agent-repair' : 'agent-impl',
          label:
            options.mode === 'repair'
              ? 'Controlled defect repaired'
              : 'Dodge implemented and verified',
          detail: `Dodge ${final.dodge.summary.passed}/${final.dodge.summary.total}; existing ${final.existing.summary.passed}/${final.existing.summary.total}.`,
        },
      })
      upsertStep({
        id: options.mode === 'repair' ? 'agent-repair' : 'agent-impl',
        label: options.mode === 'repair' ? 'Controlled defect repair' : 'Agent implementation',
        status: 'done',
        detail: `Passed after ${manifest.attempts.length} attempt(s).`,
      })
      logLive(
        options.mode === 'repair'
          ? 'Controlled defect repaired and independently verified.'
          : 'Dodge feature implemented and independently verified.',
        'pass',
      )
    }
  } catch (error) {
    failure = error
    manifest.status = 'failed'
    manifest.failure_reason = error.message
    if (options.live) {
      setAgent({
        status: 'failed',
        attempts: liveAttempts(manifest),
      })
      upsertStep({
        id: options.mode === 'repair' ? 'agent-repair' : 'agent-impl',
        label: options.mode === 'repair' ? 'Controlled defect repair' : 'Agent implementation',
        status: 'failed',
        detail: error.message,
      })
      logLive(error.message, 'fail')
    }
  } finally {
    const cleanup = { sandbox_removed: false, orphans: [] }
    if (options.keepSandbox) {
      cleanup.kept_at = sandboxRoot
    } else {
      try {
        fs.rmSync(sandboxRoot, { recursive: true, force: true })
        cleanup.sandbox_removed = !fs.existsSync(sandboxRoot)
      } catch (error) {
        cleanup.sandbox_error = error.message
      }
    }
    for (const pid of spawnedPids) {
      if (processExists(pid)) cleanup.orphans.push(pid)
    }
    cleanup.orphan_check = 'every opencode process spawned by this run was reaped'
    manifest.cleanup = cleanup
    writeJsonFile(outDir, 'manifest.json', manifest)
  }

  console.log(`STATUS ${manifest.status}`)
  console.log(`RUN ${path.relative(process.cwd(), outDir)}`)
  if (manifest.before) {
    console.log(
      `BEFORE existing=${manifest.before.existing.passed}/${manifest.before.existing.total} ` +
        `dodge_red=${manifest.before.dodge_red?.passed ?? 'n/a'}/${manifest.before.dodge_red?.total ?? 'n/a'} ` +
        `defect=${manifest.before.dodge_defect?.failing?.join(',') || 'n/a'}`,
    )
  }
  for (const attempt of manifest.attempts) {
    console.log(
      `ATTEMPT ${attempt.label} ${attempt.status} ${attempt.summary} ` +
        `${attempt.failure ? `failure=${attempt.failure}` : ''}`,
    )
  }
  if (manifest.failure_reason) console.log(`REASON ${manifest.failure_reason}`)
  if (failure) process.exitCode = 1
}

main().catch((error) => {
  console.error(`FATAL ${error.stack || error.message}`)
  process.exitCode = 1
})
