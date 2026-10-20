import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const HARNESS_ROOT = path.resolve(HERE, '..')
const DEFAULT_TIMEOUT_MS = 60000

/**
 * `godot` is a .cmd shim on this Windows install. Resolve it to the console
 * executable once instead of spawning through a shell, so project paths are
 * never interpreted by cmd.exe.
 */
function resolveGodotBinary() {
  if (process.env.GODOT_BIN) return process.env.GODOT_BIN
  if (process.platform !== 'win32') return 'godot'
  const where = spawnSync('where.exe', ['godot'], { encoding: 'utf8', windowsHide: true })
  for (const candidate of (where.stdout || '').split(/\r?\n/).filter(Boolean)) {
    if (candidate.toLowerCase().endsWith('.exe') && fs.existsSync(candidate)) return candidate
    if (candidate.toLowerCase().endsWith('.cmd') || candidate.toLowerCase().endsWith('.bat')) {
      const shim = fs.readFileSync(candidate, 'utf8')
      const match = /"([^"]+\.exe)"/i.exec(shim)
      if (match && fs.existsSync(match[1])) return match[1]
    }
  }
  return 'godot'
}

const GODOT_BIN = resolveGodotBinary()

function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '')
}

export function resolveProject(projectArg, { allowOutsideRoot = false } = {}) {
  const project = path.resolve(HARNESS_ROOT, projectArg || 'fixtures/sentry')
  const relative = path.relative(HARNESS_ROOT, project)
  if (!allowOutsideRoot && (relative.startsWith('..') || path.isAbsolute(relative))) {
    throw new Error(
      `Project must stay inside the harness root (${HARNESS_ROOT}); ` +
        `pass --allow-outside-root for an explicit clean-copy check.`,
    )
  }
  if (!fs.existsSync(path.join(project, 'project.godot'))) {
    throw new Error(`No project.godot in ${project}`)
  }
  return project
}

export function runProcess(command, args, { cwd, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      env: process.env,
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), timedOut })
    })
  })
}

export function parseGodotTestOutput(stdout, stderr = '') {
  const results = []
  const errors = []
  const warnings = []
  let summary = null

  for (const rawLine of `${stdout}\n${stderr}`.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    const pass = /^PASS ([^ ]+) (.*)$/.exec(line)
    const fail = /^FAIL ([^ ]+) (.*)$/.exec(line)
    const result = /^RESULT passed=(\d+) failed=(\d+)$/.exec(line)
    if (pass) {
      results.push({ name: pass[1], passed: true, detail: pass[2] })
    } else if (fail) {
      results.push({ name: fail[1], passed: false, detail: fail[2] })
    } else if (result) {
      summary = { passed: Number(result[1]), failed: Number(result[2]) }
    } else if (/\bERROR:|\bSCRIPT ERROR:/.test(line)) {
      errors.push(line)
    } else if (/\bWARNING:/.test(line)) {
      warnings.push(line)
    }
  }

  const countedPassed = results.filter((result) => result.passed).length
  const countedFailed = results.length - countedPassed
  const countsMatch =
    summary !== null && summary.passed === countedPassed && summary.failed === countedFailed
  const ok = summary !== null && summary.failed === 0 && countsMatch && errors.length === 0

  return {
    ok,
    results,
    summary,
    errors,
    warnings,
    reason: ok
      ? 'tests passed'
      : summary === null
        ? 'missing RESULT line'
        : !countsMatch
          ? 'RESULT counts do not match individual cases'
          : errors.length > 0
            ? 'Godot reported ERROR lines'
            : 'test cases failed',
  }
}

export async function runTests({
  project,
  script = 'res://tests/run_tests.gd',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  allowOutsideRoot = false,
} = {}) {
  const resolvedProject = resolveProject(project, { allowOutsideRoot })
  if (!script.startsWith('res://') || !script.endsWith('.gd')) {
    throw new Error('Test script must be a res:// .gd path')
  }
  const startedAt = Date.now()
  const processResult = await runProcess(
    GODOT_BIN,
    ['--headless', '--path', resolvedProject, '-s', script],
    { cwd: resolvedProject, timeoutMs },
  )
  const parsed = parseGodotTestOutput(processResult.stdout, processResult.stderr)
  return {
    operation: 'run_tests',
    project: resolvedProject,
    script,
    exitCode: processResult.code,
    signal: processResult.signal,
    timedOut: processResult.timedOut,
    durationMs: Date.now() - startedAt,
    ok: parsed.ok && processResult.code === 0 && !processResult.timedOut,
    ...parsed,
    stdout: processResult.stdout,
    stderr: processResult.stderr,
  }
}

function parseArgs(argv) {
  const [command = 'help', ...rest] = argv
  const options = { command, json: false, allowOutsideRoot: false }
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]
    if (arg === '--json') options.json = true
    else if (arg === '--allow-outside-root') options.allowOutsideRoot = true
    else if (arg === '--project') options.project = rest[++i]
    else if (arg === '--script') options.script = rest[++i]
    else if (arg === '--out') options.out = rest[++i]
    else if (arg === '--timeout-ms') options.timeoutMs = Number(rest[++i])
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

function usage() {
  return `godot-harness

Usage:
  node controller/harness.mjs test --project fixtures/sentry [--json] [--out result.json]

Options:
  --project <path>          Project root, relative to ${HARNESS_ROOT}
  --script <res://...>      Test entry script (default res://tests/run_tests.gd)
  --json                    Print the structured result
  --out <path>              Write the structured result to a file
  --allow-outside-root      Allow an explicit project outside the harness root
  --timeout-ms <number>     Process timeout (default 60000)
`
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2))
    if (options.command === 'help' || options.command === '--help') {
      process.stdout.write(usage())
      return 0
    }
    if (options.command !== 'test') throw new Error(`Unknown command: ${options.command}`)
    const result = await runTests(options)
    if (options.out) {
      fs.mkdirSync(path.dirname(path.resolve(options.out)), { recursive: true })
      fs.writeFileSync(options.out, `${JSON.stringify(result, null, 2)}\n`)
    }
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      for (const caseResult of result.results) {
        process.stdout.write(
          `${caseResult.passed ? 'PASS' : 'FAIL'} ${caseResult.name} ${caseResult.detail}\n`,
        )
      }
      process.stdout.write(
        `RESULT passed=${result.summary?.passed ?? 0} failed=${result.summary?.failed ?? 0} ` +
          `exit=${result.exitCode} ok=${result.ok}\n`,
      )
    }
    return result.ok ? 0 : 1
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${usage()}`)
    return 2
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await main()
}
