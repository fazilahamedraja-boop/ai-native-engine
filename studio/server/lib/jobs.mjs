import fs from 'node:fs'
import path from 'node:path'

import {
  JOBS_ROOT,
  StudioError,
  ensureDataDirs,
  isInside,
  newId,
  readJson,
  resolveRelative,
  writeJsonAtomic,
} from './studio-paths.mjs'

const JOB_ID_RE = /^job-[a-z0-9-]{6,60}$/

export function isJobId(value) {
  return typeof value === 'string' && JOB_ID_RE.test(value)
}

/**
 * Artifacts are addressed by job-relative POSIX paths (`artifacts/after.png`)
 * because that is what the artifact route accepts and what the UI can build a
 * URL from. Screenshot helpers hand back absolute paths, so convert them here;
 * a path outside the job directory is left as-is and will fail containment.
 */
export function jobRelativeArtifact(jobDir, entry) {
  if (!entry || typeof entry.path !== 'string' || !path.isAbsolute(entry.path)) return entry
  const relative = path.relative(jobDir, entry.path)
  if (relative === '' || relative.startsWith('..') || path.isAbsolute(relative)) return entry
  return { ...entry, path: relative.split(path.sep).join('/') }
}

/** Rewrite any legacy absolute artifact paths in a manifest loaded from disk. */
export function normalizeJobArtifacts(job, jobDir) {
  const artifacts = job?.artifacts
  if (!artifacts || typeof artifacts !== 'object') return job
  const next = {}
  let changed = false
  for (const [key, entry] of Object.entries(artifacts)) {
    const normalized = jobRelativeArtifact(jobDir, entry)
    if (normalized !== entry) changed = true
    next[key] = normalized
  }
  return changed ? { ...job, artifacts: next } : job
}

export function jobPaths(jobId, root = JOBS_ROOT) {
  if (!isJobId(jobId)) throw new StudioError('invalid_job', 'Invalid job id.', 400)
  const dir = path.join(root, jobId)
  if (!isInside(dir, root)) throw new StudioError('path_outside_root', 'Job path escaped its root.', 400)
  return {
    dir,
    manifest: path.join(dir, 'job.json'),
    events: path.join(dir, 'events.jsonl'),
    workspace: path.join(dir, 'workspace'),
    baseline: path.join(dir, 'baseline'),
    attempts: path.join(dir, 'attempts'),
    logs: path.join(dir, 'logs'),
    artifacts: path.join(dir, 'artifacts'),
  }
}

export class JobStore {
  constructor({ root = JOBS_ROOT, now = () => new Date() } = {}) {
    this.root = root
    this.now = now
    this.subscribers = new Map()
    this.eventSeq = new Map()
    ensureDataDirs()
  }

  paths(jobId) {
    return jobPaths(jobId, this.root)
  }

