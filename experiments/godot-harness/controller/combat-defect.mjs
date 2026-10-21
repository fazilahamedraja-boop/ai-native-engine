import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT, HarnessSession, runTests } from './harness.mjs'

const SOURCE_PROJECT = 'fixtures/combat'
const SOURCE_DIR = path.resolve(HARNESS_ROOT, SOURCE_PROJECT)
const EVIDENCE = path.resolve(HARNESS_ROOT, '..', '..', 'docs', 'phase11', 'stage-c')
const DEFECT_LINE = 'const HITBOX_CENTER_LOCAL := Vector3(0.0, 0.0, 0.60)'
const DEFECT_VALUE = 'const HITBOX_CENTER_LOCAL := Vector3(0.0, 0.0, 0.18)'
const ATTACK_INPUT = {
  forward: 0,
  strafe: 0,
  jump: false,
  restart: false,
  actions: { attack: true },
}
const TARGETS = [
  '/root/Main',
  '/root/Main/Player',
  '/root/Main/Player/Humanoid',
  '/root/Main/Player/Humanoid/character_root/hand_r/WeaponPivot',
  '/root/Main/Player/Humanoid/character_root/hand_r/WeaponPivot/WeaponHitbox',
  '/root/Main/Target',
  '/root/Main/Ground',
]

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`)
}

function copyCapture(capture, target) {
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(capture.screenshot.absolute_path, target)
  const hash = sha256(target)
  assert.equal(hash, capture.screenshot.sha256)
  return {
    path: path.relative(EVIDENCE, target).split(path.sep).join('/'),
    bytes: fs.statSync(target).size,
    sha256: hash,
    tick: capture.tick,
    simulation_step: capture.simulation_step,
    state: {
      target_health: capture.state_before?.combat?.target_health ?? null,
      hits: capture.state_before?.combat?.hits ?? null,
      attacks: capture.state_before?.combat?.attacks ?? null,
      attack_state: capture.state_before?.combat?.attack_state ?? null,
      hitbox_center_local: capture.state_before?.weapon?.hitbox_center_local ?? null,
      hitbox_center_world: capture.state_before?.weapon?.hitbox_center_world ?? null,
      blade_center_world: capture.state_before?.weapon?.blade_center_world ?? null,
      target_in_hitbox: capture.state_before?.weapon?.target_in_hitbox ?? null,
    },
  }
}

function mutateConstant(file, expected, replacement) {
  const source = fs.readFileSync(file, 'utf8')
  const count = source.split(expected).length - 1
  assert.equal(count, 1, `expected exactly one occurrence of ${expected}`)
  fs.writeFileSync(file, source.replace(expected, replacement))
}

async function runScenario(project, label) {
  const outDir = path.join(EVIDENCE, label)
  const manifest = {
    operation: 'phase11_stage_c_scenario',
    label,
    ok: false,
    project,
    started_at: new Date().toISOString(),
    finished_at: null,
    headless_test: null,
    captures: {},
    sequence: null,
    final_snapshot: null,
    observations: null,
    stop: null,
    error: null,
  }
  const session = new HarnessSession({ project, headless: false })
  try {
    const started = await session.startProject()
    assert.equal(started.ok, true)
    manifest.godot = started.ping.godot
    await session.pause()
    await session.reset()
    const initial = await session.captureFrame({
      path: `res://artifacts/${label}-initial.png`,
      scenario: `${label}: initial combat state before attack`,
      runId: `stage-c-${label}`,
      metadata: { stage: 'phase11-c', label, checkpoint: 'initial' },
    })
    manifest.captures.initial = copyCapture(initial, path.join(outDir, 'initial.png'))
    const sequence = await session.captureSequence({
      scenario: `${label}: attack swing sampled every 3 fixed ticks`,
      prefix: `${label}-attack`,
      frameCount: 7,
      everyFrames: 3,
      input: ATTACK_INPUT,
      runId: `stage-c-${label}`,
      metadata: { stage: 'phase11-c', label, sequence: 'attack' },
    })
    manifest.sequence = {
      frame_count: sequence.frame_count,
      every_frames: sequence.every_frames,
      input: sequence.input,
      note: sequence.note,
      frames: sequence.frames.map((frame, index) => ({
        index,
        ...copyCapture(frame, path.join(outDir, `attack-${String(index).padStart(3, '0')}.png`)),
      })),
    }
    const final = await session.captureFrame({
      path: `res://artifacts/${label}-final.png`,
      scenario: `${label}: final combat state after attack`,
      runId: `stage-c-${label}`,
      metadata: { stage: 'phase11-c', label, checkpoint: 'final' },
    })
    manifest.captures.final = copyCapture(final, path.join(outDir, 'final.png'))
    const observation = await session.observe({
      targets: TARGETS,
      descendants: 2,
      sinceTick: 0,
    })
    manifest.observations = observation
    const snapshot = await session.snapshot()
    manifest.final_snapshot = snapshot
    writeJson(path.join(outDir, 'snapshot.json'), snapshot)
    writeJson(path.join(outDir, 'observation.json'), observation)
    manifest.ok = true
    return manifest
  } catch (error) {
    manifest.error = error instanceof Error ? error.message : String(error)
    throw error
  } finally {
    manifest.stop = await session.stop()
    manifest.finished_at = new Date().toISOString()
    writeJson(path.join(outDir, 'manifest.json'), manifest)
  }
}

