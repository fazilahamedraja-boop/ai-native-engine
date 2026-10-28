import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'

import { diffTrees, scopeProblems } from '../server/lib/workspace.mjs'
import { tempRoot, writeFile } from './helpers.mjs'

test('diff: Godot import line-ending churn is not reported as an agent change', () => {
  const before = tempRoot('studio-diff-before-')
  const after = tempRoot('studio-diff-after-')
  writeFile(path.join(before, 'assets', 'icon.svg.import'), 'a=1\nb=2\n')
  writeFile(path.join(after, 'assets', 'icon.svg.import'), 'a=1\r\nb=2\r\n')
  writeFile(path.join(before, 'scripts', 'data.gd'), 'extends RefCounted\n')
  writeFile(path.join(after, 'scripts', 'data.gd'), 'extends RefCounted\n\nfunc value() -> int:\n\treturn 2\n')

  const changed = diffTrees(before, after)
  assert.deepEqual(changed.map((entry) => `${entry.status}:${entry.file}`), ['modified:scripts/data.gd'])
})

test('diff: a real .import edit, an added file and a deleted file are still reported', () => {
  const before = tempRoot('studio-diff-before-')
  const after = tempRoot('studio-diff-after-')
  writeFile(path.join(before, 'assets', 'icon.svg.import'), 'a=1\n')
  writeFile(path.join(after, 'assets', 'icon.svg.import'), 'a=2\n')
  writeFile(path.join(before, 'scripts', 'old.gd'), 'x\n')
  writeFile(path.join(after, 'scripts', 'new.gd'), 'y\n')

  const changed = diffTrees(before, after)
  assert.deepEqual(
    changed.map((entry) => `${entry.status}:${entry.file}`).sort(),
    ['added:scripts/new.gd', 'deleted:scripts/old.gd', 'modified:assets/icon.svg.import'],
  )
})

test('scope: only a modified allowed file is acceptable', () => {
  assert.deepEqual(scopeProblems([{ file: 'scripts/data.gd', status: 'modified' }], ['scripts/data.gd']), [])
  assert.match(scopeProblems([], ['scripts/data.gd'])[0], /made no change/)
  assert.match(
    scopeProblems([{ file: 'assets/icon.svg.import', status: 'modified' }], ['scripts/data.gd']).join(' '),
    /outside the allowed list: assets\/icon\.svg\.import/,
  )
  assert.match(
    scopeProblems([{ file: 'scripts/data.gd', status: 'modified' }, { file: 'x.txt', status: 'added' }], [
      'scripts/data.gd',
    ]).join(' '),
    /Added an unexpected file/,
  )
  assert.match(
    scopeProblems([{ file: 'scripts/old.gd', status: 'deleted' }], ['scripts/old.gd']).join(' '),
    /Deleted a project file/,
  )
})

test('scope: feature mode allows additions inside patterns and still refuses deletions', () => {
  const options = {
    patterns: ['scripts/**/*.gd', 'scenes/**', 'assets/**'],
    allowAdditions: true,
    protectedPaths: ['tests/**', 'harness/**', 'project.godot'],
  }
  const ok = scopeProblems(
    [
      { file: 'scripts/main.gd', status: 'modified' },
      { file: 'scripts/combat/damage.gd', status: 'added' },
      { file: 'scenes/main.tscn', status: 'modified' },
      { file: 'assets/ui/hud.png', status: 'added' },
    ],
    ['scripts/main.gd'],
    options,
  )
  assert.deepEqual(ok, [])

  assert.match(
    scopeProblems([{ file: 'scripts/main.gd', status: 'deleted' }], ['scripts/main.gd'], options).join(' '),
    /Deleted a project file/,
  )
  assert.match(
    scopeProblems([{ file: 'tests/run_arena_tests.gd', status: 'modified' }], ['scripts/main.gd'], options).join(' '),
    /Changed a protected file/,
  )
  assert.match(
    scopeProblems([{ file: 'project.godot', status: 'modified' }], ['scripts/main.gd'], options).join(' '),
    /Changed a protected file/,
  )
  assert.match(
    scopeProblems([{ file: 'README.md', status: 'modified' }], ['scripts/main.gd'], options).join(' '),
    /outside the allowed list/,
  )
  assert.match(
    scopeProblems([{ file: 'scripts/escape.gd', status: 'added' }], ['scripts/main.gd'], { ...options, allowAdditions: false }).join(' '),
    /Added an unexpected file/,
  )
  assert.match(
    scopeProblems([{ file: '../outside.gd', status: 'added' }], ['scripts/main.gd'], options).join(' '),
    /unsafe path/,
  )
  assert.match(
    scopeProblems([], ['scripts/main.gd'], options).join(' '),
    /made no change/,
  )
})
