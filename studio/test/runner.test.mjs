import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createAgentRunner } from '../server/lib/agent-runner.mjs'
import { JobStore } from '../server/lib/jobs.mjs'
import { StudioError } from '../server/lib/studio-paths.mjs'
import {
  agentOk,
  agentQuota,
  fakeProject,
  makeCanonical,
  runnerDeps,
  successAgent,
  tempRoot,
  waitFor,
  waitForJob,
} from './helpers.mjs'

function setup({ projectOverrides = {}, deps = {} } = {}) {
  const root = tempRoot('studio-runner-')
  const canonical = makeCanonical(path.join(root, 'canonical'))
  const store = new JobStore({ root: path.join(root, 'jobs') })
  const project = fakeProject(canonical, projectOverrides)
  const projects = {
    listRegisteredProjects: () => [project],
    getProject: (id) => {
      if (id !== project.id) throw new StudioError('invalid_project', 'Unknown project.', 404)
      return project
    },
    projectStatus: () => ({}),
  }
  const built = runnerDeps({
    projectRootImpl: () => canonical,
    ...deps,
  })
  const runner = createAgentRunner({ store, projects, deps: built.deps })
  return { root, canonical, store, project, runner, deps: built.deps, counters: built.counters }
}

function createJob(store, overrides = {}) {
  return store.create({
    projectId: 'fake-project',
    projectName: 'Fake Project',
    task: 'Change the fixture value to 42.',
    model: 'opencode/first-model',
    limits: { maxAttempts: 2, attemptTimeoutMs: 5000, maxRuntimeMs: 60000 },
    forbiddenFiles: ['tests/'],
    ...overrides,
  })
}

async function startJob(runner, store, overrides = {}) {
  const job = createJob(store, overrides)
  await runner.start(job.id)
  return job.id
}

test('runner: a successful candidate waits for approval and never touches canonical files', async () => {
  const { canonical, store, runner } = setup()
  const before = fs.readFileSync(path.join(canonical, 'scripts', 'other.gd'), 'utf8')
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'awaiting_approval')

  assert.equal(job.verification.ok, true)
  assert.deepEqual(
    job.verification.steps.map((step) => [step.id, step.skipped === true]),
    [
      ['import', false],
      ['static', false],
      ['test:unit', false],
      ['hidden', true],
    ],
  )
  assert.deepEqual(job.changedFiles.map((entry) => `${entry.status}:${entry.file}`), [
    'modified:scripts/data.gd',
  ])
  assert.ok(job.baselineHash)
  assert.ok(job.candidateHash)
  assert.ok(job.artifacts.diff)
  assert.ok(job.artifacts.candidate)
  assert.ok(job.artifacts.verification)
  for (const relative of ['artifacts/diff.patch', 'artifacts/candidate.json', 'artifacts/verification.json']) {
    assert.equal(fs.existsSync(path.join(store.paths(jobId).dir, relative)), true, relative)
  }

  // Independent reads of the canonical project still see the original value.
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8').includes('return 1'), true)
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'other.gd'), 'utf8'), before)
})

test('runner: approve applies only the allowed modified file and preserves siblings', async () => {
  const { canonical, store, runner } = setup()
  const otherBefore = fs.readFileSync(path.join(canonical, 'scripts', 'other.gd'), 'utf8')
  const readmeBefore = fs.readFileSync(path.join(canonical, 'README.md'), 'utf8')
  const jobId = await startJob(runner, store)
  const verified = await waitForJob(store, jobId, 'awaiting_approval')

  const approved = await runner.approve(jobId)
  assert.equal(approved.status, 'applied')
  assert.equal(approved.approval.appliedFiles.length, 1)
  assert.equal(approved.approval.appliedFiles[0].file, 'scripts/data.gd')
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8').includes('return 42'), true)
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'other.gd'), 'utf8'), otherBefore)
  assert.equal(fs.readFileSync(path.join(canonical, 'README.md'), 'utf8'), readmeBefore)
  // The applied file now matches the verified candidate hash exactly.
  assert.equal(approved.approval.appliedFiles[0].afterSha256, verified.changedFiles[0].afterSha256)

  // Discard after apply cleans only the disposable workspace, keeping evidence.
  const discarded = await runner.discard(jobId)
  assert.equal(discarded.status, 'applied')
  assert.equal(fs.existsSync(store.paths(jobId).workspace), false)
  assert.equal(fs.existsSync(path.join(store.paths(jobId).dir, 'artifacts', 'candidate.json')), true)
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8').includes('return 42'), true)
})

