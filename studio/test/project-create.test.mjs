import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { createApp } from '../server/index.mjs'
import { JobStore } from '../server/lib/jobs.mjs'
import { createOperations } from '../server/lib/operations.mjs'
import { createProjectRegistry } from '../server/lib/projects.mjs'
import { StudioError } from '../server/lib/studio-paths.mjs'
import { tempRoot, writeFile } from './helpers.mjs'

/**
 * Project creation is tested against a temporary harness root and a temporary
 * projects root, so the suite never writes into the real Studio data directory
 * or the canonical Phase 8–19 projects.
 */

function makeTemplate(harnessRoot) {
  const voxel = path.join(harnessRoot, 'voxel')
  writeFile(path.join(voxel, 'project.godot'), 'config_version=5\n\n[application]\nconfig/name="Voxel"\n')
  writeFile(path.join(voxel, 'export_presets.cfg'), 'name="Windows Desktop"\nplatform="Windows Desktop"\n')
  writeFile(path.join(voxel, 'main.tscn'), '[gd_scene format=3]\n')
  writeFile(path.join(voxel, 'scripts', 'voxel_data.gd'), 'extends RefCounted\n\nfunc value():\n\treturn 1\n')
  writeFile(path.join(voxel, 'tests', 'run_voxel_tests.gd'), 'extends SceneTree\n')
  writeFile(path.join(voxel, 'tests', 'run_voxel_data_tests.gd'), 'extends SceneTree\n')
  // Both of these must never be copied into a new project: the import cache is
  // machine-specific and captures belong to the source project.
  writeFile(path.join(voxel, '.godot', 'imported', 'stale.txt'), 'cache')
  writeFile(path.join(voxel, 'artifacts', 'capture.png'), 'not a real png')
  // A stale manifest in the template must not leak into created projects.
  writeFile(path.join(voxel, 'project.manifest.json'), '{"id":"voxel"}')
  return voxel
}

function setup({
  maxProjects,
  initializeProject = async () => ({
    ok: true,
    code: 0,
    message: 'fixture import',
    durationMs: 1,
  }),
} = {}) {
  const harnessRoot = tempRoot('studio-template-')
  const projectsRoot = tempRoot('studio-created-')
  makeTemplate(harnessRoot)
  const registry = createProjectRegistry({
    harnessRoot,
    projectsRoot,
    maxProjects,
    initializeProject,
  })
  return { harnessRoot, projectsRoot, registry }
}

function treeDigest(root) {
  const hash = crypto.createHash('sha256')
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name)
      hash.update(path.relative(root, absolute).split(path.sep).join('/'))
      if (entry.isDirectory()) walk(absolute)
      else hash.update(fs.readFileSync(absolute))
    }
  }
  walk(root)
  return hash.digest('hex')
}

function filesOf(root) {
  const files = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(absolute)
      else files.push(path.relative(root, absolute).split(path.sep).join('/'))
    }
  }
  walk(root)
  return files.sort()
}

