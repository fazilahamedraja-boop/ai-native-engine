import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function tempRoot(prefix = 'studio-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}

export function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents, 'utf8')
  return file
}

export function makeCanonical(root) {
  writeFile(
    path.join(root, 'scripts', 'data.gd'),
    'extends RefCounted\n\nfunc value() -> int:\n\treturn 1\n',
  )
  writeFile(
    path.join(root, 'scripts', 'other.gd'),
    'extends RefCounted\n\nfunc other() -> int:\n\treturn 2\n',
  )
  writeFile(
    path.join(root, 'tests', 'run_tests.gd'),
    'extends SceneTree\n\nfunc _initialize() -> void:\n\tquit(0)\n',
  )
  writeFile(path.join(root, 'project.godot'), 'config_version=5\n')
  writeFile(path.join(root, 'README.md'), 'fixture project\n')
  return root
}

export function fakeProject(root, overrides = {}) {
  return {
    id: 'fake-project',
    name: 'Fake Project',
    tagline: 'A controlled fixture.',
    root: 'fake',
    accent: '#5cc8a1',
    runModes: ['native'],
    tests: [
      {
        id: 'unit',
        label: 'Unit suite',
        script: 'res://tests/run_tests.gd',
        timeoutMs: 5000,
      },
    ],
    hiddenTest: null,
    agent: {
      enabled: true,
      allowedFiles: ['scripts/data.gd'],
      note: 'Only scripts/data.gd may change.',
      maxAttempts: 2,
      timeoutMs: 5000,
      defaultModel: 'opencode/deepseek-v4.1-flash-free',
    },
    controls: { movement: ['forward'], actions: [] },
    smoke: null,
    exportPreset: null,
    browser: null,
    ...overrides,
  }
}

export function agentOk(overrides = {}) {
  return {
    code: 0,
    timedOut: false,
    aborted: false,
    durationMs: 5,
    stdout: '{"type":"text","part":{"text":"done"}}\n',
    stderr: '',
    classification: { class: 'none', stop: false, retryable: false, message: null, code: 0 },
    transcriptRelative: null,
    stderrRelative: null,
    ...overrides,
  }
}

export function agentQuota() {
  return agentOk({
    code: 1,
    stdout: '',
    stderr: 'HTTP 429: rate limit exceeded; quota exhausted',
    classification: {
      class: 'quota',
      stop: true,
      retryable: false,
      message: 'HTTP 429: rate limit exceeded; quota exhausted',
      code: 1,
    },
  })
}

export function successAgent(text = 'extends RefCounted\n\nfunc value() -> int:\n\treturn 42\n') {
  return async ({ workspace }) => {
    fs.writeFileSync(path.join(workspace, 'scripts', 'data.gd'), text, 'utf8')
    return agentOk()
  }
}

export function runnerDeps(overrides = {}) {
  const counters = { static: 0, tests: 0, hidden: 0 }
  return {
    counters,
    deps: {
      staticCheckProjectImpl: async () => {
        counters.static += 1
        return {
          available: true,
          ok: true,
          mode: 'fixture',
          errors: [],
          warnings: [],
          diagnostics: [],
          fileCount: 3,
        }
      },
      runScriptTestImpl: async () => {
        counters.tests += 1
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
      runHiddenSuiteImpl: async () => ({
        available: false,
        ok: false,
        skipped: true,
        reason: 'No hidden suite in the fixture.',
        summary: { passed: 0, failed: 0 },
        results: [],
        errors: [],
      }),
      prepareImportsImpl: async () => ({
        ok: true,
        code: 0,
        timedOut: false,
        message: 'imports skipped in fixture',
      }),
      gitCommit: async () => 'a'.repeat(40),
      runAgentImpl: successAgent(),
      ...overrides,
    },
  }
}

export async function waitFor(fn, predicate, { timeoutMs = 10000, intervalMs = 20 } = {}) {
  const started = Date.now()
  let last
  while (Date.now() - started < timeoutMs) {
    last = await fn()
    if (predicate(last)) return last
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
  throw new Error(`Timed out waiting for condition. Last value: ${JSON.stringify(last, null, 2)}`)
}

export async function waitForJob(store, jobId, statuses, options) {
  const wanted = new Set(Array.isArray(statuses) ? statuses : [statuses])
  return waitFor(
    () => store.load(jobId),
    (job) => job && wanted.has(job.status),
    options,
  )
}
