import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test, { after, before } from 'node:test'
import { fileURLToPath } from 'node:url'

import { DEFAULT_PORT, startServer } from '../server/index.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const STUDIO_DIR = path.resolve(TEST_DIR, '..')
const REPO_ROOT = path.resolve(STUDIO_DIR, '..')

const RUNTIME_OK = 'runtime/2026-10-25T05-55-04-354Z'
const AGENT = 'agent-runs/implementation-2026-10-23T17-06-43-470Z'

let started

before(async () => {
  started = await startServer({ repoRoot: REPO_ROOT, port: 0 })
})

after(async () => {
  if (!started) return
  await new Promise((resolve, reject) => {
    started.server.close((error) => (error ? reject(error) : resolve()))
  })
})

function url(pathname) {
  return new URL(pathname, started.url)
}

function assertSecurityHeaders(response) {
  const csp = response.headers.get('content-security-policy')
  assert.ok(csp, 'Content-Security-Policy must be present')
  assert.match(csp, /default-src 'none'/)
  assert.match(csp, /frame-ancestors 'none'/)
  assert.match(csp, /script-src 'self'/)
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer')
  assert.equal(response.headers.get('cache-control'), 'no-store')
}

test('server: binds to loopback and defaults to port 8787', () => {
  assert.equal(DEFAULT_PORT, 8787)
  const address = started.server.address()
  assert.equal(address.address, '127.0.0.1')
  assert.equal(started.host, '127.0.0.1')
  assert.match(started.url, /^http:\/\/127\.0\.0\.1:\d+\/$/)
})

test('server: refuses to bind a non-loopback interface', () => {
  assert.throws(
    () => startServer({ repoRoot: REPO_ROOT, host: '0.0.0.0', port: 0 }),
    /only listens on loopback/,
  )
})

test('static: exact routes are served with a restrictive CSP', async () => {
  const index = await fetch(url('/'))
  assert.equal(index.status, 200)
  assert.match(index.headers.get('content-type'), /^text\/html/)
  assertSecurityHeaders(index)
  const html = await index.text()
  assert.match(html, /AI Game Studio/)
  assert.match(html, /Read-only view of Phase 19/)

  for (const [pathname, type] of [
    ['/index.html', /^text\/html/],
    ['/app.js', /^text\/javascript/],
    ['/styles.css', /^text\/css/],
    ['/favicon.svg', /^image\/svg\+xml/],
  ]) {
    const response = await fetch(url(pathname))
    assert.equal(response.status, 200, pathname)
    assert.match(response.headers.get('content-type'), type, pathname)
    assertSecurityHeaders(response)
  }
})

test('static: only the three frontend assets exist, nothing else leaks', async () => {
  for (const pathname of ['/favicon.ico', '/server/index.mjs', '/package.json', '/../package.json']) {
    const response = await fetch(url(pathname))
    assert.equal(response.status, 404, pathname)
    assert.equal((await response.json()).error.code, 'not_found')
  }
})

test('api: meta advertises the read-only boundaries', async () => {
  const response = await fetch(url('/api/meta'))
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assertSecurityHeaders(response)

  const meta = await response.json()
  assert.equal(meta.runCount, 14)
  assert.equal(meta.readOnly, true)
  assert.equal(meta.modelCalls, 0)
  assert.equal(meta.commandsExecutedFromBrowser, 0)
  assert.equal(meta.scope, 'S0 read-only evidence dashboard')
})

test('api: runs list and single-run lookup use the scanned index', async () => {
  const list = await fetch(url('/api/runs'))
  assert.equal(list.status, 200)
  const body = await list.json()
  assert.equal(body.runs.length, 14)
  assert.ok(body.runs.every((run) => typeof run.id === 'string'))

  const one = await fetch(url(`/api/runs/${encodeURIComponent(RUNTIME_OK)}`))
  assert.equal(one.status, 200)
  const run = await one.json()
  assert.equal(run.id, RUNTIME_OK)
  assert.equal(run.verdict, 'verified-pass')
  assert.equal(run.checks.length, 12)

  const missing = await fetch(url(`/api/runs/${encodeURIComponent('runtime/nope')}`))
  assert.equal(missing.status, 404)
  assert.equal((await missing.json()).error.code, 'not_found')

  const traversal = await fetch(url('/api/runs/%2E%2E%2F%2E%2E%2Fpackage'))
  assert.equal(traversal.status, 404)
})

