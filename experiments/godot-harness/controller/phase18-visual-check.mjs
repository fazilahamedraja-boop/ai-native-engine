#!/usr/bin/env node
/**
 * Phase 18 windowed visual capture and independent acceptance runner.
 *
 * The runner launches the real game in a visible window, uses the public
 * harness setup command to place both fighters at a reproducible distance,
 * advances real fixed physics ticks until the enemy is in late windup, and
 * captures the viewport. Every capture is paired with the paused public
 * snapshot and the event stream, then an independent Python script measures
 * the rendered pixels.
 *
 * It is not an answer-key runner: the capture loop reads only public snapshot
 * fields. The visual acceptance thresholds live in
 * `phase18_visual_acceptance.py`, outside the game and outside agent sandboxes.
 *
 * Usage:
 *   node controller/phase18-visual-check.mjs \
 *     --out-dir ../../docs/phase18/evidence/baseline/<run>
 *
 *   node controller/phase18-visual-check.mjs \
 *     --out-dir ../../docs/phase18/evidence/post/<run> \
 *     --baseline-dir ../../docs/phase18/evidence/baseline/<run> \
 *     --expect pass
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { HarnessSession, HARNESS_ROOT } from './harness.mjs'
import {
  DOCS_ROOT,
  copyCaptureFile,
  rejectReason,
  sha256,
  writeJsonFile,
} from './evidence-output.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PHASE18_DIR = path.join(DOCS_ROOT, 'phase18')
const DEFAULT_PROJECT = 'game'
const PYTHON = process.env.PYTHON || 'python'

const SUMMARY_FIELDS = [
  'step',
  'sim_time_seconds',
  'player_position',
  'player_velocity',
  'player_health',
  'player_attack_phase',
  'player_attack_tick',
  'hitbox_active',
  'last_hitbox_query_step',
  'parry_ticks',
  'parry_result',
  'dodge_phase',
  'dodge_tick',
  'dodge_cooldown',
  'dodge_invulnerable',
  'dodge_available',
  'enemy_position',
  'enemy_health',
  'enemy_posture',
  'enemy_phase',
  'enemy_phase_tick',
  'enemy_staggered',
  'enemy_stagger_ticks',
  'enemy_defeated',
  'enemy_ai_enabled',
  'outcome',
  'camera_position',
  'camera_distance',
  'grounded',
  'input',
  'hud',
  'last_event_type',
  'hash',
]

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const options = {
    outDir: null,
    project: DEFAULT_PROJECT,
    label: 'visual',
    baselineDir: null,
    expectation: 'either',
    timeoutMs: 45000,
  }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--project') options.project = argv[++i]
    else if (argv[i] === '--label') options.label = argv[++i]
    else if (argv[i] === '--baseline-dir') options.baselineDir = argv[++i]
    else if (argv[i] === '--expect') options.expectation = argv[++i]
    else if (argv[i] === '--timeout-ms') options.timeoutMs = Number(argv[++i])
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  if (!['pass', 'fail', 'either'].includes(options.expectation)) {
    throw new Error('--expect must be pass, fail, or either')
  }
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

function idleInput() {
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    actions: { attack: false, parry: false, dodge: false },
  }
}

function summary(snapshot) {
  const result = {}
  for (const field of SUMMARY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(snapshot, field)) result[field] = snapshot[field]
  }
  return result
}

function gitValue(args, fallback = null) {
  const result = spawnSync('git', ['-C', path.resolve(HARNESS_ROOT, '..', '..'), ...args], {
    encoding: 'utf8',
    windowsHide: true,
  })
  return result.status === 0 ? result.stdout.trim() : fallback
}

function sha256File(file) {
  return sha256(file)
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
}

function cross(a, b) {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ]
}

function normalize(v) {
  const length = Math.hypot(v[0], v[1], v[2])
  if (length < 1e-9) return [0, 0, 0]
  return [v[0] / length, v[1] / length, v[2] / length]
}

/**
 * Project the enemy's feet into the 1280x720 game viewport using the same
 * public camera state the game reports. This is a measurement helper, not a
 * private game call. It lets the independent image checker place its region
 * around the actual enemy instead of guessing a fixed screen coordinate.
 */
