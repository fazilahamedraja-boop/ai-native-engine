import fs from 'node:fs'
import path from 'node:path'

import { listFiles, sha256Comparable, sha256File, toPosix } from './studio-paths.mjs'

export const COPY_SKIP_DIRS = new Set(['.godot', 'build', 'artifacts', 'node_modules', '__pycache__', '.git', '.studio-hidden'])
export const COPY_SKIP_FILES = new Set(['opencode.json'])

export function copyProject(source, target, { skipFiles = COPY_SKIP_FILES, skipDirs = COPY_SKIP_DIRS } = {}) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (entry.isDirectory() && skipDirs.has(entry.name)) continue
    if (entry.isFile() && skipFiles.has(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) copyProject(from, to, { skipFiles, skipDirs })
    else if (entry.isFile()) fs.copyFileSync(from, to)
  }
}

export function diffTrees(beforeRoot, afterRoot, options = {}) {
  const before = new Set(listFiles(beforeRoot, options))
  const after = new Set(listFiles(afterRoot, options))
  const files = [...new Set([...before, ...after])].sort()
  const changed = []
  for (const file of files) {
    const inBefore = before.has(file)
    const inAfter = after.has(file)
    if (!inBefore) {
      changed.push({
        file,
        status: 'added',
        beforeSha256: null,
        afterSha256: sha256Comparable(path.join(afterRoot, file), file),
        beforeBytes: 0,
        afterBytes: fs.statSync(path.join(afterRoot, file)).size,
      })
      continue
    }
    if (!inAfter) {
      changed.push({
        file,
        status: 'deleted',
        beforeSha256: sha256Comparable(path.join(beforeRoot, file), file),
        afterSha256: null,
        beforeBytes: fs.statSync(path.join(beforeRoot, file)).size,
        afterBytes: 0,
      })
      continue
    }
    const beforeSha = sha256Comparable(path.join(beforeRoot, file), file)
    const afterSha = sha256Comparable(path.join(afterRoot, file), file)
    if (beforeSha !== afterSha) {
      changed.push({
        file,
        status: 'modified',
        beforeSha256: beforeSha,
        afterSha256: afterSha,
        beforeBytes: fs.statSync(path.join(beforeRoot, file)).size,
        afterBytes: fs.statSync(path.join(afterRoot, file)).size,
      })
    }
  }
  return changed
}