test('create: writes a real project tree and manifest, and never copies the import cache', async () => {
  const { projectsRoot, registry } = setup()
  const project = await registry.create({
    name: 'Ice World',
    templateId: 'voxel-sandbox',
    description: 'A cold survival sandbox.',
  })

  assert.equal(project.id, 'ice-world')
  assert.equal(project.name, 'Ice World')
  assert.equal(project.created, true)
  assert.equal(project.builtIn, false)
  assert.equal(project.templateId, 'voxel-sandbox')
  assert.equal(project.templateName, 'Voxel Sandbox')
  assert.match(project.createdAt, /^\d{4}-\d{2}-\d{2}T/)

  const dir = path.join(projectsRoot, 'ice-world')
  assert.equal(registry.rootOf(project), dir)
  assert.equal(fs.existsSync(dir), true)

  const files = filesOf(dir)
  assert.deepEqual(files, [
    'PROJECT.md',
    'export_presets.cfg',
    'main.tscn',
    'project.godot',
    'project.manifest.json',
    'scripts/voxel_data.gd',
    'tests/run_voxel_data_tests.gd',
    'tests/run_voxel_tests.gd',
  ])
  assert.equal(files.some((file) => file.startsWith('.godot/')), false)
  assert.equal(files.some((file) => file.startsWith('artifacts/')), false)

  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'project.manifest.json'), 'utf8'))
  assert.equal(manifest.schema, 'studio.project.v1')
  assert.equal(manifest.id, 'ice-world')
  assert.equal(manifest.name, 'Ice World')
  assert.equal(manifest.template, 'voxel-sandbox')
  assert.equal(manifest.description, 'A cold survival sandbox.')
  assert.equal(manifest.createdAt, project.createdAt)
  assert.equal(manifest.status, 'ready')
  assert.equal(manifest.initialization.ok, true)
  assert.match(manifest.initializedAt, /^\d{4}-\d{2}-\d{2}T/)

  // The copy is initialised for real (the stub stands in for Godot in tests).
  assert.equal(project.manifestStatus, 'ready')
  assert.equal(project.initialization.message, 'fixture import')
  assert.match(fs.readFileSync(path.join(dir, 'PROJECT.md'), 'utf8'), /# Ice World/)
  // The copied project carries its own name, not the template's.
  assert.match(fs.readFileSync(path.join(dir, 'project.godot'), 'utf8'), /config\/name="Ice World"/)
  assert.doesNotMatch(
    fs.readFileSync(path.join(dir, 'project.godot'), 'utf8'),
    /config\/name="Voxel"/,
  )
  // No staging directory is left behind.
  assert.deepEqual(
    fs.readdirSync(projectsRoot).filter((entry) => entry.startsWith('.creating-')),
    [],
  )
})

test('create: a created project survives a restart and keeps its template policy', async () => {
  const { projectsRoot, harnessRoot } = setup()
  const initializeProject = async () => ({ ok: true, message: 'fixture import' })
  await createProjectRegistry({ harnessRoot, projectsRoot, initializeProject }).create({
    name: 'Survival Build',
    templateId: 'voxel-sandbox',
  })

  const restarted = createProjectRegistry({ harnessRoot, projectsRoot, initializeProject })
  const ids = restarted.list().map((project) => project.id)
  assert.deepEqual(ids, ['voxel-sandbox', 'deflect-arena', 'survival-build'])

  const project = restarted.get('survival-build')
  assert.equal(project.name, 'Survival Build')
  assert.deepEqual(project.agent.allowedFiles, ['scripts/voxel_data.gd'])
  assert.equal(project.agent.enabled, true)
  assert.deepEqual(project.runModes, ['native'])
  assert.equal(project.browser, null)
  assert.deepEqual(
    project.tests.map((suite) => suite.id),
    ['voxel-public'],
  )
  assert.equal(project.hiddenTest.relative, 'tests/run_voxel_data_tests.gd')

  const status = restarted.status(project)
  assert.equal(status.status.exists, true)
  assert.equal(status.status.ready, false, 'a fresh project has no import cache yet')
  assert.equal(
    status.path,
    path.join(projectsRoot, 'survival-build').split(path.sep).join('/'),
  )
  assert.equal(status.templateName, 'Voxel Sandbox')

  fs.mkdirSync(path.join(projectsRoot, 'survival-build', '.godot'), { recursive: true })
  fs.writeFileSync(
    path.join(projectsRoot, 'survival-build', '.godot', 'global_script_class_cache.cfg'),
    '[]',
    'utf8',
  )
  assert.equal(restarted.status(project).status.ready, true)
})

test('create: a failed template import is recorded instead of hidden', async () => {
  const seen = []
  const { projectsRoot, registry } = setup({
    initializeProject: async (dir) => {
      seen.push(dir)
      return { ok: false, message: 'Godot import failed (exit 1)', durationMs: 5 }
    },
  })
  const project = await registry.create({ name: 'Broken Import', templateId: 'voxel-sandbox' })

  assert.equal(seen.length, 1)
  assert.equal(path.basename(seen[0]), 'broken-import')
  assert.equal(seen[0], path.join(projectsRoot, 'broken-import'))
  assert.equal(project.manifestStatus, 'needs_import')
  assert.equal(project.initialization.ok, false)
  assert.equal(project.initialization.message, 'Godot import failed (exit 1)')
  // The project is kept, listed and openable so the failure can be diagnosed.
  assert.equal(registry.get('broken-import').id, 'broken-import')
  assert.ok(registry.list().some((entry) => entry.id === 'broken-import'))
  const status = registry.status(project)
  assert.equal(status.status.ready, false)
  assert.equal(status.manifestStatus, 'needs_import')
})

