#!/usr/bin/env node
/**
 * Phase 18 evidence-only visual diagnosis.
 *
 * Copies only real baseline screenshots and public snapshot fields into a
 * disposable sandbox, then asks an image-capable OpenCode model to read the
 * images and write a diagnosis. It never copies game source or tests into the
 * sandbox, and it runs with the Phase 15 deny-by-default config.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  SANDBOX_CONFIG_SOURCE,
  resolveOpencodeBin,
  runOpencode,
} from './agent-adapter.mjs'
import { DOCS_ROOT, rejectReason, sha256, writeJsonFile } from './evidence-output.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PHASE18_DIR = path.join(DOCS_ROOT, 'phase18')
const DEFAULT_MODEL = 'opencode/deepseek-v4.1-flash-free'
const IMAGES = ['idle.png', 'windup-early.png', 'windup-late.png', 'active.png', 'recovery.png', 'restart.png']

function parseArgs(argv) {
  const options = {
    baselineDir: null,
    outDir: null,
    model: DEFAULT_MODEL,
    timeoutMs: 600000,
    keepSandbox: false,
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--baseline-dir') options.baselineDir = argv[++i]
    else if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--model') options.model = argv[++i]
    else if (argv[i] === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (argv[i] === '--keep-sandbox') options.keepSandbox = true
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!options.baselineDir) throw new Error('--baseline-dir is required')
  return options
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function safePath(dir, name) {
  const resolved = path.resolve(dir, name)
  const root = path.resolve(dir)
  if (!resolved.startsWith(root + path.sep) && resolved !== root) {
    throw new Error(`path escapes directory: ${name}`)
  }
  return resolved
}

function assertPhase18Dir(dir) {
  const resolved = path.resolve(dir)
  const root = path.resolve(PHASE18_DIR)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Phase 18 evidence output must stay inside ${root}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  return resolved
}

function readCaptures(baselineDir) {
  const file = path.join(baselineDir, 'captures.json')
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`)
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  const captures = Array.isArray(value) ? value : value.captures
  if (!Array.isArray(captures)) throw new Error('captures.json has no captures array')
  return captures
}

function publicObservations(baselineDir, captures, runId) {
  return {
    schema: 'phase18.public-observations.v1',
    source_run: runId,
    source: 'public HarnessSession snapshot fields and captured HUD text only',
    no_source_access: true,
    captures: captures.map((capture) => ({
      name: capture.name,
      image: path.basename(capture.image?.path || capture.screenshot?.path || `${capture.name}.png`),
      image_sha256: capture.image?.sha256 || capture.screenshot?.sha256 || null,
      captured_at: capture.captured_at,
      engine_tick: capture.engine_tick,
      simulation_step: capture.simulation_step,
      scenario: capture.scenario,
      state: {
        enemy_phase: capture.state?.enemy_phase,
        enemy_phase_tick: capture.state?.enemy_phase_tick,
        player_position: capture.state?.player_position,
        enemy_position: capture.state?.enemy_position,
        camera_position: capture.state?.camera_position,
        player_health: capture.state?.player_health,
        enemy_health: capture.state?.enemy_health,
        hud: capture.state?.hud,
        outcome: capture.state?.outcome,
        step: capture.state?.step,
      },
      enemy_feet_screen: capture.enemy_feet_screen,
      events_recent: (capture.events?.items || []).slice(-12),
    })),
  }
}

function writeTask(sandboxDir, baselineRun) {
  const task = `# Phase 18 visual diagnosis task

You are the vision-capable diagnosis stage of a controlled game-repair experiment.

## Allowed workspace
- This directory only. It contains six real screenshots from a windowed Godot run and \`observations.json\`.
- There is no game source, no test source, no docs, no shell, and no network here. Do not look for them.
- You may read files and write only \`diagnosis.md\`. Do not modify the screenshots or observations.

## Evidence
- Source run: \`${baselineRun}\`
- Screenshots: \`idle.png\`, \`windup-early.png\`, \`windup-late.png\`, \`active.png\`, \`recovery.png\`, \`restart.png\`
- \`observations.json\` contains only public snapshot fields and captured HUD text correlated with each image.

Use the \`read\` tool to open **every** PNG. Do not infer an image you did not open. Also read \`observations.json\`.

## Goal
The game should communicate an incoming enemy attack clearly in the 3D scene, not only as HUD text. The baseline may have several presentation weaknesses. Identify one concrete, bounded, visual-only problem that the actual screenshots support.

## Required output: \`diagnosis.md\`
Use exactly these sections:

# Phase 18 Baseline Diagnosis

## Evidence (observed)
Concrete things visible in named images and stated in the public snapshots. Quote image filenames. Include both the HUD cue and the world-space cues you can actually see.

## Hypotheses
Possible causes or interpretations. Mark them clearly as hypotheses; do not present them as facts.

## Chosen visual problem
One bounded visual problem. Explain why it is genuine from the evidence and worth fixing, and what must remain unchanged.

## Proposed acceptance evidence
How an independent observer could verify improvement from new screenshots, without trusting source code. Propose image-based evidence, not a code assertion.

## Limitations
What cannot be determined from these still images, and what must be verified by a later real run.

Do not propose code edits or file names. Do not claim to have run the game or verified a fix. Do not invent a screenshot or a measurement. If an image is unreadable, say so explicitly.
`
  fs.writeFileSync(path.join(sandboxDir, 'TASK.md'), task, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const baselineDir = path.resolve(options.baselineDir)
  const captures = readCaptures(baselineDir)
  const runInfo = JSON.parse(fs.readFileSync(path.join(baselineDir, 'run.json'), 'utf8'))
  const baselineRun = runInfo.run_id || path.basename(baselineDir)
  const outDir = assertPhase18Dir(
    options.outDir || path.join(PHASE18_DIR, 'evidence', 'diagnosis', `phase18-diagnosis-${stamp()}`),
  )
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true })
  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-diagnosis-'))
  const sandboxDir = path.join(sandboxRoot, 'sandbox')
  const configDir = path.join(sandboxRoot, 'config')
  fs.mkdirSync(sandboxDir, { recursive: true })
  fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
  fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, 'opencode', 'opencode.json'))

  const imageManifest = []
  for (const name of IMAGES) {
    const src = path.join(baselineDir, name)
    if (!fs.existsSync(src)) throw new Error(`missing baseline image: ${src}`)
    const dst = path.join(sandboxDir, name)
    fs.copyFileSync(src, dst)
    imageManifest.push({
      name,
      sha256: sha256(dst),
      bytes: fs.statSync(dst).size,
      source: path.relative(path.resolve(HERE, '..', '..', '..'), src).split(path.sep).join('/'),
    })
  }
  const observations = publicObservations(baselineDir, captures, baselineRun)
  fs.writeFileSync(path.join(sandboxDir, 'observations.json'), JSON.stringify(observations, null, 2) + '\n', 'utf8')
  writeTask(sandboxDir, baselineRun)

  const prompt =
    'Read ./TASK.md, then read every listed PNG and observations.json. Write ./diagnosis.md exactly as TASK.md requires. Do not edit any other file.'
  const args = ['run', '--standalone', '--format', 'json', '--auto', '--model', options.model, prompt]
  const bin = resolveOpencodeBin()
  const version = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 20000, windowsHide: true })
  const pids = []
  const run = await runOpencode({
    bin,
    args,
    cwd: sandboxDir,
    env: { ...process.env, XDG_CONFIG_HOME: configDir },
    timeoutMs: options.timeoutMs,
    pids,
  })
  fs.writeFileSync(path.join(outDir, 'logs', 'opencode.jsonl'), run.stdout, 'utf8')
  fs.writeFileSync(path.join(outDir, 'logs', 'opencode.stderr.txt'), run.stderr, 'utf8')
  fs.writeFileSync(path.join(outDir, 'prompt.txt'), prompt + '\n', 'utf8')
  const diagnosisPath = path.join(sandboxDir, 'diagnosis.md')
  const diagnosis = fs.existsSync(diagnosisPath) ? fs.readFileSync(diagnosisPath, 'utf8') : ''
  if (diagnosis) fs.writeFileSync(path.join(outDir, 'diagnosis.md'), diagnosis, 'utf8')
  const lower = diagnosis.toLowerCase()
  const sections = ['evidence', 'hypotheses', 'chosen visual problem', 'proposed acceptance evidence', 'limitations']
  const sectionChecks = sections.map((section) => ({ section, ok: lower.includes(section) }))
  const imageCitations = IMAGES.filter((name) => lower.includes(name.toLowerCase()))
  const jsonl = run.stdout
  const imageReadEvidence =
    jsonl.includes('"mime":"image/png"') ||
    jsonl.includes('"mime": "image/png"') ||
    jsonl.includes('Image read successfully')
  const valid =
    diagnosis.length > 400 &&
    sectionChecks.every((entry) => entry.ok) &&
    imageCitations.length >= 2 &&
    imageReadEvidence &&
    run.code === 0 &&
    !run.timedOut

  const manifest = {
    schema: 'phase18.diagnosis.v1',
    baseline_run: baselineRun,
    baseline_dir: baselineDir,
    status: valid ? 'passed' : 'failed',
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    model: options.model,
    opencode: {
      bin,
      version: (version.stdout || '').trim(),
      exit_code: run.code,
      timed_out: run.timedOut,
      duration_ms: run.durationMs,
      invocation: 'opencode run --standalone --format json --auto --model <model> <prompt>',
    },
    sandbox: {
      source_copied: false,
      tests_copied: false,
      images: imageManifest,
      observations: 'observations.json',
      task: 'TASK.md',
      config: {
        path: SANDBOX_CONFIG_SOURCE.split(path.sep).join('/'),
        sha256: sha256(SANDBOX_CONFIG_SOURCE),
        denies: ['shell', 'webfetch', 'websearch', 'execute', 'question', 'skill', 'subagent'],
      },
    },
    evidence: {
      diagnosis_sha256: diagnosis ? sha256(path.join(outDir, 'diagnosis.md')) : null,
      diagnosis_bytes: diagnosis.length,
      sections: sectionChecks,
      cited_images: imageCitations,
      image_read_evidence: imageReadEvidence,
      raw_jsonl: 'logs/opencode.jsonl',
      stderr: 'logs/opencode.stderr.txt',
    },
    checks: [
      { name: 'opencode-ended', ok: run.code === 0 && !run.timedOut, detail: { code: run.code, timed_out: run.timedOut } },
      { name: 'diagnosis-written', ok: diagnosis.length > 0, detail: diagnosis.length },
      { name: 'required-sections', ok: sectionChecks.every((entry) => entry.ok), detail: sectionChecks },
      { name: 'cites-images', ok: imageCitations.length >= 2, detail: imageCitations },
      { name: 'image-read-tool-used', ok: imageReadEvidence, detail: imageReadEvidence },
      { name: 'diagnosis-substantive', ok: diagnosis.length > 400, detail: diagnosis.length },
    ],
  }
  writeJsonFile(outDir, 'run.json', manifest)
  if (!options.keepSandbox) {
    fs.rmSync(sandboxRoot, { recursive: true, force: true })
  } else {
    manifest.sandbox.kept_at = sandboxRoot
    writeJsonFile(outDir, 'run.json', manifest)
  }
  console.log(JSON.stringify({ status: manifest.status, out_dir: outDir, baseline_run: baselineRun, diagnosis_bytes: diagnosis.length, cited_images: imageCitations, model: options.model }))
  return valid ? 0 : 1
}

process.exitCode = await main()
