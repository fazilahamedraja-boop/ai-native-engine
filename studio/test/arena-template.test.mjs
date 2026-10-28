// The arena template is a contract: the untouched scaffold must FAIL the
// acceptance suite (it is honestly not a game), and the reference
// implementation must PASS it. Both runs are headless, so this is cheap enough
// to keep in `npm test`. It catches template drift that would otherwise only
// show up as a broken agent run.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

import { runScriptTest } from '../server/lib/verification.mjs'

const templateDir = path.join(import.meta.dirname, '..', 'templates', 'arena')
const referenceDir = path.join(import.meta.dirname, 'fixtures', 'arena-reference')

function copyTemplate() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'arena-template-'))
  const target = path.join(root, 'arena')
  fs.cpSync(templateDir, target, { recursive: true })
  return target
}

function copyReference(projectDir) {
  fs.copyFileSync(
    path.join(referenceDir, 'scripts', 'main.gd'),
    path.join(projectDir, 'scripts', 'main.gd'),
  )
}

test('arena template: the untouched scaffold fails its own acceptance suite', async () => {
  const result = await runScriptTest({
    projectDir: copyTemplate(),
    script: 'res://tests/run_arena_tests.gd',
  })

  assert.equal(result.available, true)
  assert.equal(result.ok, false, 'the scaffold must not pass as a finished game')
  assert.equal(result.summary.failed > 0, true, 'the scaffold must fail checks')
  assert.deepEqual(result.errors ?? [], [], 'the scaffold must at least parse')
})

test('arena template: the reference implementation passes every check', async () => {
  const projectDir = copyTemplate()
  copyReference(projectDir)

  const result = await runScriptTest({
    projectDir,
    script: 'res://tests/run_arena_tests.gd',
  })

  assert.equal(result.available, true)
  assert.deepEqual(result.errors ?? [], [])
  assert.equal(result.summary.failed, 0, 'the reference implementation must not fail')
  assert.equal(result.summary.passed, 20)
  assert.equal(result.ok, true)
})
