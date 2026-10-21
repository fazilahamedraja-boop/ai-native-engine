import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession } from './harness.mjs'

const PROJECT = 'fixtures/door'
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase10')
const FRAME_DIR = path.join(EVIDENCE, 'stage-b-frames')
const scenarioLog = []

function idleInput() {
  return {
    forward: 0,
    strafe: 0,
    jump: false,
    restart: false,
    actions: { interact: false },
  }
}

function withInput(overrides = {}) {
  return {
    ...idleInput(),
    ...overrides,
    actions: { ...idleInput().actions, ...(overrides.actions || {}) },
  }
}

async function advance(session, frames, overrides = {}) {
  return session.advancePhysics({ frames, input: withInput(overrides) })
}

async function loggedAdvance(session, frames, overrides = {}) {
  const input = withInput(overrides)
  const result = await advance(session, frames, overrides)
  scenarioLog.push({
    type: 'advance_physics',
    frames,
    input,
    final_step: result.final.step,
    final_tick: result.final.physics_frames,
  })
  return result
}

async function loggedReset(session) {
  const result = await session.reset()
  scenarioLog.push({ type: 'reset', snapshot_step: result.snapshot.step })
  return result
}

function stateSummary(snapshot) {
  return {
    step: snapshot.step,
    physics_frames: snapshot.physics_frames,
    physics_ticks_per_second: snapshot.physics_ticks_per_second,
    player_position: snapshot.player_position,
    player_velocity: snapshot.player_velocity,
    grounded: snapshot.grounded,
    door_locked: snapshot.door_locked,
    door_open: snapshot.door_open,
    player_has_key: snapshot.player_has_key,
    key_available: snapshot.key_available,
    key_visible: snapshot.key_visible,
    feedback: snapshot.feedback,
    prompt: snapshot.prompt,
    locked_attempts: snapshot.locked_attempts,
    open_count: snapshot.open_count,
    interaction_count: snapshot.interaction_count,
    input: snapshot.input,
    hash: snapshot.hash,
    outcome_hash: snapshot.outcome_hash,
  }
}

function captureSummary(capture) {
  return {
    operation: capture.operation,
    run_id: capture.run_id,
    scenario: capture.scenario,
    captured_at: capture.captured_at,
    duration_ms: capture.duration_ms,
    tick: capture.tick,
    sim_time_seconds: capture.sim_time_seconds,
    paused: capture.paused,
    screenshot: capture.screenshot,
    state: stateSummary(capture.state_before),
    state_after_tick: capture.state_after.physics_frames ?? capture.state_after.step ?? null,
    metadata: capture.metadata,
  }
}

function copyCapture(capture, targetName) {
  const source = capture.screenshot.absolute_path
  const target = path.join(EVIDENCE, targetName)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(source, target)
  const hash = crypto.createHash('sha256').update(fs.readFileSync(target)).digest('hex')
  assert.equal(hash, capture.screenshot.sha256, `${targetName} hash should match the bridge capture`)
  return {
    path: targetName,
    bytes: fs.statSync(target).size,
    sha256: hash,
  }
}

function encodeSequence(frames, outputName) {
  const ffmpeg = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', windowsHide: true })
  if (ffmpeg.error || ffmpeg.status !== 0) {
    return {
      available: false,
      error: ffmpeg.error?.message || `ffmpeg exited ${ffmpeg.status}`,
      note: 'The sampled PNG frames remain the visual evidence.',
    }
  }
  const inputPattern = path.join(FRAME_DIR, 'stage-b-approach-%03d.png')
  const output = path.join(EVIDENCE, outputName)
  const args = [
    '-y',
    '-loglevel',
    'error',
    '-framerate',
    '5',
    '-start_number',
    '0',
    '-i',
    inputPattern,
    '-c:v',
    'libx264',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    output,
  ]
  const encoded = spawnSync('ffmpeg', args, { encoding: 'utf8', windowsHide: true })
  if (encoded.error || encoded.status !== 0) {
    return {
      available: false,
      error: encoded.error?.message || encoded.stderr || `ffmpeg exited ${encoded.status}`,
      command: ['ffmpeg', ...args].join(' '),
      note: 'The sampled PNG frames remain the visual evidence.',
    }
  }
  return {
    available: true,
    path: outputName,
    bytes: fs.statSync(output).size,
    sha256: crypto.createHash('sha256').update(fs.readFileSync(output)).digest('hex'),
    command: ['ffmpeg', ...args].join(' '),
    note:
      'Offline encoding of sampled PNG frames at 5 fps; not a real-time capture and not used as live video understanding.',
  }
}