test('runner: a change outside the allowlist fails the job and is never applicable', async () => {
  const { canonical, store, runner } = setup({
    deps: {
      runAgentImpl: async ({ workspace }) => {
        fs.writeFileSync(path.join(workspace, 'scripts', 'data.gd'), 'extends RefCounted\n\nfunc value() -> int:\n\treturn 42\n', 'utf8')
        fs.writeFileSync(path.join(workspace, 'scripts', 'other.gd'), 'extends RefCounted\n\nfunc other() -> int:\n\treturn 99\n', 'utf8')
        return agentOk()
      },
    },
  })
  const otherCanonical = fs.readFileSync(path.join(canonical, 'scripts', 'other.gd'), 'utf8')
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'failed')

  assert.equal(job.error.class, 'scope_violation')
  assert.equal(job.error.requiresModelSwitch, false)
  assert.match(job.error.message, /outside the allowed list: scripts\/other\.gd/)
  assert.equal(job.attempts[0].status, 'scope_violation')
  assert.ok(job.artifacts.diff, 'the rejected candidate diff is preserved as evidence')
  const rejected = store.readEvents(jobId).find((event) => event.type === 'scope.rejected')
  assert.ok(rejected, 'the operator log names the real file-policy breach')
  assert.match(rejected.message, /outside the allowed list/)
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'other.gd'), 'utf8'), otherCanonical)
  await assert.rejects(
    runner.approve(jobId),
    (error) => error instanceof StudioError && error.code === 'invalid_state',
  )
})

test('runner: an agent that changes nothing is rejected instead of approved', async () => {
  const { store, runner } = setup({
    deps: { runAgentImpl: async () => agentOk() },
  })
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'failed')
  assert.equal(job.error.class, 'scope_violation')
  assert.match(job.error.message, /made no change/i)
  const noChangeEvent = store.readEvents(jobId).find((event) => event.type === 'scope.no_change')
  assert.ok(noChangeEvent, 'the operator log names a no-change refusal, not a file-policy breach')
  assert.match(noChangeEvent.message, /without changing an allowed file/)
})

test('runner: feature mode accepts an added script and approval creates it', async () => {
  const featureAgent = {
    enabled: true,
    allowedFiles: ['scripts/data.gd'],
    allowedPatterns: ['scripts/**/*.gd', 'scenes/**', 'assets/**'],
    allowAdditions: true,
    protectedPaths: ['tests/**', 'project.godot'],
    note: 'Feature fixture.',
    maxAttempts: 1,
    timeoutMs: 5000,
    defaultModel: 'opencode/deepseek-v4.1-flash-free',
  }
  const { canonical, store, runner } = setup({
    projectOverrides: { agent: featureAgent },
    deps: {
      runAgentImpl: async ({ workspace }) => {
        fs.writeFileSync(
          path.join(workspace, 'scripts', 'data.gd'),
          'extends RefCounted\n\nfunc value() -> int:\n\treturn 42\n',
          'utf8',
        )
        fs.mkdirSync(path.join(workspace, 'scripts', 'combat'), { recursive: true })
        fs.writeFileSync(
          path.join(workspace, 'scripts', 'combat', 'damage.gd'),
          'extends RefCounted\n\nfunc damage() -> int:\n\treturn 34\n',
          'utf8',
        )
        return agentOk()
      },
    },
  })
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'awaiting_approval')
  assert.deepEqual(
    job.changedFiles.map((entry) => `${entry.status}:${entry.file}`).sort(),
    ['added:scripts/combat/damage.gd', 'modified:scripts/data.gd'],
  )
  // Nothing is written before approval.
  assert.equal(fs.existsSync(path.join(canonical, 'scripts', 'combat', 'damage.gd')), false)

  const approved = await runner.approve(jobId)
  assert.equal(approved.status, 'applied')
  assert.deepEqual(
    approved.approval.appliedFiles.map((entry) => `${entry.status}:${entry.file}`).sort(),
    ['added:scripts/combat/damage.gd', 'modified:scripts/data.gd'],
  )
  assert.match(fs.readFileSync(path.join(canonical, 'scripts', 'combat', 'damage.gd'), 'utf8'), /return 34/)
  assert.match(fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8'), /return 42/)
})

