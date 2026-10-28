import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { EvidenceError, createEvidenceStore } from './lib/evidence.mjs'
import { JobStore, isJobId } from './lib/jobs.mjs'
import { DEFAULT_LIMITS, createAgentRunner } from './lib/agent-runner.mjs'
import { createOperations } from './lib/operations.mjs'
import { createProjectRegistry } from './lib/projects.mjs'
import { ARTIFACT_ROOT, StudioError, isInside, resolveRelative } from './lib/studio-paths.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const DEFAULT_REPO_ROOT = path.resolve(HERE, '..', '..')
const PUBLIC_DIR = path.resolve(HERE, '..', 'public')

export const DEFAULT_HOST = '127.0.0.1'
export const DEFAULT_PORT = 8787

const DEFAULT_MODELS = Object.freeze([
  'opencode/deepseek-v4.1-flash-free',
  'opencode/glm-5.3-flash-free',
  'opencode/mimo-v2.6-flash-free',
  'opencode/flint-40b-free',
  'opencode/beam-free',
  'opencode/nemotron-3-ultra-free',
  'opencode/nemotron-3.5-lightning-free',
])

const MAX_BODY_BYTES = 64 * 1024
const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024

/**
 * Exact path -> file mapping. There is no directory serving, no extension
 * guessing and no user-controlled filesystem path; these are the whole
 * frontend. The S0 evidence dashboard and the Studio share styles only by
 * explicit file, never by directory listing.
 */
const STATIC_ROUTES = new Map([
  ['/', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/index.html', { file: 'index.html', type: 'text/html; charset=utf-8' }],
  ['/app.js', { file: 'app.js', type: 'text/javascript; charset=utf-8' }],
  ['/styles.css', { file: 'styles.css', type: 'text/css; charset=utf-8' }],
  ['/favicon.svg', { file: 'favicon.svg', type: 'image/svg+xml; charset=utf-8' }],
  ['/studio', { file: 'studio.html', type: 'text/html; charset=utf-8' }],
  ['/studio.html', { file: 'studio.html', type: 'text/html; charset=utf-8' }],
  ['/studio.js', { file: 'studio.js', type: 'text/javascript; charset=utf-8' }],
  ['/studio.css', { file: 'studio.css', type: 'text/css; charset=utf-8' }],
  // Desktop application surface (Electron loads /app). The existing /studio
  // dashboard stays untouched; these are additional, explicitly registered
  // files, not a directory listing.
  ['/app', { file: 'desktop.html', type: 'text/html; charset=utf-8' }],
  ['/app.html', { file: 'desktop.html', type: 'text/html; charset=utf-8' }],
  ['/desktop.js', { file: 'desktop.js', type: 'text/javascript; charset=utf-8' }],
  ['/desktop.css', { file: 'desktop.css', type: 'text/css; charset=utf-8' }],
])

const SECURITY_HEADERS = Object.freeze({
  'Content-Security-Policy': [
    "default-src 'none'",
    "img-src 'self'",
    "media-src 'self'",
    "style-src 'self'",
    "script-src 'self'",
    "connect-src 'self'",
    "frame-src http://127.0.0.1:8790",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
  ].join('; '),
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'Cross-Origin-Resource-Policy': 'same-origin',
})

const TEXT_CONTENT_TYPES = new Map([
  ['.json', 'application/json; charset=utf-8'],
  ['.jsonl', 'application/x-ndjson; charset=utf-8'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.log', 'text/plain; charset=utf-8'],
  ['.patch', 'text/plain; charset=utf-8'],
  ['.diff', 'text/plain; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.gd', 'text/plain; charset=utf-8'],
  ['.png', 'image/png'],
])

function sendJson(response, status, body, extraHeaders = {}) {
  const payload = Buffer.from(JSON.stringify(body), 'utf8')
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': payload.length,
    'Cache-Control': 'no-store',
    ...extraHeaders,
  })
  response.end(payload)
}

function sendError(response, error) {
  const known = error instanceof EvidenceError || error instanceof StudioError
  const status = known ? error.status : 500
  const code = known ? error.code : 'internal_error'
  if (!known) {
    console.error('[studio] request failed:', error)
  }
  sendJson(response, status, { error: { code, message: error.message } })
}

