import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import {
  classifyProviderError,
  summarizeTranscript,
} from '../server/lib/provider-errors.mjs'
import { tempRoot, writeFile } from './helpers.mjs'

test('provider classifier: quota and rate limits stop immediately', () => {
  for (const text of [
    'HTTP 429 Too Many Requests',
    'rate limit exceeded',
    'You exceeded your current quota',
    'insufficient credits',
  ]) {
    const result = classifyProviderError({ code: 1, stderr: text })
    assert.equal(result.class, 'quota', text)
    assert.equal(result.stop, true)
    assert.equal(result.retryable, false)
  }
})

test('provider classifier: auth and model errors are terminal too', () => {
  assert.equal(classifyProviderError({ stderr: 'HTTP 401 Unauthorized' }).class, 'auth')
  assert.equal(classifyProviderError({ stderr: 'invalid api key' }).class, 'auth')
  assert.equal(classifyProviderError({ stderr: 'model "x" not found' }).class, 'model')
  assert.equal(classifyProviderError({ stderr: 'unknown model: foo' }).class, 'model')
  assert.equal(classifyProviderError({ stderr: 'HTTP 403 Forbidden' }).class, 'auth')
})

test('provider classifier: timeouts, network and crashes are distinct', () => {
  assert.equal(classifyProviderError({ timedOut: true }).class, 'timeout')
  assert.equal(classifyProviderError({ stderr: 'read ECONNRESET' }).class, 'network')
  assert.equal(classifyProviderError({ stderr: 'fetch failed' }).class, 'network')
  assert.equal(classifyProviderError({ stderr: 'Segmentation fault' }).class, 'crash')
  assert.equal(classifyProviderError({ code: 2, stderr: 'unexpected failure' }).class, 'exited')
  assert.equal(classifyProviderError({ aborted: true }).class, 'cancelled')
  assert.equal(classifyProviderError({ code: 0, stderr: '' }).class, 'none')
})

test('provider classifier: quota wins over a generic timeout label in the same output', () => {
  const result = classifyProviderError({
    code: 1,
    stderr: 'request timed out\nHTTP 429 rate limit',
  })
  assert.equal(result.class, 'quota')
})

test('provider classifier: JSON counters and token counts are never read as HTTP status', () => {
  const transcript = [
    JSON.stringify({
      type: 'step_finish',
      part: { tokens: { input: 403, output: 44, cache: { read: 401 } } },
    }),
    JSON.stringify({ type: 'step_finish', part: { tokens: { input: 429, output: 12 } } }),
    JSON.stringify({ type: 'text', part: { text: 'edited one file' } }),
  ].join('\n')
  const result = classifyProviderError({ code: 0, stdout: transcript, stderr: '' })
  assert.equal(result.class, 'none')
})

test('provider classifier: structured error events are classified, not the raw JSON', () => {
  const quota = classifyProviderError({
    code: 1,
    stdout: JSON.stringify({ type: 'error', error: { data: { message: 'HTTP 429 Too Many Requests' } } }),
  })
  assert.equal(quota.class, 'quota')
  assert.match(quota.message, /429/)

  const auth = classifyProviderError({
    code: 1,
    stdout: JSON.stringify({ type: 'error', error: { message: 'authentication failed: invalid api key' } }),
  })
  assert.equal(auth.class, 'auth')

  const toolError = classifyProviderError({
    code: 1,
    stdout: JSON.stringify({
      type: 'tool_use',
      part: { tool: 'read', state: { status: 'error', error: 'HTTP 403 Forbidden' } },
    }),
  })
  assert.equal(toolError.class, 'auth')

  // A plain-text stdout line (not JSON) is still diagnostic material.
  assert.equal(classifyProviderError({ code: 1, stdout: 'HTTP 401 Unauthorized' }).class, 'auth')
})

test('provider classifier: an unknown failure names a real line, not a JSON blob', () => {
  const result = classifyProviderError({
    code: 2,
    stdout: JSON.stringify({ type: 'step_finish', part: { tokens: { input: 3 } } }),
    stderr: 'unexpected failure while writing the file',
  })
  assert.equal(result.class, 'exited')
  assert.match(result.message, /unexpected failure/)
})

test('transcript summary counts tool statuses without trusting the text', () => {
  const stdout = [
    JSON.stringify({ type: 'text', part: { text: 'planning' } }),
    JSON.stringify({ type: 'tool_use', part: { tool: 'read', state: { status: 'completed' } } }),
    JSON.stringify({ type: 'tool_use', part: { tool: 'edit', state: { status: 'completed' } } }),
    JSON.stringify({ type: 'tool_use', part: { tool: 'edit', state: { status: 'error' } } }),
    JSON.stringify({ type: 'text', part: { text: 'done' } }),
    'not json',
  ].join('\n')
  const summary = summarizeTranscript(stdout)
  assert.equal(summary.events, 5)
  assert.equal(summary.tools.read.completed, 1)
  assert.equal(summary.tools.edit.completed, 1)
  assert.equal(summary.tools.edit.error, 1)
  assert.equal(summary.lastText, 'done')
})

test('a worktree is not needed: the classifier never reads the filesystem', () => {
  const root = tempRoot('studio-provider-')
  writeFile(path.join(root, 'x.txt'), 'x')
  assert.equal(fs.existsSync(path.join(root, 'x.txt')), true)
  assert.equal(classifyProviderError({ code: 0 }).class, 'none')
})