async function main() {
  fs.mkdirSync(EVIDENCE, { recursive: true })
  const base = fs.mkdtempSync(path.join(HARNESS_ROOT, 'fixtures', '.stage-c-'))
  const projectDir = path.join(base, 'project')
  fs.cpSync(SOURCE_DIR, projectDir, { recursive: true })
  const project = path.relative(HARNESS_ROOT, projectDir).split(path.sep).join('/')
  const sourceHash = sha256(path.join(SOURCE_DIR, 'scripts', 'combat_world.gd'))
  const testHash = sha256(path.join(SOURCE_DIR, 'tests', 'run_combat.gd'))
  const before = {
    source_hash: sourceHash,
    test_hash: testHash,
    defect_line: DEFECT_LINE,
    defect_value: DEFECT_VALUE,
  }
  const report = {
    operation: 'phase11_stage_c_controlled_defect',
    ok: false,
    baseline_source_hash: sourceHash,
    identical_test_sha256: testHash,
    repair: {
      file: 'scripts/combat_world.gd',
      before: DEFECT_VALUE,
      after: DEFECT_LINE,
      reason: 'diagnosis from runtime evidence only',
    },
    before: null,
    after: null,
    tests: {},
    error: null,
  }
  try {
    mutateConstant(path.join(projectDir, 'scripts', 'combat_world.gd'), DEFECT_LINE, DEFECT_VALUE)
    const defectiveSourceHash = sha256(path.join(projectDir, 'scripts', 'combat_world.gd'))
    const beforeTest = await runTests({
      project,
      script: 'res://tests/run_combat.gd',
      timeoutMs: 30000,
    })
    writeJson(path.join(EVIDENCE, 'before', 'test.json'), beforeTest)
    report.before = await runScenario(project, 'before')
    report.before.defective_source_hash = defectiveSourceHash
    report.before.headless_test = beforeTest
    report.tests.before = beforeTest.summary

    mutateConstant(path.join(projectDir, 'scripts', 'combat_world.gd'), DEFECT_VALUE, DEFECT_LINE)
    const repairedSourceHash = sha256(path.join(projectDir, 'scripts', 'combat_world.gd'))
    const afterTest = await runTests({
      project,
      script: 'res://tests/run_combat.gd',
      timeoutMs: 30000,
    })
    writeJson(path.join(EVIDENCE, 'after', 'test.json'), afterTest)
    report.after = await runScenario(project, 'after')
    report.after.repaired_source_hash = repairedSourceHash
    report.after.headless_test = afterTest
    report.tests.after = afterTest.summary
    fs.writeFileSync(
      path.join(EVIDENCE, 'repair.diff'),
      [
        '--- a/experiments/godot-harness/fixtures/combat/scripts/combat_world.gd',
        '+++ b/experiments/godot-harness/fixtures/combat/scripts/combat_world.gd',
        '@@',
        `-${DEFECT_VALUE}`,
        `+${DEFECT_LINE}`,
        '',
      ].join('\n'),
    )
    writeJson(path.join(EVIDENCE, 'stage-c-report.json'), report)
    console.log(JSON.stringify({
      ok: true,
      before: report.tests.before,
      after: report.tests.after,
      before_hits: report.before.final_snapshot.combat.hits,
      after_hits: report.after.final_snapshot.combat.hits,
      before_health: report.before.final_snapshot.combat.target_health,
      after_health: report.after.final_snapshot.combat.target_health,
      before_hitbox_local: report.before.final_snapshot.weapon.hitbox_center_local,
      after_hitbox_local: report.after.final_snapshot.weapon.hitbox_center_local,
      same_test_sha256: report.identical_test_sha256,
      evidence_dir: EVIDENCE,
    }, null, 2))
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
