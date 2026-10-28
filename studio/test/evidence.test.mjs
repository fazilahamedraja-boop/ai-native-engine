import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EvidenceError,
  classifyProvenance,
  contentTypeFor,
  createEvidenceStore,
  isInside,
  resolveArtifact,
  runProvenance,
} from '../server/lib/evidence.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(TEST_DIR, '..', '..')
const EVIDENCE_ROOT = path.join(REPO_ROOT, 'docs', 'phase19', 'evidence')

const RUNTIME_OK = 'runtime/2026-10-25T05-55-04-354Z'
const RUNTIME_EARLY = 'runtime/2026-10-25T05-50-50-624Z'
const EXPORT_OK = 'export/2026-10-25T06-11-40-680Z'
const EXPORT_EARLY = 'export/2026-10-25T06-08-43-608Z'
const REPAIR_OK = 'repair/2026-10-25T06-02-23-740Z'
const REPAIR_FAIL = 'repair/2026-10-25T05-59-48-987Z'
const MEASUREMENTS = 'measurements/2026-10-25T06-05-56-931Z'
const AGENT = 'agent-runs/implementation-2026-10-23T17-06-43-470Z'

function evidenceError(code, status) {
  return (error) => {
    assert.ok(error instanceof EvidenceError, `expected EvidenceError, got ${error}`)
    assert.equal(error.code, code)
    assert.equal(error.status, status)
    return true
  }
}

function makeFixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'studio-s0-fixture-'))
  const repoRoot = path.join(base, 'repo')
  const evidenceRoot = path.join(repoRoot, 'docs', 'phase19', 'evidence')
  fs.mkdirSync(evidenceRoot, { recursive: true })
  return { base, repoRoot, evidenceRoot }
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

function writeJson(file, value) {
  write(file, `${JSON.stringify(value, null, 2)}\n`)
}

test('path guard: rejects traversal, absolute paths, null bytes and odd extensions', () => {
  const cases = [
    ['', 'invalid_path', 400],
    ['   ', 'invalid_path', 400],
    ['../run.json', 'invalid_path', 400],
    ['runtime/../../secret.json', 'invalid_path', 400],
    ['..\\..\\secret.json', 'invalid_path', 400],
    ['/etc/passwd', 'invalid_path', 400],
    ['C:/Windows/win.ini', 'invalid_path', 400],
    ['c:\\Windows\\win.ini', 'invalid_path', 400],
    ['runtime/./run.json', 'invalid_path', 400],
    ['runtime//run.json', 'invalid_path', 400],
    [`runtime/run.json\0.png`, 'invalid_path', 400],
    ['runtime/run.gd', 'extension_not_allowed', 415],
    ['runtime/run.exe', 'extension_not_allowed', 415],
    ['runtime/no-extension', 'extension_not_allowed', 415],
  ]

  for (const [requested, code, status] of cases) {
    assert.throws(() => resolveArtifact(EVIDENCE_ROOT, requested), evidenceError(code, status), requested)
  }
})

test('path guard: accepts a known artifact and reports its canonical relative path', () => {
  const resolved = resolveArtifact(EVIDENCE_ROOT, 'web/web-verification.json')
  assert.equal(resolved.relativePath, 'web/web-verification.json')
  assert.equal(resolved.extension, '.json')
  assert.ok(fs.existsSync(resolved.absolutePath))
  assert.equal(contentTypeFor(resolved.extension), 'application/json; charset=utf-8')
})

test('path guard: a canonical path outside the root is refused even when the literal path looks fine', () => {
  const outside = path.join(os.tmpdir(), 'studio-s0-outside.json')
  assert.throws(
    () => resolveArtifact(EVIDENCE_ROOT, 'web/web-verification.json', {
      realpath: (value) => (value === EVIDENCE_ROOT ? EVIDENCE_ROOT : outside),
    }),
    evidenceError('outside_root', 403),
  )
})

test('path guard: a missing artifact is a 404, not a 500', () => {
  assert.throws(
    () => resolveArtifact(EVIDENCE_ROOT, 'runtime/does-not-exist.png'),
    evidenceError('not_found', 404),
  )
  assert.throws(
    () => resolveArtifact(EVIDENCE_ROOT, 'web/web-verification.json', {
      realpath: () => {
        throw new Error('boom')
      },
    }),
    evidenceError('not_found', 404),
  )
})

test('isInside is a true containment check, not a string prefix check', () => {
  const root = path.resolve('C:/repo/evidence')
  assert.equal(isInside(path.join(root, 'a', 'b.json'), root), true)
  assert.equal(isInside(root, root), true)
  assert.equal(isInside(path.resolve('C:/repo/evidence-extra/b.json'), root), false)
  assert.equal(isInside(path.resolve('C:/repo/b.json'), root), false)
})