test('api: a browser-supplied path cannot escape the evidence root', async () => {
  const cases = [
    ['', 400],
    ['..%2F..%2Fpackage.json', 400],
    ['%2Fetc%2Fpasswd', 400],
    ['C%3A%2FWindows%2Fwin.ini', 400],
    ['runtime%2F..%2F..%2Fpackage.json', 400],
    ['README.md', 404],
    ['runtime%2Fdoes-not-exist.png', 404],
    ['repair%2F2026-10-25T06-02-23-740Z%2Fagent-attempt%2Fvoxel_data.gd', 415],
    ['web%2Fpage-load.exe', 415],
  ]

  for (const [requested, status] of cases) {
    const response = await fetch(url(`/api/file?path=${requested}`))
    assert.equal(response.status, status, requested)
    assertSecurityHeaders(response)
    const body = await response.json()
    assert.equal(typeof body.error.code, 'string')
    assert.equal(typeof body.error.message, 'string')
  }

  const noPath = await fetch(url('/api/file'))
  assert.equal(noPath.status, 400)
  assert.equal((await noPath.json()).error.code, 'invalid_path')
})

test('api: allow-listed artifacts are served with their real content type', async () => {
  const image = await fetch(url(`/api/file?path=${encodeURIComponent(`${RUNTIME_OK}/spawn.png`)}`))
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(image.headers.get('content-disposition'), 'inline')
  assertSecurityHeaders(image)
  const bytes = Buffer.from(await image.arrayBuffer())
  assert.deepEqual([...bytes.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  assert.equal(Number(image.headers.get('content-length')), bytes.length)

  const json = await fetch(url('/api/file?path=web%2Fweb-verification.json'))
  assert.equal(json.status, 200)
  assert.match(json.headers.get('content-type'), /^application\/json/)
  assert.equal((await json.json()).schema, 'phase19.web-verification.v1')
})

test('api: text previews are capped, hashed and reject binary files', async () => {
  const response = await fetch(url(`/api/text?path=${encodeURIComponent(`${RUNTIME_OK}/run.json`)}`))
  assert.equal(response.status, 200)
  const preview = await response.json()
  assert.ok(Array.isArray(preview.lines))
  assert.match(preview.sha256, /^[0-9a-f]{64}$/)
  assert.equal(preview.path, `${RUNTIME_OK}/run.json`)

  const transcript = await fetch(
    url(`/api/text?path=${encodeURIComponent(`${AGENT}/attempts/attempt-1/opencode.jsonl`)}`),
  )
  assert.equal(transcript.status, 200)
  const capped = await transcript.json()
  assert.equal(capped.truncated, true)
  assert.ok(capped.returnedLines <= 120)

  const binary = await fetch(url(`/api/text?path=${encodeURIComponent(`${RUNTIME_OK}/spawn.png`)}`))
  assert.equal(binary.status, 415)
  assert.equal((await binary.json()).error.code, 'not_text')
})

test('api: only GET and HEAD are accepted', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
    const response = await fetch(url('/api/meta'), { method })
    assert.equal(response.status, 405, method)
    assert.equal(response.headers.get('allow'), 'GET, HEAD')
    assert.equal((await response.json()).error.code, 'method_not_allowed')
  }
})

test('api: HEAD returns headers without a body', async () => {
  const meta = await fetch(url('/api/meta'), { method: 'HEAD' })
  assert.equal(meta.status, 200)
  assert.match(meta.headers.get('content-type'), /^application\/json/)
  assert.ok(Number(meta.headers.get('content-length')) > 0)
  assert.equal(await meta.text(), '')

  const image = await fetch(
    url(`/api/file?path=${encodeURIComponent(`${RUNTIME_OK}/spawn.png`)}`),
    { method: 'HEAD' },
  )
  assert.equal(image.status, 200)
  assert.equal(image.headers.get('content-type'), 'image/png')
  assert.equal(await image.text(), '')
})

test('unknown api routes return JSON 404 rather than a file or a redirect', async () => {
  const response = await fetch(url('/api/unknown'))
  assert.equal(response.status, 404)
  assert.match(response.headers.get('content-type'), /^application\/json/)
  assert.equal((await response.json()).error.code, 'not_found')
})

test('source: the server never imports process-spawning or vm modules', () => {
  const files = [
    path.join(STUDIO_DIR, 'server', 'index.mjs'),
    path.join(STUDIO_DIR, 'server', 'lib', 'evidence.mjs'),
  ]

  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8')
    assert.doesNotMatch(source, /child_process/, file)
    assert.doesNotMatch(source, /\bexecSync\b|\bspawnSync\b|\bexecFileSync\b/, file)
    assert.doesNotMatch(source, /node:vm|from 'vm'/, file)
    assert.doesNotMatch(source, /eval\(|new Function\(/, file)
  }
})
