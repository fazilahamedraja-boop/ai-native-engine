import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export const STUDIO_ROOT = path.resolve(HERE, '..', '..')
export const REPO_ROOT = path.resolve(STUDIO_ROOT, '..')
export const HARNESS_ROOT = path.join(REPO_ROOT, 'experiments', 'godot-harness')
export const DATA_ROOT = path.join(STUDIO_ROOT, '.data')
export const JOBS_ROOT = path.join(DATA_ROOT, 'jobs')
export const ARTIFACT_ROOT = path.join(DATA_ROOT, 'artifacts')
export const OPS_ROOT = path.join(DATA_ROOT, 'ops')
// Projects created from a template live here, never inside the repository's
// tracked game directories, so generated work stays out of the Phase 8–19 tree.
export const PROJECTS_ROOT = path.join(DATA_ROOT, 'projects')

export class StudioError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'StudioError'
    this.code = code
    this.status = status
  }
}

export function isInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child))
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function assertInside(child, parent, code = 'path_outside_root') {
  if (!isInside(child, parent)) {
    throw new StudioError(code, `Refusing path outside ${parent}`, 400)
  }
  return path.resolve(child)
}

/**
 * Resolve a client-supplied relative path below a root. Absolute paths, drive
 * letters, UNC prefixes, traversal and NUL bytes are rejected before touching
 * the filesystem.
 */
export function resolveRelative(root, requested, { mustExist = false } = {}) {
  if (typeof requested !== 'string' || requested.length === 0) {
    throw new StudioError('invalid_path', 'A non-empty relative path is required.', 400)
  }
  if (requested.includes('\0') || path.isAbsolute(requested) || /^[a-zA-Z]:/.test(requested)) {
    throw new StudioError('invalid_path', 'Absolute paths are not accepted.', 400)
  }
  const normalized = requested.replaceAll('\\', '/')
  if (normalized.split('/').some((part) => part === '..')) {
    throw new StudioError('path_traversal', 'Path traversal is not accepted.', 400)
  }
  const resolved = path.resolve(root, ...normalized.split('/').filter(Boolean))
  assertInside(resolved, root)
  if (mustExist && !fs.existsSync(resolved)) {
    throw new StudioError('not_found', 'That path does not exist.', 404)
  }
  return resolved
}

export function toPosix(value) {
  return value.split(path.sep).join('/')
}

export function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Godot rewrites `.import` metadata with platform line endings every time it
 * imports a project. That is not a content edit, so `.import` files are hashed
 * and diffed with CRLF normalised to LF. A real metadata change still changes
 * the hash and is still reported, so tampering stays visible.
 */
export function isImportMetadata(relative) {
  return typeof relative === 'string' && relative.endsWith('.import')
}

export function sha256Comparable(file, relative) {
  const buffer = fs.readFileSync(file)
  if (!isImportMetadata(relative)) return crypto.createHash('sha256').update(buffer).digest('hex')
  const normalized = buffer.toString('utf8').split('\r\n').join('\n')
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex')
}

export function sha256Text(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex')
}

const DEFAULT_IGNORE = new Set([
  '.godot',
  'build',
  '.studio-hidden',
  '.data',
  'artifacts',
  'node_modules',
  '__pycache__',
  '.git',
])

export function listFiles(root, { ignore = DEFAULT_IGNORE, skipNames = new Set() } = {}) {
  const files = []
  function walk(relative) {
    const absolute = path.join(root, relative)
    for (const entry of fs.readdirSync(absolute, { withFileTypes: true })) {
      if (ignore.has(entry.name) || skipNames.has(entry.name)) continue
      const next = relative === '' ? entry.name : path.join(relative, entry.name)
      if (entry.isDirectory()) walk(next)
      else if (entry.isFile()) files.push(toPosix(next))
    }
  }
  walk('')
  return files.sort()
}

/**
 * Stable tree hash: sorted relative paths plus SHA-256 of each file. It is used
 * to prove that a workspace has not changed between verification, resume and
 * approval.
 */
export function hashTree(root, options = {}) {
  const hash = crypto.createHash('sha256')
  for (const relative of listFiles(root, options)) {
    hash.update(relative)
    hash.update('\0')
    hash.update(sha256Comparable(path.join(root, relative), relative))
    hash.update('\n')
  }
  return hash.digest('hex')
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw new StudioError('invalid_json', `Could not parse ${file}: ${error.message}`, 500)
  }
}

/** Atomic write: a reader never observes a half-written manifest. */
export function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
  fs.writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(temp, file)
}

export function ensureDataDirs() {
  for (const dir of [DATA_ROOT, JOBS_ROOT, ARTIFACT_ROOT, OPS_ROOT, PROJECTS_ROOT]) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

export function newId(prefix) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  return `${prefix}-${stamp}-${crypto.randomBytes(4).toString('hex')}`
}