function parseRunId(pathname) {
  const prefix = '/api/runs/'
  if (!pathname.startsWith(prefix)) return null
  const encoded = pathname.slice(prefix.length)
  if (encoded === '') return null
  try {
    return decodeURIComponent(encoded)
  } catch {
    throw new EvidenceError('invalid_path', 'Run id is not valid percent-encoding.', 400)
  }
}

async function readJsonBody(request) {
  const contentType = String(request.headers['content-type'] ?? '')
  if (!contentType.toLowerCase().startsWith('application/json')) {
    throw new StudioError('invalid_content_type', 'Send application/json.', 415)
  }
  return new Promise((resolve, reject) => {
    let bytes = 0
    const chunks = []
    let settled = false
    const fail = (error) => {
      if (settled) return
      settled = true
      reject(error)
    }
    request.on('data', (chunk) => {
      if (settled) return
      bytes += chunk.length
      if (bytes > MAX_BODY_BYTES) {
        // Stop buffering but keep draining the socket so the 413 response can
        // still be delivered instead of turning into a connection reset.
        chunks.length = 0
        fail(new StudioError('body_too_large', 'Request body exceeds 64 KiB.', 413))
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => {
      if (settled) return
      settled = true
      const text = Buffer.concat(chunks).toString('utf8')
      if (text.trim() === '') return resolve({})
      try {
        const parsed = JSON.parse(text)
        if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
          return reject(new StudioError('invalid_json', 'The body must be a JSON object.', 400))
        }
        return resolve(parsed)
      } catch {
        return reject(new StudioError('invalid_json', 'The body is not valid JSON.', 400))
      }
    })
    request.on('error', (error) => fail(new StudioError('request_error', error.message, 400)))
  })
}

function rejectUnknownFields(body, allowed) {
  for (const key of Object.keys(body)) {
    if (!allowed.has(key)) {
      throw new StudioError('unknown_field', `Unknown field "${key}".`, 400)
    }
  }
}

function parseModelList() {
  const raw = String(process.env.STUDIO_AGENT_MODELS ?? '').trim()
  if (raw === '') return [...DEFAULT_MODELS]
  const models = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return models.length > 0 ? [...new Set(models)] : [...DEFAULT_MODELS]
}

const ALLOWED_MODELS = new Set(parseModelList())

function assertAllowedModel(model) {
  if (typeof model !== 'string' || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/.test(model) || model.length > 160) {
    throw new StudioError('invalid_model', 'Model must look like provider/model.', 400)
  }
  if (!ALLOWED_MODELS.has(model)) {
    throw new StudioError(
      'model_not_allowed',
      `"${model}" is not in the configured model list. Set STUDIO_AGENT_MODELS to make another provider/model available.`,
      400,
    )
  }
}

function jobSummary(job) {
  return {
    id: job.id,
    projectId: job.projectId,
    projectName: job.projectName,
    kind: job.kind ?? 'repair',
    task: job.task,
    model: job.model,
    status: job.status,
    step: job.step,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error ?? null,
    verificationOk: job.verification ? Boolean(job.verification.ok) : null,
    attemptCount: Array.isArray(job.attempts) ? job.attempts.length : 0,
    changedFiles: Array.isArray(job.changedFiles) ? job.changedFiles.length : 0,
    artifacts: Object.keys(job.artifacts ?? {}),
    corrupted: Boolean(job.corrupted),
  }
}

function createStudioServices({ jobStore = null, registry = null } = {}) {
  const store = jobStore ?? new JobStore()
  const projectRegistry = registry ?? createProjectRegistry()
  const operations = createOperations({
    deps: {
      getProjectImpl: (projectId) => projectRegistry.get(projectId),
      projectRootImpl: (project) => projectRegistry.rootOf(project),
    },
  })
  const projectApi = {
    listRegisteredProjects: () => projectRegistry.list(),
    getProject: (projectId) => projectRegistry.get(projectId),
    projectStatus: (project, options) => projectRegistry.status(project, options),
  }
  const runner = createAgentRunner({ store, projects: projectApi })
  const startedAt = new Date().toISOString()
  return {
    store,
    operations,
    projects: projectApi,
    registry: projectRegistry,
    runner,
    startedAt,
  }
}

function projectView(project, operations, registry) {
  const runtime = operations.sessionSummary(project.id)
  return registry.status(project, {
    runtime,
    lastOps: operations.latestForProject(project.id),
  })
}

function parseArtifactRequest(pathname) {
  const jobPrefix = '/api/studio/jobs/'
  if (pathname.startsWith(jobPrefix)) {
    const marker = '/artifacts/'
    const index = pathname.indexOf(marker)
    if (index === -1) return null
    const jobId = pathname.slice(jobPrefix.length, index)
    const relative = pathname.slice(index + marker.length)
    if (!isJobId(jobId) || relative === '') return null
    return { kind: 'job', jobId, relative: safeDecode(relative) }
  }
  const projectPrefix = '/api/studio/artifacts/'
  if (pathname.startsWith(projectPrefix)) {
    const rest = pathname.slice(projectPrefix.length)
    const slash = rest.indexOf('/')
    if (slash === -1) return null
    const projectId = rest.slice(0, slash)
    const relative = rest.slice(slash + 1)
    if (relative === '') return null
    return { kind: 'project', projectId, relative: safeDecode(relative) }
  }
  return null
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    throw new StudioError('invalid_path', 'The artifact path is not valid percent-encoding.', 400)
  }
}

