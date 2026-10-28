import fs from 'node:fs'
import path from 'node:path'

import { HARNESS_ROOT, REPO_ROOT, isInside, listFiles, sha256File } from './studio-paths.mjs'
import { runFixed } from './process.mjs'

export function collectGdScripts(projectDir) {
  return listFiles(projectDir, { ignore: new Set(['.godot', 'build', 'artifacts', 'node_modules', '__pycache__', '.git', '.studio-hidden']) })
    .filter((relative) => relative.endsWith('.gd'))
    .map((relative) => path.join(projectDir, relative))
}

export async function staticCheckProject({ projectDir, project, useLsp = false, timeoutMs = 60000 }) {
  const files = collectGdScripts(projectDir)
  if (files.length === 0) {
    return {
      available: false,
      ok: false,
      mode: 'none',
      errors: ['No GDScript files found in the workspace.'],
      warnings: [],
      diagnostics: [],
      fileCount: 0,
    }
  }

  if (useLsp) {
    try {
      const { checkWithLsp } = await import(
        new URL('../../../experiments/godot-harness/controller/gd-check.mjs', import.meta.url)
      )
      const result = await checkWithLsp({ files, timeoutMs })
      const errors = result.diagnostics.filter((item) => item.severity === 'error')
      const warnings = result.diagnostics.filter((item) => item.severity === 'warning')
      return {
        available: true,
        ok: errors.length === 0,
        mode: 'godot-lsp',
        complete: result.complete,
        diagnostics: result.diagnostics.slice(0, 500),
        errors: errors.slice(0, 200).map(formatDiagnostic),
        warnings: warnings.slice(0, 200).map(formatDiagnostic),
        fileCount: files.length,
      }
    } catch (error) {
      return {
        available: false,
        ok: false,
        mode: 'godot-lsp',
        errors: [`Language server check failed: ${error.message}`],
        warnings: [],
        diagnostics: [],
        fileCount: files.length,
      }
    }
  }

  const { GODOT_BIN } = await import(
    new URL('../../../experiments/godot-harness/controller/harness.mjs', import.meta.url)
  )
  const errors = []
  const warningLines = []
  const checked = []
  for (const file of files) {
    const relative = path.relative(projectDir, file).split(path.sep).join('/')
    const result = await runFixed({
      file: GODOT_BIN,
      args: ['--headless', '--path', projectDir, '--check-only', '--script', `res://${relative}`],
      cwd: projectDir,
      timeoutMs,
    })
    checked.push(relative)
    const text = `${result.stdout}\n${result.stderr}`
    for (const line of text.split(/\r?\n/)) {
      if (/SCRIPT ERROR|Parse Error|Failed to load script|Invalid (call|assignment|get index)/i.test(line)) {
        errors.push(`${relative}: ${line.trim()}`)
      } else if (/^WARNING:|warning:/i.test(line.trim())) {
        warningLines.push(`${relative}: ${line.trim()}`)
      }
    }
    if (result.code !== 0) errors.push(`${relative}: Godot check-only exited with code ${result.code}.`)
    if (result.timedOut) errors.push(`${relative}: check-only timed out.`)
  }
  return {
    available: true,
    ok: errors.length === 0,
    mode: 'godot-check-only',
    fileCount: files.length,
    files: checked,
    errors: errors.slice(0, 200),
    warnings: warningLines.slice(0, 200),
    diagnostics: [],
  }
}

function formatDiagnostic(item) {
  return `${item.file}:${item.line}:${item.column} ${item.message}`
}

/**
 * A suite can declare diagnostics that are intentionally produced by one of its
 * own passing cases (for example the voxel invalid-save test, which loads
 * malformed JSON on purpose). Such a line is only forgiven when:
 *
 *   - the case named by `whenPassed` actually passed,
 *   - the summary has zero failures and its counts match the individual cases,
 *   - the process exited 0 and did not time out,
 *   - every ERROR line matches a declared expectation, and
 *   - no expectation is used more often than its `max`.
 *
 * Anything else stays a failure, so an unexpected Godot error can never be
 * silently ignored.
 */
