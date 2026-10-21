import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { HARNESS_ROOT } from './harness.mjs'

/**
 * Evidence output helpers for Phase 13 runners.
 *
 * Every Phase 8-12 runner in this repository writes to a hard-coded directory
 * under `docs/`. That is convenient for a one-shot evidence record and unsafe
 * for a runner that can be re-executed: re-running one of them overwrites the
 * committed evidence of an earlier phase. `controller/combat-defect.mjs` did
 * exactly that during Phase 12B, and the damage had to be reverted with
 * `git checkout -- docs/phase11/`.
 *
 * These helpers give a runner an explicit, configurable output directory and
 * refuse to write into any protected evidence directory.
 */

export const REPO_ROOT = path.resolve(HARNESS_ROOT, '..', '..')
export const DOCS_ROOT = path.resolve(REPO_ROOT, 'docs')

/**
 * Evidence directories owned by earlier phases. A Phase 13 runner must never
 * write inside one of them.
 */
export const PROTECTED_EVIDENCE_DIRS = [
  'contact-sheets',
  'phase3',
  'phase4',
  'phase5',
  'phase8',
  'phase9',
  'phase10',
  'phase11',
  'phase12',
  'phase12-verification',
]

/** The only phase directory a Phase 13 runner may write into by default. */
export const PHASE13_DIR = 'phase13'

function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

/**
 * Return every protected evidence directory that currently exists.
 */
export function protectedEvidenceDirs(docsRoot = DOCS_ROOT) {
  return PROTECTED_EVIDENCE_DIRS.map((name) => path.join(docsRoot, name)).filter((dir) =>
    fs.existsSync(dir),
  )
}

/**
 * Explain why `target` may not be used as an evidence output directory.
 * Returns null when the directory is allowed.
 */
export function rejectReason(target, { docsRoot = DOCS_ROOT, repoRoot = REPO_ROOT } = {}) {
  const resolved = path.resolve(target)
  if (!isInside(resolved, repoRoot)) {
    return `output directory must stay inside the repository (${repoRoot})`
  }
  for (const protectedDir of protectedEvidenceDirs(docsRoot)) {
    if (isInside(resolved, protectedDir)) {
      return `output directory is inside protected evidence directory ${path.relative(repoRoot, protectedDir)}`
    }
  }
  if (isInside(resolved, path.join(repoRoot, 'experiments'))) {
    return 'output directory must not be inside the harness source tree'
  }
  return null
}

/**
 * Resolve a runner output directory.
 *
 * @param {object} options
 * @param {string} [options.outDir]   explicit directory requested by the caller
 * @param {string} [options.runner]    runner name, used to build the default path
 * @param {string} [options.stamp]     unique stamp, used to build the default path
 * @param {string} [options.docsRoot]
 * @param {string} [options.repoRoot]
 * @returns {string} the absolute directory, created if necessary
 */
export function resolveOutputDir({
  outDir = null,
  runner = 'runner',
  stamp = null,
  docsRoot = DOCS_ROOT,
  repoRoot = REPO_ROOT,
} = {}) {
  let resolved
  if (outDir) {
    resolved = path.resolve(outDir)
  } else {
    const unique = stamp || new Date().toISOString().replace(/[:.]/g, '-')
    resolved = path.join(docsRoot, PHASE13_DIR, 'artifacts', runner, unique)
  }
  const reason = rejectReason(resolved, { docsRoot, repoRoot })
  if (reason) {
    throw new Error(reason)
  }
  fs.mkdirSync(resolved, { recursive: true })
  return resolved
}

export function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * Write a JSON document and return a manifest entry for it.
 */
export function writeJsonFile(dir, name, value) {
  const target = path.join(dir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`)
  return {
    path: path.relative(dir, target).split(path.sep).join('/'),
    absolute_path: target,
    bytes: fs.statSync(target).size,
    sha256: sha256(target),
  }
}

/**
 * Copy a capture's PNG into the evidence directory and return a manifest entry.
 * The copied file is re-hashed and compared with the bridge's own hash, so a
 * truncated or stale copy is detected rather than silently recorded.
 */
export function copyCaptureFile(dir, name, capture) {
  const target = path.join(dir, name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(capture.screenshot.absolute_path, target)
  const hash = sha256(target)
  if (hash !== capture.screenshot.sha256) {
    throw new Error(
      `copied capture ${name} does not match the bridge hash ` +
        `(${hash} != ${capture.screenshot.sha256})`,
    )
  }
  return {
    path: path.relative(dir, target).split(path.sep).join('/'),
    absolute_path: target,
    bytes: fs.statSync(target).size,
    sha256: hash,
    width: capture.screenshot.width,
    height: capture.screenshot.height,
  }
}
