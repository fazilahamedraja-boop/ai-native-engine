import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * Read-only evidence store for Phase 19.
 *
 * Two boundaries are enforced here and nowhere else:
 *   1. Every path must resolve inside `docs/phase19/evidence`.
 *   2. Only extensions in ALLOWED_EXTENSIONS can be served.
 *
 * Run ids are never used to build a filesystem path directly. They are looked
 * up in an index built by scanning the evidence tree, so an unknown id cannot
 * name a file.
 */

export const EVIDENCE_REL = path.join('docs', 'phase19', 'evidence')

export const ALLOWED_EXTENSIONS = Object.freeze(
  new Set(['.json', '.jsonl', '.md', '.txt', '.png', '.mp4']),
)

const TEXT_EXTENSIONS = new Set(['.json', '.jsonl', '.md', '.txt'])
const IMAGE_EXTENSIONS = new Set(['.png'])
const VIDEO_EXTENSIONS = new Set(['.mp4'])

const MANIFEST_BY_GROUP = Object.freeze({
  web: 'web-verification.json',
  tooling: 'tooling-verification.json',
})

export class EvidenceError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'EvidenceError'
    this.code = code
    this.status = status
  }
}

export function isInside(child, parent) {
  const relative = path.relative(parent, child)
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
}

export function contentTypeFor(extension) {
  if (extension === '.png') return 'image/png'
  if (extension === '.mp4') return 'video/mp4'
  if (extension === '.json') return 'application/json; charset=utf-8'
  if (TEXT_EXTENSIONS.has(extension)) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

export function toPosix(value) {
  return value.split(path.sep).join('/')
}

/**
 * Model output is not evidence of correctness. These paths are the model's own
 * words or its candidate copy; everything else in the tree was written by a
 * runner that did not take the model's word for anything.
 */
export function classifyProvenance(relativePath) {
  const posix = toPosix(relativePath)
  const parts = posix.split('/')
  const isModelFile =
    posix.endsWith('opencode.jsonl') ||
    posix.endsWith('IMPLEMENTATION.md') ||
    posix.endsWith('AGENT-NOTES.md') ||
    posix.endsWith('repair.md') ||
    posix.endsWith('diagnosis.md')

  if (parts[0] === 'agent-runs') {
    if (isModelFile || parts.includes('project')) return 'model-generated'
    return 'trusted-runner'
  }
  // The repair experiment keeps the agent's candidate next to runner-written
  // logs. The candidate source is the model's output even though the run that
  // judged it is trusted.
  if (parts.includes('agent-attempt')) {
    if (isModelFile || posix.endsWith('.gd')) return 'model-generated'
  }
  if (parts[0] === 'web') return 'human-recorded'
  return 'trusted-runner'
}

export function runProvenance(group) {
  if (group === 'agent-runs') return 'model-generated'
  if (group === 'web') return 'human-recorded'
  return 'trusted-runner'
}

function readJsonFile(file) {
  try {
    return { json: JSON.parse(fs.readFileSync(file, 'utf8')), parseError: null }
  } catch (error) {
    return { json: null, parseError: error.message }
  }
}

function failureText(failure) {
  if (!failure) return null
  if (typeof failure === 'string') return failure
  return failure.message || 'run recorded a failure object'
}

function numberOrNull(value) {
  return Number.isFinite(value) ? value : null
}

function firstLine(value) {
  if (typeof value !== 'string') return null
  return value.split(/\r?\n/)[0].replace(/^Error:\s*/, '')
}

function checksFrom(list, passKey) {
  if (!Array.isArray(list)) return []
  return list.map((check) => ({
    name: String(check?.name ?? 'unnamed'),
    pass: Boolean(check?.[passKey]),
    detail: typeof check?.detail === 'string' ? check.detail : null,
  }))
}

function checkVerdict(total, failed, failure) {
  if (failure) return 'verified-fail'
  if (!total) return 'informational'
  return failed > 0 ? 'verified-fail' : 'verified-pass'
}

function observationSummary(json) {
  const failure = failureText(json.failure)
  const checks = checksFrom(json.checks, 'pass')
  const failed = numberOrNull(json.failed) ?? checks.filter((check) => !check.pass).length
  const passed = numberOrNull(json.passed) ?? checks.length - failed
  return {
    kind: 'observation',
    // A run can pass every check it reached and still abort. Saying only
    // "8/8" would imply a clean run, so the failure is part of the headline.
    headline: failure
      ? `${passed}/${checks.length} windowed observation checks, then the run aborted`
      : `${passed}/${checks.length} windowed observation checks`,
    startedAt: json.started_at ?? null,
    finishedAt: json.finished_at ?? null,
    passed,
    failed,
    total: checks.length,
    checks,
    failure,
    verdict: checkVerdict(checks.length, failed, failure),
    verificationBasis:
      'Trusted runner: controller/voxel-observe.mjs drove real physics ticks in a real window and captured paused frames.',
    caveats: [
      'Screenshots are paused 1280x720 frames, not video; smoothness is not asserted.',
      'Verified on one Windows host; mouse capture is game state, not OS-verified.',
    ],
  }
}

function repairSummary(json) {
  const failed = json.status !== 'repaired-by-agent'
  const defect = json.stages?.defect?.summary ?? null
  const agent = json.stages?.agent?.summary ?? null
  const canonical = json.stages?.canonical ?? null
  const headline = defect && agent
    ? `Defect ${defect.passed}/${defect.passed + defect.failed} -> candidate ${agent.passed}/${agent.passed + agent.failed}`
    : json.failure_reason
      ? `Repair run aborted: ${firstLine(json.failure_reason)}`
      : `Repair experiment: ${json.status ?? 'unknown'}`
  return {
    kind: 'repair-experiment',
    headline,
    startedAt: json.exported_at ?? null,
    finishedAt: null,
    passed: numberOrNull(agent?.passed),
    failed: numberOrNull(agent?.failed),
    total: agent ? agent.passed + agent.failed : null,
    checks: [],
    failure: json.failure_reason ?? null,
    verdict: failed ? 'verified-fail' : 'verified-pass',
    model: json.model ?? null,
    verificationBasis:
      'Trusted runner: hidden suite on a disposable copy; candidate hash and canonical-tree hash recorded.',
    caveats: [
      'One controlled defect (raycast previous-cell); not general autonomous repair.',
      canonical?.unchanged
        ? 'Canonical data module hash was unchanged before and after the run.'
        : 'Canonical-tree hash was not recorded as unchanged.',
    ],
    details: {
      defect: json.stages?.defect ?? null,
      agent: json.stages?.agent ?? null,
      trusted: json.stages?.trusted ?? null,
      canonical: canonical ?? null,
      ordering: json.ordering ?? [],
      actors: json.actors ?? null,
      hidden_test: json.hidden_test ?? null,
      hidden_test_sha256: json.hidden_test_sha256 ?? null,
    },
  }
}

function exportSummary(json) {
  const failure = failureText(json.failure)
  const checks = checksFrom(json.checks, 'ok')
  const failed = numberOrNull(json.failed) ?? checks.filter((check) => !check.pass).length
  const passed = numberOrNull(json.passed) ?? checks.length - failed
  return {
    kind: 'export-verification',
    headline: failure
      ? `${passed}/${checks.length} packaged-build checks, then the run aborted (${json.exe_name ?? 'unknown exe'})`
      : `${passed}/${checks.length} packaged-build checks (${json.exe_name ?? 'unknown exe'})`,
    startedAt: json.exported_at ?? null,
    finishedAt: null,
    passed,
    failed,
    total: checks.length,
    checks,
    failure,
    verdict: checkVerdict(checks.length, failed, failure),
    verificationBasis:
      'Trusted runner: launched the shipped .exe, spoke the bridge protocol, and captured the real window.',
    caveats: [
      'Verified on this host only.',
      'The binary is git-ignored; rebuilding changes its SHA-256.',
    ],
    details: {
      exe_bytes: json.exe_bytes ?? null,
      exe_sha256: json.exe_sha256 ?? null,
      pe_valid: json.pe?.valid ?? null,
    },
  }
}

function measurementsSummary(json) {
  return {
    kind: 'measurements',
    headline: `Measurements: ${json.system?.cpu ?? 'unknown CPU'}`,
    startedAt: json.exported_at ?? null,
    finishedAt: null,
    passed: null,
    failed: null,
    total: null,
    checks: [],
    failure: null,
    verdict: 'informational',
    verificationBasis: 'Trusted runner: wall-clock timings; there is no pass/fail gate.',
    caveats: ['Timings are host-specific and are not a performance budget.'],
    details: {
      system: json.system ?? null,
      cpu_ok: json.cpu?.ok ?? null,
      runtime_ok: json.runtime?.ok ?? null,
      fps_samples: json.runtime?.fps_samples ?? [],
      launch_duration_ms: numberOrNull(json.runtime?.launch_duration_ms),
      notes: json.notes ?? [],
    },
  }
}

function webSummary(json) {
  const observations = Array.isArray(json.input?.observations) ? json.input.observations : []
  return {
    kind: 'browser-session',
    headline: `${observations.length} browser interactions recorded on ${json.url ?? 'the local build'}`,
    startedAt: json.created_at ?? null,
    finishedAt: null,
    passed: observations.length,
    failed: 0,
    total: observations.length,
    checks: observations.map((observation) => ({
      name: String(observation.step ?? 'step'),
      pass: true,
      detail: observation.observed ?? null,
    })),
    failure: null,
    verdict: observations.length ? 'recorded' : 'informational',
    verificationBasis:
      'Human-recorded session (Playwright MCP + ffmpeg) per docs/phase19/evidence/README.md; not a runner gate.',
    caveats: [
      'Recorded by hand, not by a reproducible runner.',
      'Saves live in browser IndexedDB for this origin.',
    ],
    details: {
      console_errors: json.console?.errors ?? null,
      clip: json.clip ?? null,
    },
  }
}

function toolingSummary(json) {
  const gaps = Array.isArray(json.gaps) ? json.gaps : []
  const closed = gaps.filter((gap) => String(gap?.verdict ?? '').startsWith('installed')).length
  return {
    kind: 'tooling-verification',
    headline: `${closed}/${gaps.length} follow-up tooling gaps closed`,
    startedAt: json.generatedAt ?? null,
    finishedAt: null,
    passed: closed,
    failed: gaps.length - closed,
    total: gaps.length,
    checks: gaps.map((gap) => ({
      name: String(gap?.gap ?? 'gap'),
      pass: String(gap?.verdict ?? '').startsWith('installed'),
      detail: gap?.verdict ?? null,
    })),
    failure: null,
    verdict: gaps.length && closed === gaps.length ? 'verified-pass' : 'verified-fail',
    verificationBasis: 'Trusted runner: each tool was exercised against the real native build.',
    caveats: ['Tool availability, not gameplay correctness.'],
    details: { environment: json.environment ?? null },
  }
}

function agentRunSummary(json) {
  const attempts = Array.isArray(json.attempts) ? json.attempts : []
  const accepted = attempts.filter((attempt) => attempt?.accepted === true).length
  return {
    kind: 'agent-implementation-run',
    headline: `${attempts.length} implementation attempts, ${accepted} accepted`,
    startedAt: json.exported_at ?? null,
    finishedAt: null,
    passed: accepted,
    failed: attempts.length - accepted,
    total: attempts.length,
    checks: attempts.map((attempt) => ({
      name: `Attempt ${attempt.attempt ?? '?'}`,
      pass: attempt?.accepted === true,
      detail: Array.isArray(attempt?.problems) ? attempt.problems.join('; ') : null,
    })),
    failure: json.failure_reason ?? null,
    verdict: json.status === 'failed' ? 'model-claim-rejected' : 'informational',
    model: json.model ?? null,
    verificationBasis:
      'Trusted runner recorded every attempt and rejected each one; model output is never the acceptance decision.',
    caveats: [
      'All three attempts were rejected; attempt 3 ended with HTTP 429 FreeUsageLimitError.',
      'No accepted module was produced by the model.',
    ],
    details: {
      hidden_test_sha256_before: json.hidden_test_sha256_before ?? null,
      hidden_test_sha256_after: json.hidden_test_sha256_after ?? null,
      attempts: attempts.map((attempt) => ({
        attempt: attempt?.attempt ?? null,
        duration_ms: attempt?.duration_ms ?? null,
        problems: attempt?.problems ?? [],
      })),
    },
  }
}

function unknownSummary(json, parseError) {
  return {
    kind: 'unknown',
    headline: parseError ? 'Manifest could not be parsed' : 'Unrecognised evidence record',
    startedAt: json?.exported_at ?? json?.started_at ?? null,
    finishedAt: null,
    passed: null,
    failed: null,
    total: null,
    checks: [],
    failure: parseError,
    verdict: 'informational',
    verificationBasis: 'No known schema; displayed for completeness only.',
    caveats: ['This record was not interpreted by S0.'],
    details: {},
  }
}

function summaryFor(kind, json, parseError) {
  if (parseError) return unknownSummary(json, parseError)
  if (kind === 'observation') return observationSummary(json)
  if (kind === 'repair-experiment') return repairSummary(json)
  if (kind === 'export-verification') return exportSummary(json)
  if (kind === 'measurements') return measurementsSummary(json)
  if (kind === 'browser-session') return webSummary(json)
  if (kind === 'tooling-verification') return toolingSummary(json)
  if (kind === 'agent-implementation-run') return agentRunSummary(json)
  return unknownSummary(json, null)
}

function kindForGroup(group) {
  return {
    runtime: 'observation',
    repair: 'repair-experiment',
    export: 'export-verification',
    measurements: 'measurements',
    web: 'browser-session',
    tooling: 'tooling-verification',
    'agent-runs': 'agent-implementation-run',
  }[group] ?? 'unknown'
}

function captureFromManifest(entry) {
  return {
    name: String(entry?.name ?? 'capture'),
    path: String(entry?.image?.path ?? `${entry?.name ?? 'capture'}.png`),
    bytes: numberOrNull(entry?.image?.bytes),
    sha256: entry?.image?.sha256 ?? null,
    width: numberOrNull(entry?.image?.width),
    height: numberOrNull(entry?.image?.height),
    capturedAt: entry?.captured_at ?? null,
    tick: numberOrNull(entry?.tick),
  }
}

function capturesFor(kind, json, files) {
  if (kind === 'observation') {
    return Array.isArray(json.captures) ? json.captures.map(captureFromManifest) : []
  }
  if (kind === 'browser-session') {
    const screenshots = json.screenshots ?? {}
    return Object.entries(screenshots)
      .filter(([name]) => name.endsWith('.png'))
      .map(([name, meta]) => ({
        name: name.replace(/\.png$/, ''),
        path: name,
        bytes: numberOrNull(meta?.bytes),
        sha256: meta?.sha256 ?? null,
        width: numberOrNull(meta?.width),
        height: numberOrNull(meta?.height),
        capturedAt: null,
        tick: null,
      }))
  }
  if (kind === 'export-verification' && json.capture?.file) {
    const name = path.basename(String(json.capture.file))
    return [{
      name: 'packaged-window',
      path: name,
      // The manifest records the .exe size next to the capture, not the PNG
      // size, so take the real byte count from the scanned file list instead.
      bytes: numberOrNull(files.find((file) => file.path === name)?.bytes),
      sha256: json.capture.sha256 ?? null,
      width: null,
      height: null,
      capturedAt: null,
      tick: null,
    }]
  }
  return files
    .filter((file) => file.path.endsWith('.png'))
    .map((file) => ({
      name: path.basename(file.path, '.png'),
      path: file.path,
      bytes: file.bytes,
      sha256: null,
      width: null,
      height: null,
      capturedAt: null,
      tick: null,
    }))
}

const COMPARISON_PAIRS = {
  observation: [
    ['spawn', 'movement', 'Spawn -> after forward input'],
    ['save', 'reload', 'Save -> reload (persistence)'],
  ],
  'browser-session': [
    ['page-load', 'moved', 'Page load -> after movement'],
    ['saved', 'loaded', 'Save -> load'],
  ],
}

function comparisonsFor(kind, captures) {
  const pairs = COMPARISON_PAIRS[kind] ?? []
  const byName = new Map(captures.map((capture) => [capture.name, capture]))
  return pairs
    .map(([before, after, label]) => {
      const left = byName.get(before)
      const right = byName.get(after)
      if (!left || !right) return null
      return { label, before: left, after: right }
    })
    .filter(Boolean)
}

function fileKind(file) {
  const extension = path.extname(file.path).toLowerCase()
  if (IMAGE_EXTENSIONS.has(extension)) return 'image'
  if (VIDEO_EXTENSIONS.has(extension)) return 'video'
  if (TEXT_EXTENSIONS.has(extension)) return 'text'
  return 'other'
}

function sortKey(summary, id) {
  const value = summary.startedAt ? Date.parse(summary.startedAt) : Number.NaN
  if (Number.isFinite(value)) return value
  const match = id.match(/(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/)
  if (!match) return 0
  return Date.parse(`${match[1]}T${match[2]}:${match[3]}:${match[4]}.${match[5]}Z`) || 0
}

function walkFiles(absoluteDir, base = absoluteDir) {
  const out = []
  for (const entry of fs.readdirSync(absoluteDir, { withFileTypes: true })) {
    const absolutePath = path.join(absoluteDir, entry.name)
    if (entry.isDirectory()) {
      out.push(...walkFiles(absolutePath, base))
    } else if (entry.isFile()) {
      out.push({
        absolutePath,
        path: toPosix(path.relative(base, absolutePath)),
        bytes: fs.statSync(absolutePath).size,
      })
    }
  }
  return out
}

/**
 * Validate a caller-supplied relative path against the evidence root.
 * Throws EvidenceError with a stable code; never returns a path outside root.
 */
export function resolveArtifact(evidenceRoot, requested, { realpath = fs.realpathSync.native } = {}) {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new EvidenceError('invalid_path', 'A non-empty path is required.', 400)
  }
  if (requested.includes('\0')) {
    throw new EvidenceError('invalid_path', 'Path contains a null byte.', 400)
  }

  const posix = requested.replace(/\\/g, '/')
  if (posix.startsWith('/') || /^[a-zA-Z]:/.test(posix)) {
    throw new EvidenceError('invalid_path', 'Absolute paths are not accepted.', 400)
  }

  const segments = posix.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new EvidenceError('invalid_path', 'Path traversal segments are not accepted.', 400)
  }

  const extension = path.extname(posix).toLowerCase()
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new EvidenceError('extension_not_allowed', `Extension ${extension || '(none)'} is not served.`, 415)
  }

  const absolutePath = path.resolve(evidenceRoot, ...segments)
  if (!isInside(absolutePath, evidenceRoot)) {
    throw new EvidenceError('outside_root', 'Path escapes the evidence root.', 403)
  }

  let canonicalRoot
  let canonicalPath
  try {
    canonicalRoot = realpath(evidenceRoot)
    canonicalPath = realpath(absolutePath)
  } catch {
    throw new EvidenceError('not_found', 'Artifact does not exist.', 404)
  }

  if (!isInside(canonicalPath, canonicalRoot)) {
    throw new EvidenceError('outside_root', 'Path resolves outside the evidence root.', 403)
  }

  return {
    absolutePath: canonicalPath,
    relativePath: toPosix(path.relative(canonicalRoot, canonicalPath)),
    extension,
  }
}

