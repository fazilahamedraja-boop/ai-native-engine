#!/usr/bin/env node
/**
 * Phase 17 windowed dodge verification.
 *
 * Launches the real game in a visible window, drives the dodge with the same
 * harness input the controller uses, and captures the six states requested by
 * the phase: before, initiation, mid-dodge, recovery, cooldown, restart. Each
 * PNG is copied from the bridge and paired with the paused snapshot and event
 * stream for the same simulation tick.
 *
 * The script uses only public snapshot fields and normal harness input. It does
 * not call private dodge helpers or fabricate a result.
 *
 * Usage:
 *   node controller/dodge-verify.mjs [--out-dir <dir>]
 */

import fs from 'node:fs'
import path from 'node:path'
import { HarnessSession } from './harness.mjs'
import { copyCaptureFile, writeJsonFile, rejectReason, DOCS_ROOT } from './evidence-output.mjs'
import { LIVE_DIR, addCapture, logLive } from './phase17-status.mjs'

const PHASE17_DIR = path.join(DOCS_ROOT, 'phase17')
const PROJECT = 'game'

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const options = { outDir: null }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  return options
}

function assertPhase17Dir(dir) {
  const resolved = path.resolve(dir)
  const relative = path.relative(PHASE17_DIR, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`evidence output must stay inside ${PHASE17_DIR}`)
  }
  const reason = rejectReason(resolved)
  if (reason) throw new Error(reason)
  return resolved
}

function input(overrides = {}) {
  const { actions = {}, ...movement } = overrides
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    ...movement,
    actions: { attack: false, parry: false, dodge: false, ...actions },
  }
}

async function step(session, frames = 1, overrides = {}) {
  const reply = await session.advancePhysics({ frames, input: input(overrides) })
  return reply.final
}

const SUMMARY_FIELDS = [
  'step',
  'sim_time_seconds',
  'player_position',
  'player_health',
  'player_attack_phase',
  'hitbox_active',
  'last_hitbox_query_step',
  'parry_ticks',
  'parry_result',
  'dodge_phase',
  'dodge_tick',
  'dodge_cooldown',
  'dodge_invulnerable',
  'dodge_direction',
  'dodge_available',
  'enemy_position',
  'enemy_health',
  'enemy_posture',
  'enemy_phase',
  'enemy_phase_tick',
  'enemy_staggered',
  'enemy_stagger_ticks',
  'enemy_defeated',
  'outcome',
  'camera_position',
  'camera_distance',
  'grounded',
  'hud',
  'last_event_type',
  'hash',
]

function summary(snapshot) {
  const result = {}
  for (const field of SUMMARY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) result[field] = snapshot[field]
  }
  return result
}

async function recentEvents(session, sinceTick = 0) {
  const observation = await session.observe({ targets: [], properties: [], sinceTick })
  return {
    available: observation.events.available,
    count: observation.events.count,
    items: observation.events.items.slice(-40),
  }
}

async function capture(session, outDir, name, scenario, runId) {
  await session.pause()
  const snapshot = await session.snapshot()
  const events = await recentEvents(session, 0)
  const frame = await session.captureFrame({
    path: `res://artifacts/phase17-${name}.png`,
    scenario,
    runId,
    metadata: { phase: 'phase17', stage: name },
  })
  const screenshot = copyCaptureFile(outDir, `${name}.png`, frame)
  return {
    name,
    scenario,
    screenshot,
    captured_at: frame.captured_at,
    engine_tick: frame.tick,
    simulation_step: frame.simulation_step,
    paused: frame.paused,
    state: summary(snapshot),
    event_types: [...new Set(events.items.map((event) => String(event.type)))],
    events,
  }
}

