#!/usr/bin/env node
/**
 * Phase 16 agent-task runner.
 *
 * Reuses the Phase 15 adapter's sandbox policy, OpenCode invocation, tree
 * hashing, and diff helpers, but runs a single game task instead of the
 * blind-benchmark diagnosis/repair pair:
 *
 *   1. copy `game/` into an isolated sandbox
 *   2. inject a controlled regression from a JSON spec
 *   3. import and run the acceptance suite (must reproduce the failure)
 *   4. give the agent the task + source and let it edit
 *   5. reject any test-oracle change
 *   6. verify with the real Godot harness
 *
 * Evidence is written only under docs/phase16/agent-runs/<run>.
 *
 * Usage:
 *   node controller/game-task.mjs \
 *     --task  ../../docs/phase16/agent-tasks/parry-window-repair.md \
 *     --defect ../../docs/phase16/agent-tasks/parry-window-repair.json \
 *     [--model opencode/...] [--out-dir <docs/phase16/agent-runs/...>]
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
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

const GAME_SOURCE = path.join(HARNESS_ROOT, 'game')
const AGENT_RUNS_DIR = path.join(DOCS_ROOT, 'phase16', 'agent-runs')
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free'
const DEFAULT_VERIFY_SCRIPT = 'res://tests/run_game_tests.gd'

function parseArgs(argv) {
  const options = {
    task: null,
    defect: null,
    outDir: null,
    model: process.env.PHASE16_AGENT_MODEL || DEFAULT_MODEL,
    timeoutMs: 300000,
    verifyScript: DEFAULT_VERIFY_SCRIPT,
    keepSandbox: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--task') options.task = argv[++i]
    else if (arg === '--defect') options.defect = argv[++i]
    else if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg === '--verify-script') options.verifyScript = argv[++i]
    else if (arg === '--keep-sandbox') options.keepSandbox = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.task) throw new Error('--task is required')
  if (!options.defect) throw new Error('--defect is required')
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 30000) {
    throw new Error('--timeout-ms must be a number >= 30000')
  }
  return options
}

function assertAgentRunDir(dir) {
  const resolved = path.resolve(dir)
  const relative = path.relative(AGENT_RUNS_DIR, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`agent evidence must stay inside ${AGENT_RUNS_DIR}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  return resolved
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function failingNames(result) {
  return (result.results || []).filter((entry) => !entry.passed).map((entry) => entry.name)
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
  const bin = GODOT_BIN
  const result = spawnSync(bin, ['--headless', '--path', projectDir, '--import'], {
    cwd: projectDir,
    encoding: 'utf8',
    timeout: 180000,
    windowsHide: true,
  })
  return {
    command: `${bin} --headless --path <sandbox>/game --import`,
    status: result.status,
    error: result.error ? result.error.message : null,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const taskText = fs.readFileSync(options.task, 'utf8')
  const spec = readJson(options.defect)
  for (const key of ['id', 'file', 'find', 'replace', 'expected_failing']) {
    if (!(key in spec)) throw new Error(`defect spec is missing ${key}`)
  }
  if (!Array.isArray(spec.expected_failing) || spec.expected_failing.length === 0) {
    throw new Error('defect spec expected_failing must be a non-empty array')
  }

  const runId = `${nowStamp()}-${spec.id}`
  const outDir = assertAgentRunDir(options.outDir || path.join(AGENT_RUNS_DIR, runId))
  const logsDir = path.join(outDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase16-agent-'))
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
    schema: 'phase16.agent-task.manifest.v1',
    run_id: path.basename(outDir),
    created_at: new Date().toISOString(),
    status: 'failed',
    failure_reason: null,
    model_spec: options.model,
    task: {
      path: path.relative(DOCS_ROOT, path.resolve(options.task)).split(path.sep).join('/'),
      sha256: sha256(options.task),
      bytes: fs.statSync(options.task).size,
    },
    agent: {
      bin,
      version: String(versionRun.stdout || versionRun.stderr || '').trim(),
      version_exit_code: versionRun.status,
      standalone: true,
      invocation: 'opencode run --standalone --format json --auto',
      sandbox_config: {
        path: path.relative(path.resolve(HARNESS_ROOT, '..', '..'), SANDBOX_CONFIG_SOURCE).split(path.sep).join('/'),
        sha256: sha256(SANDBOX_CONFIG_SOURCE),
      },
      denied: ['shell', 'webfetch', 'websearch', 'execute', 'question', 'skill', 'subagent'],
      events: null,
      exit_code: null,
      timed_out: false,
      duration_ms: null,
    },
    defect: {
      spec_path: path.relative(DOCS_ROOT, path.resolve(options.defect)).split(path.sep).join('/'),
      spec_sha256: sha256(options.defect),
      id: spec.id,
      description: spec.description ?? '',
      file: spec.file,
      pristine_sha256: null,
      injected_sha256: null,
      expected_failing: spec.expected_failing,
    },
    before: null,
    repair: null,
    after: null,
    verification: null,
    import: null,
    cleanup: null,
  }

  const spawnedPids = []
  let failure = null
  try {
    // ---- 1. Isolated copy + controlled defect -----------------------------
    copyDir(GAME_SOURCE, projectDir, { skip: ['.godot', 'artifacts'] })
    fs.copyFileSync(options.task, path.join(outDir, 'TASK.md'))
    fs.copyFileSync(options.task, path.join(sandboxDir, 'TASK.md'))
    fs.copyFileSync(options.defect, path.join(outDir, 'defect.json'))

    const targetRelative = spec.file.replace(/^game[\\/]/, '')
    const targetPath = path.join(projectDir, targetRelative)
    if (!fs.existsSync(targetPath)) throw new Error(`defect target does not exist: ${spec.file}`)
    const pristine = fs.readFileSync(targetPath, 'utf8')
    const occurrences = pristine.split(spec.find).length - 1
    if (occurrences !== 1) {
      throw new Error(`defect find string must occur exactly once (found ${occurrences})`)
    }
    fs.writeFileSync(targetPath, pristine.replace(spec.find, spec.replace), 'utf8')
    manifest.defect.pristine_sha256 = crypto.createHash('sha256').update(pristine, 'utf8').digest('hex')
    manifest.defect.injected_sha256 = sha256(targetPath)

    // Diff baseline: the injected project before the agent touches it.
    copyDir(projectDir, baselineDir)
    const testsBefore = hashTreeOfTests(projectDir)

    // ---- 2. Import and reproduce the failure -------------------------------
    manifest.import = ensureImported(projectDir)
    fs.writeFileSync(
      path.join(logsDir, 'import.txt'),
      `${manifest.import.command}\nexit=${manifest.import.status}\n${manifest.import.stdout}\n${manifest.import.stderr}`,
      'utf8',
    )
    if (manifest.import.error || manifest.import.status !== 0) {
      throw new Error(`Godot import failed: ${manifest.import.error || `exit ${manifest.import.status}`}`)
    }

    const before = await runTests({
      project: projectDir,
      script: options.verifyScript,
      timeoutMs: 90000,
      allowOutsideRoot: true,
    })
    const failingBefore = failingNames(before)
    manifest.before = {
      ok: before.ok,
      summary: before.summary,
      failing_before: failingBefore,
      duration_ms: before.durationMs,
      timed_out: before.timedOut ?? false,
    }
    writeJsonFile(logsDir, 'before-tests.json', {
      ok: before.ok,
      summary: before.summary,
      results: before.results ?? [],
      failing: failingBefore,
      stdout: before.stdout,
      stderr: before.stderr,
    })
    const missed = spec.expected_failing.filter((name) => !failingBefore.includes(name))
    if (missed.length > 0) {
      throw new Error(`injected defect did not reproduce: ${missed.join(', ')} still passing`)
    }

    // ---- 3. Single agent task ---------------------------------------------
    const jsonl = path.join(logsDir, 'opencode.jsonl')
    const run = await runOpencode({
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
        `phase16 ${spec.id}`,
        'Read ./TASK.md and carry out the task. Follow it exactly.',
      ],
      cwd: sandboxDir,
      env: { ...process.env, XDG_CONFIG_HOME: configDir },
      timeoutMs: options.timeoutMs,
      pids: spawnedPids,
    })
    fs.writeFileSync(jsonl, run.stdout, 'utf8')
    fs.writeFileSync(path.join(logsDir, 'opencode.stderr.txt'), run.stderr, 'utf8')
    manifest.agent.events = summarizeJsonl(jsonl)
    manifest.agent.exit_code = run.code
    manifest.agent.timed_out = run.timedOut
    manifest.agent.duration_ms = run.durationMs
    if (run.timedOut) throw new Error(`agent run timed out after ${options.timeoutMs} ms`)
    if (run.code !== 0) throw new Error(`agent run exited with code ${run.code}`)

    // ---- 4. Reject oracle changes and empty diffs --------------------------
    const testsAfter = hashTreeOfTests(projectDir)
    const oracleChanged = Object.keys({ ...testsBefore, ...testsAfter }).filter(
      (key) => testsBefore[key] !== testsAfter[key],
    )
    const changed = diffAgainstGiven({ defectiveDir: baselineDir, agentDir: projectDir })
    const intendedRelative = spec.file.replace(/^game[\\/]/, '')
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
      entry.touches_injected_file = entry.file === intendedRelative
      diffParts.push(`=== ${entry.file} ===\n${described.patch}`)
    }
    fs.writeFileSync(path.join(outDir, 'repair.diff'), `${diffParts.join('\n\n')}\n`, 'utf8')
    manifest.repair = {
      changed_files: changed,
      diff: 'repair.diff',
      test_oracle_unchanged: oracleChanged.length === 0,
      oracle_changed: oracleChanged,
      deletes_files: changed.some((entry) => entry.deleted),
      matches_intended_file:
        changed.length > 0 && changed.every((entry) => entry.file === intendedRelative),
    }
    if (oracleChanged.length > 0) {
      throw new Error(`the agent modified the test oracle: ${oracleChanged.join(', ')}`)
    }
    if (changed.length === 0) throw new Error('the agent made no change to the project')
    if (changed.some((entry) => entry.deleted)) throw new Error('the agent deleted a project file')

    // ---- 5. Adapter-side verification with the real harness ---------------
    const after = await runTests({
      project: projectDir,
      script: options.verifyScript,
      timeoutMs: 90000,
      allowOutsideRoot: true,
    })
    const failingAfter = failingNames(after)
    manifest.after = {
      ok: after.ok,
      summary: after.summary,
      failing_after: failingAfter,
      duration_ms: after.durationMs,
      timed_out: after.timedOut ?? false,
    }
    fs.writeFileSync(
      path.join(outDir, 'verification-test-output.txt'),
      `${after.stdout}\n${after.stderr}`,
      'utf8',
    )
    writeJsonFile(logsDir, 'after-tests.json', {
      ok: after.ok,
      summary: after.summary,
      results: after.results ?? [],
      failing: failingAfter,
      stdout: after.stdout,
      stderr: after.stderr,
    })
    manifest.verification = {
      script: options.verifyScript,
      status: after.ok && failingAfter.length === 0 ? 'passed' : 'failed',
      expected_now_passing: spec.expected_failing.filter((name) => !failingAfter.includes(name)),
      still_failing: failingAfter,
    }
    if (!after.ok || failingAfter.length > 0) {
      throw new Error(
        `verification failed (exit ${after.exitCode}); still failing: ${failingAfter.join(', ') || 'none reported'}`,
      )
    }

    manifest.status = 'passed'
  } catch (error) {
    failure = error
    manifest.status = 'failed'
    manifest.failure_reason = error.message
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
  if (manifest.before) {
    console.log(
      `BEFORE ok=${manifest.before.ok} failing=${manifest.before.failing_before.join(',') || 'none'}`,
    )
  }
  if (manifest.repair) {
    console.log(`CHANGED ${manifest.repair.changed_files.map((entry) => entry.file).join(',')}`)
  }
  if (manifest.after) {
    console.log(
      `AFTER ok=${manifest.after.ok} failing=${manifest.after.failing_after.join(',') || 'none'}`,
    )
  }
  if (manifest.failure_reason) console.log(`FAILURE ${manifest.failure_reason}`)
  console.log(`EVIDENCE ${outDir}`)
  if (manifest.status !== 'passed') process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