test('runner: feature mode still refuses a protected file', async () => {
  const { canonical, store, runner } = setup({
    projectOverrides: {
      agent: {
        enabled: true,
        allowedFiles: ['scripts/data.gd'],
        allowedPatterns: ['scripts/**/*.gd'],
        allowAdditions: true,
        protectedPaths: ['tests/**', 'project.godot'],
        note: 'Feature fixture.',
        maxAttempts: 1,
        timeoutMs: 5000,
        defaultModel: 'opencode/deepseek-v4.1-flash-free',
      },
    },
    deps: {
      runAgentImpl: async ({ workspace }) => {
        fs.writeFileSync(path.join(workspace, 'scripts', 'data.gd'), 'extends RefCounted\n', 'utf8')
        fs.writeFileSync(path.join(workspace, 'tests', 'run_tests.gd'), '# weakened\n', 'utf8')
        return agentOk()
      },
    },
  })
  const testsBefore = fs.readFileSync(path.join(canonical, 'tests', 'run_tests.gd'), 'utf8')
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'failed')
  assert.equal(job.error.class, 'scope_violation')
  assert.match(job.error.message, /protected file: tests\/run_tests\.gd/)
  assert.equal(fs.readFileSync(path.join(canonical, 'tests', 'run_tests.gd'), 'utf8'), testsBefore)
})

test('runner: a suite marked baseline:false is skipped on the untouched baseline', async () => {
  let testCalls = 0
  const { store, runner } = setup({
    projectOverrides: {
      tests: [{ id: 'unit', label: 'Unit suite', script: 'res://tests/run_tests.gd', timeoutMs: 5000, baseline: false }],
    },
    deps: {
      runScriptTestImpl: async () => {
        testCalls += 1
        return {
          available: true,
          ok: true,
          summary: { passed: 3, failed: 0 },
          results: [{ name: 'fixture', passed: true, detail: 'ok' }],
          errors: [],
          warnings: [],
          durationMs: 1,
        }
      },
    },
  })
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'awaiting_approval')
  assert.equal(job.baseline.tests[0].skipped, true)
  assert.match(job.baseline.tests[0].reason, /untouched baseline/i)
  const skipped = store.readEvents(jobId).find((event) => event.type === 'baseline.test_skipped')
  assert.ok(skipped, 'the skip is recorded instead of pretending the baseline passed')
  assert.equal(testCalls, 1, 'only the candidate verification ran the suite')
})

test('runner: a failing baseline never calls the agent', async () => {  let agentCalls = 0
  const { store, runner } = setup({
    deps: {
      staticCheckProjectImpl: async () => ({
        available: true,
        ok: false,
        mode: 'fixture',
        errors: ['scripts/data.gd: Parse Error'],
        warnings: [],
        diagnostics: [],
        fileCount: 3,
      }),
      runAgentImpl: async () => {
        agentCalls += 1
        return agentOk()
      },
    },
  })
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'failed')
  assert.equal(job.error.class, 'baseline_failed')
  assert.equal(job.error.resumable, false)
  assert.equal(agentCalls, 0)
  assert.equal(job.attempts.length, 0)
})

