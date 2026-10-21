import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession, runTests } from './harness.mjs'

const PROJECT = 'fixtures/character-audit'
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase11', 'stage-a')
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

function flatten(node, result = []) {
  result.push(node)
  for (const child of Array.isArray(node?.children) ? node.children : []) {
    flatten(child, result)
  }
  return result
}

function nodeByPath(observation, nodePath) {
  return observation.nodes.find((node) => node.path === nodePath)
}

function countTree(tree) {
  let count = 1
  for (const child of Array.isArray(tree?.children) ? tree.children : []) {
    count += countTree(child)
  }
  return count
}

function maxTreeDepth(tree) {
  const children = Array.isArray(tree?.children) ? tree.children : []
  return 1 + (children.length === 0 ? 0 : Math.max(...children.map(maxTreeDepth)))
}

function compactTest(result) {
  return {
    ok: result.ok,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    reason: result.reason,
    summary: result.summary,
    results: result.results,
    errors: result.errors,
  }
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const runId = `stage-a-${crypto.randomUUID()}`
  const session = new HarnessSession({ project: PROJECT, headless: true })
  const report = {
    operation: 'phase11_stage_a_capability_audit',
    ok: false,
    run_id: runId,
    project: PROJECT,
    started_at: new Date().toISOString(),
    finished_at: null,
    godot: null,
    capabilities: {},
    tests: null,
    stop: null,
    error: null,
  }

  try {
    const started = await session.startProject()
    assert.equal(started.ok, true)
    report.godot = started.ping.godot
    report.pid = started.pid
    await session.pause()
    await session.reset()

    const inspection = await session.inspectState()
    const animationProperty = await session.property(ANIMATION_PATH, 'current_animation')
    const mainProperty = await session.property('/root/Main', 'name')
    const skeletonObservation = await session.observe({
      targets: [SKELETON_PATH],
      sinceTick: 0,
    })
    const characterObservation = await session.observe({
      targets: [TARGETS[0], TARGETS[1], HUMANOID_PATH],
      descendants: 3,
      sinceTick: 0,
    })
    const skeleton = nodeByPath(skeletonObservation, SKELETON_PATH)?.skeleton
    const humanoid = nodeByPath(characterObservation, HUMANOID_PATH)
    const humanoidNodes = flatten(humanoid)
    const tree = inspection.scene_tree
    assert.ok(tree, 'inspect_state should return a scene tree')
    assert.equal(tree.name, 'root')
    assert.ok(countTree(tree) > 20, 'scene tree should contain the loaded character and ground')
    assert.equal(animationProperty.value, 'Animation')
    assert.equal(mainProperty.value, 'Main')
    assert.equal(skeleton.bone_count, 19)
    assert.equal(humanoidNodes.filter((node) => node.class === 'MeshInstance3D').length, 22)
    assert.equal(humanoidNodes.filter((node) => node.class === 'Skeleton3D').length, 0)

    const timeline = await session.observeTimeline({
      frames: 24,
      everyFrames: 8,
      targets: [SKELETON_PATH, ANIMATION_PATH],
      sinceTick: 0,
      scenario: 'character-audit animation and pose samples',
      runId,
    })
    const timelineSamples = timeline.samples.map((sample) => {
      const skeletonNode = nodeByPath(sample.observation, SKELETON_PATH)?.skeleton
      const animationNode = nodeByPath(sample.observation, ANIMATION_PATH)?.animations?.[0]
      return {
        index: sample.index,
        frames_advanced: sample.frames_advanced,
        engine_tick: sample.engine_tick,
        simulation_step: sample.simulation_step,
        simulation_time_seconds: sample.simulation_time_seconds,
        animation_position: animationNode?.current_animation_position ?? null,
        animation_playing: animationNode?.is_playing ?? null,
        bone_count: skeletonNode?.bone_count ?? null,
        first_bone_global_pose: skeletonNode?.bones?.[0]?.global_pose ?? null,
        first_bone_world_pose: skeletonNode?.bones?.[0]?.derived_world_pose ?? null,
      }
    })
    const animationPositions = timelineSamples.map((sample) => sample.animation_position)
    assert.ok(animationPositions.every((value) => Number.isFinite(value)))
    assert.ok(animationPositions[animationPositions.length - 1] > animationPositions[0])

    report.capabilities = {
      scene_tree: {
        source: 'verified runtime: HarnessSession.inspectState() -> bridge scene_tree',
        node_count: countTree(tree),
        max_depth: maxTreeDepth(tree),
        root: tree.name,
        root_class: tree.class,
      },
      property: {
        source: 'verified runtime: bridge property command over get_property_list/get',
        main_name: mainProperty,
        animation_current_animation: animationProperty,
      },
      structured_observe: {
        source: 'verified runtime: bridge observe command',
        targets: TARGETS,
        skeleton: {
          path: skeleton.path,
          bone_count: skeleton.bone_count,
          source: skeleton.source,
          first_bone: skeleton.bones[0],
        },
        humanoid: {
          mesh_instance_count: humanoidNodes.filter((node) => node.class === 'MeshInstance3D').length,
          skeleton_count: humanoidNodes.filter((node) => node.class === 'Skeleton3D').length,
          animation_player_count: humanoidNodes.filter((node) => node.class === 'AnimationPlayer').length,
        },
      },
      timeline: {
        source: 'verified runtime: observeTimeline with real advance_physics',
        frames: timeline.frames,
        every_frames: timeline.every_frames,
        sample_count: timeline.sample_count,
        samples: timelineSamples,
        timing: timeline.timing,
      },
      capture: {
        source: 'Phase 10 captureFrame/captureSequence plus Phase 11 Stage B windowed evidence',
        headless_available: false,
        windowed_note: 'Godot headless has a dummy renderer; screenshot requires a window.',
      },
      physics_and_collision: {
        source: 'Phase 10 observation fixture and Stage C combat fixture; native API presence checked by ClassDB',
        observed_nodes: ['CharacterBody3D', 'StaticBody3D', 'Area3D', 'RigidBody3D', 'CollisionShape3D'],
      },
      animation_tree: {
        source: 'ClassDB only; no AnimationTree in the existing fixtures and no bridge state path',
        native_class_exists: true,
        harness_exposed: false,
      },
      debug_overlay: {
        source: 'ClassDB only; SceneTree.debug_collisions_hint exists, bridge has no setter',
        native_property: 'SceneTree.debug_collisions_hint',
        harness_exposed: false,
      },
      native_input: {
        source: 'ClassDB only; harness uses fixture-defined harness_input, not Input event injection',
        native_method: 'Input.parse_input_event',
        harness_event_history: false,
      },
      movie_writer: {
        source: 'ClassDB only; not used by the harness',
        native_class_exists: true,
        harness_recording: 'sampled PNG frames only, with optional offline encoding',
      },
    }

    report.tests = compactTest(await runTests({
      project: PROJECT,
      script: 'res://tests/run_character_audit.gd',
      timeoutMs: 30000,
    }))
    assert.equal(report.tests.ok, true)
    report.runtime_evidence = writeJson('stage-a-runtime.json', {
      run_id: runId,
      godot: report.godot,
      report,
    })
    report.ok = true
    report.finished_at = new Date().toISOString()
    console.log(JSON.stringify({
      ok: report.ok,
      run_id: runId,
      scene_nodes: report.capabilities.scene_tree.node_count,
      skeleton_bones: report.capabilities.structured_observe.skeleton.bone_count,
      timeline_samples: report.capabilities.timeline.sample_count,
      tests: report.tests.summary,
      evidence: report.runtime_evidence,
    }, null, 2))
    writeJson('stage-a-audit.json', report)
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
    report.finished_at = new Date().toISOString()
    writeJson('stage-a-audit.json', report)
    throw error
  } finally {
    report.stop = await session.stop()
    const target = path.join(EVIDENCE, 'stage-a-audit.json')
    if (fs.existsSync(target)) {
      const current = JSON.parse(fs.readFileSync(target, 'utf8'))
      current.stop = report.stop
      current.finished_at = new Date().toISOString()
      fs.writeFileSync(target, `${JSON.stringify(current, null, 2)}\n`)
    }
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})

