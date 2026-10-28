import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { JobStore, findJobOrThrow, isJobId, jobPaths } from '../server/lib/jobs.mjs'
import { StudioError } from '../server/lib/studio-paths.mjs'
import { tempRoot, writeFile } from './helpers.mjs'

function makeStore() {
  const root = tempRoot('studio-jobs-')
  return { root, store: new JobStore({ root }) }
}

function createJob(store, overrides = {}) {
  return store.create({
    projectId: 'fake-project',
    projectName: 'Fake Project',
    task: 'Change the fixture value.',
    model: 'opencode/test-model',
    limits: { maxAttempts: 1 },
    ...overrides,
  })
}

test('job store: create persists a queued manifest inside its own root', () => {
  const { root, store } = makeStore()
  const job = createJob(store)
  assert.equal(job.status, 'queued')
  assert.equal(job.step, 'created')
  assert.equal(job.revision, 1)
  assert.match(job.id, /^job-/)
  assert.equal(isJobId(job.id), true)

  const paths = jobPaths(job.id, root)
  for (const dir of [paths.dir, paths.workspace, paths.baseline, paths.attempts, paths.logs, paths.artifacts]) {
    assert.equal(fs.existsSync(dir), true, dir)
  }
  const manifest = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'))
  assert.equal(manifest.id, job.id)
  assert.equal(manifest.modelHistory[0].reason, 'initial')
  assert.equal(store.countEvents(job.id), 1)
})

test('job store: events keep a monotonic sequence across reloads', () => {
  const { root, store } = makeStore()
  const job = createJob(store)
  store.appendEvent(job.id, { type: 'step.one', message: 'one' })
  store.appendEvent(job.id, { type: 'step.two', message: 'two', level: 'warn' })
  const events = store.readEvents(job.id)
  assert.deepEqual(events.map((event) => event.seq), [1, 2, 3])
  assert.equal(events[2].level, 'warn')

  // A fresh store has an empty in-memory sequence and must continue from disk.
  const reopened = new JobStore({ root })
  const event = reopened.appendEvent(job.id, { type: 'step.three', message: 'three' })
  assert.equal(event.seq, 4)
  assert.equal(reopened.readEvents(job.id, { limit: 2 }).length, 2)
})

test('job store: list is newest-first and filters by valid ids only', () => {
  const { root, store } = makeStore()
  const older = store.create({
    projectId: 'a',
    projectName: 'A',
    task: 'one',
    model: 'm/x',
    limits: {},
  })
  const newer = store.create({
    projectId: 'b',
    projectName: 'B',
    task: 'two',
    model: 'm/x',
    limits: {},
  })
  // Not a job id, so it must never appear in the list.
  fs.mkdirSync(path.join(root, 'not-a-job'), { recursive: true })
  const ids = store.list().map((job) => job.id)
  assert.deepEqual(ids, [newer.id, older.id])
})

test('job store: a corrupt manifest is reported and can never be overwritten', () => {
  const { root, store } = makeStore()
  const job = createJob(store)
  const manifest = jobPaths(job.id, root).manifest
  fs.writeFileSync(manifest, '{"broken": ', 'utf8')

  const corrupted = store.load(job.id)
  assert.equal(corrupted.status, 'corrupted')
  assert.equal(corrupted.corrupted, true)
  assert.equal(corrupted.error.class, 'corrupted_state')

  assert.throws(
    () => store.save(job, { status: 'running' }),
    (error) => error instanceof StudioError && error.code === 'corrupted_state',
  )
  assert.throws(
    () => store.update(job.id, { status: 'running' }),
    (error) => error instanceof StudioError && error.code === 'corrupted_state',
  )
  // The evidence on disk is untouched by the refused write.
  assert.equal(fs.readFileSync(manifest, 'utf8'), '{"broken": ')
})

test('job store: a manifest whose id does not match its directory is corrupt', () => {
  const { root, store } = makeStore()
  const job = createJob(store)
  const manifest = jobPaths(job.id, root).manifest
  writeFile(manifest, JSON.stringify({ ...job, id: 'job-00000000000000-deadbeef' }))
  const loaded = store.load(job.id)
  assert.equal(loaded.corrupted, true)
})

