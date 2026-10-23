#!/usr/bin/env node
/**
 * Phase 18 vision-driven implementation runner.
 *
 * The diagnosis stage already ran in an evidence-only sandbox. This runner
 * gives a fresh disposable source copy to the agent only after that diagnosis
 * exists. It accepts only bounded visual code changes, applies them to the
 * real Phase 18 worktree, and verifies the result with the real windowed game,
 * the existing 18-check game suite, and the hidden 12-check dodge suite.
 *
 * The agent never receives tests, the harness, docs, or the acceptance
 * thresholds. Failed attempts are preserved before the next bounded attempt.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
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

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PHASE18_DIR = path.join(DOCS_ROOT, 'phase18')
const AGENT_RUNS_DIR = path.join(PHASE18_DIR, 'evidence', 'agent-runs')
const GAME_SOURCE = path.join(HARNESS_ROOT, 'game')
const WORKTREE_ROOT = path.resolve(HARNESS_ROOT, '..', '..')
const VISUAL_SCRIPT = path.join(HERE, 'phase18-visual-check.mjs')
const HIDDEN_TEST = path.join(GAME_SOURCE, 'tests', 'run_dodge_tests.gd')
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free'
const ALLOWED_SCRIPT = /^scripts\/.+\.gd$/
const IMAGES = [
  'idle.png',
  'windup-early.png',
  'windup-mid.png',
  'windup-late.png',
  'active.png',
  'recovery.png',
  'restart.png',
]

function parseArgs(argv) {
  const options = {
    source: GAME_SOURCE,
    baselineDir: null,
    referenceDir: null,
    diagnosisDir: null,
    outDir: null,
    model: process.env.PHASE18_AGENT_MODEL || DEFAULT_MODEL,
    timeoutMs: 900000,
    maxAttempts: 3,
    seedScripts: null,
    seedFailure: null,
    observedDir: null,
    taskFile: null,
    keepSandbox: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--source') options.source = argv[++i]
    else if (arg === '--baseline-dir') options.baselineDir = argv[++i]
    else if (arg === '--reference-dir') options.referenceDir = argv[++i]
    else if (arg === '--diagnosis-dir') options.diagnosisDir = argv[++i]
    else if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg === '--max-attempts') options.maxAttempts = Number(argv[++i])
    else if (arg === '--seed-scripts') options.seedScripts = argv[++i]
    else if (arg === '--seed-failure') options.seedFailure = argv[++i]
    else if (arg === '--observed-dir') options.observedDir = argv[++i]
    else if (arg === '--task') options.taskFile = argv[++i]
    else if (arg === '--keep-sandbox') options.keepSandbox = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.baselineDir) throw new Error('--baseline-dir is required')
  if (!options.diagnosisDir) throw new Error('--diagnosis-dir is required')
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 30000) {
    throw new Error('--timeout-ms must be >= 30000')
  }
  if (!Number.isInteger(options.maxAttempts) || options.maxAttempts < 1 || options.maxAttempts > 4) {
    throw new Error('--max-attempts must be an integer from 1 to 4')
  }
  return options
}

function assertEvidenceDir(dir) {
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

function sha256Text(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex')
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'))
}

function fileState(root) {
  const out = {}
  function walk(dir, rel = '') {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, childRel)
      else if (entry.isFile()) out[childRel] = sha256(full)
    }
  }
  if (fs.existsSync(root)) walk(root)
  return out
}

function copyFileInto(source, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
}

function listScripts(root) {
  const out = []
  function walk(dir, rel = '') {
    if (!fs.existsSync(dir)) return
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full, childRel)
      else if (entry.isFile() && childRel.endsWith('.gd')) out.push(childRel)
    }
  }
  walk(root)
  return out.sort()
}

/**
 * Apply exactly the agent's allowed .gd files to the canonical worktree. A
 * new script that a later attempt removed is removed here too, but only when
 * it was not present in the original game source.
 */