test('create: the source template is never modified', async () => {
  const { harnessRoot, registry } = setup()
  const before = treeDigest(path.join(harnessRoot, 'voxel'))
  await registry.create({ name: 'Untouched Source', templateId: 'voxel-sandbox' })
  await registry.create({ name: 'Untouched Source Two', templateId: 'voxel-sandbox' })
  assert.equal(treeDigest(path.join(harnessRoot, 'voxel')), before)
})

test('create: duplicate names are rejected regardless of case or spacing', async () => {
  const { projectsRoot, registry } = setup()
  await registry.create({ name: 'Stone Age', templateId: 'voxel-sandbox' })

  for (const name of ['Stone Age', 'stone age', 'STONE AGE', 'Stone   Age', 'Voxel Sandbox']) {
    await assert.rejects(
      () => registry.create({ name, templateId: 'voxel-sandbox' }),
      (error) => error instanceof StudioError && error.code === 'project_exists' && error.status === 409,
      name,
    )
  }
  assert.deepEqual(
    fs.readdirSync(projectsRoot).sort(),
    ['stone-age'],
    'a rejected duplicate must not create a second directory',
  )
})

test('create: unsafe and invalid names are rejected before anything is written', async () => {
  const { projectsRoot, registry } = setup()
  const invalid = [
    '',
    'a',
    '   ',
    '..',
    '../escape',
    '..\\escape',
    'folder/name',
    'folder\\name',
    'C:\\Windows',
    'CON',
    'nul',
    '-leading',
    '.hidden',
    'double..dot',
    'bad\u0000name',
    'x'.repeat(49),
    '!!!',
  ]
  for (const name of invalid) {
    await assert.rejects(
      () => registry.create({ name, templateId: 'voxel-sandbox' }),
      (error) =>
        error instanceof StudioError &&
        ['invalid_project_name', 'project_exists'].includes(error.code),
      JSON.stringify(name),
    )
  }
  // No traversal or control-character name escaped the root, and nothing was
  // created for the rejected names.
  assert.deepEqual(fs.readdirSync(projectsRoot), [])
  assert.equal(fs.existsSync(path.join(path.dirname(projectsRoot), 'escape')), false)
})

test('create: unsupported templates and over-long descriptions are refused', async () => {
  const { registry } = setup()
  await assert.rejects(
    () => registry.create({ name: 'Racing Game', templateId: 'racing' }),
    (error) => error instanceof StudioError && error.code === 'invalid_template',
  )
  await assert.rejects(
    () => registry.create({ name: 'Long Text', templateId: 'voxel-sandbox', description: 'x'.repeat(601) }),
    (error) => error instanceof StudioError && error.code === 'invalid_description',
  )
  assert.deepEqual(registry.templates().map((template) => template.id), ['voxel-sandbox', 'arena'])
})

test('create: a configured limit stops runaway creation', async () => {
  const { registry } = setup({ maxProjects: 1 })
  await registry.create({ name: 'First Project', templateId: 'voxel-sandbox' })
  await assert.rejects(
    () => registry.create({ name: 'Second Project', templateId: 'voxel-sandbox' }),
    (error) => error instanceof StudioError && error.code === 'project_limit',
  )
})

test('create: a corrupted project is reported, not silently listed', () => {
  const { projectsRoot, registry } = setup()
  writeFile(path.join(projectsRoot, 'broken-project', 'project.manifest.json'), '{not json')
  writeFile(path.join(projectsRoot, 'broken-project', 'PROJECT.md'), '# Broken\n')

  assert.throws(
    () => registry.get('broken-project'),
    (error) => error instanceof StudioError && error.code === 'corrupted_project',
  )
  const ids = registry.list().map((project) => project.id)
  assert.equal(ids.includes('broken-project'), false)
})

