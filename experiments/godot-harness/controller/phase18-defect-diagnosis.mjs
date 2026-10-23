#!/usr/bin/env node
/**
 * Phase 18 controlled-defect visual comparison diagnosis.
 *
 * Compares two real windowed captures of the same frozen encounter: a healthy
 * accepted build and a disposable build with one controlled visual regression.
 * The sandbox contains only screenshots and public snapshot fields; it never
 * sees game source, tests, the harness, or the acceptance thresholds.
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
const DEFAULT_MODEL = 'opencode/nemotron-3.5-super-vl-free'
const IMAGES = [
  'idle.png',
  'windup-early.png',
  'windup-mid.png',
  'windup-late.png',
  'active.png',
  'recovery.png',
  'restart.png',
]

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const options = {
    healthyDir: null,
    defectDir: null,
    outDir: null,
    model: DEFAULT_MODEL,
    timeoutMs: 600000,
    keepSandbox: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--healthy-dir') options.healthyDir = argv[++i]
    else if (arg === '--defect-dir') options.defectDir = argv[++i]
    else if (arg === '--out-dir') options.outDir = argv[++i]
    else if (arg === '--model') options.model = argv[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else if (arg === '--keep-sandbox') options.keepSandbox = true
    else throw new Error(`Unknown option: ${arg}`)
  }
  if (!options.healthyDir) throw new Error('--healthy-dir is required')
  if (!options.defectDir) throw new Error('--defect-dir is required')
  return options
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

function readCaptures(dir) {
  const file = path.join(dir, 'captures.json')
  if (!fs.existsSync(file)) throw new Error(`missing ${file}`)
  const value = JSON.parse(fs.readFileSync(file, 'utf8'))
  const captures = Array.isArray(value) ? value : value.captures
  if (!Array.isArray(captures)) throw new Error('captures.json has no captures array')
  return captures
}

function publicObservations(dir, captures, runId) {
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

function writeTask(sandboxDir, healthyRun, defectRun) {
  const task = `# Phase 18 controlled visual regression diagnosis

You are the vision-only diagnosis stage of a controlled game-repair experiment.

## Allowed workspace
- This directory only. It contains two sets of real screenshots and public
  observation files. There is no game source, test source, harness, or docs.
- Do not look for source. Do not run anything. Write only \`diagnosis.md\`.

## Evidence
- \`healthy/\` is the accepted build. Run: \`${healthyRun}\`.
- \`defect/\` is a disposable copy of that build with exactly one controlled
  visual regression. Run: \`${defectRun}\`.
- Both runs used the same frozen encounter, camera, scenario, input sequence,
  and screenshot names. \`healthy/observations.json\` and
  \`defect/observations.json\` contain only public snapshot fields.

Read **every** PNG in both directories with the \`read\` tool. Compare like-named
images. Do not infer an image you did not open. Read both observations files.

## Goal
Identify the concrete visual difference caused by the regression. The defect is
visual-only: gameplay, positions, timing, health, and HUD text are unchanged.
Do not claim a difference the images do not show.

## Required output: \`diagnosis.md\`
Use exactly these sections:

# Phase 18 Controlled Defect Diagnosis

## Evidence (observed)
Concrete visible things in named healthy and defect images, plus public snapshot
facts. Quote filenames with their directory.

## Comparison
The specific like-named frame pairs that differ and how. Separate observation
from interpretation.

## Chosen visual defect
One bounded defect supported by the comparison. Explain what changed visually
and why it matters for the intended escalating windup cue. State what must
remain unchanged.

## Proposed repair evidence
How an independent observer could verify the repair from new screenshots,
without trusting source code or this diagnosis.

## Limitations
What the still images cannot determine and what must be verified by a real run.

Do not propose code edits or file names. Do not claim you ran the game or
verified a fix. Do not invent a screenshot or a measurement.
`
  fs.writeFileSync(path.join(sandboxDir, 'TASK.md'), task, 'utf8')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const healthyDir = path.resolve(options.healthyDir)
  const defectDir = path.resolve(options.defectDir)
  const healthyRun = JSON.parse(fs.readFileSync(path.join(healthyDir, 'run.json'), 'utf8')).run_id
  const defectRun = JSON.parse(fs.readFileSync(path.join(defectDir, 'run.json'), 'utf8')).run_id
  const outDir = assertPhase18Dir(
    options.outDir || path.join(PHASE18_DIR, 'evidence', 'defect', 'diagnosis', `defect-${stamp()}`),
  )
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true })

  const sandboxRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'phase18-defect-diagnosis-'))
  const sandboxDir = path.join(sandboxRoot, 'sandbox')
  const configDir = path.join(sandboxRoot, 'config')
  fs.mkdirSync(sandboxDir, { recursive: true })
  fs.mkdirSync(path.join(configDir, 'opencode'), { recursive: true })
  fs.copyFileSync(SANDBOX_CONFIG_SOURCE, path.join(configDir, 'opencode', 'opencode.json'))

  const manifestImages = { healthy: [], defect: [] }
  for (const [label, dir] of [['healthy', healthyDir], ['defect', defectDir]]) {
    const target = path.join(sandboxDir, label)
    fs.mkdirSync(target, { recursive: true })
    for (const name of IMAGES) {
      const src = path.join(dir, name)
      if (!fs.existsSync(src)) throw new Error(`missing ${label} image: ${src}`)
      const dst = path.join(target, name)
      fs.copyFileSync(src, dst)
      manifestImages[label].push({
        name,
        sha256: sha256(dst),
        bytes: fs.statSync(dst).size,
      })
    }
    const captures = readCaptures(dir)
    fs.writeFileSync(
      path.join(target, 'observations.json'),
      JSON.stringify(publicObservations(dir, captures, label === 'healthy' ? healthyRun : defectRun), null, 2) + '\n',
      'utf8',
    )
  }
  writeTask(sandboxDir, healthyRun, defectRun)

  const prompt =
    'Read ./TASK.md, then read every healthy/*.png and defect/*.png and both observations.json files. Write ./diagnosis.md exactly as TASK.md requires. Do not edit any other file.'
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
  const sections = ['evidence', 'comparison', 'chosen visual defect', 'proposed repair evidence', 'limitations']
  const sectionChecks = sections.map((section) => ({ section, ok: lower.includes(section) }))
  const healthyCitations = IMAGES.filter((name) => lower.includes(`healthy/${name}`.toLowerCase()))
  const defectCitations = IMAGES.filter((name) => lower.includes(`defect/${name}`.toLowerCase()))
  const jsonl = run.stdout
  const imageReadEvidence =
    jsonl.includes('"mime":"image/png"') ||
    jsonl.includes('"mime": "image/png"') ||
    jsonl.includes('Image read successfully')
  const valid =
    diagnosis.length > 400 &&
    sectionChecks.every((entry) => entry.ok) &&
    healthyCitations.length >= 1 &&
    defectCitations.length >= 1 &&
    imageReadEvidence &&
    run.code === 0 &&
    !run.timedOut

  const manifest = {
    schema: 'phase18.defect-diagnosis.v1',
    healthy_run: healthyRun,
    defect_run: defectRun,
    healthy_dir: healthyDir,
    defect_dir: defectDir,
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
      thresholds_copied: false,
      images: manifestImages,
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
      healthy_citations: healthyCitations,
      defect_citations: defectCitations,
      image_read_evidence: imageReadEvidence,
      raw_jsonl: 'logs/opencode.jsonl',
      stderr: 'logs/opencode.stderr.txt',
    },
    checks: [
      { name: 'opencode-ended', ok: run.code === 0 && !run.timedOut, detail: { code: run.code, timed_out: run.timedOut } },
      { name: 'diagnosis-written', ok: diagnosis.length > 0, detail: diagnosis.length },
      { name: 'required-sections', ok: sectionChecks.every((entry) => entry.ok), detail: sectionChecks },
      { name: 'cites-healthy', ok: healthyCitations.length >= 1, detail: healthyCitations },
      { name: 'cites-defect', ok: defectCitations.length >= 1, detail: defectCitations },
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
  console.log(
    JSON.stringify({
      status: manifest.status,
      out_dir: outDir,
      healthy_run: healthyRun,
      defect_run: defectRun,
      diagnosis_bytes: diagnosis.length,
      healthy_citations: healthyCitations,
      defect_citations: defectCitations,
      model: options.model,
    }),
  )
  return valid ? 0 : 1
}

process.exitCode = await main()
