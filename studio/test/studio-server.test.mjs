import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'

import { createApp, startServer } from '../server/index.mjs'
import { JobStore } from '../server/lib/jobs.mjs'
import { createProjectRegistry } from '../server/lib/projects.mjs'
import { ARTIFACT_ROOT } from '../server/lib/studio-paths.mjs'
import { tempRoot, writeFile } from './helpers.mjs'

const MODELS = [
  'opencode/deepseek-v4.1-flash-free',
  'opencode/glm-5.3-flash-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/flint-40b-free',
  'opencode/beam-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
]

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
    const req = http.request(
      { host: '127.0.0.1', port, method, path: requestPath, headers },
      (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          const text = buffer.toString('utf8')
          let json = null
          try {
            json = JSON.parse(text)
          } catch {
            json = null
          }
          resolve({ status: response.statusCode, headers: response.headers, body: text, json })
        })
      },
    )
    req.on('error', reject)
    if (body !== null) req.write(body)
    req.end()
  })
}

async function withApp(fn) {
  const jobStore = new JobStore({ root: tempRoot('studio-server-jobs-') })
  // Keep the HTTP suite independent of whatever the operator has created in
  // studio/.data/projects: this registry sees only the built-in projects.
  const registry = createProjectRegistry({
    projectsRoot: tempRoot('studio-server-projects-'),
  })
  const server = http.createServer(createApp({ store: EVIDENCE_STUB, jobStore, registry }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  try {
    return await fn({ port, jobStore })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

function postJson(port, requestPath, value, extraHeaders = {}) {
  const body = Buffer.from(JSON.stringify(value), 'utf8')
  return request({
    port,
    method: 'POST',
    path: requestPath,
    headers: { 'content-type': 'application/json', 'content-length': body.length, ...extraHeaders },
    body,
  })
}

function seedJob(jobStore, overrides = {}) {
  const job = jobStore.create({
    projectId: 'voxel-sandbox',
    projectName: 'Voxel Sandbox',
    task: 'A controlled fixture task that is long enough.',
    model: MODELS[0],
    limits: { maxAttempts: 1 },
    ...overrides,
  })
  return jobStore.update(job.id, {
    status: 'awaiting_approval',
    step: 'awaiting_approval',
    verification: { ok: true, steps: [] },
    workspaceHash: 'a'.repeat(64),
    candidateHash: 'a'.repeat(64),
    ...overrides.patch,
  })
}

test('studio server: static routes, studio shell and security headers', async () => {
  await withApp(async ({ port }) => {
    const studio = await request({ port, path: '/studio' })
    assert.equal(studio.status, 200)
    assert.match(studio.headers['content-type'], /^text\/html/)
    assert.match(studio.body, /studio\.js/)
    const csp = studio.headers['content-security-policy']
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:8790/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.equal(studio.headers['x-content-type-options'], 'nosniff')
    assert.equal(studio.headers['cache-control'], 'no-store')

    for (const [pathname, type] of [
      ['/', /^text\/html/],
      ['/studio.js', /^text\/javascript/],
      ['/studio.css', /^text\/css/],
    ]) {
      const response = await request({ port, path: pathname })
      assert.equal(response.status, 200, pathname)
      assert.match(response.headers['content-type'], type, pathname)
    }

    const missing = await request({ port, path: '/server/index.mjs' })
    assert.equal(missing.status, 404)
    assert.equal(missing.json.error.code, 'not_found')

    const post = await request({ port, method: 'POST', path: '/' })
    assert.equal(post.status, 405)
  })
})

test('studio server: meta advertises projects, allowed models and limits', async () => {
  await withApp(async ({ port }) => {
    const response = await request({ port, path: '/api/studio/meta' })
    assert.equal(response.status, 200)
    const meta = response.json
    assert.equal(meta.schema, 'studio.meta.v1')
    assert.equal(meta.evidenceDashboard, '/')
    assert.deepEqual(meta.models, MODELS)
    assert.equal(meta.projects[0].id, 'voxel-sandbox')
    assert.equal(meta.projects[0].agentEnabled, true)
    assert.equal(meta.projects[1].id, 'deflect-arena')
    assert.equal(meta.projects[1].agentEnabled, false)
    assert.equal(meta.limits.maxBodyBytes, 64 * 1024)
    assert.equal(meta.limits.maxArtifactBytes, 24 * 1024 * 1024)
  })
})

test('studio server: project views come from the registry, not hard-coded UI data', async () => {
  await withApp(async ({ port }) => {
    const list = await request({ port, path: '/api/studio/projects' })
    assert.equal(list.status, 200)
    const projects = list.json.projects
    assert.equal(projects.length, 2)
    assert.equal(projects[0].id, 'voxel-sandbox')
    assert.equal(projects[0].path, 'experiments/godot-harness/voxel')
    assert.deepEqual(projects[0].runModes, ['native', 'browser'])
    assert.equal(projects[0].status.exists, true)
    assert.equal(projects[0].agent.enabled, true)
    assert.deepEqual(projects[0].agent.allowedFiles, ['scripts/voxel_data.gd'])
    assert.equal(projects[0].tests[0].id, 'voxel-public')

    assert.equal(projects[1].id, 'deflect-arena')
    assert.equal(projects[1].path, 'experiments/godot-harness/game')
    assert.equal(projects[1].agent.enabled, false)
    assert.ok(projects[1].tests.some((suite) => suite.id === 'game-dodge'))

    const detail = await request({ port, path: '/api/studio/projects/voxel-sandbox' })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.project.id, 'voxel-sandbox')
    assert.ok(Array.isArray(detail.json.project.jobs))

    for (const [pathname, status] of [
      ['/api/studio/projects/nope', 404],
      ['/api/studio/projects/../voxel', 404],
      ['/api/studio/projects/VOXEL-SANDBOX', 404],
    ]) {
      const response = await request({ port, path: pathname })
      assert.equal(response.status, status, pathname)
    }
  })
})

test('studio server: job creation validates content type, fields, task, model and agent policy', async () => {
  await withApp(async ({ port }) => {
    const noType = await request({
      port,
      method: 'POST',
      path: '/api/studio/jobs',
      headers: { 'content-length': 2 },
      body: '{}',
    })
    assert.equal(noType.status, 415)
    assert.equal(noType.json.error.code, 'invalid_content_type')

    const unknown = await postJson(port, '/api/studio/jobs', {
      projectId: 'voxel-sandbox',
      task: 'A task description long enough to pass validation.',
      command: 'rm -rf /',
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.code, 'unknown_field')

    const short = await postJson(port, '/api/studio/jobs', { projectId: 'voxel-sandbox', task: 'too short' })
    assert.equal(short.status, 400)
    assert.equal(short.json.error.code, 'invalid_task')

    const long = await postJson(port, '/api/studio/jobs', {
      projectId: 'voxel-sandbox',
      task: 'x'.repeat(4001),
    })
    assert.equal(long.status, 400)
    assert.equal(long.json.error.code, 'invalid_task')

    const badModel = await postJson(port, '/api/studio/jobs', {
      projectId: 'voxel-sandbox',
      task: 'A task description long enough to pass validation.',
      model: 'shell/rm',
    })
    assert.equal(badModel.status, 400)
    assert.equal(badModel.json.error.code, 'model_not_allowed')

    const malformedModel = await postJson(port, '/api/studio/jobs', {
      projectId: 'voxel-sandbox',
      task: 'A task description long enough to pass validation.',
      model: '../../etc/passwd',
    })
    assert.equal(malformedModel.status, 400)
    assert.equal(malformedModel.json.error.code, 'invalid_model')

    const disabled = await postJson(port, '/api/studio/jobs', {
      projectId: 'deflect-arena',
      task: 'A task description long enough to pass validation.',
    })
    assert.equal(disabled.status, 409)
    assert.equal(disabled.json.error.code, 'agent_disabled')
    assert.match(disabled.json.error.message, /bounded editable-file policy/)
  })
})

test('studio server: job listing, detail and events read persisted state', async () => {
  await withApp(async ({ port, jobStore }) => {
    const job = jobStore.create({
      projectId: 'voxel-sandbox',
      projectName: 'Voxel Sandbox',
      task: 'Read the persisted manifest and events.',
      model: MODELS[0],
      limits: { maxAttempts: 1 },
    })
    jobStore.appendEvent(job.id, { type: 'step.test', message: 'an event' })

    const list = await request({ port, path: '/api/studio/jobs?projectId=voxel-sandbox' })
    assert.equal(list.status, 200)
    assert.equal(list.json.jobs[0].id, job.id)
    assert.equal(list.json.jobs[0].corrupted, false)

    const detail = await request({ port, path: `/api/studio/jobs/${job.id}` })
    assert.equal(detail.status, 200)
    assert.equal(detail.json.job.id, job.id)
    assert.ok(detail.json.events.length >= 2)

    const events = await request({ port, path: `/api/studio/jobs/${job.id}/events?limit=1` })
    assert.equal(events.status, 200)
    assert.equal(events.json.events.length, 1)

    const invalid = await request({ port, path: '/api/studio/jobs/job-abc' })
    assert.equal(invalid.status, 400)
    assert.equal(invalid.json.error.code, 'invalid_job')

    const unknown = await request({ port, path: '/api/studio/jobs/job-20260101000000-abcdef12' })
    assert.equal(unknown.status, 404)

    const unknownSuffix = await request({ port, path: `/api/studio/jobs/${job.id}/shell` })
    assert.equal(unknownSuffix.status, 404)
  })
})

test('studio server: job artifacts are served, typed and never escape the job root', async () => {
  await withApp(async ({ port, jobStore }) => {
    const job = jobStore.create({
      projectId: 'voxel-sandbox',
      projectName: 'Voxel Sandbox',
      task: 'Serve the recorded artifacts.',
      model: MODELS[0],
      limits: { maxAttempts: 1 },
    })
    jobStore.writeArtifact(job.id, 'artifacts/diff.patch', '--- a/scripts/x.gd\n+++ b/scripts/x.gd\n')
    jobStore.writeArtifact(job.id, 'artifacts/raw.bin', Buffer.from([0, 1, 2]))

    const diff = await request({ port, path: `/api/studio/jobs/${job.id}/artifacts/artifacts/diff.patch` })
    assert.equal(diff.status, 200)
    assert.match(diff.headers['content-type'], /^text\/plain/)
    assert.equal(diff.headers['x-artifact-name'], 'diff.patch')
    assert.match(diff.body, /scripts\/x\.gd/)

    const unsupported = await request({ port, path: `/api/studio/jobs/${job.id}/artifacts/artifacts/raw.bin` })
    assert.equal(unsupported.status, 415)
    assert.equal(unsupported.json.error.code, 'unsupported_artifact')

    for (const relative of ['..%2Fjob.json', '..%5Cjob.json', '%2Fetc%2Fpasswd', 'C%3A%5CWindows%5Cwin.ini']) {
      const response = await request({
        port,
        path: `/api/studio/jobs/${job.id}/artifacts/${relative}`,
      })
      assert.equal(response.status, 400, relative)
      assert.ok(['path_traversal', 'invalid_path'].includes(response.json.error.code), relative)
    }

    const missing = await request({ port, path: `/api/studio/jobs/${job.id}/artifacts/artifacts/nope.txt` })
    assert.equal(missing.status, 404)

    const post = await request({
      port,
      method: 'POST',
      path: `/api/studio/jobs/${job.id}/artifacts/artifacts/diff.patch`,
      headers: { 'content-type': 'application/json' },
      body: '{}',
    })
    assert.equal(post.status, 405)

    fs.writeFileSync(jobStore.paths(job.id).manifest, '{"id": ', 'utf8')
    const corrupted = await request({ port, path: `/api/studio/jobs/${job.id}/artifacts/artifacts/diff.patch` })
    assert.equal(corrupted.status, 409)
    assert.equal(corrupted.json.error.code, 'corrupted_state')
  })
})

test('studio server: project artifacts stay under the registered artifact root', async () => {
  const projectDir = path.join(ARTIFACT_ROOT, 'voxel-sandbox')
  const name = `test-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`
  const file = path.join(projectDir, name)
  fs.mkdirSync(projectDir, { recursive: true })
  writeFile(file, 'operation artifact\n')
  try {
    await withApp(async ({ port }) => {
      const ok = await request({ port, path: `/api/studio/artifacts/voxel-sandbox/${name}` })
      assert.equal(ok.status, 200)
      assert.match(ok.body, /operation artifact/)

      for (const relative of ['..%2F..%2Fpackage.json', '%2Fetc%2Fpasswd', 'C%3A%5CWindows%5Cwin.ini']) {
        const response = await request({ port, path: `/api/studio/artifacts/voxel-sandbox/${relative}` })
        assert.equal(response.status, 400, relative)
      }

      const missingProject = await request({ port, path: `/api/studio/artifacts/nope/${name}` })
      assert.equal(missingProject.status, 404)
    })
  } finally {
    fs.rmSync(file, { force: true })
  }
})

test('studio server: request bodies above 64 KiB are refused with 413', async () => {
  await withApp(async ({ port }) => {
    const body = Buffer.from(
      JSON.stringify({ projectId: 'voxel-sandbox', task: 'x'.repeat(70 * 1024) }),
      'utf8',
    )
    const response = await request({
      port,
      method: 'POST',
      path: '/api/studio/jobs',
      headers: { 'content-type': 'application/json', 'content-length': body.length },
      body,
    })
    assert.equal(response.status, 413)
    assert.equal(response.json.error.code, 'body_too_large')
  })
})

test('studio server: operations accept only named ops and registered arguments', async () => {
  await withApp(async ({ port }) => {
    const list = await request({ port, path: '/api/studio/ops' })
    assert.equal(list.status, 200)
    assert.ok(Array.isArray(list.json.ops))

    const unknownProject = await request({ port, path: '/api/studio/ops?projectId=nope' })
    assert.equal(unknownProject.status, 404)

    const unknown = await postJson(port, '/api/studio/ops', {
      projectId: 'voxel-sandbox',
      op: 'shell',
      args: {},
    })
    assert.equal(unknown.status, 400)
    assert.equal(unknown.json.error.code, 'invalid_op')

    for (const value of ['rm', 'exec', 'powershell', 'node']) {
      const response = await postJson(port, '/api/studio/ops', {
        projectId: 'voxel-sandbox',
        op: value,
        args: {},
      })
      assert.equal(response.status, 400, value)
      assert.equal(response.json.error.code, 'invalid_op', value)
    }

    const extraArg = await postJson(port, '/api/studio/ops', {
      projectId: 'voxel-sandbox',
      op: 'check',
      args: { command: 'whoami' },
    })
    assert.equal(extraArg.status, 400)
    assert.equal(extraArg.json.error.code, 'invalid_args')

    const badTest = await postJson(port, '/api/studio/ops', {
      projectId: 'voxel-sandbox',
      op: 'test',
      args: { testId: 'voxel-public; rm -rf /' },
    })
    assert.equal(badTest.status, 400)
    assert.equal(badTest.json.error.code, 'invalid_test')

    const badHeadless = await postJson(port, '/api/studio/ops', {
      projectId: 'voxel-sandbox',
      op: 'launch',
      args: { headless: 'yes' },
    })
    assert.equal(badHeadless.status, 400)
    assert.equal(badHeadless.json.error.code, 'invalid_args')

    const badSteps = await postJson(port, '/api/studio/ops', {
      projectId: 'voxel-sandbox',
      op: 'advance',
      args: { steps: 100000 },
    })
    assert.equal(badSteps.status, 400)
    assert.equal(badSteps.json.error.code, 'invalid_args')

    const arrayArgs = await postJson(port, '/api/studio/ops', {
      projectId: 'voxel-sandbox',
      op: 'check',
      args: ['--version'],
    })
    assert.equal(arrayArgs.status, 400)
    assert.equal(arrayArgs.json.error.code, 'invalid_args')

    const missingOp = await request({ port, path: '/api/studio/ops/op-20260101000000-abcdef12' })
    assert.equal(missingOp.status, 404)
  })
})

test('studio server: cancel, discard and resume enforce their state machines', async () => {
  await withApp(async ({ port, jobStore }) => {
    const queued = jobStore.create({
      projectId: 'voxel-sandbox',
      projectName: 'Voxel Sandbox',
      task: 'A queued job to cancel.',
      model: MODELS[0],
      limits: { maxAttempts: 1 },
    })
    const cancelled = await postJson(port, `/api/studio/jobs/${queued.id}/cancel`, {})
    assert.equal(cancelled.status, 202)
    assert.equal(cancelled.json.job.status, 'cancelled')

    const approveQueued = await postJson(port, `/api/studio/jobs/${queued.id}/approve`, {})
    // Cancelled, so approval is refused; the exact 409 is the point.
    assert.equal(approveQueued.status, 409)

    const pending = seedJob(jobStore)
    fs.mkdirSync(path.join(jobStore.paths(pending.id).workspace, 'scripts'), { recursive: true })
    writeFile(path.join(jobStore.paths(pending.id).workspace, 'scripts', 'data.gd'), 'x')
    const discarded = await postJson(port, `/api/studio/jobs/${pending.id}/discard`, {})
    assert.equal(discarded.status, 200)
    assert.equal(discarded.json.job.status, 'discarded')
    assert.equal(fs.existsSync(jobStore.paths(pending.id).workspace), false)

    const unverified = seedJob(jobStore, { patch: { status: 'awaiting_approval', verification: { ok: false } } })
    const refused = await postJson(port, `/api/studio/jobs/${unverified.id}/approve`, {})
    assert.equal(refused.status, 409)
    assert.equal(refused.json.error.code, 'not_verified')

    // A queued job cannot be resumed; only failed/cancelled jobs can.
    const queuedForResume = jobStore.create({
      projectId: 'voxel-sandbox',
      projectName: 'Voxel Sandbox',
      task: 'A queued job that must not be resumable.',
      model: MODELS[0],
      limits: { maxAttempts: 1 },
    })
    const resumeQueued = await postJson(port, `/api/studio/jobs/${queuedForResume.id}/resume`, { model: MODELS[1] })
    assert.equal(resumeQueued.status, 409)
    assert.equal(resumeQueued.json.error.code, 'invalid_state')

    const noModel = await postJson(port, `/api/studio/jobs/${queuedForResume.id}/resume`, {})
    assert.equal(noModel.status, 400)
    assert.equal(noModel.json.error.code, 'invalid_model')

    const notAllowed = await postJson(port, `/api/studio/jobs/${queuedForResume.id}/resume`, { model: 'evil/shell' })
    assert.equal(notAllowed.status, 400)
    assert.equal(notAllowed.json.error.code, 'model_not_allowed')

    const unknownField = await postJson(port, `/api/studio/jobs/${queuedForResume.id}/resume`, {
      model: MODELS[1],
      shell: 'cmd',
    })
    assert.equal(unknownField.status, 400)
    assert.equal(unknownField.json.error.code, 'unknown_field')
  })
})

test('studio server: SSE emits a snapshot and then live job events', async () => {
  await withApp(async ({ port, jobStore }) => {
    const job = seedJob(jobStore)
    let buffer = ''
    let resolveSnapshot
    let resolveEvent
    const snapshotSeen = new Promise((resolve) => {
      resolveSnapshot = resolve
    })
    const eventSeen = new Promise((resolve) => {
      resolveEvent = resolve
    })
    const req = http.get(
      { host: '127.0.0.1', port, path: `/api/studio/jobs/${job.id}/stream` },
      (response) => {
        assert.equal(response.statusCode, 200)
        assert.match(response.headers['content-type'], /^text\/event-stream/)
        response.setEncoding('utf8')
        response.on('data', (chunk) => {
          buffer += chunk
          if (buffer.includes('event: snapshot') && !buffer.includes('__snapshot_done__')) {
            buffer += '__snapshot_done__'
            resolveSnapshot()
          }
          if (buffer.includes('event: job-event')) resolveEvent()
        })
      },
    )
    req.on('error', () => {})

    const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('SSE timeout')), ms))
    try {
      await Promise.race([snapshotSeen, timeout(5000)])
      jobStore.appendEvent(job.id, { type: 'agent.text', message: 'live progress' })
      await Promise.race([eventSeen, timeout(5000)])
      const body = buffer.replace('__snapshot_done__', '')
      assert.match(body, /event: snapshot/)
      assert.match(body, /"id":"job-/) // job summary id
      assert.match(body, /event: job-event/)
      assert.match(body, /live progress/)
    } finally {
      req.destroy()
    }
  })
})

test('studio server: creates only loopback servers and rejects unknown studio routes', async () => {
  assert.throws(() => startServer({ host: '0.0.0.0', store: EVIDENCE_STUB }), /only listens on loopback/)
  await withApp(async ({ port }) => {
    const response = await request({ port, path: '/api/studio/nope' })
    assert.equal(response.status, 404)
    assert.equal(response.json.error.code, 'not_found')
  })
})