export function applyExpectedDiagnostics(result, expectations = []) {
  const errors = Array.isArray(result.errors) ? result.errors : []
  if (errors.length === 0) {
    return { ...result, expectedDiagnostics: [], unexpectedDiagnostics: [] }
  }

  const passedNames = new Set(
    (Array.isArray(result.results) ? result.results : [])
      .filter((entry) => entry?.passed === true)
      .map((entry) => entry.name),
  )
  const compiled = expectations
    .map((expectation) => {
      try {
        return { ...expectation, regex: new RegExp(expectation.pattern) }
      } catch {
        return null
      }
    })
    .filter(Boolean)

  const matched = []
  const unexpected = []
  const uses = new Map()
  for (const line of errors) {
    const expectation = compiled.find((candidate) => candidate.regex.test(line))
    if (!expectation) {
      unexpected.push(line)
      continue
    }
    const used = (uses.get(expectation) ?? 0) + 1
    if (used > (expectation.max ?? 1)) {
      unexpected.push(line)
      continue
    }
    uses.set(expectation, used)
    if (expectation.whenPassed && !passedNames.has(expectation.whenPassed)) {
      unexpected.push(line)
      continue
    }
    matched.push(line)
  }

  if (unexpected.length > 0 || matched.length === 0) {
    return { ...result, expectedDiagnostics: matched, unexpectedDiagnostics: unexpected }
  }

  const summary = result.summary ?? null
  const results = Array.isArray(result.results) ? result.results : []
  const countsMatch =
    summary !== null &&
    summary.failed === 0 &&
    results.length === summary.passed + summary.failed &&
    results.every((entry) => entry?.passed === true)
  const structurallyClean = countsMatch && result.exitCode === 0 && result.timedOut !== true
  if (!structurallyClean) {
    return {
      ...result,
      expectedDiagnostics: matched,
      unexpectedDiagnostics: ['Expected diagnostics were not accompanied by a clean passing run.'],
    }
  }

  return {
    ...result,
    ok: true,
    reason: `tests passed with ${matched.length} expected diagnostic line(s)`,
    expectedDiagnostics: matched,
    unexpectedDiagnostics: [],
  }
}

export async function runScriptTest({ projectDir, script, timeoutMs = 180000, expectedDiagnostics = [] }) {
  if (typeof script !== 'string' || !script.startsWith('res://') || !script.endsWith('.gd')) {
    return {
      available: false,
      ok: false,
      summary: { passed: 0, failed: 0 },
      errors: ['Refusing a test script that is not a res:// .gd path.'],
      results: [],
    }
  }
  const { runTests } = await import(
    new URL('../../../experiments/godot-harness/controller/harness.mjs', import.meta.url)
  )
  try {
    const result = await runTests({ project: projectDir, script, timeoutMs, allowOutsideRoot: true })
    const normalized = applyExpectedDiagnostics(
      {
        available: true,
        ok: Boolean(result.ok),
        summary: result.summary ?? { passed: 0, failed: 0 },
        reason: result.reason ?? null,
        durationMs: result.durationMs ?? null,
        exitCode: result.exitCode ?? null,
        timedOut: Boolean(result.timedOut),
        results: Array.isArray(result.results) ? result.results.slice(0, 300) : [],
        errors: Array.isArray(result.errors) ? result.errors.slice(0, 50) : [],
        warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 50) : [],
      },
      expectedDiagnostics,
    )
    return normalized
  } catch (error) {
    return {
      available: true,
      ok: false,
      summary: { passed: 0, failed: 0 },
      errors: [`Test runner failed: ${error.message}`],
      results: [],
    }
  }
}

/**
 * Copy the canonical hidden suite into the candidate workspace only for the
 * duration of the run, then remove it. The agent never sees this file.
 */
export async function runHiddenSuite({ workspace, project, timeoutMs = 120000 }) {
  if (!project.hiddenTest) {
    return {
      available: false,
      ok: false,
      skipped: true,
      reason: 'No hidden acceptance suite is configured for this project.',
      summary: { passed: 0, failed: 0 },
      results: [],
      errors: [],
    }
  }
  // A built-in project keeps its hidden suite inside the harness (pristine,
  // outside the project). A created project can name an absolute template file
  // instead, because its own tree lives under studio/.data and the pristine
  // copy must come from the read-only template.
  const source = project.hiddenTest.sourcePath
    ? path.resolve(REPO_ROOT, project.hiddenTest.sourcePath)
    : path.join(HARNESS_ROOT, project.root, project.hiddenTest.relative)
  if (!isInside(source, REPO_ROOT)) {
    return {
      available: false,
      ok: false,
      reason: 'The hidden acceptance suite path escapes the repository.',
      summary: { passed: 0, failed: 0 },
      results: [],
      errors: [],
    }
  }
  if (!fs.existsSync(source)) {
    return {
      available: false,
      ok: false,
      reason: `Configured hidden suite is missing: ${project.hiddenTest.relative}`,
      summary: { passed: 0, failed: 0 },
      results: [],
      errors: [],
    }
  }
  const hiddenDir = path.join(workspace, '.studio-hidden')
  const target = path.join(hiddenDir, path.basename(project.hiddenTest.relative))
  fs.mkdirSync(hiddenDir, { recursive: true })
  fs.copyFileSync(source, target)
  try {
    const relative = path.relative(workspace, target).split(path.sep).join('/')
    return await runScriptTest({
      projectDir: workspace,
      script: `res://${relative}`,
      timeoutMs: project.hiddenTest.timeoutMs ?? timeoutMs,
    })
  } finally {
    fs.rmSync(hiddenDir, { recursive: true, force: true })
  }
}