function projectFeet(snapshot, width = 1280, height = 720) {
  const enemy = snapshot.enemy_position
  const player = snapshot.player_position
  const camera = snapshot.camera_position
  if (!enemy || !player || !camera) return null
  const target = [player[0], player[1] + 1.15, player[2]]
  const forward = normalize([
    target[0] - camera[0],
    target[1] - camera[1],
    target[2] - camera[2],
  ])
  const right = normalize(cross(forward, [0, 1, 0]))
  const up = cross(right, forward)
  const world = [enemy[0], enemy[1] + 0.03, enemy[2]]
  const view = [world[0] - camera[0], world[1] - camera[1], world[2] - camera[2]]
  const depth = dot(view, forward)
  if (depth <= 0.05) return null
  const tan = Math.tan((62 * Math.PI) / 180 / 2)
  const ndcX = dot(view, right) / (depth * tan * (width / height))
  const ndcY = dot(view, up) / (depth * tan)
  return [
    Math.round(((ndcX + 1) * width) / 2 * 100) / 100,
    Math.round(((1 - ndcY) * height) / 2 * 100) / 100,
  ]
}

async function recentEvents(session, sinceTick = 0) {
  const observation = await session.observe({ targets: [], properties: [], sinceTick })
  return {
    available: observation.events.available,
    count: observation.events.count,
    items: observation.events.items.slice(-40),
  }
}

function capture(session, outDir, name, scenario, runId, metadata = {}) {
  return (async () => {
    await session.pause()
    const before = await session.snapshot()
    const events = await recentEvents(session, 0)
    const frame = await session.captureFrame({
      path: `res://artifacts/phase18-${name}.png`,
      scenario,
      runId,
      metadata: { phase: 'phase18', stage: name, ...metadata },
    })
    if (frame.state_before.hash !== frame.state_after.hash) {
      throw new Error(
        `capture ${name} changed simulation state (${frame.state_before.hash} -> ${frame.state_after.hash})`,
      )
    }
    const image = copyCaptureFile(outDir, `${name}.png`, frame)
    const state = summary(frame.state_before)
    return {
      name,
      scenario,
      image,
      screenshot: {
        path: image.path,
        sha256: image.sha256,
        width: image.width,
        height: image.height,
      },
      captured_at: frame.captured_at,
      engine_tick: frame.tick,
      simulation_step: frame.simulation_step,
      paused: frame.paused,
      state,
      state_after: summary(frame.state_after),
      enemy_feet_screen: projectFeet(frame.state_before),
      events,
      capture_metadata: metadata,
    }
  })()
}