test('runner: verification failure repairs once, keeps both attempts, then passes', async () => {
  let testCalls = 0
  const { store, runner } = setup({
    deps: {
      runScriptTestImpl: async () => {
        testCalls += 1
        // baseline -> ok, first verification -> fail, repair verification -> ok
        const ok = testCalls !== 2
        return {
          available: true,
          ok,
          summary: ok ? { passed: 3, failed: 0 } : { passed: 2, failed: 1 },
          results: ok
            ? [{ name: 'fixture', passed: true, detail: 'ok' }]
            : [{ name: 'fixture', passed: false, detail: 'value was 7' }],
          errors: [],
          warnings: [],
          durationMs: 1,
        }
      },
    },
  })
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'awaiting_approval')
  assert.equal(job.attempts.length, 2)
  assert.equal(job.attempts[0].status, 'verification_failed')
  assert.equal(job.attempts[0].verification.ok, false)
  assert.equal(job.attempts[1].status, 'passed')
  assert.equal(job.attempts[1].verification.ok, true)
  assert.equal(testCalls, 3)
  assert.ok(store.readEvents(jobId).some((event) => event.type === 'attempt.retry'))
})

test('runner: exhausted verification attempts end failed with preserved evidence', async () => {
  let testCalls = 0
  const { store, runner } = setup({
    deps: {
      runScriptTestImpl: async () => {
        testCalls += 1
        // The untouched baseline must pass so the agent is called; every
        // candidate verification then fails.
        const ok = testCalls === 1
        return {
          available: true,
          ok,
          summary: ok ? { passed: 1, failed: 0 } : { passed: 0, failed: 1 },
          results: ok
            ? [{ name: 'fixture', passed: true, detail: 'ok' }]
            : [{ name: 'fixture', passed: false, detail: 'always fails' }],
          errors: [],
          warnings: [],
          durationMs: 1,
        }
      },
    },
  })
  const jobId = await startJob(runner, store, { limits: { maxAttempts: 1, attemptTimeoutMs: 5000, maxRuntimeMs: 60000 } })
  const job = await waitForJob(store, jobId, 'failed')
  assert.equal(job.error.class, 'verification_failed')
  assert.equal(job.error.resumable, true)
  assert.equal(job.attempts.length, 1)
  assert.equal(job.attempts[0].status, 'verification_failed')
  assert.match(job.lastFailure, /always fails/)
})

test('runner: a repair that makes no change after a verified failure keeps the reason', async () => {
  let agentCalls = 0
  let testCalls = 0
  const { store, runner } = setup({
    deps: {
      runAgentImpl: async ({ workspace }) => {
        agentCalls += 1
        // Attempt 1 breaks the fixture; attempt 2 writes the baseline bytes
        // back, which is a no-change candidate rather than a passing repair.
        const text =
          agentCalls === 1
            ? 'extends RefCounted\n\nfunc value() -> int:\n\treturn 42\n'
            : 'extends RefCounted\n\nfunc value() -> int:\n\treturn 1\n'
        fs.writeFileSync(path.join(workspace, 'scripts', 'data.gd'), text, 'utf8')
        return agentOk()
      },
      runScriptTestImpl: async () => {
        testCalls += 1
        const ok = testCalls === 1 // only the untouched baseline passes
        return {
          available: true,
          ok,
          summary: ok ? { passed: 1, failed: 0 } : { passed: 0, failed: 1 },
          results: ok
            ? [{ name: 'fixture', passed: true, detail: 'ok' }]
            : [{ name: 'fixture', passed: false, detail: 'expected 1, got 42' }],
          errors: [],
          warnings: [],
          durationMs: 1,
        }
      },
    },
  })
  const jobId = await startJob(runner, store)
  const job = await waitForJob(store, jobId, 'failed')

  assert.equal(job.error.class, 'scope_violation')
  // The headline must not reduce a failed verification to "made no change".
  assert.match(job.error.message, /made no change/i)
  assert.match(job.error.message, /Unit suite/)
  assert.match(job.error.message, /expected 1, got 42/)
  // The repair handoff keeps the verified failure it was trying to fix.
  assert.match(job.lastFailure, /Verified failure after attempt 1/)
  assert.match(job.lastFailure, /Repair made no change/)
  assert.equal(job.attempts.length, 2)
  assert.equal(job.attempts[0].status, 'verification_failed')
  assert.equal(job.attempts[1].status, 'scope_violation')
})