function mirrorScripts(projectDir, baselineScriptsDir, worktreeScriptsDir) {
  const baseline = new Set(listScripts(baselineScriptsDir))
  const sandboxScripts = listScripts(path.join(projectDir, 'scripts'))
  for (const rel of sandboxScripts) {
    copyFileInto(path.join(projectDir, 'scripts', rel), path.join(worktreeScriptsDir, rel))
    const stat = fs.statSync(path.join(projectDir, 'scripts', rel))
    fs.utimesSync(path.join(worktreeScriptsDir, rel), stat.atime, stat.mtime)
  }
  const sandboxSet = new Set(sandboxScripts)
  for (const rel of listScripts(worktreeScriptsDir)) {
    if (!baseline.has(rel) && !sandboxSet.has(rel)) {
      fs.rmSync(path.join(worktreeScriptsDir, rel), { force: true })
    }
  }
  return sandboxScripts
}

function writeTask(sandboxDir, diagnosisFile, baselineRun) {
  const task = `# Phase 18 implementation task: readable incoming-attack telegraph

You are the implementation stage of a controlled visual-repair experiment.
You have a disposable copy of the game source. The diagnosis stage ran before
you received source access and its report is \`./diagnosis.md\`.

## Evidence
- Baseline captures: \`./baseline/*.png\`
- Correlated public snapshots: \`./baseline/captures.json\`
- Source: \`./game\` (no tests, harness, docs, or acceptance thresholds)
- Baseline run: \`${baselineRun}\`

Read \`./TASK.md\`, \`./diagnosis.md\`, the baseline images, and the relevant source.
Use the actual images, not assumptions.

## Visual requirement
The game currently announces an incoming attack mainly with HUD text and a
thin blade glow. Make the threat readable in the 3D scene itself.

Implement a bounded visual change that:
1. adds a ground-level warning around the enemy's feet, visible in the normal
   camera framing even when the player partly occludes the enemy;
2. is already visible early in windup;
3. becomes more prominent as windup approaches the attack;
4. is absent in idle and recovery;
5. is driven by the existing enemy windup phase/tick, not a separate timer;
6. leaves all movement, attacks, deflect/posture, dodge, enemy damage, victory/
   defeat, restart/reset, camera, and existing HUD behavior unchanged.

Use only existing game assets and code. Do not add an external asset or a new
dependency. Do not change tests, the harness, \`project.godot\`, scenes, input
maps, physics, combat timings, or HUD text. Do not add a screen-space overlay:
the warning must be in the 3D world around the enemy.

## Allowed changes
Only existing or new \`.gd\` files under \`game/scripts/\`. Keep the change small
and reviewable. If you add a helper, place it under \`game/scripts/\`.

## Required notes
Write \`./IMPLEMENTATION.md\` with these sections:

# Phase 18 Implementation

## Chosen approach
What visual mechanism you added and why it matches the diagnosis.

## Files changed
Exact relative paths and what changed.

## Visual behavior
How it appears early and late in windup, and why it does not appear in idle or
recovery.

## Behavior preserved
Why this cannot affect gameplay, timing, collisions, health, posture, dodge,
camera, restart, or HUD text.

## Limits
What you could not verify without running the game.

Do not claim the implementation passes a test or that you ran the game. The
independent runner will apply this exact source to the canonical worktree and
capture real screenshots.
`
  fs.writeFileSync(path.join(sandboxDir, 'TASK.md'), task, 'utf8')
  fs.copyFileSync(diagnosisFile, path.join(sandboxDir, 'diagnosis.md'))
}

