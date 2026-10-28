import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import { createOperations } from '../server/lib/operations.mjs'
import { ARTIFACT_ROOT, StudioError } from '../server/lib/studio-paths.mjs'
import { tempRoot } from './helpers.mjs'

const OK_CHECK = {
  available: true,
  ok: true,
  mode: 'fixture',
  errors: [],
  warnings: [],
  diagnostics: [],
  fileCount: 3,
}

const OK_TEST = {
  available: true,
  ok: true,
  summary: { passed: 4, failed: 0 },
  results: [{ name: 'fixture', passed: true, detail: 'ok' }],
  errors: [],
  warnings: [],
  durationMs: 2,
}

function baseDeps(overrides = {}) {
  return {
    staticCheckProjectImpl: async () => OK_CHECK,
    runScriptTestImpl: async () => OK_TEST,
    projectRootImpl: () => current.projectRoot,
    hashFile: () => 'a'.repeat(64),
    fetchImpl: async () => ({ ok: true, status: 200 }),
    ...overrides,
  }
}

const current = { projectRoot: null }

function setup({ deps = {}, sessionFactory = null } = {}) {
  current.projectRoot = tempRoot('studio-op-project-')
  const root = tempRoot('studio-ops-')
  const operations = createOperations({
    root,
    deps: baseDeps(deps),
    sessionFactory,
  })
  return { root, projectRoot: current.projectRoot, operations }
}