function directionX(snapshot) {
  const direction = snapshot.dodge_direction
  return Array.isArray(direction) && direction.length >= 3 ? Number(direction[0]) : 0
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runId = `phase17-live-${stamp()}`
  const outDir = assertPhase17Dir(
    options.outDir || path.join(PHASE17_DIR, 'evidence', 'live', runId),
  )
  fs.mkdirSync(outDir, { recursive: true })

  const captures = []
  const checks = []
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail })
  }

  const session = new HarnessSession({ project: PROJECT, headless: false })
  let failure = null
  try {
    await session.startProject()
    await session.pause()
    await session.reset()
    check('windowed-session', session.headless === false, 'headless=false')

    let snapshot = await session.snapshot()
    check(
      'spawn-dodge-ready',
      Number(snapshot.step) === 0 &&
        String(snapshot.dodge_phase) === 'idle' &&
        Number(snapshot.dodge_cooldown) === 0 &&
        snapshot.dodge_available === true &&
        snapshot.dodge_invulnerable === false,
      `step=${snapshot.step} phase=${snapshot.dodge_phase} cooldown=${snapshot.dodge_cooldown}`,
    )
    captures.push(
      await capture(session, outDir, '01-before-dodge', 'before dodge: ready at spawn', runId),
    )

    // A strafe dodge keeps the motion across the camera rather than walking
    // directly toward the enemy, which makes the pose and movement visible.
    snapshot = await step(session, 1, { strafe: 1, actions: { dodge: true } })
    check(
      'dodge-initiated',
      String(snapshot.dodge_phase) === 'active' &&
        Number(snapshot.dodge_tick) >= 0 &&
        Number(snapshot.dodge_cooldown) >= 44 &&
        Number(snapshot.dodge_cooldown) <= 45 &&
        directionX(snapshot) > 0.9,
      `phase=${snapshot.dodge_phase} tick=${snapshot.dodge_tick} cooldown=${snapshot.dodge_cooldown} dx=${directionX(snapshot)}`,
    )
    captures.push(
      await capture(session, outDir, '02-initiation', 'dodge start: directional burst', runId),
    )

    snapshot = await step(session, 4)
    check(
      'dodge-mid-iframes',
      String(snapshot.dodge_phase) === 'active' &&
        snapshot.dodge_invulnerable === true &&
        Number(snapshot.dodge_tick) >= 3 &&
        Number(snapshot.dodge_tick) < 14,
      `phase=${snapshot.dodge_phase} tick=${snapshot.dodge_tick} invulnerable=${snapshot.dodge_invulnerable}`,
    )
    captures.push(
      await capture(session, outDir, '03-mid-dodge', 'mid-dodge: active i-frame window', runId),
    )

    let guard = 0
    while (String(snapshot.dodge_phase) === 'active' && guard < 30) {
      snapshot = await step(session, 1)
      guard += 1
    }
    check(
      'dodge-recovery',
      String(snapshot.dodge_phase) === 'recovery' &&
        snapshot.dodge_invulnerable === false &&
        Number(snapshot.dodge_tick) <= 10,
      `phase=${snapshot.dodge_phase} tick=${snapshot.dodge_tick} invulnerable=${snapshot.dodge_invulnerable}`,
    )
    captures.push(
      await capture(session, outDir, '04-recovery', 'recovery: vulnerable, control returning', runId),
    )

    guard = 0
    while (String(snapshot.dodge_phase) !== 'idle' && guard < 30) {
      snapshot = await step(session, 1)
      guard += 1
    }
    const cooldown = Number(snapshot.dodge_cooldown)
    const rejectedBefore = await recentEvents(session, 0)
    snapshot = await step(session, 1, { actions: { dodge: true } })
    const rejected = await recentEvents(session, 0)
    const rejectedRegistered = rejected.items.some(
      (event) => event.type === 'dodge_rejected' && String(event.reason || '').includes('cooldown'),
    )
    check(
      'dodge-cooldown-blocks',
      String(snapshot.dodge_phase) === 'idle' &&
        Number(snapshot.dodge_cooldown) > 0 &&
        rejectedRegistered &&
        rejected.count > rejectedBefore.count,
      `phase=${snapshot.dodge_phase} cooldown=${snapshot.dodge_cooldown} before=${cooldown} rejected=${rejectedRegistered}`,
    )
    captures.push(
      await capture(session, outDir, '05-cooldown', 'cooldown: second dodge rejected', runId),
    )

    guard = 0
    while (Number(snapshot.dodge_cooldown) > 0 && guard < 80) {
      snapshot = await step(session, 1)
      guard += 1
    }
    check(
      'dodge-ready-after-cooldown',
      Number(snapshot.dodge_cooldown) === 0 && snapshot.dodge_available === true,
      `cooldown=${snapshot.dodge_cooldown} available=${snapshot.dodge_available}`,
    )
    snapshot = await step(session, 1, { restart: true })
    check(
      'restart-clears-dodge',
      Number(snapshot.step) === 0 &&
        String(snapshot.dodge_phase) === 'idle' &&
        Number(snapshot.dodge_tick) === 0 &&
        Number(snapshot.dodge_cooldown) === 0 &&
        snapshot.dodge_available === true &&
        snapshot.player_health === 4,
      `step=${snapshot.step} phase=${snapshot.dodge_phase} cooldown=${snapshot.dodge_cooldown} available=${snapshot.dodge_available}`,
    )
    captures.push(
      await capture(session, outDir, '06-after-restart', 'restart: dodge state cleared and rearmed', runId),
    )

    const engineErrors = session.stderrLines.filter(
      (line) => line.includes('SCRIPT ERROR') || line.includes('ERROR:'),
    )
    check('no-engine-errors', engineErrors.length === 0, `errors=${engineErrors.length}`)
    if (engineErrors.length > 0) {
      fs.writeFileSync(path.join(outDir, 'engine-errors.log'), `${engineErrors.join('\n')}\n`)
    }
  } catch (error) {
    failure = error
    check('run-completed', false, error.stack || String(error))
  } finally {
    try {
      await session.stop()
    } catch (error) {
      if (!failure) failure = error
    }
  }

  fs.writeFileSync(path.join(outDir, 'engine-stdout.log'), `${session.stdoutLines.join('\n')}\n`)
  fs.writeFileSync(path.join(outDir, 'engine-stderr.log'), `${session.stderrLines.join('\n')}\n`)

  const passed = checks.filter((entry) => entry.ok).length
  const failed = checks.length - passed
  const manifest = {
    phase: 17,
    run_id: runId,
    created_at: new Date().toISOString(),
    project: PROJECT,
    mode: 'windowed-dodge',
    session: {
      headless: session.headless,
      pid: session.pid,
      project_path: session.project,
    },
    captures,
    checks,
    summary: { passed, failed, complete: failed === 0 },
    failure: failure ? String(failure.stack || failure) : null,
    engine_output: {
      stdout_lines: session.stdoutLines.length,
      stderr_lines: session.stderrLines.length,
      stdout_file: 'engine-stdout.log',
      stderr_file: 'engine-stderr.log',
    },
  }
  writeJsonFile(outDir, 'manifest.json', manifest)
  writeJsonFile(
    outDir,
    'states.json',
    captures.map((entry) => ({
      name: entry.name,
      captured_at: entry.captured_at,
      engine_tick: entry.engine_tick,
      simulation_step: entry.simulation_step,
      state: entry.state,
    })),
  )
  writeJsonFile(
    outDir,
    'events.json',
    Object.fromEntries(captures.map((entry) => [entry.name, entry.events])),
  )

  // Mirror the images into the live dashboard's static root. The repository
  // manifest remains the source of truth; this copy is only for the telecast.
  try {
    const liveEvidence = path.join(LIVE_DIR, 'evidence', runId)
    fs.mkdirSync(liveEvidence, { recursive: true })
    for (const entry of captures) {
      const target = path.join(liveEvidence, `${entry.name}.png`)
      fs.copyFileSync(entry.screenshot.absolute_path, target)
      addCapture({
        name: entry.name,
        file: `evidence/${runId}/${entry.name}.png`,
        caption: entry.scenario,
        tick: entry.simulation_step,
        engine_tick: entry.engine_tick,
        state: {
          dodge_phase: entry.state.dodge_phase,
          dodge_tick: entry.state.dodge_tick,
          dodge_cooldown: entry.state.dodge_cooldown,
          dodge_invulnerable: entry.state.dodge_invulnerable,
        },
      })
    }
  } catch (error) {
    console.error(`live capture mirror failed: ${error.message}`)
  }

  for (const entry of checks) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} ${entry.detail}`)
  }
  console.log(`EVIDENCE ${outDir}`)
  console.log(`RESULT passed=${passed} failed=${failed}`)
  if (failed > 0) process.exitCode = 1
  else {
    logLive(`Windowed dodge run captured ${captures.length} frames and passed ${passed}/${checks.length} checks.`, 'pass')
  }
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