test('provenance: agent output and candidate code are model-generated, runner logs are not', () => {
  assert.equal(classifyProvenance('agent-runs/x/run.json'), 'trusted-runner')
  assert.equal(classifyProvenance('agent-runs/x/attempts/1/FAILURE.md'), 'trusted-runner')
  assert.equal(classifyProvenance('agent-runs/x/attempts/1/opencode.jsonl'), 'model-generated')
  assert.equal(classifyProvenance(`${REPAIR_OK}/agent-attempt/opencode.jsonl`), 'model-generated')
  assert.equal(classifyProvenance(`${REPAIR_OK}/agent-attempt/IMPLEMENTATION.md`), 'model-generated')
  assert.equal(classifyProvenance(`${REPAIR_OK}/agent-attempt/voxel_data.gd`), 'model-generated')
  assert.equal(classifyProvenance(`${REPAIR_OK}/agent-attempt/hidden-suite.json`), 'trusted-runner')
  assert.equal(classifyProvenance(`${REPAIR_OK}/healthy/voxel_data.gd`), 'trusted-runner')
  assert.equal(classifyProvenance('web/page-load.png'), 'human-recorded')
  assert.equal(classifyProvenance(`${RUNTIME_OK}/run.json`), 'trusted-runner')

  assert.equal(runProvenance('agent-runs'), 'model-generated')
  assert.equal(runProvenance('web'), 'human-recorded')
  assert.equal(runProvenance('runtime'), 'trusted-runner')
  assert.equal(runProvenance('repair'), 'trusted-runner')
})

test('store: rejects a repository without evidence and an evidence root outside it', () => {
  const fixture = makeFixture()
  const emptyRepo = path.join(fixture.base, 'empty-repo')
  fs.mkdirSync(emptyRepo, { recursive: true })
  assert.throws(() => createEvidenceStore({ repoRoot: emptyRepo }), /evidence directory not found/)

  const otherRepo = path.join(fixture.base, 'other-repo')
  fs.mkdirSync(otherRepo, { recursive: true })
  assert.throws(
    () => createEvidenceStore({ repoRoot: emptyRepo, evidenceRoot: fixture.evidenceRoot }),
    /inside the repository/,
  )

  fs.rmSync(fixture.base, { recursive: true, force: true })
})

test('store: real Phase 19 tree is scanned without inventing runs', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })
  const runs = store.listRuns()
  const meta = store.meta()

  assert.equal(runs.length, 14)
  assert.equal(meta.runCount, 14)
  assert.equal(meta.readOnly, true)
  assert.equal(meta.modelCalls, 0)
  assert.equal(meta.commandsExecutedFromBrowser, 0)
  assert.ok(meta.artifactCount > 100)
  assert.deepEqual(meta.allowedExtensions, ['.json', '.jsonl', '.md', '.mp4', '.png', '.txt'])
  assert.ok(meta.skippedDirectories.includes('repair/2026-10-25T05-59-10-201Z'))

  // A bare healthy-baseline directory has no run.json. It must not become a
  // fake "unknown" run or a served artifact.
  assert.equal(store.getRun('repair/2026-10-25T05-59-10-201Z'), null)
  assert.throws(
    () => store.getArtifact('repair/2026-10-25T05-59-10-201Z/healthy/voxel_data.gd'),
    evidenceError('extension_not_allowed', 415),
  )

  const groups = [...new Set(runs.map((run) => run.group))].sort()
  assert.deepEqual(groups, ['agent-runs', 'export', 'measurements', 'repair', 'runtime', 'tooling', 'web'])
  assert.equal(store.listRuns()[0].group, 'tooling', 'runs are ordered newest first')
})

test('parsing: a clean observation run is a verified pass with captures and comparisons', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })
  const run = store.getRun(RUNTIME_OK)

  assert.equal(run.kind, 'observation')
  assert.equal(run.verdict, 'verified-pass')
  assert.equal(run.provenance, 'trusted-runner')
  assert.equal(run.passed, 12)
  assert.equal(run.failed, 0)
  assert.equal(run.total, 12)
  assert.equal(run.checks.length, 12)
  assert.equal(run.failure, null)
  assert.equal(run.captures.length, 9)
  assert.equal(run.gallery.length, 9)
  assert.equal(run.comparisonImages.length, 0)
  assert.equal(run.comparisons.length, 2)
  assert.deepEqual(
    run.comparisons.map((comparison) => [comparison.before.name, comparison.after.name]),
    [['spawn', 'movement'], ['save', 'reload']],
  )
  assert.equal(run.captures[0].rel, `${RUNTIME_OK}/spawn.png`)
  assert.ok(run.captures[0].width > 0)
})