test('job store: invalid job ids and escaping paths are rejected before disk access', () => {
  const { root, store } = makeStore()
  for (const value of ['../job', 'job-', 'JOB-abcdef', 'job-abc', 'job-../../x', null, 7]) {
    assert.throws(
      () => jobPaths(value, root),
      (error) => error instanceof StudioError && error.code === 'invalid_job',
      String(value),
    )
  }
  assert.throws(
    () => findJobOrThrow(store, 'nope'),
    (error) => error instanceof StudioError && error.code === 'invalid_job',
  )
})

test('job store: artifacts are bounded to the job directory and readable', () => {
  const { root, store } = makeStore()
  const job = createJob(store)
  store.writeArtifact(job.id, 'artifacts/diff.patch', '--- a/x\n+++ b/x\n')
  assert.equal(store.readArtifactText(job.id, 'artifacts/diff.patch'), '--- a/x\n+++ b/x\n')
  assert.equal(fs.existsSync(path.join(root, job.id, 'artifacts', 'diff.patch')), true)

  for (const bad of ['../job.json', '..\\job.json', '/etc/passwd', 'C:\\Windows\\win.ini']) {
    assert.throws(
      () => store.artifactPath(job.id, bad),
      (error) => error instanceof StudioError && ['path_traversal', 'invalid_path'].includes(error.code),
      bad,
    )
  }
  assert.throws(
    () => store.readArtifactText(job.id, 'artifacts/missing.txt'),
    (error) => error instanceof StudioError && error.code === 'not_found',
  )
})

test('job store: oversized artifact previews are refused with 413', () => {
  const { store } = makeStore()
  const job = createJob(store)
  store.writeArtifact(job.id, 'artifacts/huge.json', 'x'.repeat(520_000))
  assert.throws(
    () => store.readArtifactText(job.id, 'artifacts/huge.json'),
    (error) => error instanceof StudioError && error.code === 'artifact_too_large' && error.status === 413,
  )
})

test('job store: discarding removes only the disposable workspace', () => {
  const { root, store } = makeStore()
  const job = createJob(store)
  store.writeArtifact(job.id, 'artifacts/candidate.json', '{"ok":true}\n')
  const workspaceFile = path.join(root, job.id, 'workspace', 'scripts', 'data.gd')
  writeFile(workspaceFile, 'extends RefCounted\n')
  store.discardWorkspace(job.id)
  assert.equal(fs.existsSync(path.join(root, job.id, 'workspace')), false)
  assert.equal(fs.existsSync(path.join(root, job.id, 'artifacts', 'candidate.json')), true)
  assert.equal(fs.existsSync(path.join(root, job.id, 'job.json')), true)
})

test('job store: legacy absolute artifact paths are served as job-relative ones', () => {
  const { root, store } = makeStore()
  const job = createJob(store)
  const dir = path.join(root, job.id)
  const absolute = path.join(dir, 'artifacts', 'after.png')
  writeFile(absolute, 'png-bytes')
  // Simulate an older manifest that recorded the absolute path.
  store.update(job.id, {
    artifacts: {
      after: { path: absolute, bytes: 9, sha256: 'x'.repeat(64) },
      diff: { path: 'artifacts/diff.patch', bytes: 3, sha256: 'y'.repeat(64) },
      outside: { path: path.join(root, 'elsewhere.png'), bytes: 1, sha256: 'z'.repeat(64) },
    },
  })

  const view = store.loadForView(job.id)
  assert.equal(view.artifacts.after.path, 'artifacts/after.png')
  assert.equal(view.artifacts.diff.path, 'artifacts/diff.patch')
  // A path outside the job is left untouched so containment keeps rejecting it.
  assert.equal(path.isAbsolute(view.artifacts.outside.path), true)
  // The manifest on disk is untouched; normalisation is a read-time view.
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'job.json'), 'utf8')).artifacts.after.path, absolute)
  assert.equal(store.artifactPath(job.id, view.artifacts.after.path), absolute)
})

test('job store: missing jobs load as null and unknown jobs are 404s', () => {
  const { store } = makeStore()
  const missing = 'job-20260101000000-abcdef12'
  assert.equal(store.load(missing), null)
  assert.throws(
    () => findJobOrThrow(store, missing),
    (error) => error instanceof StudioError && error.code === 'not_found' && error.status === 404,
  )
})