function serveArtifact(response, absolute, requestedName) {
  const extension = path.extname(absolute).toLowerCase()
  const contentType = TEXT_CONTENT_TYPES.get(extension)
  if (!contentType) {
    throw new StudioError('unsupported_artifact', 'That artifact type cannot be previewed.', 415)
  }
  const stat = fs.statSync(absolute)
  if (stat.size > MAX_ARTIFACT_BYTES) {
    throw new StudioError('artifact_too_large', 'That artifact is too large to preview.', 413)
  }
  const body = fs.readFileSync(absolute)
  response.writeHead(200, {
    ...SECURITY_HEADERS,
    'Content-Type': contentType,
    'Content-Length': body.length,
    'Cache-Control': 'no-store',
    'Content-Disposition': 'inline',
    'X-Artifact-Name': path.basename(requestedName),
  })
  response.end(body)
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\n`)
  response.write(`data: ${JSON.stringify(data)}\n\n`)
}

async function handleStudio(request, response, url, studio) {
  const { pathname, searchParams } = url
  const { store, operations, runner, registry } = studio

  const artifactRequest = parseArtifactRequest(pathname)
  if (artifactRequest) {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new StudioError('method_not_allowed', 'Only GET and HEAD are supported for artifacts.', 405)
    }
    if (artifactRequest.kind === 'job') {
      const job = store.load(artifactRequest.jobId)
      if (!job) throw new StudioError('not_found', 'No such job.', 404)
      if (job.corrupted) throw new StudioError('corrupted_state', 'This job manifest is corrupted.', 409)
      const absolute = store.artifactPath(artifactRequest.jobId, artifactRequest.relative)
      serveArtifact(response, absolute, artifactRequest.relative)
      return true
    }
    registry.get(artifactRequest.projectId)
    const root = path.join(ARTIFACT_ROOT, artifactRequest.projectId)
    const absolute = resolveRelative(root, artifactRequest.relative, { mustExist: true })
    if (!isInside(absolute, root)) throw new StudioError('path_outside_root', 'Refused.', 400)
    serveArtifact(response, absolute, artifactRequest.relative)
    return true
  }

  if (pathname === '/api/studio/meta') {
    const projects = registry.list().map((project) => ({
      id: project.id,
      name: project.name,
      agentEnabled: project.agent.enabled,
      defaultModel: project.agent.defaultModel,
    }))
    sendJson(response, 200, {
      schema: 'studio.meta.v1',
      startedAt: studio.startedAt,
      projects,
      templates: registry.templates(),
      models: [...ALLOWED_MODELS],
      limits: {
        ...DEFAULT_LIMITS,
        maxBodyBytes: MAX_BODY_BYTES,
        maxArtifactBytes: MAX_ARTIFACT_BYTES,
      },
      evidenceDashboard: '/',
    })
    return true
  }

  if (pathname === '/api/studio/projects') {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const projects = registry.list().map((project) => {
        const view = projectView(project, operations, registry)
        const jobs = store
          .list()
          .filter((job) => job.projectId === project.id)
          .slice(0, 8)
          .map(jobSummary)
        return { ...view, jobs }
      })
      sendJson(response, 200, { projects })
      return true
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      rejectUnknownFields(body, new Set(['name', 'templateId', 'description']))
      const project = await registry.create({
        name: body.name,
        templateId: body.templateId,
        description: body.description ?? '',
      })
      sendJson(response, 201, { project: projectView(project, operations, registry) })
      return true
    }
    throw new StudioError('method_not_allowed', 'Use GET or POST.', 405)
  }

  if (pathname === '/api/studio/templates') {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      throw new StudioError('method_not_allowed', 'Use GET.', 405)
    }
    sendJson(response, 200, { templates: registry.templates() })
    return true
  }

  /**
   * Build Game with AI: create an isolated project from the arena template and
   * start one real implementation job against it. Creation and the job are
   * separate, auditable records; nothing is applied to the canonical project
   * until the candidate has been verified and explicitly approved.
   */
  if (pathname === '/api/studio/build-game') {
    if (request.method !== 'POST') throw new StudioError('method_not_allowed', 'Use POST.', 405)
    const body = await readJsonBody(request)
    rejectUnknownFields(body, new Set(['name', 'prompt', 'model', 'templateId']))
    const prompt = typeof body.prompt === 'string' ? body.prompt.trim() : ''
    if (prompt.length < 10 || prompt.length > 4000) {
      throw new StudioError('invalid_prompt', 'Describe the game in 10–4000 characters.', 400)
    }
    const templateId = body.templateId ?? 'arena'
    const template = registry.templates().find((entry) => entry.id === templateId)
    if (!template) throw new StudioError('unknown_template', 'Choose an implemented template.', 400)
    if (!template.agentEnabled) {
      throw new StudioError('agent_disabled', 'That template cannot be built with the agent.', 409)
    }
    const project = await registry.create({
      name: body.name,
      templateId,
      description: prompt,
    })
    const model = body.model ?? project.agent.defaultModel
    assertAllowedModel(model)
    const job = store.create({
      projectId: project.id,
      projectName: project.name,
      kind: 'build',
      task: prompt,
      model,
      limits: {
        maxAttempts: project.agent.maxAttempts,
        attemptTimeoutMs: project.agent.timeoutMs,
        maxRuntimeMs: 30 * 60 * 1000,
      },
      forbiddenFiles: ['tests/', 'project.godot', 'export_presets.cfg', 'harness/'],
    })
    const started = await runner.start(job.id)
    sendJson(response, 202, {
      project: projectView(project, operations, registry),
      job: started,
    })
    return true
  }

  const projectPreview = pathname.match(/^\/api\/studio\/projects\/([a-z0-9-]+)\/preview$/)
  if (projectPreview) {
    sendJson(response, 200, await operations.preview(projectPreview[1]))
    return true
  }

  const projectDetail = pathname.match(/^\/api\/studio\/projects\/([a-z0-9-]+)$/)
  if (projectDetail) {
    const project = registry.get(projectDetail[1])
    const view = projectView(project, operations, registry)
    const jobs = store
      .list()
      .filter((job) => job.projectId === project.id)
      .map(jobSummary)
    sendJson(response, 200, { project: { ...view, jobs } })
    return true
  }

  if (pathname === '/api/studio/jobs') {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const projectId = searchParams.get('projectId')
      const jobs = store
        .list()
        .filter((job) => !projectId || job.projectId === projectId)
        .map(jobSummary)
      sendJson(response, 200, { jobs })
      return true
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      rejectUnknownFields(body, new Set(['projectId', 'task', 'model']))
      const project = registry.get(body.projectId)
      if (!project.agent.enabled) {
        throw new StudioError(
          'agent_disabled',
          project.agent.note || 'Agent tasks are disabled for this project.',
          409,
        )
      }
      const task = typeof body.task === 'string' ? body.task.trim() : ''
      if (task.length < 10 || task.length > 4000) {
        throw new StudioError('invalid_task', 'Describe the task in 10–4000 characters.', 400)
      }
      const model = body.model ?? project.agent.defaultModel
      assertAllowedModel(model)
      const job = store.create({
        projectId: project.id,
        projectName: project.name,
        task,
        model,
        limits: {
          maxAttempts: project.agent.maxAttempts,
          attemptTimeoutMs: project.agent.timeoutMs,
          maxRuntimeMs: 20 * 60 * 1000,
        },
        forbiddenFiles: ['tests/', 'project.godot', 'export_presets.cfg', 'harness/'],
      })
      const started = await runner.start(job.id)
      sendJson(response, 202, { job: started })
      return true
    }
    throw new StudioError('method_not_allowed', 'Use GET or POST.', 405)
  }

  const jobMatch = pathname.match(/^\/api\/studio\/jobs\/(job-[a-z0-9-]+)(\/.*)?$/)
  if (jobMatch) {
    const jobId = jobMatch[1]
    const suffix = jobMatch[2] ?? ''
    if (!isJobId(jobId)) throw new StudioError('invalid_job', 'Invalid job id.', 400)

    if (suffix === '' && (request.method === 'GET' || request.method === 'HEAD')) {
      const job = store.loadForView(jobId)
      if (!job) throw new StudioError('not_found', 'No such job.', 404)
      sendJson(response, 200, { job, events: store.readEvents(jobId, { limit: 200 }) })
      return true
    }

    if (suffix === '/events' && (request.method === 'GET' || request.method === 'HEAD')) {
      const job = store.load(jobId)
      if (!job) throw new StudioError('not_found', 'No such job.', 404)
      const limit = Number(searchParams.get('limit') ?? 500)
      sendJson(response, 200, { events: store.readEvents(jobId, { limit }) })
      return true
    }

    if (suffix === '/stream' && request.method === 'GET') {
      const job = store.load(jobId)
      if (!job) throw new StudioError('not_found', 'No such job.', 404)
      response.writeHead(200, {
        ...SECURITY_HEADERS,
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      })
      response.write('retry: 2000\n\n')
      writeSse(response, 'snapshot', { job: jobSummary(job), events: store.readEvents(jobId, { limit: 300 }) })
      const unsubscribe = store.subscribe(jobId, (event) => {
        writeSse(response, 'job-event', event)
      })
      const heartbeat = setInterval(() => {
        response.write(': keep-alive\n\n')
      }, 15000)
      const close = () => {
        clearInterval(heartbeat)
        unsubscribe()
        response.end()
      }
      request.on('close', close)
      return true
    }

    if (suffix === '/cancel' && request.method === 'POST') {
      sendJson(response, 202, { job: await runner.cancel(jobId) })
      return true
    }

    if (suffix === '/discard' && request.method === 'POST') {
      sendJson(response, 200, { job: await runner.discard(jobId) })
      return true
    }

    if (suffix === '/approve' && request.method === 'POST') {
      sendJson(response, 200, { job: await runner.approve(jobId) })
      return true
    }

    if (suffix === '/resume' && request.method === 'POST') {
      const body = await readJsonBody(request)
      rejectUnknownFields(body, new Set(['model']))
      if (!body.model) throw new StudioError('invalid_model', 'Choose a model to resume with.', 400)
      assertAllowedModel(body.model)
      sendJson(response, 202, { job: await runner.resume(jobId, { model: body.model }) })
      return true
    }

    if (suffix === '/diff' && (request.method === 'GET' || request.method === 'HEAD')) {
      const job = store.load(jobId)
      if (!job) throw new StudioError('not_found', 'No such job.', 404)
      const artifact = job.artifacts?.diff
      if (!artifact) throw new StudioError('not_found', 'This job has no recorded diff.', 404)
      const absolute = store.artifactPath(jobId, artifact.path)
      serveArtifact(response, absolute, artifact.path)
      return true
    }

    throw new StudioError('not_found', 'Unknown job route.', 404)
  }

  if (pathname === '/api/studio/ops') {
    if (request.method === 'GET' || request.method === 'HEAD') {
      const projectId = searchParams.get('projectId')
      if (projectId) registry.get(projectId)
      const limit = Number(searchParams.get('limit') ?? 50)
      sendJson(response, 200, {
        ops: operations.listOps({ projectId, limit: Number.isFinite(limit) ? limit : 50 }),
      })
      return true
    }
    if (request.method === 'POST') {
      const body = await readJsonBody(request)
      rejectUnknownFields(body, new Set(['projectId', 'op', 'args']))
      const project = registry.get(body.projectId)
      if (typeof body.op !== 'string' || !/^[a-z]{3,20}$/.test(body.op)) {
        throw new StudioError('invalid_op', 'Choose a supported operation.', 400)
      }
      const args = body.args ?? {}
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        throw new StudioError('invalid_args', 'args must be an object.', 400)
      }
      validateOpArgs(body.op, args, project)
      const record = await operations.run(project.id, body.op, args)
      sendJson(response, 200, { op: record })
      return true
    }
    throw new StudioError('method_not_allowed', 'Use GET or POST.', 405)
  }

  const opMatch = pathname.match(/^\/api\/studio\/ops\/(op-[a-z0-9-]+)$/)
  if (opMatch && (request.method === 'GET' || request.method === 'HEAD')) {
    sendJson(response, 200, { op: operations.getOp(opMatch[1]) })
    return true
  }

  if (pathname === '/api/studio/preview') {
    const projectId = searchParams.get('projectId')
    if (!projectId) throw new StudioError('invalid_project', 'projectId is required.', 400)
    sendJson(response, 200, await operations.preview(projectId))
    return true
  }

  return false
}

function validateOpArgs(op, args, project) {
  const specs = {
    check: new Set(),
    test: new Set(['testId']),
    launch: new Set(['headless']),
    stop: new Set(),
    capture: new Set(),
    reset: new Set(),
    advance: new Set(['steps', 'input']),
    logs: new Set(),
    export: new Set(),
  }
  const allowed = specs[op]
  if (!allowed) throw new StudioError('invalid_op', 'Unknown operation.', 400)
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new StudioError('invalid_args', `Unknown argument "${key}" for ${op}.`, 400)
    }
  }
  if (op === 'test') {
    if (typeof args.testId !== 'string' || !project.tests.some((entry) => entry.id === args.testId)) {
      throw new StudioError('invalid_test', 'Choose a test suite registered for this project.', 400)
    }
  }
  if (op === 'launch' && args.headless !== undefined && typeof args.headless !== 'boolean') {
    throw new StudioError('invalid_args', 'headless must be a boolean.', 400)
  }
  if (op === 'advance') {
    if (args.steps !== undefined) {
      if (!Number.isInteger(args.steps) || args.steps < 1 || args.steps > 3600) {
        throw new StudioError('invalid_args', 'steps must be an integer between 1 and 3600.', 400)
      }
    }
    if (args.input !== undefined && (args.input === null || typeof args.input !== 'object' || Array.isArray(args.input))) {
      throw new StudioError('invalid_args', 'input must be an object.', 400)
    }
  }
}

export function createApp({ store, studio = null, jobStore = null, registry = null } = {}) {
  if (!store) throw new Error('store is required')
  let services = studio

  function ensureStudio() {
    if (!services) services = createStudioServices({ jobStore, registry })
    return services
  }

  return function handleRequest(request, response) {
    const url = new URL(request.url ?? '/', `http://${DEFAULT_HOST}`)
    const { pathname } = url

    if (pathname.startsWith('/api/studio/')) {
      handleStudio(request, response, url, ensureStudio())
        .then((handled) => {
          if (!handled) {
            sendJson(response, 404, { error: { code: 'not_found', message: 'Unknown Studio API route.' } })
          }
        })
        .catch((error) => sendError(response, error))
      return
    }

    try {
      // Browsers may send OPTIONS for same-origin fetches only in edge cases;
      // there is no CORS surface here, so anything but GET/HEAD is rejected.
      if (request.method !== 'GET' && request.method !== 'HEAD') {
        sendJson(
          response,
          405,
          { error: { code: 'method_not_allowed', message: 'Only GET and HEAD are supported.' } },
          { Allow: 'GET, HEAD' },
        )
        return
      }

      if (pathname === '/api/meta') {
        sendJson(response, 200, store.meta())
        return
      }

      if (pathname === '/api/runs') {
        sendJson(response, 200, { runs: store.listRuns() })
        return
      }

      const runId = parseRunId(pathname)
      if (runId !== null) {
        const run = store.getRun(runId)
        if (!run) {
          sendJson(response, 404, {
            error: { code: 'not_found', message: 'No such run in the scanned evidence index.' },
          })
          return
        }
        sendJson(response, 200, run)
        return
      }

      if (pathname === '/api/text') {
        const requested = url.searchParams.get('path')
        const text = store.readText(requested)
        sendJson(response, 200, text)
        return
      }

      if (pathname === '/api/file') {
        const requested = url.searchParams.get('path')
        const artifact = store.getArtifact(requested)
        const body = fs.readFileSync(artifact.absolutePath)
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': artifact.contentType,
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
          'Content-Disposition': 'inline',
        })
        response.end(body)
        return
      }

      const staticRoute = STATIC_ROUTES.get(pathname)
      if (staticRoute) {
        const body = fs.readFileSync(path.join(PUBLIC_DIR, staticRoute.file))
        response.writeHead(200, {
          ...SECURITY_HEADERS,
          'Content-Type': staticRoute.type,
          'Content-Length': body.length,
          'Cache-Control': 'no-store',
        })
        response.end(body)
        return
      }

      if (pathname.startsWith('/api/')) {
        sendJson(response, 404, {
          error: { code: 'not_found', message: 'Unknown API route.' },
        })
        return
      }

      sendJson(response, 404, {
        error: { code: 'not_found', message: 'Unknown route.' },
      })
    } catch (error) {
      sendError(response, error)
    }
  }
}