function fakeSessionFactory(overrides = {}) {
  const calls = []
  const factory = ({ projectDir, headless }) => {
    const session = {
      child: { pid: 4321 },
      pid: 4321,
      headless: Boolean(headless),
      stdoutLines: ['godot booted'],
      stderrLines: [],
      started: false,
      paused: false,
      calls,
      async start() {
        session.started = true
        calls.push('start')
        return { pid: 4321, ready: true }
      },
      async stop() {
        session.child = null
        calls.push('stop')
        return { alreadyStopped: false }
      },
      async pause() {
        session.paused = true
        calls.push('pause')
        return {}
      },
      async resume() {
        session.paused = false
        calls.push('resume')
        return {}
      },
      async captureFrame({ path: resPath, scenario, metadata }) {
        const relative = resPath.replace(/^res:\/\//, '')
        const target = path.join(projectDir, ...relative.split('/'))
        fs.mkdirSync(path.dirname(target), { recursive: true })
        fs.writeFileSync(target, Buffer.from('89504e470d0a1a0a', 'hex'))
        calls.push('capture')
        return {
          captured_at: '2026-01-01T00:00:00.000Z',
          scenario,
          width: 320,
          height: 180,
          paused: true,
          sim_time_seconds: 1.5,
          state_after: { player_position: [1, 2, 3], metadata },
        }
      },
      async reset() {
        calls.push('reset')
        return { player_position: [0, 0, 0], chunks: { huge: true } }
      },
      async step({ steps, input }) {
        calls.push(`step:${steps}`)
        return { player_position: [steps, 0, 0], input }
      },
      ...overrides,
    }
    return session
  }
  return { factory, calls }
}

test('operations: a static check is recorded and readable after the fact', async () => {
  const { operations } = setup()
  const record = await operations.run('voxel-sandbox', 'check', {})
  assert.equal(record.status, 'ok')
  assert.equal(record.projectId, 'voxel-sandbox')
  assert.equal(record.op, 'check')
  assert.equal(record.result.fileCount, 3)
  assert.match(record.summary, /3 script\(s\) parsed cleanly/)

  const reloaded = operations.getOp(record.id)
  assert.equal(reloaded.id, record.id)
  assert.equal(reloaded.status, 'ok')
  assert.equal(operations.listOps({ projectId: 'voxel-sandbox' })[0].id, record.id)
  assert.deepEqual(operations.latestForProject('voxel-sandbox')[0].op, 'check')
  assert.throws(
    () => operations.getOp('../../etc/passwd'),
    (error) => error instanceof StudioError && error.code === 'invalid_op',
  )
  assert.throws(
    () => operations.getOp('op-20260101000000-abcdef12'),
    (error) => error instanceof StudioError && error.code === 'not_found',
  )
})

test('operations: unknown operations and unregistered test suites are refused', async () => {
  const { operations } = setup()
  await assert.rejects(
    operations.run('voxel-sandbox', 'shell', {}),
    (error) => error instanceof StudioError && error.code === 'invalid_op',
  )
  await assert.rejects(
    operations.run('voxel-sandbox', 'exec', { cmd: 'whoami' }),
    (error) => error instanceof StudioError && error.code === 'invalid_op',
  )
  await assert.rejects(
    operations.run('missing-project', 'check', {}),
    (error) => error instanceof StudioError && error.code === 'invalid_project',
  )

  const badTest = await operations.run('voxel-sandbox', 'test', { testId: 'shell --version' })
  assert.equal(badTest.status, 'failed')
  assert.equal(badTest.error.class, 'invalid_test')
  assert.equal(badTest.error.status, 400)

  const noTestId = await operations.run('voxel-sandbox', 'test', {})
  assert.equal(noTestId.status, 'failed')
  assert.equal(noTestId.error.class, 'invalid_test')
})

test('operations: a registered test suite runs through the fixed harness', async () => {
  const { operations } = setup()
  const record = await operations.run('voxel-sandbox', 'test', { testId: 'voxel-public' })
  assert.equal(record.status, 'ok')
  assert.equal(record.result.suite.id, 'voxel-public')
  assert.equal(record.result.summary.passed, 4)
  assert.match(record.summary, /4 passed, 0 failed in Voxel public suite/)
})

test('operations: native session launch, capture, advance, reset and stop form one owned lifecycle', async () => {
  const { factory, calls } = fakeSessionFactory()
  const { operations } = setup({ sessionFactory: factory })
  const projectId = 'voxel-sandbox'
  const captureArtifacts = []

  try {
    const wrong = await operations.run(projectId, 'capture', {})
    assert.equal(wrong.status, 'failed')
    assert.equal(wrong.error.class, 'session_not_running')

    const launch = await operations.run(projectId, 'launch', {})
    assert.equal(launch.status, 'ok')
    assert.equal(launch.result.pid, 4321)
    assert.equal(launch.result.alreadyRunning, false)
    assert.equal(operations.sessionSummary(projectId).running, true)

    const again = await operations.run(projectId, 'launch', {})
    assert.equal(again.result.alreadyRunning, true)
    assert.equal(calls.filter((entry) => entry === 'start').length, 1)

    const advance = await operations.run(projectId, 'advance', { steps: 12, input: { forward: 1 } })
    assert.equal(advance.status, 'ok')
    assert.equal(advance.result.steps, 12)
    assert.deepEqual(advance.result.input, { forward: 1 })
    assert.equal(advance.result.snapshot.input.forward, 1)

    const invalid = await operations.run(projectId, 'advance', { steps: 3, input: { forward: 5 } })
    assert.equal(invalid.status, 'failed')
    assert.equal(invalid.error.class, 'invalid_input')
    assert.equal(invalid.error.status, 400)

    const badSteps = await operations.run(projectId, 'advance', { steps: 0 })
    assert.equal(badSteps.status, 'failed')
    assert.equal(badSteps.error.class, 'invalid_input')

    const capture = await operations.run(projectId, 'capture', {})
    assert.equal(capture.status, 'ok')
    assert.equal(capture.artifact.contentType, 'image/png')
    assert.match(capture.artifact.path, /^artifacts\/voxel-sandbox\/capture-/)
    const absolute = path.join(ARTIFACT_ROOT, projectId, path.basename(capture.artifact.path))
    captureArtifacts.push(absolute)
    assert.equal(fs.existsSync(absolute), true)
    assert.ok(fs.statSync(absolute).size > 0)
    assert.equal(capture.result.frame.width, 320)
    assert.equal(capture.result.state.player_position[2], 3)

    const reset = await operations.run(projectId, 'reset', {})
    assert.equal(reset.status, 'ok')
    assert.deepEqual(reset.result.snapshot.player_position, [0, 0, 0])
    assert.equal(reset.result.snapshot.chunks, '[chunk map omitted]')

    const logs = await operations.run(projectId, 'logs', {})
    assert.equal(logs.status, 'ok')
    assert.equal(logs.result.running, true)
    assert.deepEqual(logs.logs.stdout, ['godot booted'])

    const stop = await operations.run(projectId, 'stop', {})
    assert.equal(stop.status, 'ok')
    assert.equal(stop.result.stopped, true)
    assert.equal(operations.sessionSummary(projectId).running, false)

    const afterStop = await operations.run(projectId, 'capture', {})
    assert.equal(afterStop.status, 'failed')
    assert.equal(afterStop.error.class, 'session_not_running')

    const staleLogs = await operations.run(projectId, 'logs', {})
    assert.equal(staleLogs.status, 'ok')
    assert.equal(staleLogs.result.running, false)
    assert.ok(staleLogs.result.fromOp)
  } finally {
    for (const file of captureArtifacts) fs.rmSync(file, { force: true })
    await operations.stopAll()
  }
})

test('operations: capture measures the real PNG header when Godot omits dimensions', async () => {
  const { factory } = fakeSessionFactory()
  const png = ({ projectDir }) => {
    const session = factory({ projectDir })
    session.captureFrame = async ({ path: resPath }) => {
      const target = path.join(projectDir, ...resPath.replace(/^res:\/\//, '').split('/'))
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const buffer = Buffer.alloc(24)
      buffer.writeUInt32BE(0x89504e47, 0)
      buffer.writeUInt32BE(0x0d0a1a0a, 4)
      buffer.writeUInt32BE(800, 16)
      buffer.writeUInt32BE(450, 20)
      fs.writeFileSync(target, buffer)
      return { captured_at: '2026-01-01T00:00:00.000Z', scenario: 'studio', paused: true }
    }
    return session
  }
  const { operations } = setup({ sessionFactory: png })
  const artifacts = []
  try {
    await operations.run('voxel-sandbox', 'launch', {})
    const capture = await operations.run('voxel-sandbox', 'capture', {})
    assert.equal(capture.status, 'ok')
    assert.equal(capture.result.frame.width, 800)
    assert.equal(capture.result.frame.height, 450)
    assert.match(capture.summary, /\(800x450\)/)
    artifacts.push(path.join(ARTIFACT_ROOT, 'voxel-sandbox', path.basename(capture.artifact.path)))
  } finally {
    for (const file of artifacts) fs.rmSync(file, { force: true })
    await operations.stopAll()
  }
})

test('operations: launch failure reports the blocker and leaves no session', async () => {
  const { factory } = fakeSessionFactory()
  const failing = ({ projectDir, headless }) => {
    const session = factory({ projectDir, headless })
    session.start = async () => {
      throw new Error('Vulkan device creation failed')
    }
    return session
  }
  const { operations } = setup({ sessionFactory: failing })
  const record = await operations.run('voxel-sandbox', 'launch', {})
  assert.equal(record.status, 'failed')
  assert.equal(record.error.class, 'launch_failed')
  assert.equal(record.error.status, 502)
  assert.match(record.error.message, /Vulkan device creation failed/)
  assert.equal(operations.sessionSummary('voxel-sandbox').running, false)
})

test('operations: a second concurrent operation for the same project is rejected as busy', async () => {
  let release
  const gate = new Promise((resolve) => {
    release = resolve
  })
  const { operations } = setup({
    deps: {
      staticCheckProjectImpl: async () => {
        await gate
        return OK_CHECK
      },
    },
  })
  const first = operations.run('voxel-sandbox', 'check', {})
  await assert.rejects(
    operations.run('voxel-sandbox', 'check', {}),
    (error) => error instanceof StudioError && error.code === 'busy' && error.status === 409,
  )
  release()
  const record = await first
  assert.equal(record.status, 'ok')
  // The lock is released after the first operation finishes.
  const next = await operations.run('voxel-sandbox', 'check', {})
  assert.equal(next.status, 'ok')
})

test('operations: preview reports real native state and browser reachability', async () => {
  const { factory } = fakeSessionFactory()
  const reachable = setup({
    sessionFactory: factory,
    deps: { fetchImpl: async () => ({ ok: true, status: 200 }) },
  })
  await reachable.operations.run('voxel-sandbox', 'launch', {})
  const preview = await reachable.operations.preview('voxel-sandbox')
  assert.equal(preview.projectId, 'voxel-sandbox')
  assert.equal(preview.native.running, true)
  assert.equal(preview.browser.configured, true)
  assert.equal(preview.browser.reachable, true)
  assert.equal(preview.browser.status, 200)
  assert.equal(preview.controls.movement.includes('jump'), true)
  await reachable.operations.stopAll()

  const unreachable = setup({
    deps: {
      fetchImpl: async () => {
        const error = new Error('connect ECONNREFUSED 127.0.0.1:8790')
        throw error
      },
    },
  })
  const offline = await unreachable.operations.preview('voxel-sandbox')
  assert.equal(offline.browser.configured, true)
  assert.equal(offline.browser.reachable, false)
  assert.match(offline.browser.error, /ECONNREFUSED/)

  const deflect = await unreachable.operations.preview('deflect-arena')
  assert.equal(deflect.browser.configured, false)
  assert.equal(deflect.browser.url, null)
})

test('operations: export has an explicit disabled state when the preset is unavailable', async () => {
  const { operations } = setup()
  const record = await operations.run('voxel-sandbox', 'export', {})
  assert.equal(record.status, 'failed')
  assert.equal(record.error.class, 'export_unsupported')
  assert.match(record.error.message, /export_presets\.cfg is missing/)
})

test('operations: logs with no session and no history is an explicit failure, not an empty success', async () => {
  const { operations } = setup()
  const record = await operations.run('deflect-arena', 'logs', {})
  assert.equal(record.status, 'failed')
  assert.equal(record.error.class, 'no_logs')
  assert.equal(record.error.status, 404)
})

test('operations: stopAll tears down every owned session', async () => {
  const { factory, calls } = fakeSessionFactory()
  const { operations } = setup({ sessionFactory: factory })
  await operations.run('voxel-sandbox', 'launch', {})
  await operations.run('deflect-arena', 'launch', {})
  assert.equal(operations.sessions.size, 2)
  const results = await operations.stopAll()
  assert.equal(results.length, 2)
  assert.equal(calls.filter((entry) => entry === 'stop').length, 2)
  assert.equal(operations.sessions.size, 0)
})
