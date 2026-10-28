const PATTERNS = [
  {
    class: 'quota',
    stop: true,
    retryable: false,
    patterns: [
      /(?:HTTP|status|statusCode|code)\D{0,3}429\b/i,
      /\b429\s+(?:too many requests|rate[ _-]?limit)/i,
      /rate[ _-]?limit/i,
      /too many requests/i,
      /quota/i,
      /insufficient[ _-]?(quota|credits|balance)/i,
      /usage[ _-]?limit/i,
      /exceeded your current quota/i,
      /out of credits/i,
    ],
  },
  {
    class: 'auth',
    stop: true,
    retryable: false,
    patterns: [
      /(?:HTTP|status|statusCode|code)\D{0,3}40[13]\b/i,
      /\b40[13]\s+(?:unauthori[sz]ed|forbidden)/i,
      /unauthori[sz]ed/i,
      /unauthenticated/i,
      /authentication (failed|required)/i,
      /invalid api[ _-]?key/i,
      /api key.*(invalid|missing|expired)/i,
      /forbidden/i,
    ],
  },
  {
    class: 'model',
    stop: true,
    retryable: false,
    patterns: [
      /model.*(not found|does not exist|unknown|unsupported|invalid)/i,
      /(unknown|invalid|unsupported) model/i,
      /no such model/i,
      /provider.*not found/i,
    ],
  },
  {
    class: 'timeout',
    stop: false,
    retryable: true,
    patterns: [/timed out/i, /timeout/i, /ETIMEDOUT/, /ESOCKETTIMEDOUT/],
  },
  {
    class: 'network',
    stop: false,
    retryable: true,
    patterns: [/ECONNRESET/, /ECONNREFUSED/, /ENOTFOUND/, /EAI_AGAIN/, /network error/i, /fetch failed/i],
  },
  {
    class: 'crash',
    stop: false,
    retryable: true,
    patterns: [/segmentation fault/i, /SIGSEGV/, /SIGABRT/, /panic:/i, /fatal error/i],
  },
]

export const PROVIDER_ERROR_CLASSES = Object.freeze([
  'none',
  'quota',
  'auth',
  'model',
  'timeout',
  'network',
  'crash',
  'exited',
  'cancelled',
])

/**
 * Pull human-readable diagnostics out of an OpenCode `--format json` stream.
 *
 * The transcript also contains counters, hashes and token counts. Scanning the
 * raw JSON for patterns like `403` produced false "auth" failures when a token
 * count happened to be 403 (observed in the first end-to-end Studio run), so
 * pattern matching only ever sees real error messages.
 */
export function diagnosticTextFromStdout(stdout) {
  const parts = []
  for (const rawLine of String(stdout || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      // Plain-text output is already diagnostic material.
      parts.push(line)
      continue
    }
    if (!event || typeof event !== 'object') continue
    const candidates = [
      event.error?.data?.message,
      event.error?.message,
      event.part?.error?.message,
      event.part?.error?.data?.message,
      event.part?.state?.error,
      event.type === 'error' ? event.message : null,
      event.type === 'error' && typeof event.error === 'string' ? event.error : null,
    ]
    for (const value of candidates) {
      if (typeof value === 'string' && value.trim()) parts.push(value.trim())
      else if (value && typeof value === 'object') {
        const message = value.message ?? value.data?.message
        if (typeof message === 'string' && message.trim()) parts.push(message.trim())
      }
    }
  }
  return parts.join('\n').slice(-100_000)
}

/**
 * Classify a provider failure from its exit status and captured output.
 * Quota and auth are terminal: the pipeline must stop rather than hammer a
 * rate-limited or misconfigured provider.
 */
export function classifyProviderError({ code = null, timedOut = false, aborted = false, stderr = '', stdout = '' } = {}) {
  if (aborted) {
    return { class: 'cancelled', stop: true, retryable: true, message: 'The run was cancelled.', code: null }
  }
  if (timedOut) {
    return {
      class: 'timeout',
      stop: true,
      retryable: true,
      message: 'The provider did not finish before the configured timeout.',
      code,
    }
  }

  const haystack = `${stderr}\n${diagnosticTextFromStdout(stdout)}`.slice(-200_000)
  for (const rule of PATTERNS) {
    for (const pattern of rule.patterns) {
      const match = haystack.match(pattern)
      if (match) {
        return {
          class: rule.class,
          stop: rule.stop,
          retryable: rule.retryable,
          message: firstUsefulLine(haystack, match.index ?? 0) || `Matched ${pattern}`,
          code,
        }
      }
    }
  }

  if (code !== 0 && code !== null) {
    return {
      class: 'exited',
      stop: true,
      retryable: true,
      message: firstUsefulLine(haystack) || `The provider exited with code ${code}.`,
      code,
    }
  }

  return { class: 'none', stop: false, retryable: false, message: null, code }
}

function firstUsefulLine(text, around = 0) {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return ''
  const index = Math.min(lines.length - 1, Math.max(0, Math.floor((around / Math.max(1, text.length)) * lines.length)))
  const candidates = [lines[index], ...lines.slice(Math.max(0, index - 2), index + 3)]
  const useful = candidates.find((line) => line.length >= 8 && line.length <= 300) || lines[0]
  return useful.slice(0, 300)
}

/** Extract human-readable text from an OpenCode `--format json` transcript. */
export function summarizeTranscript(stdout) {
  let events = 0
  let tools = {}
  let lastText = ''
  for (const line of String(stdout || '').split(/\r?\n/)) {
    if (!line.trim()) continue
    let event
    try {
      event = JSON.parse(line)
    } catch {
      continue
    }
    events += 1
    if (event.type === 'tool_use' && event.part?.tool) {
      const name = event.part.tool
      const status = event.part.state?.status || 'unknown'
      tools[name] = tools[name] || {}
      tools[name][status] = (tools[name][status] || 0) + 1
    }
    if (event.type === 'text' && typeof event.part?.text === 'string') {
      lastText = event.part.text
    }
  }
  return { events, tools, lastText, lastTextBytes: lastText.length }
}