async function advance(session, frames, input) {
  const reply = await session.advancePhysics({ frames, input })
  return reply.final
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runId = `phase18-${options.label}-${stamp()}`
  const outDir = assertPhase18Dir(
    options.outDir || path.join(PHASE18_DIR, 'evidence', options.label, runId),
  )
  fs.mkdirSync(outDir, { recursive: true })
  fs.mkdirSync(path.join(outDir, 'logs'), { recursive: true })

  const manifest = {
    schema: 'phase18.visual-check.v1',
    run_id: runId,
    label: options.label,
    project: options.project,
    out_dir: outDir,
    status: 'failed',
    failure_reason: null,
    started_at: new Date().toISOString(),
    git: {
      commit: gitValue(['rev-parse', 'HEAD']),
      branch: gitValue(['rev-parse', '--abbrev-ref', 'HEAD']),
      status: gitValue(['status', '--short']),
    },
    windowed: null,
    capture_count: 0,
    captures: [],
    input_sequence: [],
    visual_acceptance: null,
    checks: [],
    logs: [],
  }
  const check = (name, ok, detail) => {
    manifest.checks.push({ name, ok: Boolean(ok), detail })
    return Boolean(ok)
  }
  const recordAdvance = (frames, input, final) => {
    manifest.input_sequence.push({ frames, input, final_step: final?.step ?? null })
    return final
  }
  const step = async (session, frames, input) =>
    recordAdvance(frames, input, await advance(session, frames, input))

  const session = new HarnessSession({
    project: options.project,
    headless: false,
    timeoutMs: options.timeoutMs,
    // Agent sandboxes live outside the harness root. The runner, not the
    // agent, chooses this project path; keep the game's own path checks
    // unchanged while allowing a disposable copy to be inspected.
    allowOutsideRoot: true,
  })
  let failure = null
  try {
    await session.startProject()
    await session.pause()
    await session.reset()
    manifest.windowed = !session.headless
    check('windowed-session', session.headless === false, 'headless=false')

    // A windowed process can still render a scene whose GLB import failed.
    // Verify both rigs actually have their imported model before treating a
    // blank capture as evidence about the game's visuals.
    const modelPaths = [
      '/root/Main/Player/Rig/Model',
      '/root/Main/Enemy/Rig/Model',
    ]
    const missingModels = []
    for (const nodePath of modelPaths) {
      try {
        await session.property(nodePath, 'name')
      } catch (error) {
        missingModels.push(nodePath)
      }
    }
    check('rig-models-present', missingModels.length === 0, missingModels)
    if (missingModels.length > 0) {
      throw new Error(
        'Character models are not loaded. Import the game assets before capturing: ' +
          missingModels.join(', '),
      )
    }

    let snapshot = await session.snapshot()
    check(
      'spawn-clean',
      snapshot.step === 0 &&
        snapshot.player_health === 4 &&
        snapshot.enemy_health === 5 &&
        snapshot.outcome === 'playing',
      `step=${snapshot.step} player_hp=${snapshot.player_health} enemy_hp=${snapshot.enemy_health} outcome=${snapshot.outcome}`,
    )
    manifest.input_sequence.push({ command: 'reset', final_step: snapshot.step })

    // The idle control uses the exact positions and camera as the windup
    // comparison, but freezes the enemy AI so no attack begins.
    await session.reset()
    await session.setup({
      player_position: [0, 0.02, 2.6],
      enemy_position: [0, 0.02, 0.8],
      player_rotation_deg: 0,
      enemy_ai_enabled: false,
      player_health: 4,
      enemy_health: 5,
    })
    snapshot = await step(session, 1, idleInput())
    check(
      'idle-scenario',
      snapshot.enemy_phase === 'idle' && snapshot.enemy_ai_enabled === false,
      `phase=${snapshot.enemy_phase} enabled=${snapshot.enemy_ai_enabled}`,
    )
    manifest.captures.push(
      await capture(
        session,
        outDir,
        'idle',
        'control: enemy idle at attack distance; AI frozen',
        runId,
        { scenario_role: 'idle-control' },
      ),
    )

    // Windup scenario: reset, place the same two bodies, enable the real enemy
    // AI, and advance exactly until the public phase/tick fields reach the
    // target. No damage or phase is injected by the runner.
    await session.reset()
    await session.setup({
      player_position: [0, 0.02, 2.6],
      enemy_position: [0, 0.02, 0.8],
      player_rotation_deg: 0,
      enemy_ai_enabled: true,
      player_health: 4,
      enemy_health: 5,
    })
    snapshot = await step(session, 1, idleInput())
    let guard = 0
    while (!(snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 18) && guard < 120) {
      snapshot = await step(session, 1, idleInput())
      guard += 1
    }
    check(
      'windup-early-reached',
      snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 18,
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick} guard=${guard}`,
    )
    manifest.captures.push(
      await capture(
        session,
        outDir,
        'windup-early',
        'enemy windup: early warning window',
        runId,
        { scenario_role: 'windup-early' },
      ),
    )

    guard = 0
    while (
      snapshot.enemy_phase === 'windup' &&
      snapshot.enemy_phase_tick < 22 &&
      guard < 30
    ) {
      snapshot = await step(session, 1, idleInput())
      guard += 1
    }
    check(
      'windup-mid-reached',
      snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 21,
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick} guard=${guard}`,
    )
    manifest.captures.push(
      await capture(
        session,
        outDir,
        'windup-mid',
        'enemy windup: middle warning window',
        runId,
        { scenario_role: 'windup-mid' },
      ),
    )

    guard = 0
    while (
      snapshot.enemy_phase === 'windup' &&
      snapshot.enemy_phase_tick < 26 &&
      guard < 60
    ) {
      snapshot = await step(session, 1, idleInput())
      guard += 1
    }
    check(
      'windup-late-reached',
      snapshot.enemy_phase === 'windup' && snapshot.enemy_phase_tick >= 24,
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick} guard=${guard}`,
    )
    manifest.captures.push(
      await capture(
        session,
        outDir,
        'windup-late',
        'enemy windup: late warning window',
        runId,
        { scenario_role: 'windup-late' },
      ),
    )

    guard = 0
    while (snapshot.enemy_phase === 'windup' && guard < 20) {
      snapshot = await step(session, 1, idleInput())
      guard += 1
    }
    if (snapshot.enemy_phase === 'active') {
      snapshot = await step(session, 1, idleInput())
    }
    check(
      'active-reached',
      snapshot.enemy_phase === 'active',
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick}`,
    )
    manifest.captures.push(
      await capture(session, outDir, 'active', 'enemy attack active window', runId, {
        scenario_role: 'active',
      }),
    )

    guard = 0
    while (snapshot.enemy_phase !== 'recover' && guard < 30) {
      snapshot = await step(session, 1, idleInput())
      guard += 1
    }
    if (snapshot.enemy_phase === 'recover') {
      snapshot = await step(session, 1, idleInput())
    }
    check(
      'recovery-reached',
      snapshot.enemy_phase === 'recover',
      `phase=${snapshot.enemy_phase} tick=${snapshot.enemy_phase_tick}`,
    )
    manifest.captures.push(
      await capture(session, outDir, 'recovery', 'enemy recovery: warning should be gone', runId, {
        scenario_role: 'recovery',
      }),
    )

    snapshot = await step(session, 1, { ...idleInput(), restart: true })
    check(
      'restart-clean',
      snapshot.step === 0 &&
        snapshot.player_health === 4 &&
        snapshot.enemy_health === 5 &&
        snapshot.outcome === 'playing',
      `step=${snapshot.step} player_hp=${snapshot.player_health} enemy_hp=${snapshot.enemy_health} outcome=${snapshot.outcome}`,
    )
    manifest.captures.push(
      await capture(session, outDir, 'restart', 'restart: clean playable state', runId, {
        scenario_role: 'restart',
      }),
    )

    // Offline but independent: still images plus the public state are scored by
    // a Python script that has no access to the game implementation.
    writeJsonFile(outDir, 'captures.tmp.json', {
      schema: 'phase18.captures.v1',
      run_id: runId,
      label: options.label,
      project: options.project,
      git: manifest.git,
      captured_at: new Date().toISOString(),
      captures: manifest.captures,
    })
    fs.renameSync(path.join(outDir, 'captures.tmp.json'), path.join(outDir, 'captures.json'))

    const acceptanceScript = path.join(HERE, 'phase18_visual_acceptance.py')
    const acceptanceArgs = [
      acceptanceScript,
      '--run-dir',
      outDir,
      '--out',
      path.join(outDir, 'visual-acceptance.json'),
    ]
    if (options.baselineDir) {
      acceptanceArgs.push('--baseline-dir', path.resolve(options.baselineDir))
    }
    const acceptance = spawnSync(PYTHON, acceptanceArgs, {
      cwd: HARNESS_ROOT,
      encoding: 'utf8',
      timeout: 120000,
      windowsHide: true,
    })
    fs.writeFileSync(
      path.join(outDir, 'logs', 'visual-acceptance.stdout.txt'),
      acceptance.stdout || '',
      'utf8',
    )
    fs.writeFileSync(
      path.join(outDir, 'logs', 'visual-acceptance.stderr.txt'),
      acceptance.stderr || '',
      'utf8',
    )
    manifest.logs.push('logs/visual-acceptance.stdout.txt', 'logs/visual-acceptance.stderr.txt')
    const reportPath = path.join(outDir, 'visual-acceptance.json')
    if (!fs.existsSync(reportPath)) {
      throw new Error(
        `visual acceptance did not write ${reportPath} (exit ${acceptance.status}): ${acceptance.stderr || ''}`,
      )
    }
    const report = JSON.parse(fs.readFileSync(reportPath, 'utf8'))
    manifest.visual_acceptance = {
      passed: report.passed,
      checks: report.checks?.length ?? 0,
      failed_checks: (report.checks || []).filter((entry) => !entry.ok).map((entry) => entry.name),
      exit_code: acceptance.status,
      path: 'visual-acceptance.json',
      sha256: sha256File(reportPath),
    }
    if (options.expectation === 'pass') {
      check('visual-acceptance-pass', report.passed === true && acceptance.status === 0, {
        passed: report.passed,
        exit_code: acceptance.status,
        failed: manifest.visual_acceptance.failed_checks,
      })
    } else if (options.expectation === 'fail') {
      check('visual-acceptance-fails-as-expected', report.passed === false && acceptance.status !== 0, {
        passed: report.passed,
        exit_code: acceptance.status,
        failed: manifest.visual_acceptance.failed_checks,
      })
    } else {
      check(
        'visual-acceptance-ran',
        acceptance.status === 0 || acceptance.status === 1,
        { passed: report.passed, exit_code: acceptance.status },
      )
    }

    manifest.capture_count = manifest.captures.length
    const godotErrors = session.stderrLines.filter((line) =>
      /^(ERROR|SCRIPT ERROR|WARNING):/.test(line),
    )
    manifest.godot = {
      stdout_lines: session.stdoutLines.length,
      stderr_lines: session.stderrLines.length,
      errors: godotErrors.slice(0, 80),
    }
    check('godot-clean', godotErrors.length === 0, godotErrors.slice(0, 20))
    manifest.status = manifest.checks.every((entry) => entry.ok) ? 'passed' : 'failed'
  } catch (error) {
    failure = error
    manifest.failure_reason = error?.stack || String(error)
    check('runner-completed', false, error?.message || String(error))
  } finally {
    try {
      await session.stop()
    } catch (error) {
      manifest.logs.push(`stop error: ${error.message}`)
    }
    // The captures up to the failure point are still written, so a partial
    // attempt is evidence rather than a silent retry.
    writeJsonFile(outDir, 'captures.partial.json', {
      schema: 'phase18.captures.v1',
      run_id: runId,
      label: options.label,
      project: options.project,
      git: manifest.git,
      captured_at: new Date().toISOString(),
      captures: manifest.captures,
    })
    if (!fs.existsSync(path.join(outDir, 'captures.json'))) {
      fs.copyFileSync(
        path.join(outDir, 'captures.partial.json'),
        path.join(outDir, 'captures.json'),
      )
    }
    manifest.finished_at = new Date().toISOString()
    manifest.status = manifest.status === 'passed' && !failure ? 'passed' : 'failed'
    fs.writeFileSync(
      path.join(outDir, 'logs', 'godot-stdout.txt'),
      session.stdoutLines.join('\n') + '\n',
      'utf8',
    )
    fs.writeFileSync(
      path.join(outDir, 'logs', 'godot-stderr.txt'),
      session.stderrLines.join('\n') + '\n',
      'utf8',
    )
    manifest.logs.push('logs/godot-stdout.txt', 'logs/godot-stderr.txt')
    writeJsonFile(outDir, 'run.json', manifest)
  }
  console.log(
    JSON.stringify({
      run_id: runId,
      out_dir: outDir,
      status: manifest.status,
      capture_count: manifest.capture_count,
      visual_acceptance: manifest.visual_acceptance,
      failure: failure ? String(failure.message || failure) : null,
    }),
  )
  return failure || manifest.status !== 'passed' ? 1 : 0
}

process.exitCode = await main()
