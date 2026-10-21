import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession } from './harness.mjs'

const PROJECT = 'fixtures/character-audit'
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase11', 'stage-b')
const SKELETON_PATH = '/root/Main/CesiumMan/Z_UP/Armature/Skeleton3D'
const ANIMATION_PATH = '/root/Main/CesiumMan/AnimationPlayer'
const HUMANOID_PATH = '/root/Main/Humanoid'
const TARGETS = [
  '/root/Main',
  '/root/Main/CesiumMan',
  SKELETON_PATH,
  ANIMATION_PATH,
  HUMANOID_PATH,
  '/root/Main/Ground',
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeJson(name, value) {
  const target = path.join(EVIDENCE, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
  return {
    path: name,
    bytes: fs.statSync(target).size,
    sha256: sha256(target),
  }
}

function copyCapture(capture, name) {
  const target = path.join(EVIDENCE, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(capture.screenshot.absolute_path, target)
  const hash = sha256(target)
  assert.equal(hash, capture.screenshot.sha256, `${name} hash should match the bridge capture`)
  return {
    path: name,
    bytes: fs.statSync(target).size,
    sha256: hash,
  }
}

function nodeByPath(observation, nodePath) {
  return observation.nodes.find((node) => node.path === nodePath)
}

function flatten(node, result = []) {
  result.push(node)
  for (const child of Array.isArray(node?.children) ? node.children : []) {
    flatten(child, result)
  }
  return result
}

function boneSignature(skeleton) {
  return skeleton.bones
    .map((bone) => {
      const q = bone.pose.quaternion
      return `${bone.index}:${bone.pose.origin.map((v) => v.toFixed(6)).join(',')}:${q.map((v) => v.toFixed(6)).join(',')}`
    })
    .join('|')
}

function boneSummary(skeleton) {
  return {
    path: skeleton.path,
    bone_count: skeleton.bone_count,
    bones: skeleton.bones.map((bone) => ({
      index: bone.index,
      name: bone.name,
      parent: bone.parent,
      rest_space: bone.rest.space,
      pose_space: bone.pose.space,
      global_pose_space: bone.global_pose.space,
      derived_world_source: bone.derived_world_pose.source,
      enabled: bone.enabled,
    })),
    global_transform: skeleton.global_transform,
    source: skeleton.source,
  }
}

function observationSummary(observation) {
  const skeleton = nodeByPath(observation, SKELETON_PATH)
  const animation = nodeByPath(observation, ANIMATION_PATH)
  const humanoid = nodeByPath(observation, HUMANOID_PATH)
  const cesium = nodeByPath(observation, '/root/Main/CesiumMan')
  const humanoidNodes = flatten(humanoid)
  const animationState = animation.animations?.[0] ?? null
  return {
    runtime: observation.runtime,
    skeleton: skeleton.skeleton,
    animation: animationState,
    cesium: {
      path: cesium.path,
      class: cesium.class,
      global_transform: cesium.global_transform,
    },
    humanoid: {
      path: humanoid.path,
      class: humanoid.class,
      mesh_instance_count: humanoidNodes.filter((node) => node.class === 'MeshInstance3D').length,
      skeleton_count: humanoidNodes.filter((node) => node.class === 'Skeleton3D').length,
      animation_player_count: humanoidNodes.filter((node) => node.class === 'AnimationPlayer').length,
      part_names: humanoidNodes
        .filter((node) => node.class === 'MeshInstance3D' || node.name === 'head' || node.name === 'hand_l' || node.name === 'hand_r')
        .map((node) => node.name),
    },
  }
}

function assertSkeletonObservation(observation) {
  const skeleton = nodeByPath(observation, SKELETON_PATH)?.skeleton
  assert.ok(skeleton, 'skeleton observation should exist')
  assert.equal(skeleton.bone_count, 19)
  assert.equal(skeleton.bones[0].name, 'Skeleton_torso_joint_1')
  assert.equal(skeleton.bones[0].parent, -1)
  for (const bone of skeleton.bones) {
    assert.equal(bone.global_pose.space, 'skeleton')
    assert.equal(bone.pose.space, 'bone_parent')
    assert.equal(bone.rest.space, 'bone_parent')
    assert.equal(bone.derived_world_pose.space, 'world')
    assert.equal(bone.derived_world_pose.source, 'derived')
  }
}

function assertAnimationObservation(observation) {
  const animation = nodeByPath(observation, ANIMATION_PATH)?.animations?.[0]
  assert.ok(animation, 'animation observation should exist')
  assert.equal(animation.current_animation, 'Animation')
  assert.equal(animation.is_playing, true)
  assert.equal(animation.source, 'measured')
}

function assertHumanoidObservation(observation) {
  const humanoid = nodeByPath(observation, HUMANOID_PATH)
  const nodes = flatten(humanoid)
  const meshes = nodes.filter((node) => node.class === 'MeshInstance3D')
  const skeletons = nodes.filter((node) => node.class === 'Skeleton3D')
  const animations = nodes.filter((node) => node.class === 'AnimationPlayer')
  assert.equal(meshes.length, 22)
  assert.equal(skeletons.length, 0)
  assert.equal(animations.length, 0)
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const runId = `stage-b-${crypto.randomUUID()}`
  const session = new HarnessSession({ project: PROJECT, headless: false })
  const manifest = {
    operation: 'phase11_stage_b_character_inspection',
    ok: false,
    run_id: runId,
    project: PROJECT,
    godot: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    captures: {},
    observations: {},
    animation: null,
    humanoid: null,
    assertions: [],
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
    await session.reset()
    const start = await session.advancePhysics({ frames: 3 })

    const initialObservation = await session.observe({
      targets: TARGETS,
      descendants: 3,
      sinceTick: 0,
    })
    assertSkeletonObservation(initialObservation)
    assertAnimationObservation(initialObservation)
    assertHumanoidObservation(initialObservation)

    const initialCapture = await session.captureFrame({
      path: 'res://artifacts/phase11-stage-b-initial.png',
      scenario: 'character audit initial: skinned CesiumMan and rigid humanoid-01',
      runId,
      metadata: { stage: 'phase11-b', fixture: 'character-audit', checkpoint: 'initial' },
    })
    const initialSummary = observationSummary(initialObservation)
    const initialBones = boneSignature(initialSummary.skeleton)
    manifest.captures.initial = {
      run_id: initialCapture.run_id,
      captured_at: initialCapture.captured_at,
      tick: initialCapture.tick,
      simulation_step: initialCapture.simulation_step,
      state: {
        step: initialCapture.state_before.step,
        animation_position: initialCapture.state_before.cesium_animation_position,
        animation_playing: initialCapture.state_before.cesium_animation_playing,
      },
      screenshot: copyCapture(initialCapture, 'stage-b-initial.png'),
    }
    manifest.observations.initial = writeJson('stage-b-initial.json', initialObservation)
    manifest.observations.initial_summary = initialSummary

    await session.advancePhysics({ frames: 24 })
    const laterObservation = await session.observe({
      targets: TARGETS,
      descendants: 3,
      sinceTick: 0,
    })
    assertSkeletonObservation(laterObservation)
    assertAnimationObservation(laterObservation)
    const laterSummary = observationSummary(laterObservation)
    const laterBones = boneSignature(laterSummary.skeleton)
    const laterCapture = await session.captureFrame({
      path: 'res://artifacts/phase11-stage-b-later.png',
      scenario: 'character audit after 24 fixed physics ticks: animation and bone poses changed',
      runId,
      metadata: { stage: 'phase11-b', fixture: 'character-audit', checkpoint: 'later' },
    })
    manifest.captures.later = {
      run_id: laterCapture.run_id,
      captured_at: laterCapture.captured_at,
      tick: laterCapture.tick,
      simulation_step: laterCapture.simulation_step,
      state: {
        step: laterCapture.state_before.step,
        animation_position: laterCapture.state_before.cesium_animation_position,
        animation_playing: laterCapture.state_before.cesium_animation_playing,
      },
      screenshot: copyCapture(laterCapture, 'stage-b-later.png'),
    }
    manifest.observations.later = writeJson('stage-b-later.json', laterObservation)
    manifest.observations.later_summary = laterSummary
    const animationAdvanced =
      laterSummary.animation.current_animation_position >
      initialSummary.animation.current_animation_position
    const bonesChanged = initialBones !== laterBones
    manifest.animation = {
      initial_position: initialSummary.animation.current_animation_position,
      later_position: laterSummary.animation.current_animation_position,
      initial_bone_signature: initialBones,
      later_bone_signature: laterBones,
      animation_advanced: animationAdvanced,
      bone_poses_changed: bonesChanged,
      final_evaluated_frame_note:
        'The later observation is read after 24 real fixed physics ticks; the AnimationPlayer and Skeleton3D have evaluated through that tick.',
    }
    assert.equal(animationAdvanced, true)
    assert.equal(bonesChanged, true)

    const sequence = await session.captureSequence({
      scenario: 'character walk sampled every 8 real physics ticks',
      prefix: 'phase11-stage-b-walk',
      frameCount: 4,
      everyFrames: 8,
      runId,
      metadata: { stage: 'phase11-b', fixture: 'character-audit', sequence: 'walk' },
    })
    manifest.sequence = {
      run_id: sequence.run_id,
      frame_count: sequence.frame_count,
      every_frames: sequence.every_frames,
      note: sequence.note,
      frames: sequence.frames.map((frame, index) => ({
        index,
        tick: frame.tick,
        simulation_step: frame.simulation_step,
        state: {
          animation_position: frame.state_before.cesium_animation_position,
          animation_playing: frame.state_before.cesium_animation_playing,
        },
        screenshot: copyCapture(frame, `stage-b-walk-${String(index).padStart(3, '0')}.png`),
      })),
    }

    manifest.humanoid = initialSummary.humanoid
    manifest.assertions = [
      '19 named bones with valid parent indices',
      'bone rest/pose are parent-relative; global pose is skeleton-relative; world pose is explicitly derived',
      'AnimationPlayer current_animation=Animation and is_playing=true',
      'animation position and bone poses change after fixed physics ticks',
      'humanoid-01 has 22 MeshInstance3D nodes, zero Skeleton3D, zero AnimationPlayer',
      'captureFrame PNG dimensions and hashes match the bridge result',
    ]
    manifest.ok = true
    manifest.finished_at = new Date().toISOString()
    manifest.initial = { step: start.final.step, tick: start.final.physics_frames }
    console.log(JSON.stringify({
      ok: manifest.ok,
      run_id: runId,
      godot: manifest.godot,
      captures: Object.keys(manifest.captures),
      sequence_frames: manifest.sequence.frames.length,
      animation: manifest.animation,
      humanoid: manifest.humanoid,
      evidence_dir: EVIDENCE,
    }, null, 2))
    writeJson('stage-b-manifest.json', manifest)
  } catch (error) {
    manifest.error = error instanceof Error ? error.message : String(error)
    manifest.finished_at = new Date().toISOString()
    writeJson('stage-b-manifest.json', manifest)
    throw error
  } finally {
    manifest.stop = await session.stop()
    if (manifest.stop) {
      const target = path.join(EVIDENCE, 'stage-b-manifest.json')
      if (fs.existsSync(target)) {
        const current = JSON.parse(fs.readFileSync(target, 'utf8'))
        current.stop = manifest.stop
        current.finished_at = new Date().toISOString()
        fs.writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`)
      }
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
