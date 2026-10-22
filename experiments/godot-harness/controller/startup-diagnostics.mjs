/**
 * Startup failure diagnostics for the Godot harness.
 *
 * Phase 13 measured that a failed Godot startup surfaces as a generic
 * `Timed out waiting for HARNESS_READY after 20000 ms`, even though the real
 * cause - a GDScript parse error and the autoload failure it caused - was
 * sitting in the process's stderr. That is the same weakness that made the
 * Phase 12B root cause hard to find, and it would hide the next one too.
 *
 * This module classifies a startup failure and turns it into an actionable
 * error: what kind of failure it was, whether the process was still alive,
 * the engine's own error lines, and the tail of both output streams.
 */

export const StartupFailure = {
  /** The process could not be spawned at all. */
  SPAWN_FAILED: 'spawn_failed',
  /** The process died before it could report readiness. */
  PROCESS_EXITED: 'process_exited',
  /** The engine reported a script or parse error. */
  SCRIPT_ERROR: 'script_error',
  /** The engine reported that an autoload could not be instantiated. */
  AUTOLOAD_ERROR: 'autoload_error',
  /** The bridge published a port but the socket could not be connected. */
  CONNECTION_FAILED: 'connection_failed',
  /** The readiness payload was not a valid protocol-1 handshake. */
  PROTOCOL_ERROR: 'protocol_error',
  /** The bridge answered, but the game scene never became ready. */
  GAME_NOT_READY: 'game_not_ready',
  /** The process was alive and reported no error, but readiness never arrived. */
  SLOW_STARTUP: 'slow_startup',
}

/** Markers that identify an engine-reported failure in the output streams. */
const SCRIPT_ERROR_MARKERS = [
  'SCRIPT ERROR:',
  'Parse Error:',
  'Failed to load script',
  'Cannot open file',
  'USER ERROR:',
  'Invalid call.',
]

const AUTOLOAD_ERROR_MARKERS = [
  'Failed to instantiate an autoload',
  'does not inherit from',
]

const MAX_ERROR_LINES = 24
const MAX_TAIL_LINES = 12

/**
 * Pull the engine's own error lines out of the captured output.
 * Godot prints a bare `at: ...` line under an error, so an indented
 * continuation line is kept with the error above it.
 */
export function collectEngineErrors({ stdout = [], stderr = [] } = {}) {
  const lines = [...stderr, ...stdout]
  const found = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const isScriptError = SCRIPT_ERROR_MARKERS.some((marker) => line.includes(marker))
    const isAutoloadError = AUTOLOAD_ERROR_MARKERS.some((marker) => line.includes(marker))
    if (!isScriptError && !isAutoloadError) continue
    found.push(line.trim())
    const next = lines[index + 1]
    if (next && /^\s+at:/.test(next)) {
      found.push(next.trim())
    }
    if (found.length >= MAX_ERROR_LINES) break
  }
  return found
}

/**
 * Decide what kind of failure happened.
 *
 * Precedence matters. A process that already died is reported as a process
 * exit even if it also logged a script error, because the exit is the more
 * specific fact. A process that is still alive but logged an engine error is
 * reported by that error, because it is far more actionable than "timed out".
 * A process that is alive and logged nothing is a genuinely slow start.
 */
export function classifyStartupFailure({
  phase = 'ready',
  stdout = [],
  stderr = [],
  exited = null,
  spawnError = null,
  timeoutMs = null,
  elapsedMs = null,
  underlyingError = null,
} = {}) {
  if (spawnError) return StartupFailure.SPAWN_FAILED
  if (phase === 'connect') return StartupFailure.CONNECTION_FAILED
  if (phase === 'game') return StartupFailure.GAME_NOT_READY
  if (phase === 'protocol') return StartupFailure.PROTOCOL_ERROR
  if (exited) return StartupFailure.PROCESS_EXITED

  const errors = collectEngineErrors({ stdout, stderr })
  if (errors.some((line) => AUTOLOAD_ERROR_MARKERS.some((marker) => line.includes(marker)))) {
    return StartupFailure.AUTOLOAD_ERROR
  }
  if (errors.length > 0) return StartupFailure.SCRIPT_ERROR
  if (underlyingError) return StartupFailure.SCRIPT_ERROR
  return StartupFailure.SLOW_STARTUP
}

function tail(lines) {
  return lines.slice(-MAX_TAIL_LINES)
}

/**
 * Build an actionable Error for a failed startup.
 *
 * The returned error carries a machine-readable `code`, a `diagnostics` object
 * with the structured facts, and a message that states the failure kind, the
 * process state, the engine's own error lines, and the tail of both streams.
 */
export function startupError(input = {}) {
  const {
    phase = 'ready',
    project = null,
    stdout = [],
    stderr = [],
    exited = null,
    spawnError = null,
    timeoutMs = null,
    elapsedMs = null,
    underlyingError = null,
    pid = null,
  } = input

  const code = classifyStartupFailure(input)
  const engineErrors = collectEngineErrors({ stdout, stderr })
  const processState = exited
    ? `exited (code=${exited.code}, signal=${exited.signal})`
    : 'still running'

  const diagnostics = {
    code,
    phase,
    project,
    pid,
    process_state: processState,
    exit_code: exited ? exited.code : null,
    exit_signal: exited ? exited.signal : null,
    timeout_ms: timeoutMs,
    elapsed_ms: elapsedMs,
    engine_errors: engineErrors,
    underlying_error: underlyingError ? underlyingError.message : null,
    stdout_tail: tail(stdout),
    stderr_tail: tail(stderr),
  }

  const lines = [
    `Godot startup failed: ${code}`,
    `  phase: ${phase}`,
  ]
  if (project) lines.push(`  project: ${project}`)
  if (pid) lines.push(`  pid: ${pid}`)
  lines.push(`  process: ${processState}`)
  if (elapsedMs !== null) {
    lines.push(
      `  elapsed: ${elapsedMs} ms` + (timeoutMs !== null ? ` (readiness limit ${timeoutMs} ms)` : ''),
    )
  }
  if (engineErrors.length > 0) {
    lines.push('  engine error:')
    for (const line of engineErrors) lines.push(`    ${line}`)
  } else if (code === StartupFailure.SLOW_STARTUP) {
    lines.push(
      '  engine error: none reported; the process was alive but never signalled readiness',
    )
  }
  if (underlyingError) lines.push(`  underlying: ${underlyingError.message}`)
  if (diagnostics.stdout_tail.length > 0) {
    lines.push('  stdout tail:')
    for (const line of diagnostics.stdout_tail) lines.push(`    ${line}`)
  }
  if (diagnostics.stderr_tail.length > 0) {
    lines.push('  stderr tail:')
    for (const line of diagnostics.stderr_tail) lines.push(`    ${line}`)
  }

  const error = new Error(lines.join('\n'))
  error.code = code
  error.diagnostics = diagnostics
  return error
}
