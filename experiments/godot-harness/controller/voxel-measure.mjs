#!/usr/bin/env node
/**
 * Phase 19 measurement runner.
 *
 * Two independent measurements, written as one evidence record:
 *   1. headless CPU timings for world generation and chunk meshing
 *   2. a real windowed session for launch time and engine performance monitors
 *
 * Nothing here is estimated. Any value the engine or OS does not report is
 * written as null with a note.
 *
 * Usage:
 *   node controller/voxel-measure.mjs [--out-dir DIR]
 */

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  GODOT_BIN,
  HarnessSession,
  resolveProject,
  runProcess,
} from './harness.mjs'
import { DOCS_ROOT, rejectReason, sha256, writeJsonFile } from './evidence-output.mjs'

const MEASURE_SCRIPT = 'res://tests/measure_voxel.gd'
const PHASE19_DIR = path.join(DOCS_ROOT, 'phase19')
const DEFAULT_OUT = path.join(PHASE19_DIR, 'evidence', 'measurements')

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const options = { outDir: null, project: 'voxel' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--project') options.project = argv[++i]
    else throw new Error(`Unknown argument: ${argv[i]}`)
  }
  return options
}

function assertInsidePhase19(target) {
  const resolved = path.resolve(target)
  const relative = path.relative(PHASE19_DIR, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Phase 19 evidence must stay inside ${PHASE19_DIR}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  fs.mkdirSync(resolved, { recursive: true })
  return resolved
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function gpuName() {
  try {
    const output = execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '(Get-CimInstance Win32_VideoController | Where-Object { $_.Name -notmatch "Basic|Remote" } | Select-Object -First 1 -ExpandProperty Name)',
      ],
      { encoding: 'utf8', timeout: 20000 },
    ).trim()
    return output || null
  } catch {
    return null
  }
}

function systemInfo() {
  const cpu = os.cpus()[0]
  return {
    platform: `${os.platform()} ${os.release()}`,
    arch: os.arch(),
    cpu: cpu ? cpu.model.trim() : null,
    logical_cpus: os.cpus().length,
    total_memory_bytes: os.totalmem(),
    gpu: gpuName(),
    node: process.version,
    measured_at: new Date().toISOString(),
  }
}

function parseMeasureOutput(stdout) {
  const line = String(stdout || '')
    .split(/\r?\n/)
    .find((entry) => entry.startsWith('MEASURE_JSON '))
  if (!line) throw new Error('measurement script did not print a MEASURE_JSON line')
  return JSON.parse(line.slice('MEASURE_JSON '.length))
}

function pickPerformance(snapshot) {
  return {
    fps: snapshot.performance?.fps ?? null,
    process_frames: snapshot.performance?.process_frames ?? null,
    static_memory_bytes: snapshot.performance?.static_memory_bytes ?? null,
    render_draw_calls: snapshot.performance?.render_draw_calls ?? null,
    render_primitives: snapshot.performance?.render_primitives ?? null,
    uptime_ms: snapshot.uptime_ms ?? null,
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const outDir = assertInsidePhase19(path.join(options.outDir || DEFAULT_OUT, stamp()))

  const projectDir = resolveProject(options.project)
  const measureRun = await runProcess(
    GODOT_BIN,
    ['--headless', '--path', projectDir, '-s', MEASURE_SCRIPT],
    { cwd: projectDir, timeoutMs: 120000 },
  )
  const cpu = parseMeasureOutput(measureRun.stdout)
  fs.writeFileSync(path.join(outDir, 'cpu-measure.stdout.txt'), measureRun.stdout || '', 'utf8')
  fs.writeFileSync(path.join(outDir, 'cpu-measure.stderr.txt'), measureRun.stderr || '', 'utf8')
  writeJsonFile(outDir, 'cpu-measure.json', {
    ok: measureRun.code === 0,
    exit_code: measureRun.code,
    duration_ms: measureRun.durationMs,
    ...cpu,
  })

  const session = new HarnessSession({
    project: options.project,
    headless: false,
    timeoutMs: 30000,
  })
  const runtime = { samples: [], launch: null, start: null, error: null }
  try {
    const start = await session.start()
    runtime.launch = {
      duration_ms: start.durationMs,
      boot_uptime_ms: start.ping?.uptime_ms ?? null,
      godot: start.ping?.godot ?? null,
      headless: start.ping?.headless ?? null,
    }
    await sleep(2500)
    for (let sample = 0; sample < 3; sample++) {
      const snapshot = await session.snapshot()
      runtime.samples.push(pickPerformance(snapshot))
      await sleep(1000)
    }
    runtime.start = {
      pid: start.pid,
      port: start.port,
      scene: start.scene,
      logs: start.logs,
    }
  } catch (error) {
    runtime.error = error?.stack || String(error)
  } finally {
    try {
      await session.stop()
    } catch (stopError) {
      runtime.error = runtime.error || `stop failed: ${stopError?.stack || stopError}`
    }
  }

  const fpsValues = runtime.samples.map((entry) => entry.fps).filter((value) => Number.isFinite(value))
  const drawValues = runtime.samples
    .map((entry) => entry.render_draw_calls)
    .filter((value) => Number.isFinite(value))
  const primitiveValues = runtime.samples
    .map((entry) => entry.render_primitives)
    .filter((value) => Number.isFinite(value))
  writeJsonFile(outDir, 'runtime.json', {
    ...runtime,
    summary: {
      launch_duration_ms: runtime.launch?.duration_ms ?? null,
      fps_samples: fpsValues,
      draw_call_samples: drawValues,
      primitive_samples: primitiveValues,
      note:
        'Windowed GL compatibility samples on the machine listed in run.json. ' +
        'FPS and draw calls are engine monitors for the sampled frames, not a benchmark.',
    },
  })

  const manifest = {
    schema: 'phase19.voxel-measurements.v1',
    phase: 19,
    exported_at: new Date().toISOString(),
    project: options.project,
    measure_script: MEASURE_SCRIPT,
    measure_script_sha256: sha256(path.join(projectDir, 'tests', 'measure_voxel.gd')),
    system: systemInfo(),
    cpu: {
      ok: measureRun.code === 0,
      duration_ms: measureRun.durationMs,
      file: 'cpu-measure.json',
    },
    runtime: {
      ok: runtime.error === null && fpsValues.length > 0,
      file: 'runtime.json',
      launch_duration_ms: runtime.launch?.duration_ms ?? null,
      fps_samples: fpsValues,
    },
    notes: [
      'CPU timings are wall-clock microsecond measurements around generate() and ChunkBuilder.build().',
      'Chunk timings exclude physics body creation, material setup, and rendering.',
      'Launch duration is Node spawn to the first successful game-ready bridge ping.',
      'Missing values are null, never zero-filled.',
    ],
  }
  writeJsonFile(outDir, 'run.json', manifest)

  console.log(`evidence: ${outDir}`)
  console.log(
    `world ${cpu.dimensions.width}x${cpu.dimensions.height}x${cpu.dimensions.depth} ` +
      `cells=${cpu.dimensions.cells} solid=${cpu.blocks.solid_total} chunks=${cpu.dimensions.chunk_count}`,
  )
  console.log(
    `generation median=${cpu.timing.generation.sample.median_ms} ms ` +
      `chunk-build median=${cpu.timing.chunk_build.sample.median_ms} ms ` +
      `launch=${runtime.launch?.duration_ms ?? 'n/a'} ms fps=${fpsValues.join(',') || 'n/a'}`,
  )
  if (!manifest.cpu.ok || !manifest.runtime.ok) {
    console.error('one or more measurements failed; see run.json')
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