test('parsing: failed===0 plus a recorded failure is still a verified failure', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })
  const run = store.getRun(RUNTIME_EARLY)

  assert.equal(run.failed, 0)
  assert.ok(run.failure, 'the preserved failure text must be kept')
  assert.equal(run.verdict, 'verified-fail')
  assert.match(run.headline, /aborted/)

  const exportRun = store.getRun(EXPORT_EARLY)
  assert.equal(exportRun.failed, 0)
  assert.ok(exportRun.failure)
  assert.equal(exportRun.verdict, 'verified-fail')
  assert.match(exportRun.headline, /aborted/)
})

test('parsing: packaged export exposes the real PNG size, not the exe size', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })
  const run = store.getRun(EXPORT_OK)

  assert.equal(run.verdict, 'verified-pass')
  assert.equal(run.passed, 12)
  assert.equal(run.captures.length, 1)
  assert.equal(run.captures[0].path, 'packaged-window.png')
  assert.equal(run.captures[0].bytes, 322349)
  assert.notEqual(run.captures[0].bytes, run.details.exe_bytes)

  const artifact = store.getArtifact(run.captures[0].rel)
  assert.equal(artifact.contentType, 'image/png')
  const head = fs.readFileSync(artifact.absolutePath).subarray(0, 8)
  assert.deepEqual([...head], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
})

test('parsing: repair run separates the agent candidate from runner-verified stages', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })
  const run = store.getRun(REPAIR_OK)

  assert.equal(run.kind, 'repair-experiment')
  assert.equal(run.verdict, 'verified-pass')
  assert.equal(run.provenance, 'trusted-runner')
  assert.match(run.headline, /Defect 14\/15 -> candidate 15\/15/)
  assert.match(run.model, /deepseek/)
  assert.equal(run.details.defect.summary.passed, 14)
  assert.deepEqual(run.details.defect.failing_checks, ['data-raycast-down'])
  assert.equal(run.details.agent.summary.passed, 15)
  assert.equal(run.details.canonical.unchanged, true)

  const candidate = run.files.find((file) => file.path === 'agent-attempt/voxel_data.gd')
  const runnerLog = run.files.find((file) => file.path === 'agent-attempt/hidden-suite.json')
  assert.equal(candidate.provenance, 'model-generated')
  assert.equal(runnerLog.provenance, 'trusted-runner')

  const failed = store.getRun(REPAIR_FAIL)
  assert.equal(failed.verdict, 'verified-fail')
  assert.match(failed.headline, /injected defect was not detected/)
})

test('parsing: a rejected agent run is never presented as a pass', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })
  const run = store.getRun(AGENT)

  assert.equal(run.kind, 'agent-implementation-run')
  assert.equal(run.provenance, 'model-generated')
  assert.equal(run.verdict, 'model-claim-rejected')
  assert.equal(run.passed, 0)
  assert.equal(run.failed, 3)
  assert.equal(run.checks.length, 3)
  assert.ok(run.checks.every((check) => check.pass === false))
  assert.equal(run.details.hidden_test_sha256_before, run.details.hidden_test_sha256_after)
})

test('parsing: browser session is human-recorded with two comparisons and a video', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })
  const run = store.getRun('web')

  assert.equal(run.kind, 'browser-session')
  assert.equal(run.verdict, 'recorded')
  assert.equal(run.provenance, 'human-recorded')
  assert.equal(run.checks.length, 6)
  assert.equal(run.captures.length, 6)
  assert.equal(run.comparisons.length, 2)
  assert.equal(run.videos.length, 1)
  assert.equal(run.videos[0].name, 'playthrough.mp4')
})

test('parsing: tooling and measurements keep their own verdicts', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })

  const tooling = store.getRun('tooling')
  assert.equal(tooling.kind, 'tooling-verification')
  assert.equal(tooling.verdict, 'verified-pass')
  assert.equal(tooling.checks.length, 4)
  assert.ok(tooling.checks.every((check) => check.pass))
  assert.equal(tooling.comparisonImages.length, 1)
  assert.equal(tooling.gallery.length, 0, 'a compare image is not repeated in the plain gallery')

  const measurements = store.getRun(MEASUREMENTS)
  assert.equal(measurements.kind, 'measurements')
  assert.equal(measurements.verdict, 'informational')
  assert.equal(measurements.checks.length, 0)
  assert.equal(measurements.passed, null)
  assert.deepEqual(measurements.details.fps_samples, [60, 60, 59])
})