test('runner: quota failures stop immediately and require a different model to resume', async () => {
  let agentCalls = 0
  const { store, runner, counters } = setup({
    deps: {
      runAgentImpl: async (context) => {
        agentCalls += 1
        if (agentCalls === 1) return agentQuota()
        fs.writeFileSync(
          path.join(context.workspace, 'scripts', 'data.gd'),
          'extends RefCounted\n\nfunc value() -> int:\n\treturn 42\n',
          'utf8',
        )
        return agentOk()
      },
    },
  })
  const jobId = await startJob(runner, store)
  const failed = await waitForJob(store, jobId, 'failed')
  assert.equal(failed.error.class, 'quota')
  assert.equal(failed.error.requiresModelSwitch, true)
  assert.equal(failed.attempts.length, 1)
  assert.equal(failed.attempts[0].status, 'provider_failed')
  assert.equal(agentCalls, 1, 'quota must not trigger repeated provider attempts')
  assert.ok(!store.readEvents(jobId).some((event) => event.type === 'verify.static'), 'verification did not run')

  const before = counters.tests
  await assert.rejects(
    runner.resume(jobId, { model: 'opencode/first-model' }),
    (error) => error instanceof StudioError && error.code === 'model_switch_required',
  )
  assert.equal(counters.tests, before, 'a refused resume must not rerun verification')
  assert.equal((await store.load(jobId)).status, 'failed')

  const resumed = await runner.resume(jobId, { model: 'opencode/second-model' })
  assert.equal(resumed.status, 'running')
  const done = await waitForJob(store, jobId, 'awaiting_approval')
  assert.equal(done.model, 'opencode/second-model')
  assert.deepEqual(done.modelHistory.map((entry) => entry.reason), ['initial', 'resume'])
  assert.equal(done.attempts.length, 2)
  assert.equal(done.attempts[0].status, 'provider_failed')
  assert.equal(done.attempts[1].status, 'passed')
  assert.equal(done.verification.ok, true)
  // Baseline ran once before failure; the resumed candidate was verified again.
  assert.equal(counters.tests, before + 1)
  assert.ok(store.readEvents(jobId).some((event) => event.type === 'job.resumed'))
})

test('runner: a retryable provider failure can resume with the same model', async () => {
  let agentCalls = 0
  const { store, runner } = setup({
    deps: {
      runAgentImpl: async (context) => {
        agentCalls += 1
        if (agentCalls === 1) {
          return agentOk({
            code: 2,
            stderr: 'unexpected failure',
            classification: { class: 'exited', stop: true, retryable: true, message: 'The agent exited with code 2.', code: 2 },
          })
        }
        return successAgent()(context)
      },
    },
  })
  const jobId = await startJob(runner, store)
  const failed = await waitForJob(store, jobId, 'failed')
  assert.equal(failed.error.class, 'exited')
  assert.equal(failed.error.requiresModelSwitch, false)
  await runner.resume(jobId, { model: 'opencode/first-model' })
  const done = await waitForJob(store, jobId, 'awaiting_approval')
  assert.equal(done.model, 'opencode/first-model')
  assert.equal(done.attempts.length, 2)
})

test('runner: cancellation preserves the workspace and records the cancelled attempt', async () => {
  let release
  const hangingAgent = ({ signal }) =>
    new Promise((resolve) => {
      release = () =>
        resolve(
          agentOk({
            code: null,
            aborted: true,
            classification: { class: 'cancelled', stop: true, retryable: false, message: 'cancelled', code: null },
          }),
        )
      if (signal.aborted) release()
      else signal.addEventListener('abort', release, { once: true })
    })
  const { store, runner } = setup({ deps: { runAgentImpl: hangingAgent } })
  const jobId = await startJob(runner, store)
  await waitFor(
    () => store.load(jobId),
    (job) => job?.status === 'running' && job.attempts?.[0]?.status === 'running',
  )
  await runner.cancel(jobId)
  const cancelled = await waitForJob(store, jobId, 'cancelled')
  assert.equal(cancelled.attempts.length, 1)
  assert.equal(cancelled.attempts[0].status, 'cancelled')
  assert.equal(fs.existsSync(store.paths(jobId).workspace), true)
  assert.ok(store.readEvents(jobId).some((event) => event.type === 'job.cancelled'))
  // Cancelling again is refused rather than silently repeated.
  await assert.rejects(
    runner.cancel(jobId),
    (error) => error instanceof StudioError && error.code === 'invalid_state',
  )
  void release
})