export function startServer({
  repoRoot = DEFAULT_REPO_ROOT,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  store = createEvidenceStore({ repoRoot }),
  jobStore = null,
  registry = null,
} = {}) {
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`refusing to bind ${host}: the studio server only listens on loopback`)
  }
  const studio = createStudioServices({ jobStore, registry })
  const server = http.createServer(createApp({ store, studio }))

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.removeListener('error', reject)
      const address = server.address()
      resolve({
        server,
        store,
        studio,
        host,
        port: typeof address === 'object' && address ? address.port : port,
        url: `http://${host}:${typeof address === 'object' && address ? address.port : port}/`,
      })
    })
  })
}

function isDirectInvocation() {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return pathToFileURL(fs.realpathSync.native(entry)).href ===
      pathToFileURL(fs.realpathSync.native(fileURLToPath(import.meta.url))).href
  } catch {
    return false
  }
}

if (isDirectInvocation()) {
  // The host is deliberately not configurable: this dashboard must stay on the
  // loopback interface. Only the port can be overridden.
  const port = Number(process.env.STUDIO_PORT ?? DEFAULT_PORT)
  try {
    const started = await startServer({ port, host: DEFAULT_HOST })
    console.log(`[studio] dashboard on ${started.url}`)
    console.log(`[studio] evidence dashboard: ${started.url}`)
    console.log(`[studio] studio workspace:  ${started.url}studio`)
    console.log(`[studio] evidence root: ${started.store.evidenceRoot}`)
    console.log(`[studio] runs: ${started.store.listRuns().length}`)
    console.log(`[studio] allowed models: ${[...ALLOWED_MODELS].join(', ')}`)
    const shutdown = async () => {
      try {
        await started.studio.operations.stopAll()
      } catch {
        // Shutdown is best effort.
      }
      started.server.close(() => process.exit(0))
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
  } catch (error) {
    console.error('[studio] failed to start:', error.message)
    process.exitCode = 1
  }
}
