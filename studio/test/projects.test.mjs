import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  getProject,
  listRegisteredProjects,
  projectRoot,
  projectStatus,
} from '../server/lib/projects.mjs'
import { HARNESS_ROOT, StudioError } from '../server/lib/studio-paths.mjs'

test('registry: the voxel project is first and has a bounded agent policy', () => {
  const projects = listRegisteredProjects()
  assert.equal(projects[0].id, 'voxel-sandbox')
  assert.equal(projects[0].agent.enabled, true)
  assert.deepEqual(projects[0].agent.allowedFiles, ['scripts/voxel_data.gd'])
  assert.ok(projects[0].tests.length >= 1)
  assert.ok(projects[0].hiddenTest)
  // The voxel suite intentionally triggers one Godot diagnostic; that single
  // line is declared and anchored to the case that produces it.
  const voxelSuite = projects[0].tests.find((suite) => suite.id === 'voxel-public')
  assert.equal(voxelSuite.expectedDiagnostics.length, 1)
  assert.equal(voxelSuite.expectedDiagnostics[0].whenPassed, 'load-invalid-json-safe')
  assert.equal(voxelSuite.expectedDiagnostics[0].max, 1)
})

test('registry: Deflect Arena is registered but agent tasks are disabled with a reason', () => {
  const project = getProject('deflect-arena')
  assert.equal(project.agent.enabled, false)
  assert.deepEqual(project.agent.allowedFiles, [])
  assert.match(project.agent.note, /disabled|until a bounded editable-file policy/i)
  assert.ok(project.tests.some((suite) => suite.id === 'game-dodge'))
})

test('registry: invalid project ids are rejected without touching the filesystem', () => {
  for (const value of [
    'unknown-project',
    '../voxel',
    'voxel/../game',
    'C:\\voxel',
    '',
    null,
    42,
    'VOXEL',
  ]) {
    assert.throws(
      () => getProject(value),
      (error) => error instanceof StudioError && error.code === 'invalid_project',
      `expected ${JSON.stringify(value)} to be rejected`,
    )
  }
})

test('registry: built-in project roots stay inside the harness and are real directories', () => {
  for (const project of listRegisteredProjects().filter((entry) => entry.builtIn)) {
    const root = projectRoot(project)
    assert.equal(fs.existsSync(root), true, root)
    const relative = path.relative(HARNESS_ROOT, root)
    assert.equal(relative.startsWith('..'), false)
    assert.equal(path.isAbsolute(relative), false)
  }
})

test('project status reports real readiness, not a mock', () => {
  const project = getProject('voxel-sandbox')
  const status = projectStatus(project, {
    runtime: { running: false, pid: null, startedAt: null, headless: null },
    lastOps: [],
  })
  assert.equal(status.status.exists, true)
  assert.equal(status.status.ready, true)
  assert.equal(status.status.hasImportCache, true)
  assert.equal(status.status.hasExportPreset, true)
  assert.equal(status.path, 'experiments/godot-harness/voxel')
  assert.equal(status.agent.enabled, true)
  assert.equal(status.tests[0].last, null)
})