test('artifacts: only indexed, allow-listed files inside the root are served', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })

  const image = store.getArtifact(`${RUNTIME_OK}/spawn.png`)
  assert.equal(image.contentType, 'image/png')
  assert.ok(image.bytes > 0)

  // Structurally valid and inside the root, but never scanned into a run.
  assert.throws(
    () => store.getArtifact('README.md'),
    evidenceError('not_found', 404),
  )

  // Source files in the evidence tree are intentionally not served.
  assert.throws(
    () => store.getArtifact(`${REPAIR_OK}/agent-attempt/voxel_data.gd`),
    evidenceError('extension_not_allowed', 415),
  )

  assert.throws(
    () => store.getArtifact(`${RUNTIME_OK}/../${RUNTIME_EARLY}/run.json`),
    evidenceError('invalid_path', 400),
  )
})

test('text previews: full small files are hashed, large files are capped and flagged', () => {
  const store = createEvidenceStore({ repoRoot: REPO_ROOT })

  const manifest = store.readText(`${RUNTIME_OK}/run.json`, { maxBytes: 1_000_000, maxLines: 10_000 })
  const parsed = JSON.parse(manifest.lines.join('\n'))
  assert.equal(parsed.runner, 'voxel-observe')
  assert.equal(parsed.passed, 12)
  assert.match(manifest.sha256, /^[0-9a-f]{64}$/)
  assert.equal(manifest.truncated, false)

  const transcript = store.readText(`${AGENT}/attempts/attempt-1/opencode.jsonl`, {
    maxBytes: 1024,
    maxLines: 5,
  })
  assert.equal(transcript.truncated, true)
  assert.ok(transcript.returnedLines <= 5)
  assert.ok(transcript.lines.length <= 5)
  assert.equal(transcript.sha256, null)

  assert.throws(
    () => store.readText(`${RUNTIME_OK}/spawn.png`),
    evidenceError('not_text', 415),
  )
})

test('fixture: malformed manifests and missing manifests are handled honestly', () => {
  const fixture = makeFixture()
  const runtime = path.join(fixture.evidenceRoot, 'runtime')

  write(path.join(runtime, '2026-01-01T00-00-00-000Z', 'run.json'), '{ this is not json\n')
  writeJson(path.join(runtime, '2026-01-02T00-00-00-000Z', 'run.json'), {
    started_at: '2026-01-02T00:00:00.000Z',
    checks: [{ name: 'derived-pass', pass: true }],
  })
  writeJson(path.join(runtime, '2026-01-03T00-00-00-000Z', 'run.json'), {
    checks: [
      { name: 'first', pass: true },
      { name: 'second', pass: false },
    ],
    failure: 'aborted for the test',
  })
  write(path.join(runtime, 'orphan', 'notes.txt'), 'not part of a run\n')
  writeJson(path.join(fixture.evidenceRoot, 'web', 'web-verification.json'), {
    created_at: '2026-01-04T00:00:00.000Z',
    url: 'http://127.0.0.1:1234/',
    input: { observations: [{ step: 'one', observed: 'looked right' }] },
  })

  const store = createEvidenceStore({ repoRoot: fixture.repoRoot })
  const runs = store.listRuns()
  assert.equal(runs.length, 4)

  const malformed = store.getRun('runtime/2026-01-01T00-00-00-000Z')
  assert.ok(malformed.parseError)
  assert.equal(malformed.verdict, 'informational')
  assert.match(malformed.headline, /could not be parsed/)

  const derived = store.getRun('runtime/2026-01-02T00-00-00-000Z')
  assert.equal(derived.passed, 1)
  assert.equal(derived.failed, 0)
  assert.equal(derived.total, 1)
  assert.equal(derived.verdict, 'verified-pass')

  const failed = store.getRun('runtime/2026-01-03T00-00-00-000Z')
  assert.equal(failed.passed, 1)
  assert.equal(failed.failed, 1)
  assert.equal(failed.verdict, 'verified-fail')

  assert.ok(store.meta().skippedDirectories.includes('runtime/orphan'))
  assert.equal(store.getRun('runtime/orphan'), null)
  assert.throws(
    () => store.getArtifact('runtime/orphan/notes.txt'),
    evidenceError('not_found', 404),
  )

  const web = store.getRun('web')
  assert.equal(web.verdict, 'recorded')
  assert.equal(web.checks.length, 1)

  fs.rmSync(fixture.base, { recursive: true, force: true })
})