/**
 * Launch the candidate in a real window, pause on a real frame, capture it,
 * then drive real harness input and require an observed state change. This is
 * the only place a boss is allowed to say "controls verified".
 */
export async function runNativeSmoke({ projectDir, project, outPng, label, timeoutMs = 45000 }) {
  if (!project.smoke) {
    return {
      available: false,
      ok: false,
      skipped: true,
      reason: 'No native smoke scenario is configured for this project.',
      inputVerified: false,
      evidence: null,
    }
  }
  const { HarnessSession } = await import(
    new URL('../../../experiments/godot-harness/controller/harness.mjs', import.meta.url)
  )
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)
  const captureName = `studio-${label}-${stamp}.png`
  const session = new HarnessSession({
    project: projectDir,
    headless: false,
    timeoutMs,
    allowOutsideRoot: true,
  })
  let startInfo = null
  try {
    startInfo = await session.start()
    if (project.smoke.reset) await session.reset()
    if (project.smoke.advanceFrames > 0) {
      await session.step({ steps: project.smoke.advanceFrames })
    }
    await session.pause()
    const before = await session.snapshot()
    const frame = await session.captureFrame({
      path: `res://artifacts/${captureName}`,
      scenario: 'studio',
      metadata: { label, source: 'studio-native-smoke' },
    })
    const capturedFile = path.join(projectDir, 'artifacts', captureName)
    let screenshot = null
    if (fs.existsSync(capturedFile)) {
      fs.mkdirSync(path.dirname(outPng), { recursive: true })
      fs.copyFileSync(capturedFile, outPng)
      screenshot = {
        path: toRelativeEvidence(outPng),
        sha256: sha256File(outPng),
        bytes: fs.statSync(outPng).size,
        capturedAt: frame.captured_at,
        scenario: frame.scenario,
        paused: frame.paused,
      }
    }

    const start = await session.snapshot()
    await session.resume()
    const movement = project.smoke.movementInput ?? { forward: 1 }
    await session.step({ steps: project.smoke.movementFrames ?? 12, input: movement })
    const end = await session.snapshot()
    await session.pause()

    const field = project.smoke.positionPath ?? 'player_position'
    const startPosition = start?.[field] ?? null
    const endPosition = end?.[field] ?? null
    const distance =
      Array.isArray(startPosition) && Array.isArray(endPosition)
        ? Math.hypot(
            endPosition[0] - startPosition[0],
            endPosition[1] - startPosition[1] ?? 0,
            endPosition[2] - startPosition[2] ?? 0,
          )
        : null
    const inputVerified = distance !== null && distance > 0.05
    return {
      available: true,
      ok: inputVerified,
      skipped: false,
      reason: inputVerified
        ? `Observed ${field} change of ${distance.toFixed(3)} after real harness input.`
        : 'The native window launched and captured, but no state change was observed after the input sequence.',
      inputVerified,
      movement: { input: movement, startPosition, endPosition, distance },
      screenshot,
      evidence: {
        pid: startInfo?.pid ?? session.pid,
        pausedAtCapture: frame.paused,
        capturedAt: frame.captured_at,
      },
      logs: {
        stdout: session.stdoutLines.slice(-80),
        stderr: session.stderrLines.slice(-80),
      },
    }
  } catch (error) {
    return {
      available: false,
      ok: false,
      skipped: true,
      reason: `Native windowed smoke could not run: ${error.message}`,
      inputVerified: false,
      screenshot: null,
      logs: {
        stdout: session.stdoutLines.slice(-80),
        stderr: session.stderrLines.slice(-80),
      },
    }
  } finally {
    try {
      await session.stop()
    } catch {
      // Session teardown is best effort; the saved error already names the blocker.
    }
  }
}

function toRelativeEvidence(absolute) {
  return absolute.split(path.sep).join('/')
}

export { HARNESS_ROOT, isInside }