test('create: a created project resolves through operations', async () => {
  const { harnessRoot, projectsRoot, registry } = setup()
  const created = await registry.create({ name: 'Ops Target', templateId: 'voxel-sandbox' })

  const operations = createOperations({
    root: tempRoot('studio-created-ops-'),
    deps: {
      getProjectImpl: (projectId) => registry.get(projectId),
      projectRootImpl: (project) => registry.rootOf(project),
    },
  })

  const preview = await operations.preview(created.id)
  assert.equal(preview.projectId, 'ops-target')
  assert.equal(preview.native.running, false)
  assert.equal(preview.browser.configured, false)
  assert.deepEqual(preview.controls, registry.get('voxel-sandbox').controls)
  await assert.rejects(
    () => operations.run('../escape', 'check', {}),
    (error) => error instanceof StudioError && error.code === 'invalid_project',
  )

  // The built-in projects still resolve through the same injected registry.
  assert.equal(registry.get('voxel-sandbox').id, 'voxel-sandbox')
  assert.equal(fs.existsSync(path.join(harnessRoot, 'voxel', 'project.godot')), true)
  assert.equal(fs.existsSync(path.join(projectsRoot, 'ops-target', 'project.godot')), true)
})

/* ------------------------------------------------------------------ */
/* HTTP routes                                                         */
/* ------------------------------------------------------------------ */

const EVIDENCE_STUB = {
  meta: () => ({ runCount: 0, readOnly: true }),
  listRuns: () => [],
  getRun: () => null,
  readText: () => ({ lines: [] }),
  getArtifact: () => {
    throw new Error('no artifacts in the stub')
  },
}

function request({ port, method = 'GET', path: requestPath = '/', headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: requestPath, headers }, (response) => {
      const chunks = []
      response.on('data', (chunk) => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(text)
        } catch {
          json = null
        }
        resolve({ status: response.statusCode, headers: response.headers, body: text, json })
      })
    })
    req.on('error', reject)
    if (body) req.write(body)
    req.end()
  })
}

function postJson(port, requestPath, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  return request({
    port,
    method: 'POST',
    path: requestPath,
    headers: { 'content-type': 'application/json', 'content-length': body.length },
    body,
  })
}