async function main() {
  fs.mkdirSync(FRAME_DIR, { recursive: true })
  for (const entry of fs.readdirSync(FRAME_DIR)) {
    if (entry.endsWith('.png')) fs.rmSync(path.join(FRAME_DIR, entry), { force: true })
  }

  const runId = `stage-b-${crypto.randomUUID()}`
  const startedAt = new Date().toISOString()
  const session = new HarnessSession({ project: PROJECT, headless: false })
  const manifest = {
    operation: 'stage_b_visual_observation',
    ok: false,
    run_id: runId,
    project: PROJECT,
    headless: false,
    started_at: startedAt,
    finished_at: null,
    requirements: {
      windowed: true,
      screenshots: 'actual viewport captures through the project bridge',
      recording:
        'bounded sequence sampled after real fixed physics ticks; optional offline mp4 encoding',
    },
    godot: null,
    captures: {},
    scenario: {
      description:
        'locked approach and attempt; reset; key pickup; return; unlock; reset; sampled approach',
      steps: [],
    },
    sequence: null,
    video: null,
    stop: null,
    error: null,
  }

  try {
    const started = await session.startProject()
    assert.equal(started.ok, true)
    manifest.godot = started.ping.godot
    manifest.pid = started.pid
    manifest.port = started.port
    await session.pause()
    await loggedReset(session)

    let snap = (await loggedAdvance(session, 100, { forward: 1 })).final
    snap = (await loggedAdvance(session, 1, { actions: { interact: true } })).final
    assert.equal(snap.feedback, 'LOCKED - KEY REQUIRED')
    assert.equal(snap.door_locked, true)
    assert.equal(snap.door_open, false)
    const locked = await session.captureFrame({
      path: 'res://artifacts/stage-b-locked.png',
      scenario: 'door locked after approach and interact',
      runId,
      metadata: { fixture: 'door', stage: 'phase10-b', state: 'locked' },
    })
    assert.equal(locked.screenshot.width, 1280)
    assert.equal(locked.screenshot.height, 720)
    manifest.captures.locked = {
      capture: captureSummary(locked),
      evidence: copyCapture(locked, 'stage-b-locked.png'),
    }

    await loggedReset(session)
    await loggedAdvance(session, 30, { strafe: 1 })
    snap = (await loggedAdvance(session, 15, { forward: 1 })).final
    assert.equal(snap.player_has_key, true)
    assert.equal(snap.key_visible, false)
    const key = await session.captureFrame({
      path: 'res://artifacts/stage-b-key.png',
      scenario: 'door key acquired',
      runId,
      metadata: { fixture: 'door', stage: 'phase10-b', state: 'key' },
    })
    manifest.captures.key = {
      capture: captureSummary(key),
      evidence: copyCapture(key, 'stage-b-key.png'),
    }

    await loggedAdvance(session, 30, { strafe: -1 })
    await loggedAdvance(session, 100, { forward: 1 })
    snap = (await loggedAdvance(session, 1, { actions: { interact: true } })).final
    assert.equal(snap.feedback, 'UNLOCKED - DOOR OPEN')
    assert.equal(snap.door_open, true)
    assert.equal(snap.door_locked, false)
    const open = await session.captureFrame({
      path: 'res://artifacts/stage-b-open.png',
      scenario: 'door opened after key use',
      runId,
      metadata: { fixture: 'door', stage: 'phase10-b', state: 'open' },
    })
    manifest.captures.open = {
      capture: captureSummary(open),
      evidence: copyCapture(open, 'stage-b-open.png'),
    }

    await loggedReset(session)
    const sequence = await session.captureSequence({
      scenario: 'approach the locked door from spawn',
      prefix: 'stage-b-approach',
      frameCount: 7,
      everyFrames: 20,
      input: withInput({ forward: 1 }),
      runId: `${runId}-sequence`,
      metadata: { fixture: 'door', stage: 'phase10-b', state: 'approach' },
    })
    const sequenceFrames = []
    for (const frame of sequence.frames) {
      const targetName = `stage-b-frames/stage-b-approach-${String(frame.metadata.frame_index).padStart(3, '0')}.png`
      sequenceFrames.push({
        frame_index: frame.metadata.frame_index,
        tick: frame.tick,
        sim_time_seconds: frame.sim_time_seconds,
        captured_at: frame.captured_at,
        state: stateSummary(frame.state_before),
        evidence: copyCapture(frame, targetName),
      })
    }
    manifest.sequence = {
      run_id: sequence.run_id,
      scenario: sequence.scenario,
      duration_ms: sequence.duration_ms,
      frame_count: sequence.frame_count,
      every_frames: sequence.every_frames,
      input: sequence.input,
      frames: sequenceFrames,
      note: sequence.note,
    }
    scenarioLog.push({
      type: 'capture_sequence',
      run_id: sequence.run_id,
      scenario: sequence.scenario,
      frame_count: sequence.frame_count,
      every_frames: sequence.every_frames,
      input: sequence.input,
    })
    manifest.video = encodeSequence(sequenceFrames, 'stage-b-approach.mp4')
    manifest.ok = true
  } catch (error) {
    manifest.error = {
      name: error.name,
      message: error.message,
      stack: error.stack,
    }
    throw error
  } finally {
    try {
      manifest.stop = await session.stopProject()
    } finally {
      manifest.finished_at = new Date().toISOString()
      manifest.scenario.steps = scenarioLog
      fs.mkdirSync(EVIDENCE, { recursive: true })
      fs.writeFileSync(
        path.join(EVIDENCE, 'stage-b-captures.json'),
        `${JSON.stringify(manifest, null, 2)}\n`,
      )
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`)
  process.exitCode = 1
})