function writeBaselineEvidence(sandboxDir, baselineDir) {
  const baselineCopy = path.join(sandboxDir, 'baseline')
  fs.mkdirSync(baselineCopy, { recursive: true })
  for (const name of IMAGES) {
    const src = path.join(baselineDir, name)
    if (!fs.existsSync(src)) throw new Error(`missing baseline image: ${src}`)
    fs.copyFileSync(src, path.join(baselineCopy, name))
  }
  const captures = path.join(baselineDir, 'captures.json')
  if (!fs.existsSync(captures)) throw new Error(`missing baseline captures: ${captures}`)
  fs.copyFileSync(captures, path.join(baselineCopy, 'captures.json'))
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

function summarizeVisual(postDir) {
  const runFile = path.join(postDir, 'run.json')
  const acceptanceFile = path.join(postDir, 'visual-acceptance.json')
  const run = fs.existsSync(runFile) ? readJson(runFile) : null
  const acceptance = fs.existsSync(acceptanceFile) ? readJson(acceptanceFile) : null
  const failed = acceptance
    ? (acceptance.checks || []).filter((entry) => !entry.ok).map((entry) => entry.name)
    : ['visual-check-not-produced']
  const metrics = {}
  for (const [name, value] of Object.entries(acceptance?.metrics || {})) {
    if (value && typeof value === 'object' && 'warm_pixels' in value) {
      metrics[name] = {
        warm_pixels: value.warm_pixels,
        changed_pixels_vs_idle: value.changed_pixels_vs_idle ?? null,
        enemy_phase: value.state?.enemy_phase ?? null,
        enemy_phase_tick: value.state?.enemy_phase_tick ?? null,
      }
    }
  }
  return {
    ok: Boolean(run?.status === 'passed' && acceptance?.passed === true && failed.length === 0),
    run_status: run?.status ?? null,
    acceptance_passed: acceptance?.passed ?? null,
    failed_checks: failed,
    metrics,
    capture_count: run?.capture_count ?? 0,
    project: run?.project ?? null,
    failure: run?.failure ?? null,
  }
}

function visualFeedback(summary) {
  const lines = []
  lines.push('# Independent verification failure')
  lines.push('')
  lines.push('The real windowed game was run after your change. The independent image checker did not accept it.')
  lines.push('')
  lines.push('## Failed visual checks')
  for (const name of summary.failed_checks) lines.push(`- ${name}`)
  lines.push('')
  lines.push('## Observed ground-band warm pixels')
  for (const [name, value] of Object.entries(summary.metrics)) {
    lines.push(
      `- ${name}: warm=${value.warm_pixels}, changed_vs_idle=${value.changed_pixels_vs_idle ?? 'n/a'}, phase=${value.enemy_phase}:${value.enemy_phase_tick}`,
    )
  }
  lines.push('')
  lines.push('## New screenshots')
  lines.push('The actual post-change frames are in the feedback directory. Read them with the read tool; they are real captures, not rendered mockups. Compare early and late windup, and idle/recovery.')
  lines.push('')
  lines.push('## Constraints')
  lines.push('Do not edit tests, the harness, project.godot, scenes, assets, or HUD. The warning must be in the 3D world at the enemy feet and must escalate during windup. Keep gameplay behavior unchanged.')
  return lines.join('\n') + '\n'
}

function implementationProblems(directory) {
  const file = path.join(directory, 'IMPLEMENTATION.md')
  if (!fs.existsSync(file)) return ['IMPLEMENTATION.md is missing']
  const text = fs.readFileSync(file, 'utf8')
  const problems = []
  if (text.trim().length < 200) problems.push('IMPLEMENTATION.md is too short')
  for (const section of ['Chosen approach', 'Files changed', 'Visual behavior', 'Behavior preserved', 'Limits']) {
    if (!new RegExp(`^#{1,6}\\s*${section}`, 'im').test(text)) problems.push(`missing section: ${section}`)
  }
  return problems
}

async function runVisual({ outDir, baselineDir, label }) {
  const result = spawnSync(
    process.execPath,
    [
      VISUAL_SCRIPT,
      '--out-dir',
      outDir,
      '--baseline-dir',
      baselineDir,
      '--label',
      label,
      '--expect',
      'pass',
    ],
    {
      cwd: WORKTREE_ROOT,
      encoding: 'utf8',
      timeout: 240000,
      windowsHide: true,
      env: process.env,
    },
  )
  const summary = summarizeVisual(outDir)
  return {
    exit_code: result.status,
    signal: result.signal,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    ...summary,
  }
}

async function runSuite({ project, script, outDir, label }) {
  const result = await runTests({ project, script, timeoutMs: 120000, allowOutsideRoot: true })
  const tests = result.results || []
  const failing = tests.filter((entry) => !entry.passed).map((entry) => entry.name)
  const ok = Boolean(result.ok) && tests.length > 0 && failing.length === 0
  fs.writeFileSync(
    path.join(outDir, `${label}.txt`),
    `${label}\nscript=${script}\nexit=${result.exitCode}\nduration_ms=${result.durationMs}\nstdout:\n${result.stdout || ''}\nstderr:\n${result.stderr || ''}\n`,
    'utf8',
  )
  writeJsonFile(outDir, `${label}.json`, {
    ok,
    passed: tests.filter((entry) => entry.passed).length,
    total: tests.length,
    failing,
    duration_ms: result.durationMs,
    exit_code: result.exitCode,
    timed_out: Boolean(result.timedOut),
    results: tests,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  })
  return {
    ok,
    passed: tests.filter((entry) => entry.passed).length,
    total: tests.length,
    failing,
    exit_code: result.exitCode,
    duration_ms: result.durationMs,
    timed_out: Boolean(result.timedOut),
  }
}

function copyFeedbackImages(postDir, feedbackDir) {
  fs.mkdirSync(feedbackDir, { recursive: true })
  for (const name of IMAGES) {
    const src = path.join(postDir, name)
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(feedbackDir, name))
  }
}

