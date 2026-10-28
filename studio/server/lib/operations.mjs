import fs from 'node:fs'
import path from 'node:path'

import {
  ARTIFACT_ROOT,
  OPS_ROOT,
  StudioError,
  ensureDataDirs,
  newId,
  readJson,
  sha256File,
  writeJsonAtomic,
} from './studio-paths.mjs'
import { getProject, projectRoot } from './projects.mjs'
import { runFixed } from './process.mjs'
import { runScriptTest, staticCheckProject } from './verification.mjs'

/**
 * Trusted operation runner.
 *
 * Every operation is a named, fixed routine in this file. The HTTP layer can
 * choose an operation name and a small validated payload; it can never supply
 * an executable, a shell string, a working directory or a filesystem path.
 * Native windows are owned here and are reused across capture/advance/reset.
 */

function readPngSize(file) {
  try {
    const buffer = fs.readFileSync(file)
    if (buffer.length < 24) return null
    if (buffer.readUInt32BE(0) !== 0x89504e47 || buffer.readUInt32BE(4) !== 0x0d0a1a0a) return null
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
  } catch {
    return null
  }
}

const OP_LABELS = Object.freeze({
  check: 'Static script check',
  test: 'Project test suite',
  launch: 'Launch native window',
  stop: 'Stop native window',
  capture: 'Capture screenshot',
  reset: 'Reset game state',
  advance: 'Advance simulation',
  logs: 'Read runtime logs',
  export: 'Export build',
  preview: 'Preview status',
})

const READ_ONLY_OPS = new Set(['preview'])
const MAX_OPS = 200
const MAX_LOG_LINES = 200

function sanitizeInput(input) {
  if (input === null || input === undefined) return null
  if (typeof input !== 'object' || Array.isArray(input)) {
    throw new StudioError('invalid_input', 'Input must be an object.', 400)
  }
  const allowed = new Set(['forward', 'strafe', 'jump', 'restart', 'actions'])
  const output = {}
  for (const [key, value] of Object.entries(input)) {
    if (!allowed.has(key)) {
      throw new StudioError('invalid_input', `Unknown input field "${key}".`, 400)
    }
    if (key === 'forward' || key === 'strafe') {
      if (typeof value !== 'number' || !Number.isFinite(value) || value < -1 || value > 1) {
        throw new StudioError('invalid_input', `${key} must be a number between -1 and 1.`, 400)
      }
      output[key] = value
    } else if (key === 'jump' || key === 'restart') {
      if (typeof value !== 'boolean') {
        throw new StudioError('invalid_input', `${key} must be a boolean.`, 400)
      }
      output[key] = value
    } else {
      if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        throw new StudioError('invalid_input', 'actions must be an object of booleans.', 400)
      }
      const actions = {}
      for (const [name, enabled] of Object.entries(value)) {
        if (!/^[a-z][a-z0-9_]{0,31}$/.test(name) || typeof enabled !== 'boolean') {
          throw new StudioError('invalid_input', `Invalid action "${name}".`, 400)
        }
        actions[name] = enabled
      }
      output.actions = actions
    }
  }
  return output
}

function tail(lines, limit = MAX_LOG_LINES) {
  const value = Array.isArray(lines) ? lines : []
  return value.slice(-limit)
}

function stamp() {
  return new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
}

