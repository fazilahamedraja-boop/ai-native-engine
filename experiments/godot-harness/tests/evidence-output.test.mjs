import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  DOCS_ROOT,
  PROTECTED_EVIDENCE_DIRS,
  REPO_ROOT,
  copyCaptureFile,
  protectedEvidenceDirs,
  rejectReason,
  resolveOutputDir,
  writeJsonFile,
} from '../controller/evidence-output.mjs'

test('every declared protected evidence directory is covered', () => {
  assert.ok(PROTECTED_EVIDENCE_DIRS.includes('phase10'))
  assert.ok(PROTECTED_EVIDENCE_DIRS.includes('phase11'))
  assert.ok(PROTECTED_EVIDENCE_DIRS.includes('phase12'))
  assert.ok(PROTECTED_EVIDENCE_DIRS.includes('phase12-verification'))
  // The Phase 13 directory is the one that must stay writable.
  assert.ok(!PROTECTED_EVIDENCE_DIRS.includes('phase13'))
})

test('protected evidence directories are reported when they exist', () => {
  const dirs = protectedEvidenceDirs()
  assert.ok(dirs.length > 0)
  for (const dir of dirs) {
    assert.ok(fs.existsSync(dir))
  }
})

test('a protected evidence directory is rejected as an output directory', () => {
  for (const name of ['phase10', 'phase11', 'phase12', 'phase12-verification']) {
    const target = path.join(DOCS_ROOT, name, 'stage-c')
    assert.match(
      rejectReason(target),
      /protected evidence directory/,
      `${name} should be rejected`,
    )
  }
})

test('a nested path inside a protected evidence directory is also rejected', () => {
  const target = path.join(DOCS_ROOT, 'phase10', 'stage-c', 'deeper', 'still')
  assert.match(rejectReason(target), /protected evidence directory/)
})

test('traversal out of the phase 13 directory into a protected one is rejected', () => {
  const target = path.join(DOCS_ROOT, 'phase13', 'artifacts', '..', '..', 'phase11', 'stage-c')
  assert.match(rejectReason(target), /protected evidence directory/)
})

test('the phase 13 directory is allowed', () => {
  const target = path.join(DOCS_ROOT, 'phase13', 'stage-a')
  assert.equal(rejectReason(target), null)
})

test('an output directory outside the repository is rejected', () => {
  const target = path.join(os.tmpdir(), 'phase13-evidence')
  assert.match(rejectReason(target), /must stay inside the repository/)
})

test('an output directory inside the harness source tree is rejected', () => {
  const target = path.join(REPO_ROOT, 'experiments', 'godot-harness', 'evidence')
  assert.match(rejectReason(target), /must not be inside the harness source tree/)
})

test('resolveOutputDir creates a unique default directory under phase 13', () => {
  const stamp = 'phase13-test-stamp'
  const dir = resolveOutputDir({ runner: 'unit-test', stamp })
  try {
    assert.ok(fs.existsSync(dir))
    assert.ok(path.resolve(dir).startsWith(path.join(DOCS_ROOT, 'phase13')))
    assert.ok(dir.includes('unit-test'))
    assert.ok(dir.includes(stamp))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveOutputDir honours an explicit directory and refuses a protected one', () => {
  const explicit = path.join(DOCS_ROOT, 'phase13', 'explicit-test')
  const dir = resolveOutputDir({ outDir: explicit })
  try {
    assert.equal(path.resolve(dir), path.resolve(explicit))
    assert.ok(fs.existsSync(dir))
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
  assert.throws(
    () => resolveOutputDir({ outDir: path.join(DOCS_ROOT, 'phase11', 'stage-c') }),
    /protected evidence directory/,
  )
})

test('writeJsonFile returns a verifiable manifest entry', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase13-json-'))
  try {
    const entry = writeJsonFile(dir, 'nested/value.json', { ok: true, count: 3 })
    assert.equal(entry.path, 'nested/value.json')
    assert.ok(entry.bytes > 0)
    assert.match(entry.sha256, /^[0-9a-f]{64}$/)
    const parsed = JSON.parse(fs.readFileSync(entry.absolute_path, 'utf8'))
    assert.equal(parsed.ok, true)
    assert.equal(parsed.count, 3)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('copyCaptureFile rejects a capture whose bytes do not match its hash', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase13-capture-'))
  try {
    const source = path.join(dir, 'source.png')
    fs.writeFileSync(source, Buffer.from('not really a png'))
    const capture = {
      screenshot: {
        absolute_path: source,
        sha256: '0000000000000000000000000000000000000000000000000000000000000000',
        width: 1,
        height: 1,
      },
    }
    assert.throws(() => copyCaptureFile(dir, 'copy.png', capture), /does not match the bridge hash/)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
