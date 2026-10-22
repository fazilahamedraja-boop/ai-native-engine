#!/usr/bin/env node
/**
 * Phase 16 live verification.
 *
 * Launches the real game in a visible window, drives it through the complete
 * loop with the same harness input the controller uses, and captures actual
 * viewport frames at meaningful states. Each capture is correlated with the
 * paused game snapshot and the event stream, so the screenshot and the
 * structured state describe the same simulation tick.
 *
 * The run is scripted, but not scripted in the answer-key sense: it reads only
 * public snapshot fields (phase, tick, health, distance) and decides one input
 * pulse at a time. Any failure is recorded, not retried with private hooks.
 *
 * Usage:
 *   node controller/game-verify.mjs [--out-dir <dir>]
 */

import fs from 'node:fs'
import path from 'node:path'
import { HarnessSession } from './harness.mjs'
import { copyCaptureFile, writeJsonFile, rejectReason, DOCS_ROOT } from './evidence-output.mjs'

const PHASE16_DIR = path.join(DOCS_ROOT, 'phase16')
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

function assertPhase16Dir(dir) {
  const resolved = path.resolve(dir)
  const root = path.join(PHASE16_DIR)
  const relative = path.relative(root, resolved)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`evidence output must stay inside ${root}`)
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
    actions: { attack: false, parry: false, ...actions },
  }
}

async function step(session, frames = 1, overrides = {}) {
  const reply = await session.advancePhysics({ frames, input: input(overrides) })
  return reply.final
}

