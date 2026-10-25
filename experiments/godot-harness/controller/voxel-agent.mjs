#!/usr/bin/env node
/**
 * Phase 19 bounded implementation runner for the pure voxel world-data module.
 *
 * The adapter receives a disposable copy of the voxel project with tests,
 * build output, and the trusted reference removed. It may edit only
 * scripts/voxel_data.gd and write IMPLEMENTATION.md. The runner verifies the
 * result against a hidden behavioral suite in a separate sandbox, and only
 * copies the accepted module into the real worktree after it passes.
 *
 * Failed attempts are preserved under docs/phase19/evidence/agent-runs/.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { HARNESS_ROOT, runTests } from './harness.mjs'
import {
  SANDBOX_CONFIG_SOURCE,
  copyDir,
  diffAgainstGiven,
  nowStamp,
  resolveOpencodeBin,
  runOpencode,
} from './agent-adapter.mjs'
import { DOCS_ROOT, rejectReason, sha256, writeJsonFile } from './evidence-output.mjs'

const SOURCE = path.join(HARNESS_ROOT, 'voxel')
const PHASE19_DIR = path.join(DOCS_ROOT, 'phase19')
const AGENT_RUNS_DIR = path.join(PHASE19_DIR, 'evidence', 'agent-runs')
const TASK_TEMPLATE = path.join(PHASE19_DIR, 'tasks', 'voxel-data-task.md')
const HIDDEN_TEST_REL = 'tests/run_voxel_data_tests.gd'
const HIDDEN_TEST = path.join(SOURCE, HIDDEN_TEST_REL)
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free'
const ALLOWED_FILES = new Set(['scripts/voxel_data.gd'])
const DOC_ALLOWED = new Set(['IMPLEMENTATION.md'])
const SKIP = ['.godot', 'build', 'tests', 'artifacts']
const IMPLEMENTATION_SECTIONS = [
  'Chosen approach',
  'Files changed',
  'Data model',
  'Edge cases',
  'Limits',
]

function parseArgs(argv) {
  const options = {
    outDir: null,
    model: process.env.PHASE19_AGENT_MODEL || DEFAULT_MODEL,
    timeoutMs: 900000,
    maxAttempts: 3,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg === '--max-attempts') options.maxAttempts = Number(argv[++i])
    else if (arg === '--help' || arg === '-h') {
      console.log(
        'Usage: node controller/voxel-agent.mjs [--out-dir DIR] [--model MODEL] ' +
          '[--timeout-ms N] [--max-attempts N]',
      )
      process.exit(0)
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }
  }
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 5) {
    throw new Error('--max-attempts must be an integer between 1 and 5')
  }
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 10000) {
    throw new Error('--timeout-ms must be at least 10000')
  }
  return options
}

function assertPhase19Directory(target) {
  const resolved = path.resolve(target)
  const relative = path.relative(PHASE19_DIR, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Phase 19 output must stay inside ${PHASE19_DIR}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  fs.mkdirSync(resolved, { recursive: true })
  return resolved
}

function readText(file) {
  return fs.readFileSync(file, 'utf8')
}

function implementationProblems(projectDir) {
  const file = path.join(projectDir, 'IMPLEMENTATION.md')
  if (!fs.existsSync(file)) return ['IMPLEMENTATION.md is missing']
  const text = readText(file)
  const problems = []
  if (text.trim().length < 200) problems.push('IMPLEMENTATION.md is too short')
  if (!/^#\s+Voxel data implementation\s*$/im.test(text)) {
    problems.push('missing H1: Voxel data implementation')
  }
  for (const section of IMPLEMENTATION_SECTIONS) {
    if (!new RegExp(`^#{1,6}\\s*${section}\\b`, 'im').test(text)) {
      problems.push(`missing section: ${section}`)
    }
  }
  return problems
}

function changedFileProblems(changed) {
  const problems = []
  for (const entry of changed) {
    if (entry.deleted) {
      problems.push(`agent deleted ${entry.file}`)
      continue
    }
    if (ALLOWED_FILES.has(entry.file) || DOC_ALLOWED.has(entry.file)) continue
    problems.push(`agent changed a file outside its bounded scope: ${entry.file}`)
  }
  if (!changed.some((entry) => entry.file === 'scripts/voxel_data.gd' && !entry.deleted)) {
    problems.push('agent did not change scripts/voxel_data.gd')
  }
  return problems
}

function failureSummary(result) {
  const lines = []
  const failed = (result.results || []).filter((caseResult) => !caseResult.passed)
  for (const caseResult of failed) {
    lines.push(`FAIL ${caseResult.name}: ${caseResult.detail}`)
  }
  for (const error of result.errors || []) lines.push(`ERROR: ${error}`)
  if (result.reason) lines.push(`reason: ${result.reason}`)
  if (lines.length === 0) lines.push(`test run failed (exit ${result.exitCode}, summary ${JSON.stringify(result.summary)})`)
  return lines.join('\n')
}

function writeFailure(dir, text) {
  fs.writeFileSync(path.join(dir, 'FAILURE.md'), text.endsWith('\n') ? text : `${text}\n`, 'utf8')
}

function saveTestResult(dir, name, result) {
  const parsed = {
    ok: result.ok,
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
    durationMs: result.durationMs,
    summary: result.summary,
    reason: result.reason,
    results: result.results,
    errors: result.errors,
    warnings: result.warnings,
  }
  fs.writeFileSync(path.join(dir, `${name}.json`), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
  fs.writeFileSync(path.join(dir, `${name}.stdout.txt`), result.stdout || '', 'utf8')
  fs.writeFileSync(path.join(dir, `${name}.stderr.txt`), result.stderr || '', 'utf8')
}

async function runHiddenSuite(projectDir) {
  const testsDir = path.join(projectDir, 'tests')
  fs.mkdirSync(testsDir, { recursive: true })
  fs.copyFileSync(HIDDEN_TEST, path.join(projectDir, HIDDEN_TEST_REL))
  try {
    return await runTests({
      project: projectDir,
      script: `res://${HIDDEN_TEST_REL}`,
      timeoutMs: 120000,
      allowOutsideRoot: true,
    })
  } finally {
    fs.rmSync(testsDir, { recursive: true, force: true })
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (!fs.existsSync(TASK_TEMPLATE)) throw new Error(`missing task template: ${TASK_TEMPLATE}`)
  if (!fs.existsSync(HIDDEN_TEST)) throw new Error(`missing hidden test: ${HIDDEN_TEST}`)
  const hiddenBefore = sha256(HIDDEN_TEST)

  const outDir = assertPhase19Directory(
    options.outDir || path.join(AGENT_RUNS_DIR, `implementation-${nowStamp()}`),
  )
  const logsDir = path.join(outDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })
  const baselineDir = path.join(outDir, 'baseline-project')
  copyDir(SOURCE, baselineDir, { skip: SKIP })

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase19-agent-'))
  const configDir = path.join(sandboxRoot, 'config')
  fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
  fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, 'opencode', 'opencode.json'))

  const taskText = readText(TASK_TEMPLATE)
  const taskPath = path.join(outDir, 'TASK.md')
  fs.writeFileSync(taskPath, taskText, 'utf8')

  const bin = resolveOpencodeBin()
  const manifest = {
    schema: 'phase19.voxel-agent.manifest.v1',
    run_id: path.basename(outDir),
    exported_at: new Date().toISOString(),
    model: options.model,
    opencode_bin: bin,
    source_project: SOURCE,
    baseline_project: baselineDir,
    task: path.relative(outDir, taskPath).split(path.sep).join('/'),
    task_sha256: sha256(taskPath),
    sandbox_config_sha256: sha256(SANDBOX_CONFIG_SOURCE),
    hidden_test_sha256_before: hiddenBefore,
    ordering: ['sandbox', 'agent-run', 'hidden-suite', 'copy-on-pass', 'canonical-suite'],
    attempts: [],
    status: 'failed',
    failure_reason: null,
    accepted: null,
  }

  try {
    let failureText = ''
    for (let attempt = 1; attempt <= options.maxAttempts; attempt++) {
      const attemptDir = path.join(outDir, 'attempts', `attempt-${attempt}`)
      const attemptRoot = path.join(sandboxRoot, `attempt-${attempt}`)
      const projectDir = path.join(attemptRoot, 'project')
      fs.mkdirSync(attemptDir, { recursive: true })
      copyDir(baselineDir, projectDir)
      fs.writeFileSync(path.join(attemptRoot, 'TASK.md'), taskText, 'utf8')
      if (failureText) writeFailure(attemptRoot, failureText)

      const prompt = [
        'Read ./TASK.md and carry out the task exactly.',
        failureText
          ? 'Read ./FAILURE.md for the previous verified failure, then repair the implementation in ./project/scripts/voxel_data.gd. Start from the current project copy and keep the public API.'
          : 'Implement the module in ./project/scripts/voxel_data.gd. Write ./project/IMPLEMENTATION.md when done.',
        'Do not edit tests, the harness, or any other file. Do not run shell commands; none are available.',
      ].join(' ')

      const startedAt = new Date().toISOString()
      const startedMs = Date.now()
      const jsonl = path.join(attemptDir, 'opencode.jsonl')
      const stderrFile = path.join(attemptDir, 'opencode.stderr.txt')
      const run = await runOpencode({
        bin,
        args: [
          'run',
          '--standalone',
          '--format',
          'json',
          '--auto',
          '--model',
          options.model,
          '--title',
          `phase19 voxel data attempt ${attempt}`,
          prompt,
        ],
        cwd: attemptRoot,
        env: { ...process.env, XDG_CONFIG_HOME: configDir },
        timeoutMs: options.timeoutMs,
      })
      fs.writeFileSync(jsonl, run.stdout || '', 'utf8')
      fs.writeFileSync(stderrFile, run.stderr || '', 'utf8')

      const changed = diffAgainstGiven({ defectiveDir: baselineDir, agentDir: projectDir })
      const problems = [...changedFileProblems(changed), ...implementationProblems(projectDir)]
      const attemptRecord = {
        attempt,
        started_at: startedAt,
        duration_ms: Date.now() - startedMs,
        opencode_exit_code: run.code,
        opencode_timed_out: run.timedOut,
        opencode_signal: run.signal,
        changed_files: changed,
        problems,
        hidden_suite: null,
        accepted: false,
      }

      if (run.timedOut) problems.push('OpenCode timed out before completing the attempt')
      if (run.code !== 0) problems.push(`OpenCode exited with code ${run.code}`)
      if (problems.length > 0) {
        const failure = `# Implementation attempt ${attempt} rejected\n\n${problems.map((item) => `- ${item}`).join('\n')}\n`
        writeFailure(attemptDir, failure)
        failureText = failure
        attemptRecord.failure = failure
        manifest.attempts.push(attemptRecord)
        writeJsonFile(outDir, 'run.json', manifest)
        continue
      }

      const result = await runHiddenSuite(projectDir)
      saveTestResult(attemptDir, 'hidden-suite', result)
      attemptRecord.hidden_suite = {
        ok: result.ok,
        summary: result.summary,
        reason: result.reason,
        duration_ms: result.durationMs,
      }
      if (!result.ok) {
        const failure = `# Hidden acceptance failure after attempt ${attempt}\n\nThe module compiled but did not satisfy the behavior. Details:\n\n${failureSummary(result)}\n`
        writeFailure(attemptDir, failure)
        failureText = failure
        attemptRecord.failure = failure
        manifest.attempts.push(attemptRecord)
        writeJsonFile(outDir, 'run.json', manifest)
        continue
      }

      // Only a fully verified module reaches the canonical worktree.
      const dataSource = path.join(projectDir, 'scripts', 'voxel_data.gd')
      const acceptedDir = path.join(outDir, 'accepted')
      fs.mkdirSync(acceptedDir, { recursive: true })
      fs.copyFileSync(dataSource, path.join(acceptedDir, 'voxel_data.gd'))
      const implementation = path.join(projectDir, 'IMPLEMENTATION.md')
      if (fs.existsSync(implementation)) {
        fs.copyFileSync(implementation, path.join(acceptedDir, 'IMPLEMENTATION.md'))
      }
      fs.copyFileSync(dataSource, path.join(SOURCE, 'scripts', 'voxel_data.gd'))

      const canonicalResult = await runTests({
        project: SOURCE,
        script: `res://${HIDDEN_TEST_REL}`,
        timeoutMs: 120000,
      })
      saveTestResult(outDir, 'canonical-data-suite', canonicalResult)
      if (!canonicalResult.ok) {
        // Never leave an unverified candidate in the canonical worktree.
        fs.copyFileSync(path.join(baselineDir, 'scripts', 'voxel_data.gd'), path.join(SOURCE, 'scripts', 'voxel_data.gd'))
        const failure = `# Canonical verification failed\n\n${failureSummary(canonicalResult)}\n`
        writeFailure(attemptDir, failure)
        failureText = failure
        attemptRecord.canonical_suite = {
          ok: false,
          summary: canonicalResult.summary,
          reason: canonicalResult.reason,
        }
        manifest.attempts.push(attemptRecord)
        writeJsonFile(outDir, 'run.json', manifest)
        continue
      }

      attemptRecord.hidden_suite.ok = true
      attemptRecord.canonical_suite = {
        ok: true,
        summary: canonicalResult.summary,
        reason: canonicalResult.reason,
        duration_ms: canonicalResult.durationMs,
      }
      attemptRecord.accepted = true
      attemptRecord.accepted_sha256 = sha256(path.join(SOURCE, 'scripts', 'voxel_data.gd'))
      manifest.attempts.push(attemptRecord)
      manifest.status = 'passed'
      manifest.accepted = {
        file: 'scripts/voxel_data.gd',
        sha256: attemptRecord.accepted_sha256,
        evidence_copy: 'accepted/voxel_data.gd',
        implementation_copy: fs.existsSync(path.join(acceptedDir, 'IMPLEMENTATION.md'))
          ? 'accepted/IMPLEMENTATION.md'
          : null,
      }
      manifest.hidden_test_sha256_after = sha256(HIDDEN_TEST)
      if (manifest.hidden_test_sha256_after !== hiddenBefore) {
        manifest.status = 'failed'
        manifest.failure_reason = 'hidden test changed during the run'
      }
      writeJsonFile(outDir, 'run.json', manifest)
      if (manifest.status !== 'passed') throw new Error(manifest.failure_reason)
      console.log(JSON.stringify({ status: 'passed', out_dir: outDir, accepted: manifest.accepted }, null, 2))
      return
    }

    manifest.failure_reason = `no passing implementation after ${options.maxAttempts} attempt(s)`
    manifest.hidden_test_sha256_after = sha256(HIDDEN_TEST)
    writeJsonFile(outDir, 'run.json', manifest)
    console.log(JSON.stringify({ status: 'failed', out_dir: outDir, reason: manifest.failure_reason }, null, 2))
    process.exitCode = 2
  } catch (error) {
    manifest.failure_reason = error.message
    writeJsonFile(outDir, 'run.json', manifest)
    throw error
  }
}

main().catch((error) => {
  console.error(error.stack || error.message)
  process.exit(1)
})