/** Translate a tiny glob (`**`, `*`, `?`) into an anchored RegExp. */
function globToRegExp(pattern) {
  let out = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === '*') {
      if (pattern[index + 1] === '*') {
        index += 1
        if (pattern[index + 1] === '/') {
          index += 1
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (char === '?') {
      out += '[^/]'
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  return new RegExp(`${out}$`)
}

export function globMatch(pattern, file) {
  return globToRegExp(pattern).test(file)
}

/**
 * Reject additions, deletions, renames and changes outside the allowlist.
 *
 * Two policies share this function:
 *  - the original exact list (`allowedFiles`), used by the voxel repair flow,
 *    where only a named existing file may change;
 *  - a bounded feature mode (`options.patterns` + `options.allowAdditions`),
 *    used when the agent implements a game: it may modify or add files that
 *    match the patterns, but still cannot delete anything or touch a protected
 *    path (tests, harness, project settings, manifest, spec).
 */
export function scopeProblems(changed, allowedFiles, options = {}) {
  const allowed = new Set(allowedFiles)
  const patterns = Array.isArray(options.patterns) ? options.patterns : []
  const allowAdditions = options.allowAdditions === true
  const protectedPaths = Array.isArray(options.protectedPaths) ? options.protectedPaths : []
  const matchers = patterns.map((pattern) => globToRegExp(pattern))
  const matches = (file) => allowed.has(file) || matchers.some((matcher) => matcher.test(file))
  const problems = []
  if (changed.length === 0) problems.push('The agent made no change.')

  const unsafePath = (file) =>
    typeof file !== 'string' ||
    file.length === 0 ||
    file.startsWith('/') ||
    file.startsWith('\\') ||
    /^[A-Za-z]:/.test(file) ||
    file.split(/[/\\]/).includes('..')

  for (const entry of changed) {
    if (unsafePath(entry.file)) {
      problems.push(`Refused an unsafe path: ${String(entry.file).slice(0, 120)}`)
      continue
    }
    if (entry.status === 'deleted') {
      problems.push(`Deleted a project file: ${entry.file}`)
      continue
    }
    if (protectedPaths.some((path) => path === entry.file || globMatch(path, entry.file))) {
      problems.push(`Changed a protected file: ${entry.file}`)
      continue
    }
    if (!matches(entry.file)) {
      problems.push(`Changed a file outside the allowed list: ${entry.file}`)
    }
    if (entry.status === 'added' && !allowAdditions) {
      problems.push(`Added an unexpected file: ${entry.file}`)
    }
  }

  const produced = changed.some(
    (entry) =>
      matches(entry.file) &&
      (entry.status === 'modified' || (allowAdditions && entry.status === 'added')),
  )
  if (!produced) problems.push('None of the allowed files was modified.')
  return problems
}

/**
 * Compact line diff. It is intentionally small and deterministic: the UI needs
 * an auditable change, not a full `git diff` replacement.
 */
export function unifiedDiff(beforeText, afterText, { file = 'file', context = 3, maxLines = 4000 } = {}) {
  const a = String(beforeText ?? '').split(/\r?\n/)
  const b = String(afterText ?? '').split(/\r?\n/)
  const truncated = a.length + b.length > maxLines
  if (truncated) {
    a.length = Math.min(a.length, Math.floor(maxLines / 2))
    b.length = Math.min(b.length, Math.floor(maxLines / 2))
  }

  // Myers-lite LCS dynamic programming, bounded by maxLines.
  const n = a.length
  const m = b.length
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1))
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }

  const ops = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'same', text: a[i], ai: i + 1, bi: j + 1 })
      i += 1
      j += 1
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', text: a[i], ai: i + 1 })
      i += 1
    } else {
      ops.push({ type: 'add', text: b[j], bi: j + 1 })
      j += 1
    }
  }
  while (i < n) {
    ops.push({ type: 'del', text: a[i], ai: i + 1 })
    i += 1
  }
  while (j < m) {
    ops.push({ type: 'add', text: b[j], bi: j + 1 })
    j += 1
  }

  const keep = new Set()
  ops.forEach((op, index) => {
    if (op.type === 'same') return
    for (let k = index - context; k <= index + context; k += 1) {
      if (k >= 0 && k < ops.length) keep.add(k)
    }
  })

  const lines = [`--- a/${file}`, `+++ b/${file}`]
  if (truncated) lines.push('@@ diff truncated (file too large) @@')
  let previous = -2
  let hunk = []
  const flush = () => {
    if (hunk.length === 0) return
    lines.push(...hunk)
    hunk = []
  }
  for (let index = 0; index < ops.length; index += 1) {
    if (!keep.has(index)) continue
    if (index !== previous + 1) {
      flush()
      const op = ops[index]
      const start = op.ai ?? op.bi ?? 1
      lines.push(`@@ -${start - context < 1 ? 1 : start - 1},${context * 2 + 1} +${start - context < 1 ? 1 : start - 1},${context * 2 + 1} @@`)
    }
    const op = ops[index]
    lines.push(op.type === 'same' ? ` ${op.text}` : op.type === 'add' ? `+${op.text}` : `-${op.text}`)
    previous = index
  }
  flush()
  return lines.join('\n')
}

export function buildUnifiedDiff(beforeRoot, afterRoot, changed, { maxBytes = 400_000 } = {}) {
  const parts = []
  let bytes = 0
  for (const entry of changed) {
    if (entry.status === 'deleted') {
      parts.push(`--- a/${entry.file}\n+++ /dev/null\n@@ deleted @@`)
      continue
    }
    if (entry.status === 'added') {
      parts.push(`--- /dev/null\n+++ b/${entry.file}\n@@ added @@`)
      continue
    }
    const before = readTextBounded(path.join(beforeRoot, entry.file))
    const after = readTextBounded(path.join(afterRoot, entry.file))
    if (before === null || after === null) {
      parts.push(`--- a/${entry.file}\n+++ b/${entry.file}\n@@ binary or unreadable; ${entry.beforeBytes} -> ${entry.afterBytes} bytes @@`)
      continue
    }
    const diff = unifiedDiff(before, after, { file: entry.file })
    if (bytes + diff.length > maxBytes) {
      parts.push(`@@ diff budget reached; remaining files listed but not rendered @@`)
      break
    }
    bytes += diff.length
    parts.push(diff)
  }
  return parts.join('\n\n')
}

function readTextBounded(file, maxBytes = 512_000) {
  try {
    const stat = fs.statSync(file)
    if (stat.size > maxBytes) return null
    const text = fs.readFileSync(file, 'utf8')
    if (text.includes('\0')) return null
    return text
  } catch {
    return null
  }
}

export function describeTree(root) {
  return listFiles(root).map((file) => ({
    file,
    sha256: sha256File(path.join(root, file)),
    bytes: fs.statSync(path.join(root, file)).size,
  }))
}

export { toPosix }