  create({ projectId, projectName, task, model, limits, startCommit = null, forbiddenFiles = [], kind = 'repair' }) {
    const id = newId('job')
    const paths = this.paths(id)
    for (const dir of [paths.dir, paths.workspace, paths.baseline, paths.attempts, paths.logs, paths.artifacts]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    const timestamp = this.now().toISOString()
    const job = {
      schema: 'studio.job.v1',
      id,
      projectId,
      projectName,
      kind,
      task,
      model,
      status: 'queued',
      step: 'created',
      createdAt: timestamp,
      updatedAt: timestamp,
      startCommit,
      baselineHash: null,
      candidateHash: null,
      workspaceHash: null,
      attempts: [],
      modelHistory: [{ model, at: timestamp, reason: 'initial' }],
      limits,
      baseline: null,
      verification: null,
      changedFiles: [],
      forbiddenFiles,
      artifacts: {},
      error: null,
      approval: null,
      resume: { count: 0, lastFromStep: null, conflict: null },
      revision: 1,
    }
    writeJsonAtomic(paths.manifest, job)
    this.eventSeq.set(id, 0)
    this.appendEvent(id, { type: 'job.created', message: 'Job created.', data: { projectId, model } })
    return job
  }

  load(jobId) {
    const paths = this.paths(jobId)
    if (!fs.existsSync(paths.manifest)) return null
    try {
      const job = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'))
      if (!job || typeof job !== 'object' || job.id !== jobId) throw new Error('manifest id mismatch')
      return job
    } catch (error) {
      return {
        schema: 'studio.job.corrupted',
        id: jobId,
        status: 'corrupted',
        step: 'unknown',
        corrupted: true,
        error: { class: 'corrupted_state', message: `The job manifest is unreadable: ${error.message}` },
        createdAt: null,
        updatedAt: null,
        task: null,
        projectId: null,
        projectName: null,
        kind: null,
        model: null,
        attempts: [],
        changedFiles: [],
        artifacts: {},
      }
    }
  }

  list() {
    if (!fs.existsSync(this.root)) return []
    const jobs = []
    for (const entry of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isJobId(entry.name)) continue
      const job = this.load(entry.name)
      if (job) jobs.push(job)
    }
    return jobs.sort((a, b) => String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')))
  }

  save(job, patch = {}) {
    const current = this.load(job.id)
    if (!current || current.corrupted) {
      throw new StudioError('corrupted_state', 'Refusing to overwrite a corrupted job manifest.', 409)
    }
    const next = {
      ...current,
      ...patch,
      id: current.id,
      revision: (current.revision ?? 0) + 1,
      updatedAt: this.now().toISOString(),
    }
    writeJsonAtomic(this.paths(job.id).manifest, next)
    return next
  }

  update(jobId, patch) {
    const current = this.load(jobId)
    if (!current) throw new StudioError('not_found', 'No such job.', 404)
    if (current.corrupted) throw new StudioError('corrupted_state', 'This job manifest is corrupted.', 409)
    return this.save(current, patch)
  }

  appendEvent(jobId, { type, message, level = 'info', data = null }) {
    const paths = this.paths(jobId)
    const seq = (this.eventSeq.get(jobId) ?? this.countEvents(jobId)) + 1
    this.eventSeq.set(jobId, seq)
    const event = {
      seq,
      at: this.now().toISOString(),
      type: String(type || 'event'),
      level: ['info', 'warn', 'error', 'success'].includes(level) ? level : 'info',
      message: String(message ?? ''),
      data,
    }
    fs.appendFileSync(paths.events, `${JSON.stringify(event)}\n`, 'utf8')
    for (const listener of this.subscribers.get(jobId) ?? []) {
      try {
        listener(event)
      } catch {
        // A broken SSE client must not break the job.
      }
    }
    return event
  }

  countEvents(jobId) {
    const file = this.paths(jobId).events
    if (!fs.existsSync(file)) return 0
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).length
  }

  readEvents(jobId, { limit = 500 } = {}) {
    const file = this.paths(jobId).events
    if (!fs.existsSync(file)) return []
    const events = []
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      try {
        events.push(JSON.parse(line))
      } catch {
        // Keep the job usable even if a single line was torn by a crash.
      }
    }
    return events.slice(-Math.max(1, Math.min(2000, limit)))
  }

  subscribe(jobId, listener) {
    if (!this.subscribers.has(jobId)) this.subscribers.set(jobId, new Set())
    this.subscribers.get(jobId).add(listener)
    return () => {
      const set = this.subscribers.get(jobId)
      if (!set) return
      set.delete(listener)
      if (set.size === 0) this.subscribers.delete(jobId)
    }
  }

  artifactPath(jobId, relative) {
    return resolveRelative(this.paths(jobId).dir, relative, { mustExist: true })
  }

  /** Load a manifest with artifact paths already normalised for the UI. */
  loadForView(jobId) {
    const job = this.load(jobId)
    return job ? normalizeJobArtifacts(job, this.paths(jobId).dir) : null
  }

  /** Discard removes the disposable workspace but never the evidence. */
  discardWorkspace(jobId) {
    const workspace = this.paths(jobId).workspace
    if (fs.existsSync(workspace)) fs.rmSync(workspace, { recursive: true, force: true })
  }

  writeArtifact(jobId, relative, contents) {
    const paths = this.paths(jobId)
    const target = resolveRelative(paths.dir, relative)
    fs.mkdirSync(path.dirname(target), { recursive: true })
    if (Buffer.isBuffer(contents)) fs.writeFileSync(target, contents)
    else fs.writeFileSync(target, String(contents), 'utf8')
    return target
  }

  readArtifactText(jobId, relative) {
    const target = this.artifactPath(jobId, relative)
    const stat = fs.statSync(target)
    if (stat.size > 512_000) {
      throw new StudioError('artifact_too_large', 'That artifact is too large to preview.', 413)
    }
    return fs.readFileSync(target, 'utf8')
  }
}

export function findJobOrThrow(store, jobId) {
  if (!isJobId(jobId)) throw new StudioError('invalid_job', 'Invalid job id.', 400)
  const job = store.load(jobId)
  if (!job) throw new StudioError('not_found', 'No such job.', 404)
  return job
}

export { readJson }