test('runner: a resumed job refuses a workspace that changed while stopped', async () => {
  const { store, runner } = setup({
    deps: { runAgentImpl: async () => agentQuota() },
  })
  const jobId = await startJob(runner, store)
  await waitForJob(store, jobId, 'failed')
  fs.appendFileSync(path.join(store.paths(jobId).workspace, 'scripts', 'data.gd'), '\n# tampered\n', 'utf8')

  await assert.rejects(
    runner.resume(jobId, { model: 'opencode/second-model' }),
    (error) => error instanceof StudioError && error.code === 'resume_conflict',
  )
  const job = await store.load(jobId)
  assert.equal(job.status, 'failed')
  assert.equal(job.error.class, 'resume_conflict')
  assert.equal(job.resume.conflict.actual !== job.resume.conflict.expected, true)
})

test('runner: resume refuses a deleted workspace instead of re-running silently', async () => {
  const { store, runner } = setup({ deps: { runAgentImpl: async () => agentQuota() } })
  const jobId = await startJob(runner, store)
  await waitForJob(store, jobId, 'failed')
  fs.rmSync(store.paths(jobId).workspace, { recursive: true, force: true })
  await assert.rejects(
    runner.resume(jobId, { model: 'opencode/second-model' }),
    (error) => error instanceof StudioError && error.code === 'workspace_missing',
  )
})

test('runner: approval refuses a workspace tampered after verification', async () => {
  const { canonical, store, runner } = setup()
  const jobId = await startJob(runner, store)
  await waitForJob(store, jobId, 'awaiting_approval')
  fs.appendFileSync(path.join(store.paths(jobId).workspace, 'scripts', 'data.gd'), '\n# tampered\n', 'utf8')

  await assert.rejects(
    runner.approve(jobId),
    (error) => error instanceof StudioError && error.code === 'resume_conflict',
  )
  const job = await store.load(jobId)
  assert.equal(job.status, 'failed')
  assert.equal(job.error.class, 'resume_conflict')
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8').includes('return 1'), true)
})

test('runner: approval refuses to overwrite a canonical file that changed independently', async () => {
  const { canonical, store, runner } = setup()
  const jobId = await startJob(runner, store)
  await waitForJob(store, jobId, 'awaiting_approval')
  fs.writeFileSync(path.join(canonical, 'scripts', 'data.gd'), 'extends RefCounted\n\nfunc value() -> int:\n\treturn 7\n', 'utf8')

  await assert.rejects(
    runner.approve(jobId),
    (error) => error instanceof StudioError && error.code === 'canonical_changed',
  )
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8').includes('return 7'), true)
  assert.equal((await store.load(jobId)).status, 'awaiting_approval')
})

test('runner: corrupted job state blocks approve, discard, cancel and resume', async () => {
  const { store, runner } = setup()
  const jobId = await startJob(runner, store, {})
  await waitForJob(store, jobId, 'awaiting_approval')
  fs.writeFileSync(store.paths(jobId).manifest, '{"id": ', 'utf8')

  for (const action of [
    () => runner.approve(jobId),
    () => runner.discard(jobId),
    () => runner.cancel(jobId),
    () => runner.resume(jobId, { model: 'opencode/second-model' }),
  ]) {
    await assert.rejects(
      action,
      (error) => error instanceof StudioError && error.code === 'corrupted_state',
    )
  }
})

test('runner: discard is idempotent and leaves canonical files untouched', async () => {
  const { canonical, store, runner } = setup()
  const jobId = await startJob(runner, store)
  await waitForJob(store, jobId, 'awaiting_approval')
  const before = fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8')

  const first = await runner.discard(jobId)
  assert.equal(first.status, 'discarded')
  const second = await runner.discard(jobId)
  assert.equal(second.status, 'discarded')
  assert.equal(fs.readFileSync(path.join(canonical, 'scripts', 'data.gd'), 'utf8'), before)
  assert.equal(fs.existsSync(store.paths(jobId).workspace), false)
  assert.equal(fs.existsSync(path.join(store.paths(jobId).dir, 'artifacts', 'diff.patch')), true)
})