function makeAttemptRecord({ label, status, startedAt, durationMs, changedFiles, visual, existing, dodge, notes, failure }) {
  return {
    label,
    status,
    started_at: startedAt,
    duration_ms: durationMs,
    changed_files: changedFiles,
    implementation_notes_problems: notes,
    visual,
    existing,
    dodge,
    failure,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const baselineDir = path.resolve(options.baselineDir)
  const referenceDir = path.resolve(options.referenceDir || options.baselineDir)
  const diagnosisDir = path.resolve(options.diagnosisDir)
  const diagnosisFile = path.join(diagnosisDir, 'diagnosis.md')
  if (!fs.existsSync(path.join(baselineDir, 'visual-acceptance.json'))) {
    throw new Error(`baseline is missing visual-acceptance.json: ${baselineDir}`)
  }
  if (!fs.existsSync(diagnosisFile)) throw new Error(`missing diagnosis: ${diagnosisFile}`)
  if (!fs.existsSync(HIDDEN_TEST)) throw new Error(`hidden dodge test missing: ${HIDDEN_TEST}`)

  const outDir = assertEvidenceDir(
    options.outDir || path.join(AGENT_RUNS_DIR, `implementation-${nowStamp()}`),
  )
  const logsDir = path.join(outDir, 'logs')
  fs.mkdirSync(logsDir, { recursive: true })

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-agent-'))
  const sandboxDir = path.join(sandboxRoot, 'sandbox')
  const projectDir = path.join(sandboxDir, 'game')
  const baselineSourceDir = path.join(sandboxRoot, 'baseline', 'game')
  const baselineScriptsDir = path.join(baselineSourceDir, 'scripts')
  const configDir = path.join(sandboxRoot, 'config')
  const worktreeScriptsDir = path.join(GAME_SOURCE, 'scripts')
  fs.mkdirSync(sandboxDir, { recursive: true })
  fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
  fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, 'opencode', 'opencode.json'))

  const sourceFilesBefore = fileState(GAME_SOURCE)
  const hiddenBefore = sha256(HIDDEN_TEST)
  let manifest = {
    schema: 'phase18.agent-run.v1',
    status: 'running',
    started_at: new Date().toISOString(),
    finished_at: null,
    model: options.model,
    baseline_dir: baselineDir,
    reference_dir: referenceDir,
    diagnosis_dir: diagnosisDir,
    diagnosis_sha256: sha256(diagnosisFile),
    source: GAME_SOURCE,
    worktree: WORKTREE_ROOT,
    model_access_order: {
      diagnosis_first: true,
      diagnosis_completed_at: readJson(path.join(diagnosisDir, 'run.json')).finished_at ?? null,
      source_copied_at: null,
      note: 'Source was copied into the implementation sandbox only after the diagnosis run finished.',
    },
    policy: {
      config: SANDBOX_CONFIG_SOURCE.split(path.sep).join('/'),
      config_sha256: sha256(SANDBOX_CONFIG_SOURCE),
      tests_copied: false,
      harness_changes_allowed: false,
      allowed_change_pattern: 'scripts/*.gd',
      max_attempts: options.maxAttempts,
      hidden_test_sha256_before: hiddenBefore,
    },
    sandbox: {
      source_copied: false,
      tests_copied: false,
      baseline_images: IMAGES,
      diagnosis: 'diagnosis.md',
      task: 'TASK.md',
    },
    attempts: [],
    final: null,
    source_files_before: sourceFilesBefore,
    failure_reason: null,
  }
  writeJsonFile(outDir, 'run.json', manifest)

  try {
    copyDir(options.source, projectDir, { skip: ['.godot', 'artifacts', 'tests', 'build'] })
    if (options.seedScripts) {
      const seed = path.resolve(options.seedScripts)
      if (!fs.existsSync(seed)) throw new Error(`seed scripts directory missing: ${seed}`)
      copyDir(seed, path.join(projectDir, 'scripts'))
      manifest.seed = { scripts: seed, scripts_mode: 'overlaid on canonical source' }
    }
    if (options.seedFailure) {
      const seedFailure = path.resolve(options.seedFailure)
      if (!fs.existsSync(seedFailure)) throw new Error(`seed failure file missing: ${seedFailure}`)
      fs.copyFileSync(seedFailure, path.join(sandboxDir, 'FAILURE.md'))
      fs.copyFileSync(seedFailure, path.join(outDir, 'seed-FAILURE.md'))
      manifest.seed = { ...(manifest.seed || {}), failure: seedFailure }
    }
    copyDir(projectDir, baselineSourceDir)
    if (options.seedScripts) {
      // Keep the canonical worktree in sync with the exact failed source the
      // agent is repairing. The repair is still the only thing that can make
      // the runner reach a passing verification.
      mirrorScripts(projectDir, baselineScriptsDir, worktreeScriptsDir)
    }
    writeBaselineEvidence(sandboxDir, referenceDir)
    if (options.observedDir) {
      const observedDir = path.resolve(options.observedDir)
      if (!fs.existsSync(observedDir)) throw new Error(`observed evidence directory missing: ${observedDir}`)
      const observedCopy = path.join(sandboxDir, 'observed')
      fs.mkdirSync(observedCopy, { recursive: true })
      for (const name of IMAGES) {
        const src = path.join(observedDir, name)
        if (!fs.existsSync(src)) throw new Error(`missing observed image: ${src}`)
        fs.copyFileSync(src, path.join(observedCopy, name))
      }
      const observedCaptures = path.join(observedDir, 'captures.json')
      if (!fs.existsSync(observedCaptures)) throw new Error(`missing observed captures: ${observedCaptures}`)
      fs.copyFileSync(observedCaptures, path.join(observedCopy, 'captures.json'))
      manifest.observed = { dir: observedDir, images: IMAGES.length, sandbox_path: 'observed' }
    }
    writeTask(sandboxDir, diagnosisFile, readJson(path.join(referenceDir, 'run.json')).run_id)
    if (options.taskFile) {
      const taskFile = path.resolve(options.taskFile)
      if (!fs.existsSync(taskFile)) throw new Error(`task file missing: ${taskFile}`)
      fs.copyFileSync(taskFile, path.join(sandboxDir, 'TASK.md'))
      manifest.task = { source: taskFile, sha256: sha256(taskFile) }
    }
    fs.copyFileSync(path.join(sandboxDir, 'TASK.md'), path.join(outDir, 'TASK.md'))
    fs.copyFileSync(diagnosisFile, path.join(outDir, 'diagnosis.md'))
    copyDir(path.join(baselineSourceDir, 'scripts'), path.join(outDir, 'source-baseline', 'scripts'))
    manifest.model_access_order.source_copied_at = new Date().toISOString()
    manifest.sandbox.source_copied = true
    writeJsonFile(outDir, 'run.json', manifest)

    const bin = resolveOpencodeBin()
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
    const pids = []
    let passed = false

    for (let attemptIndex = 0; attemptIndex < options.maxAttempts; attemptIndex++) {
      const attemptNumber = attemptIndex + 1
      const label = `implementation-${attemptNumber}`
      const attemptDir = path.join(outDir, `attempt-${attemptNumber}`)
      fs.mkdirSync(attemptDir, { recursive: true })
      const startedAt = new Date().toISOString()
      const attemptStart = Date.now()
      const failurePath = path.join(sandboxDir, 'FAILURE.md')
      if (attemptIndex === 0 && !options.seedFailure) fs.rmSync(failurePath, { force: true })
      const hasFailure = fs.existsSync(failurePath)
      const prompt =
        attemptIndex === 0 && !hasFailure
          ? 'Read ./TASK.md, ./diagnosis.md, the baseline images, and the relevant game source. Implement the visual change in this disposable copy. Write ./IMPLEMENTATION.md. Do not edit tests or the harness.'
          : 'Read ./TASK.md, ./FAILURE.md, the new feedback images if present, and the source. Diagnose the failed real run and repair the visual implementation in this disposable copy. Keep all constraints. Write ./IMPLEMENTATION.md. Do not edit tests or the harness.'

      const jsonl = path.join(attemptDir, 'opencode.jsonl')
      const stderrFile = path.join(attemptDir, 'opencode.stderr.txt')
      let run
      try {
        run = await runOpencode({
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
            `phase18 visual attempt ${attemptNumber}`,
            prompt,
          ],
          cwd: sandboxDir,
          env: { ...process.env, XDG_CONFIG_HOME: configDir },
          timeoutMs: options.timeoutMs,
          pids,
        })
        fs.writeFileSync(jsonl, run.stdout, 'utf8')
        fs.writeFileSync(stderrFile, run.stderr, 'utf8')
      } catch (error) {
        run = { code: -1, timedOut: false, durationMs: Date.now() - attemptStart, stdout: '', stderr: error.message }
        fs.writeFileSync(jsonl, '', 'utf8')
        fs.writeFileSync(stderrFile, error.message, 'utf8')
      }
      const agentSummary = summarizeJsonl(jsonl)
      const notes = implementationProblems(sandboxDir)
      const changed = diffAgainstGiven({ defectiveDir: baselineSourceDir, agentDir: projectDir })
      const changedFiles = changed.map((entry) => entry.file)
      const deleted = changed.filter((entry) => entry.deleted).map((entry) => entry.file)
      const disallowed = changedFiles.filter((file) => !ALLOWED_SCRIPT.test(file))
      const diffParts = []
      for (const entry of changed) {
        if (entry.deleted) {
          diffParts.push(`deleted ${entry.file}`)
          continue
        }
        const before = path.join(baselineSourceDir, entry.file)
        const after = path.join(projectDir, entry.file)
        const beforeText = fs.existsSync(before) ? fs.readFileSync(before, 'utf8') : ''
        const afterText = fs.readFileSync(after, 'utf8')
        const lines = [`--- ${entry.file}`, `+++ ${entry.file}`]
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
        for (const line of a.slice(start, endA + 1)) lines.push(`-${line}`)
        for (const line of b.slice(start, endB + 1)) lines.push(`+${line}`)
        diffParts.push(lines.join('\n'))
      }
      fs.writeFileSync(path.join(attemptDir, 'attempt.diff'), `${diffParts.join('\n\n')}\n`, 'utf8')
      fs.writeFileSync(
        path.join(attemptDir, 'agent-summary.json'),
        JSON.stringify(agentSummary, null, 2) + '\n',
        'utf8',
      )
      copyDir(path.join(projectDir, 'scripts'), path.join(attemptDir, 'source', 'scripts'))
      if (fs.existsSync(path.join(sandboxDir, 'IMPLEMENTATION.md'))) {
        fs.copyFileSync(path.join(sandboxDir, 'IMPLEMENTATION.md'), path.join(attemptDir, 'IMPLEMENTATION.md'))
      }
      if (run.timedOut) {
        const failure = 'agent timed out'
        manifest.attempts.push(
          makeAttemptRecord({
            label,
            status: 'failed',
            startedAt,
            durationMs: Date.now() - attemptStart,
            changedFiles,
            visual: null,
            existing: null,
            dodge: null,
            notes,
            failure,
          }),
        )
        writeJsonFile(outDir, 'run.json', manifest)
        fs.writeFileSync(path.join(sandboxDir, 'FAILURE.md'), `# Agent timed out\n\nThe previous run exceeded ${options.timeoutMs} ms. Continue from the current source.\n`, 'utf8')
        if (attemptIndex + 1 >= options.maxAttempts) throw new Error(failure)
        continue
      }
      if (run.code !== 0) {
        const failure = `agent exited with code ${run.code}`
        manifest.attempts.push(
          makeAttemptRecord({
            label,
            status: 'failed',
            startedAt,
            durationMs: Date.now() - attemptStart,
            changedFiles,
            visual: null,
            existing: null,
            dodge: null,
            notes,
            failure,
          }),
        )
        writeJsonFile(outDir, 'run.json', manifest)
        fs.writeFileSync(path.join(sandboxDir, 'FAILURE.md'), `# Agent process failed\n\n${run.stderr}\n`, 'utf8')
        if (attemptIndex + 1 >= options.maxAttempts) throw new Error(failure)
        continue
      }
      if (deleted.length > 0 || disallowed.length > 0) {
        const failure = `disallowed change: deleted=${deleted.join(',') || 'none'} disallowed=${disallowed.join(',') || 'none'}`
        manifest.attempts.push(
          makeAttemptRecord({
            label,
            status: 'failed',
            startedAt,
            durationMs: Date.now() - attemptStart,
            changedFiles,
            visual: null,
            existing: null,
            dodge: null,
            notes,
            failure,
          }),
        )
        writeJsonFile(outDir, 'run.json', manifest)
        fs.writeFileSync(
          path.join(sandboxDir, 'FAILURE.md'),
          `# Policy violation\n\n${failure}\n\nOnly changes to existing or new .gd files under game/scripts/ are allowed. Restore any other file and try again.\n`,
          'utf8',
        )
        if (attemptIndex + 1 >= options.maxAttempts) throw new Error(failure)
        continue
      }
      if (changedFiles.length === 0 || notes.length > 0) {
        const failure =
          changedFiles.length === 0
            ? 'agent made no source change'
            : `implementation notes invalid: ${notes.join('; ')}`
        manifest.attempts.push(
          makeAttemptRecord({
            label,
            status: 'failed',
            startedAt,
            durationMs: Date.now() - attemptStart,
            changedFiles,
            visual: null,
            existing: null,
            dodge: null,
            notes,
            failure,
          }),
        )
        writeJsonFile(outDir, 'run.json', manifest)
        fs.writeFileSync(path.join(sandboxDir, 'FAILURE.md'), `# Incomplete implementation\n\n${failure}\n\nImplement the source change and write all required IMPLEMENTATION.md sections.\n`, 'utf8')
        if (attemptIndex + 1 >= options.maxAttempts) throw new Error(failure)
        continue
      }

      // The agent's exact allowed source is now applied to the canonical
      // worktree. Tests and the harness in the worktree were never exposed to
      // the sandbox and are untouched by this mirror.
      const sandboxScripts = mirrorScripts(projectDir, baselineScriptsDir, worktreeScriptsDir)
      manifest.attempts.push({
        label,
        status: 'verifying',
        started_at: startedAt,
        changed_files: changedFiles,
        sandbox_scripts: sandboxScripts,
      })
      writeJsonFile(outDir, 'run.json', manifest)

      const postDir = path.join(attemptDir, 'post')
      const visual = await runVisual({
        outDir: postDir,
        baselineDir,
        label: `agent-${attemptNumber}`,
      })
      const testsDir = path.join(attemptDir, 'tests')
      fs.mkdirSync(testsDir, { recursive: true })
      const existing = await runSuite({
        project: GAME_SOURCE,
        script: 'res://tests/run_game_tests.gd',
        outDir: testsDir,
        label: 'existing-18',
      })
      const dodge = await runSuite({
        project: GAME_SOURCE,
        script: 'res://tests/run_dodge_tests.gd',
        outDir: testsDir,
        label: 'hidden-dodge-12',
      })
      const attemptPassed = visual.ok && existing.ok && dodge.ok
      const summaryText = `visual=${visual.ok ? 'pass' : 'fail'} existing=${existing.passed}/${existing.total} dodge=${dodge.passed}/${dodge.total}`
      const record = makeAttemptRecord({
        label,
        status: attemptPassed ? 'passed' : 'failed',
        startedAt,
        durationMs: Date.now() - attemptStart,
        changedFiles,
        visual,
        existing,
        dodge,
        notes,
        failure: attemptPassed ? null : summaryText,
      })
      manifest.attempts.push(record)
      // Replace the provisional "verifying" entry.
      manifest.attempts = manifest.attempts.filter((entry) => !(entry.label === label && entry.status === 'verifying'))
      manifest.final = {
        attempt: attemptNumber,
        status: attemptPassed ? 'passed' : 'failed',
        summary: summaryText,
        visual,
        existing,
        dodge,
      }
      writeJsonFile(outDir, 'run.json', manifest)
      if (attemptPassed) {
        passed = true
        fs.copyFileSync(path.join(attemptDir, 'IMPLEMENTATION.md'), path.join(outDir, 'IMPLEMENTATION.md'))
        break
      }

      if (attemptIndex + 1 < options.maxAttempts) {
        const feedbackDir = path.join(sandboxDir, 'feedback', `attempt-${attemptNumber}`)
        copyFeedbackImages(postDir, feedbackDir)
        let brief = visualFeedback(visual)
        const extra = []
        if (!existing.ok) extra.push(`Existing gameplay checks failing: ${existing.failing.join(', ') || 'runner error'}`)
        if (!dodge.ok) extra.push(`Hidden behavior checks failing: ${dodge.failing.join(', ') || 'runner error'}`)
        if (extra.length) brief += `\n## Behavioral regression\n\n${extra.join('\n')}\n`
        fs.writeFileSync(path.join(sandboxDir, 'FAILURE.md'), brief, 'utf8')
        fs.copyFileSync(path.join(sandboxDir, 'FAILURE.md'), path.join(attemptDir, 'FAILURE.md'))
      } else {
        fs.copyFileSync(path.join(attemptDir, 'attempt.diff'), path.join(outDir, 'FINAL-FAILURE.diff'))
      }
    }

    if (!passed) {
      throw new Error(`visual and gameplay verification did not pass after ${options.maxAttempts} attempt(s)`)
    }

    const sourceFilesAfter = fileState(GAME_SOURCE)
    const hiddenAfter = sha256(HIDDEN_TEST)
    manifest.status = 'passed'
    manifest.finished_at = new Date().toISOString()
    manifest.opencode = {
      bin,
      version: (version.stdout || '').trim(),
    }
    manifest.policy.hidden_test_sha256_after = hiddenAfter
    manifest.policy.hidden_test_unchanged = hiddenBefore === hiddenAfter
    manifest.source_files_after = sourceFilesAfter
    manifest.final_status = manifest.final?.status ?? null
    manifest.cleanup = { keep_sandbox: options.keepSandbox }
    if (options.keepSandbox) manifest.cleanup.sandbox = sandboxRoot
    writeJsonFile(outDir, 'run.json', manifest)
    console.log(
      JSON.stringify({
        status: manifest.status,
        out_dir: outDir,
        attempts: manifest.attempts.length,
        final: manifest.final?.summary,
        model: options.model,
      }),
    )
  } catch (error) {
    manifest.status = 'failed'
    manifest.finished_at = new Date().toISOString()
    manifest.failure_reason = error.message
    manifest.opencode = { bin: resolveOpencodeBin() }
    manifest.policy.hidden_test_sha256_after = fs.existsSync(HIDDEN_TEST) ? sha256(HIDDEN_TEST) : null
    manifest.policy.hidden_test_unchanged = manifest.policy.hidden_test_sha256_after === manifest.policy.hidden_test_sha256_before
    manifest.cleanup = { keep_sandbox: options.keepSandbox }
    if (options.keepSandbox) manifest.cleanup.sandbox = sandboxRoot
    writeJsonFile(outDir, 'run.json', manifest)
    console.error(`PHASE18_AGENT_FAILED ${error.message}`)
    process.exitCode = 1
  } finally {
    if (!options.keepSandbox) {
      try {
        fs.rmSync(sandboxRoot, { recursive: true, force: true })
      } catch (error) {
        console.error(`cleanup warning: ${error.message}`)
      }
    }
  }
}

main()
