#!/usr/bin/env node
/**
 * Phase 19 windowed observation and visual-evidence runner.
 *
 * This is a trusted-runner script. It launches the real voxel project in a
 * visible window, drives the public harness input surface, pauses on real
 * frames, captures the viewport, and verifies gameplay state from the public
 * snapshot/event stream. It does not read acceptance answer keys.
 *
 * Usage:
 *   node controller/voxel-observe.mjs \
 *     --out-dir ../../docs/phase19/evidence/runtime/<run>
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HarnessSession } from './harness.mjs'
import {
  copyCaptureFile,
  rejectReason,
  resolveOutputDir,
  sha256,
  writeJsonFile,
} from './evidence-output.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_PROJECT = 'voxel'
const NEUTRAL = Object.freeze({
  forward: 0,
  strafe: 0,
  jump: false,
  restart: false,
  actions: {},
})

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

function parseArgs(argv) {
  const options = { outDir: null, project: DEFAULT_PROJECT }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out-dir') options.outDir = argv[++i]
    else if (argv[i] === '--project') options.project = argv[++i]
    else throw new Error(`Unknown option: ${argv[i]}`)
  }
  return options
}

function round(value, digits = 4) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return value
  const factor = 10 ** digits
  return Math.round(value * factor) / factor
}

function vec(value) {
  if (!Array.isArray(value) || value.length < 3) return null
  return value.map((item) => round(Number(item)))
}

function pickState(state) {
  return {
    step: state.step,
    sim_time_seconds: round(state.sim_time_seconds),
    physics_frames: state.physics_frames,
    paused: state.paused,
    player_position: vec(state.player_position),
    player_velocity: vec(state.player_velocity),
    grounded: state.grounded,
    player_facing_deg: round(state.player_facing_deg, 2),
    camera_position: vec(state.camera_position),
    camera_forward: vec(state.camera_forward),
    camera_pitch_deg: round(state.camera_pitch_deg, 2),
    target: state.target,
    selected_slot: state.selected_slot,
    selected_block: state.selected_block,
    inventory: state.inventory,
    world: state.world,
    mouse_captured: state.mouse_captured,
    feedback: state.feedback,
    last_event_type: state.last_event_type,
    events_count: state.events_count,
    save: state.save,
    performance: state.performance,
    hash: state.hash,
    hud: state.hud,
  }
}

function lastEventOfType(state, type) {
  const events = Array.isArray(state.events) ? state.events : []
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i] && events[i].type === type) return events[i]
  }
  return null
}

function horizontalDistance(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b)) return 0
  return Math.hypot(Number(b[0]) - Number(a[0]), Number(b[2]) - Number(a[2]))
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runStamp = stamp()
  const outDir = resolveOutputDir({
    outDir: options.outDir || path.join(
      path.resolve(HERE, '..', '..', '..', 'docs', 'phase19', 'evidence', 'runtime'),
      runStamp,
    ),
    runner: 'voxel-observe',
  })
  const reason = rejectReason(outDir)
  if (reason) throw new Error(reason)
  fs.mkdirSync(outDir, { recursive: true })

  const checks = []
  const captures = []
  const scenarios = []
  const session = new HarnessSession({
    project: options.project,
    headless: false,
    timeoutMs: 30000,
  })
  const startedAt = new Date().toISOString()
  let startInfo = null
  let failure = null

  const check = (name, condition, detail) => {
    checks.push({
      name,
      pass: Boolean(condition),
      detail: detail === undefined ? '' : detail,
    })
  }

  const capture = async (name, scenario, metadata = {}) => {
    const frame = await session.captureFrame({
      path: `res://artifacts/phase19-${name}.png`,
      scenario,
      metadata: { phase: 19, ...metadata },
    })
    const image = copyCaptureFile(outDir, `${name}.png`, frame)
    const state = pickState(frame.state_before)
    const stateFile = writeJsonFile(outDir, `state-${name}.json`, frame.state_before)
    captures.push({
      name,
      scenario,
      captured_at: frame.captured_at,
      tick: frame.tick,
      duration_ms: frame.duration_ms,
      image,
      state_file: stateFile,
      metadata: frame.metadata,
    })
    return { frame, state }
  }

  const advance = async (frames, input = NEUTRAL) => {
    const result = await session.advancePhysics({ frames, input })
    return result.final
  }

  try {
    startInfo = await session.start()
    await session.setup({
      save_path: 'user://phase19-observation.json',
      delete_save: true,
    })

    // Spawn and initial world state.
    await session.reset()
    await advance(30)
    const spawnCapture = await capture('spawn', 'spawn')
    const spawnState = spawnCapture.state
    check(
      'spawn-grounded',
      spawnState.grounded === true,
      `position=${JSON.stringify(spawnState.player_position)}`,
    )
    check(
      'spawn-world-shape',
      spawnState.world.width === 32 &&
        spawnState.world.height === 16 &&
        spawnState.world.depth === 32 &&
        spawnState.world.chunk_count === 16 &&
        spawnState.world.modified_blocks === 0,
      JSON.stringify(spawnState.world),
    )
    check(
      'spawn-block-types',
      spawnState.world.block_counts.grass > 0 &&
        spawnState.world.block_counts.dirt > 0 &&
        spawnState.world.block_counts.stone > 0 &&
        spawnState.world.block_counts.log > 0,
      JSON.stringify(spawnState.world.block_counts),
    )
    scenarios.push({ name: 'spawn', state: spawnState })

    // Movement.
    const beforeMove = spawnState.player_position
    const movedState = await advance(30, { ...NEUTRAL, forward: 1 })
    const movementCapture = await capture('movement', 'movement', {
      expected: 'forward displacement with grounded terrain contact',
    })
    check(
      'movement-forward',
      horizontalDistance(beforeMove, movedState.player_position) > 0.5,
      `from=${JSON.stringify(beforeMove)} to=${JSON.stringify(movedState.player_position)}`,
    )
    scenarios.push({ name: 'movement', state: movementCapture.state })
    await advance(1, NEUTRAL)

    // Jump and gravity.
    await session.reset()
    await advance(12)
    const jumpStart = await session.snapshot()
    await advance(1, { ...NEUTRAL, jump: true })
    await advance(10, NEUTRAL)
    const jumpCapture = await capture('jump', 'jump', {
      expected: 'player above spawn while gravity is active',
    })
    check(
      'jump-airborne',
      Number(jumpCapture.state.player_position[1]) > Number(jumpStart.player_position[1]) + 0.2,
      `start=${JSON.stringify(jumpStart.player_position)} jumped=${JSON.stringify(jumpCapture.state.player_position)}`,
    )
    scenarios.push({ name: 'jump', state: jumpCapture.state })

    // Targeting.
    await session.reset()
    await advance(20)
    const at = await session.snapshot()
    const sx = Math.floor(at.player_position[0])
    const sz = Math.floor(at.player_position[2])
    const feetY = Math.floor(at.player_position[1] + 0.05)
    const targetY = feetY + 1
    const targetZ = sz - 2
    await session.setup({
      blocks: [{ x: sx, y: targetY, z: targetZ, id: 3 }],
      look_at: [sx, targetY, targetZ],
      selected_slot: 1,
    })
    const targetingCapture = await capture('targeting', 'targeting', {
      expected: 'crosshair ray hits the placed stone before the origin',
    })
    const targeting = targetingCapture.state
    check(
      'targeting-hit',
      targeting.target.hit === true &&
        JSON.stringify(targeting.target.block) === JSON.stringify([sx, targetY, targetZ]) &&
        targeting.target.block_name === 'Stone',
      JSON.stringify(targeting.target),
    )
    check(
      'targeting-hud',
      String(targeting.hud).includes('target=Stone') &&
        String(targeting.hud).includes('selected=GRASS'),
      String(targeting.hud),
    )
    scenarios.push({ name: 'targeting', state: targeting })

    // Mining.
    await advance(1, { ...NEUTRAL, actions: { mine: true } })
    await advance(3, NEUTRAL)
    const miningCapture = await capture('mining', 'mining', {
      expected: 'targeted stone removed, inventory incremented',
    })
    const mined = lastEventOfType(miningCapture.frame.state_before, 'block_mined')
    check(
      'mining-event',
      mined !== null &&
        JSON.stringify(mined.block) === JSON.stringify([sx, targetY, targetZ]) &&
        mined.block_name === 'Stone' &&
        Number(miningCapture.state.inventory[String(3)] || 0) >= 17,
      JSON.stringify(mined),
    )
    scenarios.push({ name: 'mining', state: miningCapture.state })

    // Placement.
    await session.reset()
    await advance(20)
    const atPlace = await session.snapshot()
    const px = Math.floor(atPlace.player_position[0])
    const pz = Math.floor(atPlace.player_position[2])
    const pFeet = Math.floor(atPlace.player_position[1] + 0.05)
    const placeY = pFeet + 1
    const placeZ = pz - 2
    const placementSetup = await session.setup({
      blocks: [{ x: px, y: placeY, z: placeZ, id: 3 }],
      look_at: [px, placeY, placeZ],
      selected_slot: 1,
    })
    const placementState = await session.snapshot()
    const previous = placementState.target.previous
    await advance(1, { ...NEUTRAL, actions: { place: true } })
    await advance(3, NEUTRAL)
    const placementCapture = await capture('placement', 'placement', {
      expected: 'grass placed in the adjacent air cell',
    })
    const placed = lastEventOfType(placementCapture.frame.state_before, 'block_placed')
    check(
      'placement-event',
      placed !== null &&
        JSON.stringify(placed.block) === JSON.stringify(previous) &&
        placed.block_name === 'Grass' &&
        Number(placementCapture.state.inventory[String(1)] || 0) === 15,
      JSON.stringify(placed),
    )
    scenarios.push({ name: 'placement', state: placementCapture.state })

    // Hotbar.
    await session.reset()
    await advance(20)
    await advance(1, { ...NEUTRAL, actions: { select_3: true } })
    const hotbarCapture = await capture('hotbar', 'hotbar', {
      expected: 'number-key selection changes the active block and HUD',
    })
    check(
      'hotbar-selected',
      hotbarCapture.state.selected_slot === 3 &&
        hotbarCapture.state.selected_block === 'STONE' &&
        String(hotbarCapture.state.hud).includes('selected=STONE'),
      JSON.stringify({
        slot: hotbarCapture.state.selected_slot,
        block: hotbarCapture.state.selected_block,
        hud: hotbarCapture.state.hud,
      }),
    )
    scenarios.push({ name: 'hotbar', state: hotbarCapture.state })

    // Save and reload.
    await session.reset()
    await advance(20)
    const atSave = await session.snapshot()
    const saveX = Math.floor(atSave.player_position[0])
    const saveZ = Math.floor(atSave.player_position[2])
    const saveY = Math.floor(atSave.player_position[1] + 0.05) + 2
    await session.setup({
      blocks: [
        { x: saveX, y: saveY, z: saveZ - 2, id: 3 },
        { x: 4, y: 4, z: 4, id: 0 },
      ],
      selected_slot: 2,
      inventory: { 1: 7, 2: 3, 3: 5, 4: 2 },
      player_position: atSave.player_position,
      yaw_deg: 35,
      pitch_deg: -11,
    })
    const beforeSave = await session.snapshot()
    await advance(1, { ...NEUTRAL, actions: { save: true } })
    const saveCapture = await capture('save', 'save', {
      expected: 'save writes changed blocks and player state outside the repository',
    })
    const savedEvent = lastEventOfType(saveCapture.frame.state_before, 'world_saved')
    check(
      'save-event',
      savedEvent !== null &&
        saveCapture.state.save.exists === true &&
        String(saveCapture.state.save.path).startsWith('user://') &&
        Number(savedEvent.bytes) > 100,
      JSON.stringify(savedEvent),
    )
    await session.reset()
    const resetHash = (await session.snapshot()).hash
    await advance(1, { ...NEUTRAL, actions: { load: true } })
    const reloadCapture = await capture('reload', 'reload', {
      expected: 'reload restores the saved world hash and player selection',
    })
    const loadedEvent = lastEventOfType(reloadCapture.frame.state_before, 'world_loaded')
    check(
      'reload-event',
      loadedEvent !== null &&
        resetHash !== beforeSave.hash &&
        reloadCapture.state.hash === beforeSave.hash &&
        reloadCapture.state.selected_slot === 2 &&
        Number(reloadCapture.state.inventory[String(1)] || 0) === 7,
      JSON.stringify({
        reset_hash: resetHash,
        saved_hash: beforeSave.hash,
        loaded_hash: reloadCapture.state.hash,
        event: loadedEvent,
      }),
    )
    scenarios.push({ name: 'save', state: saveCapture.state })
    scenarios.push({ name: 'reload', state: reloadCapture.state })

    // Record a small set of public node observations as well as the snapshot
    // surface, so the evidence shows the scene tree was live, not synthesized.
    const observations = await session.observe({
      targets: ['/root/VoxelWorld', '/root/VoxelWorld/Player', '/root/VoxelWorld/ChunkRoot'],
      properties: ['script', 'position', 'visible'],
    })
    writeJsonFile(outDir, 'observations.json', observations)
  } catch (error) {
    failure = {
      message: error?.stack || String(error),
      checks,
      captures,
      scenarios,
    }
  } finally {
    try {
      await session.stop()
    } catch (stopError) {
      failure = failure || { message: `stop failed: ${stopError?.stack || stopError}` }
    }
  }

  const finishedAt = new Date().toISOString()
  const passed = checks.filter((entry) => entry.pass).length
  const manifest = {
    phase: 19,
    runner: 'voxel-observe',
    project: options.project,
    headless: false,
    started_at: startedAt,
    finished_at: finishedAt,
    out_dir: outDir,
    start: startInfo,
    checks,
    passed,
    failed: checks.length - passed,
    captures,
    scenarios,
    failure,
    note:
      'Captures are real windowed frames paused at the listed physics tick. ' +
      'They are sampled evidence, not a real-time video claim.',
  }
  writeJsonFile(outDir, 'run.json', manifest)
  if (failure) {
    console.error(`observation run failed: ${failure.message}`)
    process.exitCode = 1
  } else if (passed !== checks.length) {
    console.error(`observation checks failed: ${passed}/${checks.length}`)
    process.exitCode = 1
  } else {
    console.log(`observation checks passed: ${passed}/${checks.length}`)
    console.log(`evidence: ${outDir}`)
    for (const entry of captures) {
      console.log(`${entry.name}: ${entry.image.sha256} ${entry.image.width}x${entry.image.height}`)
    }
  }
}

main().catch((error) => {
  console.error(error?.stack || String(error))
  process.exitCode = 1
})
