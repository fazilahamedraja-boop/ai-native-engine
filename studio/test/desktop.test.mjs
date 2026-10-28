import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createApp } from '../server/index.mjs'
import { JobStore } from '../server/lib/jobs.mjs'
import { createProjectRegistry } from '../server/lib/projects.mjs'
import { tempRoot } from './helpers.mjs'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = path.resolve(TEST_DIR, '..', 'public')

const EVIDENCE_STUB = {
  meta: () => ({ runCount: 0, readOnly: true }),
  listRuns: () => [],
  getRun: () => null,
  readText: () => ({ lines: [] }),
  getArtifact: () => {
    throw new Error('no artifacts in the stub')
  },
}

async function withServer(fn) {
  const jobStore = new JobStore({ root: tempRoot('desktop-jobs-') })
  const registry = createProjectRegistry({ projectsRoot: tempRoot('desktop-projects-') })
  const server = http.createServer(createApp({ store: EVIDENCE_STUB, jobStore, registry }))
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', resolve)
  })
  const port = server.address().port
  try {
    return await fn({ port })
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

async function get(port, requestPath) {
  const response = await fetch(`http://127.0.0.1:${port}${requestPath}`)
  return {
    status: response.status,
    headers: response.headers,
    body: await response.text(),
  }
}

test('desktop: /app serves the desktop shell with the locked-down CSP', async () => {
  await withServer(async ({ port }) => {
    const response = await get(port, '/app')
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type'), /text\/html/)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')

    const csp = response.headers.get('content-security-policy')
    assert.ok(csp, 'CSP must be present')
    assert.match(csp, /default-src 'none'/)
    assert.match(csp, /script-src 'self'/)
    assert.match(csp, /style-src 'self'/)
    assert.match(csp, /connect-src 'self'/)
    assert.match(csp, /frame-ancestors 'none'/)
    assert.match(csp, /frame-src http:\/\/127\.0\.0\.1:8790/)

    assert.match(response.body, /<title>AI Game Studio<\/title>/)
    assert.match(response.body, /src="\/desktop\.js"/)
    assert.match(response.body, /href="\/desktop\.css"/)
    assert.match(response.body, /id="view-home"/)
    assert.match(response.body, /id="view-workspace"/)
    assert.match(response.body, /id="create-dialog"/)
    assert.match(response.body, /id="approve-dialog"/)
  })
})

test('desktop: static assets are served from registered files only', async () => {
  await withServer(async ({ port }) => {
    const html = await get(port, '/app.html')
    assert.equal(html.status, 200)
    assert.equal(html.body, fs.readFileSync(path.join(PUBLIC_DIR, 'desktop.html'), 'utf8'))

    const script = await get(port, '/desktop.js')
    assert.equal(script.status, 200)
    assert.match(script.headers.get('content-type'), /text\/javascript/)
    assert.match(script.body, /\/api\/studio\/jobs/)
    assert.match(script.body, /EventSource/)

    const css = await get(port, '/desktop.css')
    assert.equal(css.status, 200)
    assert.match(css.headers.get('content-type'), /text\/css/)
    assert.match(css.body, /\.view-workspace/)
  })
})

test('desktop: the existing studio and evidence dashboard routes are unchanged', async () => {
  await withServer(async ({ port }) => {
    const studio = await get(port, '/studio')
    assert.equal(studio.status, 200)
    assert.equal(studio.body, fs.readFileSync(path.join(PUBLIC_DIR, 'studio.html'), 'utf8'))

    const studioScript = await get(port, '/studio.js')
    assert.equal(studioScript.status, 200)
    assert.equal(studioScript.body, fs.readFileSync(path.join(PUBLIC_DIR, 'studio.js'), 'utf8'))

    const dashboardScript = await get(port, '/app.js')
    assert.equal(dashboardScript.status, 200)
    assert.equal(dashboardScript.body, fs.readFileSync(path.join(PUBLIC_DIR, 'app.js'), 'utf8'))

    const home = await get(port, '/')
    assert.equal(home.status, 200)
    assert.equal(home.body, fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8'))
  })
})

test('desktop: unknown files and traversal are not exposed', async () => {
  await withServer(async ({ port }) => {
    for (const requestPath of ['/desktop', '/server/index.mjs', '/desktop.html', '/public/desktop.js', '/app/../server/index.mjs']) {
      const response = await get(port, requestPath)
      assert.equal(response.status, 404, `${requestPath} must not be served`)
    }
  })
})

test('desktop: the page has no inline script or inline event handlers (CSP-safe)', () => {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, 'desktop.html'), 'utf8')
  assert.equal(/<script(?![^>]*\bsrc=)/i.test(html), false, 'no inline <script> blocks')
  assert.equal(/\son[a-z]+\s*=\s*"/i.test(html), false, 'no inline event handler attributes')
  assert.equal(/\sstyle\s*=\s*"/i.test(html), false, 'no inline style attributes')
  assert.equal(/javascript:/i.test(html), false)
  assert.match(html, /<script src="\/desktop.js"><\/script>/)
})

test('desktop: the client never writes inline styles (style-src stays self)', () => {
  const script = fs.readFileSync(path.join(PUBLIC_DIR, 'desktop.js'), 'utf8')
  // `style-src 'self'` blocks style attributes; the client must colour accents
  // with classes instead, or the CSP silently drops them.
  assert.equal(/setAttribute\(\s*['"]style['"]/.test(script), false)
  assert.equal(/\.style\.(setProperty|cssText)/.test(script), false)
  const css = fs.readFileSync(path.join(PUBLIC_DIR, 'desktop.css'), 'utf8')
  for (const accent of ['amber', 'mint', 'blue', 'rose', 'violet', 'cyan']) {
    assert.match(css, new RegExp(`\\.accent-${accent}\\s*\\{`))
  }
})

test('desktop: Electron main starts one in-process loopback server and no shell bridge', () => {
  const main = fs.readFileSync(path.resolve(TEST_DIR, '..', 'desktop', 'main.mjs'), 'utf8')
  assert.match(main, /startServer\(\{ port: 0 \}\)/)
  assert.match(main, /requestSingleInstanceLock/)
  assert.match(main, /nodeIntegration: false/)
  assert.match(main, /contextIsolation: true/)
  assert.match(main, /sandbox: true/)
  assert.match(main, /stopAll/)
  assert.equal(/child_process/.test(main), false, 'main must not spawn an external backend')

  const preload = fs.readFileSync(path.resolve(TEST_DIR, '..', 'desktop', 'preload.cjs'), 'utf8')
  assert.match(preload, /contextBridge\.exposeInMainWorld\('studioDesktop'/)
  assert.match(preload, /ipcRenderer\.invoke\('studio:open-external'/)
  assert.equal(/require\('node:(fs|child_process|path)'\)/.test(preload), false)
})