export function createOperations({
  deps = {},
  sessionFactory = null,
  root = OPS_ROOT,
  now = () => new Date(),
} = {}) {
  const {
    runFixedImpl = runFixed,
    staticCheckProjectImpl = staticCheckProject,
    runScriptTestImpl = runScriptTest,
    projectRootImpl = projectRoot,
    getProjectImpl = getProject,
    hashFile = sha256File,
    fetchImpl = globalThis.fetch,
  } = deps

  ensureDataDirs()

  const sessions = new Map()
  const locks = new Set()

  function sessionsFor(projectId) {
    return sessions.get(projectId) ?? null
  }

  function sessionSummary(projectId) {
    const entry = sessionsFor(projectId)
    if (!entry) {
      return { running: false, pid: null, startedAt: null, headless: null, paused: null }
    }
    return {
      running: Boolean(entry.session?.child),
      pid: entry.session?.pid ?? null,
      startedAt: entry.startedAt,
      headless: entry.session?.headless ?? null,
      paused: entry.paused ?? null,
    }
  }

  function requireSession(projectId) {
    const entry = sessionsFor(projectId)
    if (!entry || !entry.session?.child) {
      throw new StudioError(
        'session_not_running',
        'Launch the native window for this project first, then retry.',
        409,
      )
    }
    return entry
  }

  function opFile(id) {
    return path.join(root, `${id}.json`)
  }

  function listOps({ projectId = null, limit = 50 } = {}) {
    if (!fs.existsSync(root)) return []
    const records = []
    for (const name of fs.readdirSync(root)) {
      if (!name.endsWith('.json')) continue
      try {
        const record = JSON.parse(fs.readFileSync(path.join(root, name), 'utf8'))
        if (!record || typeof record.id !== 'string') continue
        if (projectId && record.projectId !== projectId) continue
        records.push(record)
      } catch {
        // A partially written or hand-edited record is ignored; it is not a job.
      }
    }
    records.sort((a, b) => String(b.startedAt ?? '').localeCompare(String(a.startedAt ?? '')))
    return records.slice(0, Math.max(1, Math.min(200, limit)))
  }

  function latestForProject(projectId, limit = 100) {
    return listOps({ projectId, limit }).map((record) => ({
      key: record.key,
      op: record.op,
      status: record.status,
      startedAt: record.startedAt,
      finishedAt: record.finishedAt,
      durationMs: record.durationMs,
      summary: record.summary ?? null,
      error: record.error ?? null,
      artifact: record.artifact ?? null,
    }))
  }

  function getOp(id) {
    if (typeof id !== 'string' || !/^op-[a-z0-9-]{6,60}$/.test(id)) {
      throw new StudioError('invalid_op', 'Invalid operation id.', 400)
    }
    const record = readJson(opFile(id), null)
    if (!record) throw new StudioError('not_found', 'No such operation.', 404)
    return record
  }

  function pruneOps() {
    const records = listOps({ limit: MAX_OPS + 50 })
    for (const record of records.slice(MAX_OPS)) {
      try {
        fs.rmSync(opFile(record.id), { force: true })
      } catch {
        // Retention is best effort.
      }
    }
  }

  async function withLock(projectId, op, fn) {
    const key = `${projectId}:${op}`
    if (locks.has(projectId)) {
      throw new StudioError(
        'busy',
        'Another operation is running for this project. Wait for it to finish.',
        409,
      )
    }
    locks.add(projectId)
    try {
      return await fn()
    } finally {
      locks.delete(projectId)
    }
  }

  async function run(projectId, op, payload = {}) {
    const project = getProjectImpl(projectId)
    if (!Object.hasOwn(OP_LABELS, op)) {
      throw new StudioError('invalid_op', 'Unknown operation.', 400)
    }
    if (READ_ONLY_OPS.has(op)) {
      return readOnly(project, op, payload)
    }
    return withLock(projectId, op, () => execute(project, op, payload))
  }

  function readOnly(project, op, payload) {
    if (op === 'preview') {
      return {
        id: newId('op'),
        key: `${project.id}:preview`,
        projectId: project.id,
        op,
        label: OP_LABELS[op],
        status: 'ok',
        startedAt: now().toISOString(),
        finishedAt: now().toISOString(),
        durationMs: 0,
        request: {},
        result: {
          native: sessionSummary(project.id),
          browser: project.browser
            ? { url: project.browser.url, label: project.browser.label, configured: true }
            : { url: null, label: 'No browser build is registered for this project.', configured: false },
          controls: project.controls,
        },
        logs: { stdout: [], stderr: [] },
        error: null,
      }
    }
    throw new StudioError('invalid_op', 'Unknown read-only operation.', 400)
  }

  async function execute(project, op, payload) {
    const root = projectRootImpl(project)
    const id = newId('op')
    const startedAt = now().toISOString()
    const startedMs = Date.now()
    const record = {
      schema: 'studio.op.v1',
      id,
      key: `${project.id}:${op}${op === 'test' ? `:${payload.testId ?? ''}` : ''}`,
      projectId: project.id,
      op,
      label: opLabel(project, op, payload),
      status: 'running',
      startedAt,
      finishedAt: null,
      durationMs: null,
      request: sanitizeRequest(op, payload),
      result: null,
      logs: { stdout: [], stderr: [] },
      artifact: null,
      error: null,
    }
    writeJsonAtomic(opFile(id), record)

    try {
      let outcome
      switch (op) {
        case 'check':
          outcome = await opCheck(project, root)
          break
        case 'test':
          outcome = await opTest(project, root, payload)
          break
        case 'launch':
          outcome = await opLaunch(project, root, payload)
          break
        case 'stop':
          outcome = await opStop(project)
          break
        case 'capture':
          outcome = await opCapture(project)
          break
        case 'reset':
          outcome = await opReset(project)
          break
        case 'advance':
          outcome = await opAdvance(project, payload)
          break
        case 'logs':
          outcome = opLogs(project)
          break
        case 'export':
          outcome = await opExport(project, root)
          break
        default:
          throw new StudioError('invalid_op', 'Unknown operation.', 400)
      }
      Object.assign(record, outcome, {
        status: outcome.status ?? 'ok',
        finishedAt: now().toISOString(),
        durationMs: Date.now() - startedMs,
      })
    } catch (error) {
      record.status = 'failed'
      record.finishedAt = now().toISOString()
      record.durationMs = Date.now() - startedMs
      record.error = {
        class: error.code ?? 'internal',
        message: error.message,
        status: error.status ?? 500,
      }
      record.logs = {
        stdout: record.logs?.stdout ?? [],
        stderr: [...(record.logs?.stderr ?? []), String(error.stack ?? error.message).slice(0, 4000)],
      }
      if (!(error instanceof StudioError)) {
        console.error(`[studio] op ${op} failed:`, error)
      }
    }

    writeJsonAtomic(opFile(id), record)
    pruneOps()
    return record
  }

  function opLabel(project, op, payload) {
    if (op === 'test') {
      const suite = project.tests.find((entry) => entry.id === payload.testId)
      return suite ? suite.label : 'Project test suite'
    }
    return OP_LABELS[op]
  }

  function sanitizeRequest(op, payload) {
    if (op === 'test') return { testId: payload.testId ?? null }
    if (op === 'advance') {
      return {
        steps: payload.steps ?? null,
        input: payload.input ?? null,
      }
    }
    return {}
  }

  async function opCheck(project, root) {
    const check = await staticCheckProjectImpl({ projectDir: root, project })
    return {
      status: check.ok ? 'ok' : 'failed',
      summary: check.ok
        ? `${check.fileCount} script(s) parsed cleanly (${check.mode}).`
        : `${check.errors.length} diagnostic error(s) across ${check.fileCount} script(s).`,
      result: {
        ok: check.ok,
        mode: check.mode,
        fileCount: check.fileCount,
        errors: check.errors.slice(0, 50),
        warnings: check.warnings.slice(0, 50),
      },
      logs: { stdout: [], stderr: check.errors.slice(0, 50) },
      error: check.ok ? null : { class: 'static_check', message: check.errors[0] ?? 'Static check failed.' },
    }
  }

  async function opTest(project, root, payload) {
    const suite = project.tests.find((entry) => entry.id === payload.testId)
    if (!suite) {
      throw new StudioError('invalid_test', 'Choose a test suite registered for this project.', 400)
    }
    const result = await runScriptTestImpl({
      projectDir: root,
      script: suite.script,
      timeoutMs: suite.timeoutMs,
      expectedDiagnostics: suite.expectedDiagnostics ?? [],
    })
    const passed = result.summary?.passed ?? 0
    const failed = result.summary?.failed ?? 0
    return {
      status: result.ok ? 'ok' : 'failed',
      summary: result.ok
        ? `${passed} passed, ${failed} failed in ${suite.label}.`
        : `${failed} failed, ${passed} passed in ${suite.label}.`,
      result: {
        suite: { id: suite.id, label: suite.label, script: suite.script },
        ok: result.ok,
        available: result.available !== false,
        summary: result.summary,
        reason: result.reason ?? null,
        durationMs: result.durationMs ?? null,
        exitCode: result.exitCode ?? null,
        timedOut: Boolean(result.timedOut),
        failures: (result.results ?? [])
          .filter((entry) => entry && entry.passed === false)
          .slice(0, 20)
          .map((entry) => ({ name: entry.name, detail: entry.detail ?? '' })),
        results: (result.results ?? []).slice(0, 200),
        errors: (result.errors ?? []).slice(0, 20),
      },
      logs: { stdout: [], stderr: (result.errors ?? []).slice(0, 20) },
      error: result.ok ? null : { class: 'test_failed', message: result.reason ?? `${failed} test(s) failed.` },
    }
  }

  async function opLaunch(project, root, payload) {
    const existing = sessionsFor(project.id)
    if (existing?.session?.child) {
      return {
        status: 'ok',
        summary: `Native window already running (pid ${existing.session.pid}).`,
        result: { ...sessionSummary(project.id), alreadyRunning: true },
        logs: sessionLogs(existing),
      }
    }

    const factory = sessionFactory ?? (await defaultSessionFactory())
    const session = factory({ projectDir: root, project, headless: payload.headless === true })
    let startInfo
    try {
      startInfo = await session.start()
    } catch (error) {
      try {
        await session.stop()
      } catch {
        // The start failure is the useful error.
      }
      throw new StudioError('launch_failed', `Godot did not start: ${error.message}`, 502)
    }
    const entry = { session, startedAt: now().toISOString(), paused: false }
    sessions.set(project.id, entry)
    return {
      status: 'ok',
      summary: `Native window launched (pid ${startInfo?.pid ?? session.pid}).`,
      result: {
        ...sessionSummary(project.id),
        alreadyRunning: false,
        start: startInfo ?? null,
      },
      logs: sessionLogs(entry),
    }
  }

  function opStop(project) {
    const entry = sessionsFor(project.id)
    if (!entry) {
      return {
        status: 'ok',
        summary: 'No native window was running.',
        result: { alreadyStopped: true, ...sessionSummary(project.id) },
        logs: { stdout: [], stderr: [] },
      }
    }
    sessions.delete(project.id)
    return stopEntry(entry)
  }

  async function stopEntry(entry) {
    let stopResult
    try {
      stopResult = await entry.session.stop()
    } catch (error) {
      return {
        status: 'failed',
        summary: `Stop failed: ${error.message}`,
        result: { stopped: false },
        logs: sessionLogs(entry),
        error: { class: 'stop_failed', message: error.message },
      }
    }
    return {
      status: 'ok',
      summary: stopResult?.alreadyStopped ? 'Native window had already stopped.' : 'Native window stopped.',
      result: { stopped: true, stop: stopResult ?? null },
      logs: sessionLogs(entry),
    }
  }

  async function opCapture(project) {
    const entry = requireSession(project.id)
    const file = `capture-${stamp()}-${Math.random().toString(16).slice(2, 8)}.png`
    const projectRelative = `artifacts/studio-capture-${stamp()}.png`
    const destinationDir = path.join(ARTIFACT_ROOT, project.id)
    fs.mkdirSync(destinationDir, { recursive: true })
    const destination = path.join(destinationDir, file)

    const wasPaused = entry.paused
    try {
      await entry.session.pause()
      entry.paused = true
      const frame = await entry.session.captureFrame({
        path: `res://${projectRelative}`,
        scenario: 'studio',
        metadata: { source: 'studio-operation', projectId: project.id },
      })
      const source = path.join(projectRootImpl(project), ...projectRelative.split("/"))
      if (!fs.existsSync(source)) {
        throw new StudioError('capture_missing', 'Godot reported a capture but no PNG was written.', 502)
      }
      fs.copyFileSync(source, destination)
      fs.rmSync(source, { force: true })
      // Godot's capture response does not always include pixel dimensions, so
      // read them from the real PNG header rather than printing "?x?".
      const measured = readPngSize(destination)
      const width = measured?.width ?? frame.width ?? null
      const height = measured?.height ?? frame.height ?? null
      const size = Number.isFinite(width) && Number.isFinite(height) ? ` (${width}x${height})` : ''
      return {
        status: 'ok',
        summary: `Captured ${frame.captured_at ?? 'a frame'}${size}.`,
        result: {
          frame: {
            capturedAt: frame.captured_at ?? null,
            scenario: frame.scenario ?? null,
            paused: frame.paused ?? true,
            width,
            height,
            simTimeSeconds: frame.sim_time_seconds ?? null,
          },
          state: frame.state_after ?? frame.state_before ?? null,
        },
        artifact: {
          path: `artifacts/${project.id}/${file}`,
          url: `/api/studio/artifacts/${project.id}/${file}`,
          contentType: 'image/png',
          bytes: fs.statSync(destination).size,
          sha256: hashFile(destination),
        },
        logs: sessionLogs(entry),
      }
    } finally {
      if (!wasPaused && entry.session?.child) {
        try {
          await entry.session.resume()
          entry.paused = false
        } catch {
          // A failed resume is surfaced by the next operation.
        }
      }
    }
  }

  async function opReset(project) {
    const entry = requireSession(project.id)
    const snapshot = await entry.session.reset()
    entry.paused = false
    return {
      status: 'ok',
      summary: 'Game state reset through the harness bridge.',
      result: { snapshot: trimmedSnapshot(snapshot) },
      logs: sessionLogs(entry),
    }
  }

  async function opAdvance(project, payload) {
    const entry = requireSession(project.id)
    const steps = payload.steps === undefined ? 30 : payload.steps
    if (!Number.isInteger(steps) || steps < 1 || steps > 3600) {
      throw new StudioError('invalid_input', 'steps must be an integer between 1 and 3600.', 400)
    }
    const input = sanitizeInput(payload.input ?? null)
    if (entry.paused) {
      await entry.session.resume()
      entry.paused = false
    }
    const snapshot = await entry.session.step({ steps, input })
    return {
      status: 'ok',
      summary: `Advanced ${steps} physics step(s)${input ? ' with harness input' : ''}.`,
      result: { steps, input, snapshot: trimmedSnapshot(snapshot) },
      logs: sessionLogs(entry),
    }
  }

  function opLogs(project) {
    const entry = sessionsFor(project.id)
    if (entry) {
      return {
        status: 'ok',
        summary: 'Runtime logs from the live native window.',
        result: { running: true, pid: entry.session?.pid ?? null },
        logs: sessionLogs(entry),
      }
    }
    const previous = listOps({ projectId: project.id, limit: 40 }).find(
      (record) => record.logs && (record.logs.stdout?.length || record.logs.stderr?.length),
    )
    if (!previous) {
      throw new StudioError('no_logs', 'No native window is running and no earlier logs were recorded.', 404)
    }
    return {
      status: 'ok',
      summary: `Runtime logs from the last operation with output (${previous.op}).`,
      result: { running: false, pid: null, fromOp: previous.id },
      logs: {
        stdout: tail(previous.logs.stdout),
        stderr: tail(previous.logs.stderr),
      },
    }
  }

  async function opExport(project, root) {
    if (!project.exportPreset) {
      throw new StudioError('export_unsupported', 'No export preset is registered for this project.', 400)
    }
    const presetFile = path.join(root, 'export_presets.cfg')
    if (!fs.existsSync(presetFile)) {
      throw new StudioError(
        'export_unsupported',
        `export_presets.cfg is missing for ${project.name}; export is unavailable.`,
        400,
      )
    }
    if (!fs.readFileSync(presetFile, 'utf8').includes(`name="${project.exportPreset}"`)) {
      throw new StudioError(
        'export_unsupported',
        `The registered preset "${project.exportPreset}" is not present in export_presets.cfg.`,
        400,
      )
    }
    const { GODOT_BIN } = await import(
      new URL('../../../experiments/godot-harness/controller/harness.mjs', import.meta.url)
    )
    const directory = path.join(ARTIFACT_ROOT, project.id, 'export')
    fs.mkdirSync(directory, { recursive: true })
    const output = path.join(directory, `${project.id}-${stamp()}.exe`)
    const result = await runFixedImpl({
      file: GODOT_BIN,
      args: ['--headless', '--path', root, '--export-release', project.exportPreset, output],
      cwd: root,
      timeoutMs: 300000,
    })
    const ok = result.code === 0 && fs.existsSync(output)
    return {
      status: ok ? 'ok' : 'failed',
      summary: ok
        ? `Exported ${path.basename(output)} (${fs.statSync(output).size} bytes).`
        : `Export failed (exit ${result.code ?? 'none'}). See stderr for the missing template or preset error.`,
      result: {
        preset: project.exportPreset,
        exitCode: result.code,
        timedOut: result.timedOut,
        bytes: ok ? fs.statSync(output).size : 0,
      },
      artifact: ok
        ? {
            path: `artifacts/${project.id}/export/${path.basename(output)}`,
            url: null,
            contentType: 'application/octet-stream',
            bytes: fs.statSync(output).size,
            sha256: hashFile(output),
          }
        : null,
      logs: {
        stdout: tail(result.stdoutLines ?? String(result.stdout ?? '').split(/\r?\n/)),
        stderr: tail(result.stderrLines ?? String(result.stderr ?? '').split(/\r?\n/)),
      },
      error: ok
        ? null
        : {
            class: 'export_failed',
            message:
              result.stderrLines?.find((line) => line.trim()) ??
              'Export failed. Export templates may not be installed for this Godot version.',
          },
    }
  }

  function sessionLogs(entry) {
    return {
      stdout: tail(entry.session?.stdoutLines),
      stderr: tail(entry.session?.stderrLines),
    }
  }

  function trimmedSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return snapshot
    const copy = { ...snapshot }
    for (const key of Object.keys(copy)) {
      const value = copy[key]
      if (typeof value === 'string' && value.length > 4000) copy[key] = `${value.slice(0, 4000)}…`
      if (key === 'chunks' && value && typeof value === 'object') copy[key] = '[chunk map omitted]'
    }
    return copy
  }

  async function preview(projectId) {
    const project = getProjectImpl(projectId)
    const native = sessionSummary(project.id)
    let browser = null
    if (project.browser) {
      browser = {
        url: project.browser.url,
        label: project.browser.label,
        configured: true,
        reachable: false,
        status: null,
        error: null,
      }
      if (typeof fetchImpl === 'function') {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 1500)
        try {
          const response = await fetchImpl(project.browser.url, {
            method: 'GET',
            signal: controller.signal,
          })
          browser.reachable = response.ok
          browser.status = response.status
        } catch (error) {
          browser.error = error.name === 'AbortError' ? 'Timed out after 1.5 s.' : error.message
        } finally {
          clearTimeout(timer)
        }
      }
    } else {
      browser = {
        url: null,
        label: 'No browser build is registered for this project.',
        configured: false,
        reachable: false,
        status: null,
        error: null,
      }
    }
    return { projectId: project.id, native, browser, controls: project.controls }
  }

  async function stopAll() {
    const results = []
    for (const [projectId, entry] of [...sessions.entries()]) {
      sessions.delete(projectId)
      results.push({ projectId, ...(await stopEntry(entry)) })
    }
    return results
  }

  return {
    run,
    listOps,
    latestForProject,
    getOp,
    preview,
    sessionSummary,
    stopAll,
    sessions,
  }
}

async function defaultSessionFactory() {
  const { HarnessSession } = await import(
    new URL('../../../experiments/godot-harness/controller/harness.mjs', import.meta.url)
  )
  return ({ projectDir, headless }) =>
    new HarnessSession({
      project: projectDir,
      headless,
      timeoutMs: 45000,
      allowOutsideRoot: true,
    })
}