async function withApp(fn) {
  const { harnessRoot, projectsRoot, registry } = setup()
  const jobStore = new JobStore({ root: tempRoot('studio-created-jobs-') })
  const server = http.createServer(createApp({ store: EVIDENCE_STUB, jobStore, registry }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  try {
    return await fn({ port, registry, projectsRoot, harnessRoot })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('http: templates are served and only implemented ones are offered', async () => {
  await withApp(async ({ port }) => {
    const response = await request({ port, path: '/api/studio/templates' })
    assert.equal(response.status, 200)
    assert.deepEqual(
      response.json.templates.map((template) => template.id),
      ['voxel-sandbox', 'arena'],
    )
    assert.equal(response.json.templates[0].implemented, true)
    assert.equal(response.json.templates[1].implemented, true)
    assert.equal(response.json.templates[1].agentEnabled, true)

    const meta = await request({ port, path: '/api/studio/meta' })
    assert.deepEqual(
      meta.json.templates.map((template) => template.id),
      ['voxel-sandbox', 'arena'],
    )
  })
})

test('http: POST creates, lists, serves and previews a new project', async () => {
  await withApp(async ({ port, projectsRoot }) => {
    const created = await postJson(port, '/api/studio/projects', {
      name: 'Copper Canyon',
      templateId: 'voxel-sandbox',
      description: 'A desert mining map.',
    })
    assert.equal(created.status, 201)
    assert.equal(created.json.project.id, 'copper-canyon')
    assert.equal(created.json.project.created, true)
    assert.equal(created.json.project.templateName, 'Voxel Sandbox')
    assert.equal(created.json.project.manifestStatus, 'ready')
    assert.equal(created.json.project.initialization.ok, true)
    assert.equal(fs.existsSync(path.join(projectsRoot, 'copper-canyon', 'project.manifest.json')), true)

    const list = await request({ port, path: '/api/studio/projects' })
    assert.equal(list.status, 200)
    assert.deepEqual(
      list.json.projects.map((project) => project.id),
      ['voxel-sandbox', 'deflect-arena', 'copper-canyon'],
    )
    const card = list.json.projects.find((project) => project.id === 'copper-canyon')
    assert.equal(card.created, true)
    assert.equal(card.status.ready, false)
    assert.deepEqual(card.jobs, [])

    const detail = await request({ port, path: '/api/studio/projects/copper-canyon' })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.project.name, 'Copper Canyon')
    assert.deepEqual(detail.json.project.tests.map((suite) => suite.id), ['voxel-public'])

    const preview = await request({ port, path: '/api/studio/projects/copper-canyon/preview' })
    assert.equal(preview.status, 200)
    assert.equal(preview.json.projectId, 'copper-canyon')
    assert.equal(preview.json.native.running, false)
    assert.equal(preview.json.browser.configured, false)

    const duplicate = await postJson(port, '/api/studio/projects', {
      name: 'copper canyon',
      templateId: 'voxel-sandbox',
    })
    assert.equal(duplicate.status, 409)
    assert.equal(duplicate.json.error.code, 'project_exists')

    const invalid = await postJson(port, '/api/studio/projects', {
      name: '../escape',
      templateId: 'voxel-sandbox',
    })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error.code, 'invalid_project_name')

    const unknownTemplate = await postJson(port, '/api/studio/projects', {
      name: 'Racer',
      templateId: 'racing',
    })
    assert.equal(unknownTemplate.status, 400)
    assert.equal(unknownTemplate.json.error.code, 'invalid_template')

    const extraField = await postJson(port, '/api/studio/projects', {
      name: 'Sneaky',
      templateId: 'voxel-sandbox',
      path: 'C:\\Windows',
    })
    assert.equal(extraField.status, 400)
    assert.equal(extraField.json.error.code, 'unknown_field')

    const wrongMethod = await request({ port, method: 'DELETE', path: '/api/studio/projects' })
    assert.equal(wrongMethod.status, 405)
  })
})

test('http: created projects are independent of the built-in projects', async () => {
  await withApp(async ({ port, harnessRoot, projectsRoot }) => {
    const before = treeDigest(path.join(harnessRoot, 'voxel'))
    const created = await postJson(port, '/api/studio/projects', {
      name: 'Isolated Copy',
      templateId: 'voxel-sandbox',
    })
    assert.equal(created.status, 201)
    assert.equal(treeDigest(path.join(harnessRoot, 'voxel')), before)

    const createdRoot = path.join(projectsRoot, 'isolated-copy')
    assert.equal(path.relative(harnessRoot, createdRoot).startsWith('..'), true)

    // A created name cannot shadow a built-in id.
    const shadow = await postJson(port, '/api/studio/projects', {
      name: 'voxel sandbox',
      templateId: 'voxel-sandbox',
    })
    assert.equal(shadow.status, 409)
    assert.equal(shadow.json.error.code, 'project_exists')
  })
})

/* ------------------------------------------------------------------ */
/* Build Game with AI                                                  */
/* ------------------------------------------------------------------ */

const DEMO_PROMPT =
  'Create a small 3D arena action game. Add a controllable player, a visible enemy, player attacks, enemy health, player health, and a win or loss condition. Make the arena visually readable and ensure the controls are explained on screen.'

async function withBuildApp(fn) {
  const { harnessRoot, projectsRoot, registry } = setup()
  const jobStore = new JobStore({ root: tempRoot('studio-build-jobs-') })
  const operations = createOperations({
    root: tempRoot('studio-build-ops-'),
    deps: {
      getProjectImpl: (projectId) => registry.get(projectId),
      projectRootImpl: (project) => registry.rootOf(project),
    },
  })
  // The route only needs the runner to accept and return the job; the agent
  // pipeline itself is covered by runner.test.mjs.
  const started = []
  const runner = {
    start: async (jobId) => {
      started.push(jobId)
      return jobStore.load(jobId)
    },
  }
  const studio = { store: jobStore, registry, operations, runner, startedAt: new Date().toISOString() }
  const server = http.createServer(createApp({ store: EVIDENCE_STUB, studio }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  try {
    return await fn({ port, registry, projectsRoot, harnessRoot, jobStore, started })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

test('http: build-game creates an arena project and a build job from a prompt', async () => {
  await withBuildApp(async ({ port, projectsRoot, jobStore, started }) => {
    const response = await postJson(port, '/api/studio/build-game', {
      name: 'Arena Demo',
      prompt: DEMO_PROMPT,
    })
    assert.equal(response.status, 202)
    const { project, job } = response.json
    assert.equal(project.id, 'arena-demo')
    assert.equal(project.templateId, 'arena')
    assert.equal(project.templateName, '3D Arena Action')
    assert.equal(project.created, true)
    assert.equal(project.manifestStatus, 'ready')
    assert.equal(project.agent.enabled, true)
    assert.equal(project.agent.defaultModel, 'opencode/deepseek-v4.1-flash-free')

    // The copied tree is the real template, not an empty directory.
    const dir = path.join(projectsRoot, 'arena-demo')
    for (const relative of [
      'project.godot',
      'scenes/main.tscn',
      'scripts/main.gd',
      'scripts/arena_host.gd',
      'harness/bridge.gd',
      'tests/run_arena_tests.gd',
      'ARENA_SPEC.md',
      'PROJECT.md',
      'project.manifest.json',
    ]) {
      assert.equal(fs.existsSync(path.join(dir, relative)), true, relative)
    }
    assert.match(fs.readFileSync(path.join(dir, 'ARENA_SPEC.md'), 'utf8'), /Arena game contract/)

    assert.equal(job.kind, 'build')
    assert.equal(job.projectId, 'arena-demo')
    assert.equal(job.task, DEMO_PROMPT)
    assert.equal(job.model, 'opencode/deepseek-v4.1-flash-free')
    assert.equal(job.status, 'queued')
    assert.deepEqual(started, [job.id])

    // The job is real: it is in the store and served by the jobs API.
    assert.ok(jobStore.load(job.id))
    const jobs = await request({ port, path: '/api/studio/jobs?projectId=arena-demo' })
    assert.equal(jobs.status, 200)
    assert.deepEqual(jobs.json.jobs.map((entry) => entry.id), [job.id])
    assert.equal(jobs.json.jobs[0].kind, 'build')

    const projects = await request({ port, path: '/api/studio/projects' })
    const card = projects.json.projects.find((entry) => entry.id === 'arena-demo')
    assert.equal(card.templateId, 'arena')
    assert.equal(card.jobs.length, 1)
    assert.equal(card.tests[0].id, 'arena-acceptance')
  })
})

test('http: build-game refuses a short prompt, unknown fields and an unknown template', async () => {
  await withBuildApp(async ({ port }) => {
    const short = await postJson(port, '/api/studio/build-game', { name: 'Too Short', prompt: 'make it' })
    assert.equal(short.status, 400)
    assert.equal(short.json.error.code, 'invalid_prompt')

    const extra = await postJson(port, '/api/studio/build-game', {
      name: 'Extra Field',
      prompt: DEMO_PROMPT,
      // A caller must not be able to point the copy at a path of its choosing.
      sourcePath: 'C:\\Windows',
    })
    assert.equal(extra.status, 400)
    assert.equal(extra.json.error.code, 'unknown_field')

    const unknown = await postJson(port, '/api/studio/build-game', {
      name: 'Unknown Template',
      prompt: DEMO_PROMPT,
      templateId: 'racing',
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.code, 'unknown_template')

    const wrongMethod = await request({ port, method: 'GET', path: '/api/studio/build-game' })
    assert.equal(wrongMethod.status, 405)
  })
})
