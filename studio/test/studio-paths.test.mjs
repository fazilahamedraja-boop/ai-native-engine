import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  StudioError,
  hashTree,
  isInside,
  listFiles,
  readJson,
  resolveRelative,
  sha256File,
  writeJsonAtomic,
} from '../server/lib/studio-paths.mjs'
import { tempRoot, writeFile } from './helpers.mjs'

test('path guard: rejects traversal, absolute paths, drive letters and NUL bytes', () => {
  const root = tempRoot('studio-paths-')
  writeFile(path.join(root, 'safe.txt'), 'ok')

  assert.equal(resolveRelative(root, 'safe.txt'), path.join(root, 'safe.txt'))
  // The guard rejects any explicit parent segment even when it would resolve
  // back inside the root; callers should supply a canonical relative path.
  assert.throws(
    () => resolveRelative(root, 'nested/../safe.txt'),
    (error) => error instanceof StudioError && error.code === 'path_traversal',
  )

  const cases = ['../outside.txt', 'nested/../../outside.txt', '/etc/passwd', 'C:\\Windows\\win.ini', 'a\0b']
  for (const requested of cases) {
    assert.throws(
      () => resolveRelative(root, requested),
      (error) => error instanceof StudioError && ['path_traversal', 'invalid_path'].includes(error.code),
      `expected ${JSON.stringify(requested)} to be rejected`,
    )
  }
})

test('path guard: mustExist reports 404 instead of leaking a missing path', () => {
  const root = tempRoot('studio-paths-')
  assert.throws(
    () => resolveRelative(root, 'missing.txt', { mustExist: true }),
    (error) => error instanceof StudioError && error.code === 'not_found' && error.status === 404,
  )
})

test('isInside is containment, not a string prefix', () => {
  const root = tempRoot('studio-paths-')
  const sibling = `${root}-sibling`
  fs.mkdirSync(sibling, { recursive: true })
  assert.equal(isInside(path.join(root, 'a'), root), true)
  assert.equal(isInside(path.join(root, '..', 'escape'), root), false)
  assert.equal(isInside(sibling, root), false)
})

test('tree hash is stable, ignores .godot/build, and changes with content', () => {
  const root = tempRoot('studio-hash-')
  writeFile(path.join(root, 'scripts', 'a.gd'), 'one\n')
  writeFile(path.join(root, 'README.md'), 'readme\n')
  writeFile(path.join(root, '.godot', 'cache.bin'), 'ignored\n')
  writeFile(path.join(root, 'build', 'out.exe'), 'ignored\n')

  const first = hashTree(root)
  assert.equal(hashTree(root), first)
  assert.deepEqual(listFiles(root), ['README.md', 'scripts/a.gd'])

  writeFile(path.join(root, 'scripts', 'a.gd'), 'two\n')
  assert.notEqual(hashTree(root), first)
})

test('tree hash treats .import line endings as generated noise, not content', () => {
  const root = tempRoot('studio-import-hash-')
  const file = path.join(root, 'assets', 'icon.svg.import')
  writeFile(file, '[remap]\n\nsource_file="res://icon.svg"\n')
  const first = hashTree(root)

  // Godot rewrites the same metadata with CRLF on Windows.
  writeFile(file, '[remap]\r\n\r\nsource_file="res://icon.svg"\r\n')
  assert.equal(hashTree(root), first)

  // A real metadata edit must still change the hash.
  writeFile(file, '[remap]\r\n\r\nsource_file="res://other.svg"\r\n')
  assert.notEqual(hashTree(root), first)
})

test('atomic JSON writes replace the file and readJson refuses malformed JSON', () => {
  const root = tempRoot('studio-json-')
  const file = path.join(root, 'nested', 'state.json')
  writeJsonAtomic(file, { revision: 1 })
  assert.deepEqual(readJson(file), { revision: 1 })
  writeJsonAtomic(file, { revision: 2 })
  assert.deepEqual(readJson(file), { revision: 2 })
  assert.equal(readJson(path.join(root, 'missing.json'), 'fallback'), 'fallback')

  fs.writeFileSync(file, '{not json', 'utf8')
  assert.throws(
    () => readJson(file),
    (error) => error instanceof StudioError && error.code === 'invalid_json',
  )
})

test('sha256File hashes exact bytes', () => {
  const root = tempRoot('studio-sha-')
  const file = writeFile(path.join(root, 'a.txt'), 'abc')
  assert.equal(
    sha256File(file),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  )
})