function distance(snapshot) {
  const player = snapshot.player_position
  const enemy = snapshot.enemy_position
  return Math.hypot(player[0] - enemy[0], player[2] - enemy[2])
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
    path: `res://artifacts/phase16-${name}.png`,
    scenario,
    runId,
    metadata: { phase: 'phase16', stage: name },
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

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runId = `phase16-live-${stamp()}`
  const outDir = assertPhase16Dir(
    options.outDir || path.join(PHASE16_DIR, 'evidence', 'live', runId),
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
      'spawn-state-clean',
      snapshot.step === 0 && snapshot.player_health === 4 && snapshot.enemy_health === 5,
      `step=${snapshot.step} player_hp=${snapshot.player_health} enemy_hp=${snapshot.enemy_health}`,
    )
    captures.push(await capture(session, outDir, '01-spawn', 'spawn: player and enemy at start', runId))

    // B1: walk forward until the enemy is inside sword reach.
    let approachFrames = 0
    while (approachFrames < 240 && distance(snapshot) > 2.2 && snapshot.outcome === 'playing') {
      snapshot = await step(session, 1, { forward: 1 })
      approachFrames += 1
    }
    check(
      'player-approaches-enemy',
      distance(snapshot) <= 2.5,
      `frames=${approachFrames} distance=${distance(snapshot).toFixed(2)}`,
    )
    captures.push(
      await capture(session, outDir, '02-approach', 'approach: player closes distance', runId),
    )

    // B4: wait for the telegraphed attack and deflect late in the windup.
    let guard = 0
    while (String(snapshot.enemy_phase) !== 'windup' && guard < 300 && snapshot.outcome === 'playing') {
      snapshot = await step(session, 1)
      guard += 1
    }
    check(
      'enemy-telegraphs',
      String(snapshot.enemy_phase) === 'windup',
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick}`,
    )
    guard = 0
    while (
      String(snapshot.enemy_phase) === 'windup' &&
      Number(snapshot.enemy_phase_tick) < 24 &&
      guard < 60
    ) {
      snapshot = await step(session, 1)
      guard += 1
    }
    captures.push(
      await capture(session, outDir, '03-telegraph', 'enemy windup: blade raised, HUD warning', runId),
    )

    await step(session, 1, { actions: { parry: true } })
    snapshot = await step(session, 2)
    check(
      'parry-window-open',
      Number(snapshot.parry_ticks) > 0,
      `parry_ticks=${snapshot.parry_ticks} result=${snapshot.parry_result}`,
    )
    captures.push(
      await capture(session, outDir, '04-parry-window', 'deflection window: blade raised', runId),
    )

    snapshot = await step(session, 8)
    const parryEvents = await recentEvents(session, 0)
    const parryRegistered = parryEvents.items.some((event) => event.type === 'parry_success')
    check(
      'deflect-registered',
      parryRegistered && snapshot.parry_result === 'success' && snapshot.player_health === 4,
      `result=${snapshot.parry_result} player_hp=${snapshot.player_health} event=${parryRegistered}`,
    )
    captures.push(
      await capture(session, outDir, '05-deflect', 'successful deflection: posture damage', runId),
    )

    // B3/B5: finish the duel. Attack only in the enemy's recovery or stagger
    // window, and deflect every telegraphed attack.
    let combatFrames = 0
    while (combatFrames < 2400 && snapshot.outcome === 'playing') {
      const phase = String(snapshot.enemy_phase)
      if (phase === 'windup' && Number(snapshot.enemy_phase_tick) >= 24) {
        snapshot = await step(session, 1, { actions: { parry: true } })
      } else if (phase === 'windup' || phase === 'active') {
        snapshot = await step(session, 1)
      } else if (phase === 'recover' || phase === 'stagger') {
        snapshot = await step(session, 1, { actions: { attack: true } })
      } else if (distance(snapshot) > 2.2) {
        snapshot = await step(session, 1, { forward: 1 })
      } else {
        snapshot = await step(session, 1)
      }
      combatFrames += 1
    }
    const victoryEvents = await recentEvents(session, 0)
    const enemyDamaged = captures.some((entry) => Number(entry.state.enemy_health) < 5) ||
      victoryEvents.items.some((event) => event.type === 'player_hit_enemy')
    check(
      'sword-damages-enemy',
      enemyDamaged,
      `frames=${combatFrames} enemy_hp=${snapshot.enemy_health}`,
    )
    check(
      'victory-reached',
      snapshot.outcome === 'victory' && victoryEvents.items.some((event) => event.type === 'victory'),
      `frames=${combatFrames} outcome=${snapshot.outcome} enemy_hp=${snapshot.enemy_health}`,
    )
    captures.push(
      await capture(session, outDir, '06-victory', 'victory: enemy defeated', runId),
    )

    // B5: restart restores a clean playable state.
    snapshot = await step(session, 1, { restart: true })
    check(
      'restart-clean',
      snapshot.step === 0 &&
        snapshot.player_health === 4 &&
        snapshot.enemy_health === 5 &&
        snapshot.outcome === 'playing',
      `step=${snapshot.step} player_hp=${snapshot.player_health} enemy_hp=${snapshot.enemy_health} outcome=${snapshot.outcome}`,
    )
    captures.push(
      await capture(session, outDir, '07-restart', 'restart: initial state restored', runId),
    )

    // B2/B5: stand in range without defending; the enemy must be able to win.
    guard = 0
    while (guard < 240 && distance(snapshot) > 2.0 && snapshot.outcome === 'playing') {
      snapshot = await step(session, 1, { forward: 1 })
      guard += 1
    }
    guard = 0
    while (guard < 1200 && snapshot.outcome === 'playing') {
      snapshot = await step(session, 1)
      guard += 1
    }
    const defeatEvents = await recentEvents(session, 0)
    check(
      'defeat-reached',
      snapshot.outcome === 'defeat' &&
        snapshot.player_health === 0 &&
        defeatEvents.items.some((event) => event.type === 'player_defeated'),
      `frames=${guard} outcome=${snapshot.outcome} player_hp=${snapshot.player_health}`,
    )
    captures.push(
      await capture(session, outDir, '08-defeat', 'defeat: player health reaches zero', runId),
    )

    await step(session, 1, { restart: true })
    captures.push(
      await capture(session, outDir, '09-final-restart', 'restart after defeat', runId),
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

  fs.writeFileSync(
    path.join(outDir, 'engine-stdout.log'),
    `${session.stdoutLines.join('\n')}\n`,
  )
  fs.writeFileSync(
    path.join(outDir, 'engine-stderr.log'),
    `${session.stderrLines.join('\n')}\n`,
  )

  const passed = checks.filter((entry) => entry.ok).length
  const failed = checks.length - passed
  const manifest = {
    phase: 16,
    run_id: runId,
    created_at: new Date().toISOString(),
    project: PROJECT,
    mode: 'windowed',
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

  for (const entry of checks) {
    console.log(`${entry.ok ? 'PASS' : 'FAIL'} ${entry.name} ${entry.detail}`)
  }
  console.log(`EVIDENCE ${outDir}`)
  console.log(`RESULT passed=${passed} failed=${failed}`)
  if (failed > 0) process.exitCode = 1
}

main().catch((error) => {
  console.error(error.stack || error)
  process.exitCode = 1
})