export function createEvidenceStore({ repoRoot, evidenceRoot = path.join(repoRoot, EVIDENCE_REL) } = {}) {
  if (!repoRoot) throw new Error('repoRoot is required')

  const repositoryRoot = fs.realpathSync.native(path.resolve(repoRoot))
  if (!fs.existsSync(evidenceRoot)) {
    throw new Error(`evidence directory not found: ${evidenceRoot}`)
  }
  const root = fs.realpathSync.native(path.resolve(evidenceRoot))
  if (!isInside(root, repositoryRoot)) {
    throw new Error('evidence directory must stay inside the repository')
  }

  const runs = []
  const runsById = new Map()
  const artifacts = new Map()
  const skipped = []

  const groups = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  for (const group of groups) {
    const groupDir = path.join(root, group)
    const singleManifest = MANIFEST_BY_GROUP[group]
    const isSingleRun = singleManifest && fs.existsSync(path.join(groupDir, singleManifest))

    if (isSingleRun) {
      addRun(group, group, groupDir, singleManifest)
      continue
    }

    const children = fs
      .readdirSync(groupDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()

    for (const child of children) {
      addRun(`${group}/${child}`, group, path.join(groupDir, child), 'run.json')
    }
  }

  function addRun(id, group, absoluteDir, manifestName) {
    const files = walkFiles(absoluteDir)
    const manifestEntry = files.find((file) => file.path === manifestName) ?? null

    // A directory without a manifest is a bare artifact copy (for example the
    // healthy baseline in the repair group), not a run. It is not turned into
    // a fake "unknown" run and its files are not served.
    if (!manifestEntry) {
      skipped.push(id)
      return
    }

    const parsed = readJsonFile(manifestEntry.absolutePath)
    const kind = kindForGroup(group)
    const summary = summaryFor(kind, parsed.json ?? {}, parsed.parseError)

    const captures = capturesFor(kind, parsed.json ?? {}, files).map((capture) => ({
      ...capture,
      rel: `${id}/${capture.path}`,
    }))
    const comparisonImages = captures.filter((capture) => /compare|diff/i.test(capture.name))
    // A compare/diff capture is shown once, under its own heading, instead of
    // also appearing in the plain captures grid.
    const gallery = captures.filter(
      (capture) => !comparisonImages.some((image) => image.rel === capture.rel),
    )

    const record = {
      id,
      group,
      kind,
      label: `${group} / ${id.split('/').slice(1).join('/') || group}`,
      provenance: runProvenance(group),
      ...summary,
      manifest: manifestEntry
        ? { path: manifestName, rel: `${id}/${manifestName}`, bytes: manifestEntry.bytes }
        : null,
      parseError: parsed.parseError,
      captures,
      gallery,
      comparisons: comparisonsFor(kind, captures),
      comparisonImages,
      videos: files
        .filter((file) => path.extname(file.path).toLowerCase() === '.mp4')
        .map((file) => ({
          name: path.basename(file.path),
          path: file.path,
          rel: `${id}/${file.path}`,
          bytes: file.bytes,
        })),
      files: files.map((file) => ({
        path: file.path,
        rel: `${id}/${file.path}`,
        bytes: file.bytes,
        kind: fileKind(file),
        servable: ALLOWED_EXTENSIONS.has(path.extname(file.path).toLowerCase()),
        provenance: classifyProvenance(`${id}/${file.path}`),
      })),
      sortKey: sortKey(summary, id),
    }

    runs.push(record)
    runsById.set(id, record)
    for (const file of record.files) artifacts.set(file.rel, file)
  }

  runs.sort((left, right) => right.sortKey - left.sortKey || left.id.localeCompare(right.id))

  return {
    repoRoot: repositoryRoot,
    evidenceRoot: root,

    meta() {
      return {
        scope: 'S0 read-only evidence dashboard',
        repoRoot: repositoryRoot,
        evidenceRoot: root,
        runCount: runs.length,
        artifactCount: artifacts.size,
        skippedDirectories: [...skipped].sort(),
        allowedExtensions: [...ALLOWED_EXTENSIONS].sort(),
        readOnly: true,
        modelCalls: 0,
        commandsExecutedFromBrowser: 0,
        scannedAt: new Date().toISOString(),
      }
    },

    listRuns() {
      return runs.map(({ sortKey, ...run }) => run)
    },

    getRun(id) {
      const run = runsById.get(id)
      if (!run) return null
      const { sortKey, ...rest } = run
      return rest
    },

    /**
     * Resolve an artifact twice: structural guard first, then membership in the
     * scanned index. A file that was never scanned is never served.
     */
    getArtifact(relativePath) {
      const resolved = resolveArtifact(root, relativePath)
      if (!artifacts.has(resolved.relativePath)) {
        throw new EvidenceError('not_found', 'Artifact is not part of the scanned evidence index.', 404)
      }
      const entry = artifacts.get(resolved.relativePath)
      return { ...resolved, bytes: entry.bytes, contentType: contentTypeFor(resolved.extension) }
    },

    readText(relativePath, { maxBytes = 65536, maxLines = 120 } = {}) {
      const artifact = this.getArtifact(relativePath)
      if (!TEXT_EXTENSIONS.has(artifact.extension)) {
        throw new EvidenceError('not_text', 'Only text artifacts can be previewed.', 415)
      }
      const byteCap = Math.min(Math.max(Number(maxBytes) || 65536, 1024), 2 * 1024 * 1024)
      const lineCap = Math.min(Math.max(Number(maxLines) || 120, 1), 2000)

      if (artifact.bytes > byteCap) {
        const handle = fs.openSync(artifact.absolutePath, 'r')
        const buffer = Buffer.alloc(byteCap)
        const read = fs.readSync(handle, buffer, 0, byteCap, 0)
        fs.closeSync(handle)
        const text = buffer.subarray(0, read).toString('utf8')
        const allLines = text.split(/\r?\n/)
        const truncated = true
        return {
          path: artifact.relativePath,
          bytes: artifact.bytes,
          sha256: null,
          lines: allLines.slice(0, lineCap),
          returnedLines: Math.min(allLines.length, lineCap),
          truncated,
        }
      }

      const buffer = fs.readFileSync(artifact.absolutePath)
      const allLines = buffer.toString('utf8').split(/\r?\n/)
      const truncated = allLines.length > lineCap
      return {
        path: artifact.relativePath,
        bytes: artifact.bytes,
        sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
        lines: allLines.slice(0, lineCap),
        returnedLines: Math.min(allLines.length, lineCap),
        truncated,
      }
    },
  }
}
