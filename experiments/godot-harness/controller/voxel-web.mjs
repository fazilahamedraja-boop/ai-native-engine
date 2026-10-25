#!/usr/bin/env node
/**
 * Export the Phase 19 voxel sandbox to the Web and serve it on loopback.
 *
 * The browser build needs a real HTTP origin: `file://` cannot fetch the PCK,
 * and the WASM MIME type must be `application/wasm`. This helper does both and
 * prints the URL to open.
 *
 * The voxel project carries its own Web preset, so the export is a plain
 * `--export-release "Web"` against the canonical project; unlike the Phase 17
 * helper this does not copy the project to a temporary directory.
 *
 *   node controller/voxel-web.mjs                 # export, then serve on :8790
 *   node controller/voxel-web.mjs --no-export     # serve the existing build
 *   node controller/voxel-web.mjs --port 8800
 *
 * The non-threaded variant is selected by the preset, so no COOP/COEP headers
 * are required.
 */

import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GODOT_BIN, HARNESS_ROOT } from './harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PROJECT = path.join(HARNESS_ROOT, 'voxel')
const BUILD_DIR = path.join(PROJECT, 'build', 'web')

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pck': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.worklet.js': 'text/javascript; charset=utf-8',
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const port = Number(argValue('--port', '8790'))
const shouldExport = !process.argv.includes('--no-export')

function exportWeb() {
  fs.mkdirSync(BUILD_DIR, { recursive: true })
  const index = path.join(BUILD_DIR, 'index.html')
  const result = spawnSync(
    GODOT_BIN,
    ['--headless', '--path', PROJECT, '--export-release', 'Web', index],
    { cwd: HARNESS_ROOT, encoding: 'utf8', timeout: 600000, windowsHide: true },
  )
  if (result.error || result.status !== 0) {
    throw new Error(
      `Web export failed (exit ${result.status ?? 'n/a'}): ${result.error || result.stderr || result.stdout}`,
    )
  }
  const required = ['index.html', 'index.js', 'index.wasm', 'index.pck']
  const missing = required.filter((name) => !fs.existsSync(path.join(BUILD_DIR, name)))
  if (missing.length > 0) throw new Error(`Web export is missing: ${missing.join(', ')}`)
}

function contentType(file) {
  if (file.endsWith('.audio.worklet.js') || file.endsWith('.position.worklet.js')) {
    return MIME['.worklet.js']
  }
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream'
}

function createServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://127.0.0.1')
    const relative = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
    const file = path.join(BUILD_DIR, path.normalize(relative).replace(/^([/\\])+/, ''))

    // Confine every request to the build directory.
    if (!file.startsWith(BUILD_DIR + path.sep) && file !== BUILD_DIR) {
      response.writeHead(403).end('forbidden')
      return
    }
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, {
      'content-type': contentType(file),
      'content-length': fs.statSync(file).size,
      // A rebuilt PCK must never be served from cache.
      'cache-control': 'no-store',
    })
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    fs.createReadStream(file).pipe(response)
  })
}

if (shouldExport) {
  console.log('[voxel-web] exporting Web build...')
  exportWeb()
}

const server = createServer()
server.listen(port, '127.0.0.1', () => {
  const url = `http://127.0.0.1:${port}/`
  console.log(`[voxel-web] serving ${BUILD_DIR}`)
  console.log(`[voxel-web] open ${url}`)
  console.log('[voxel-web] click the canvas once to capture the mouse, Esc to release it')
  console.log('[voxel-web] Ctrl-C to stop')
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0))
  })
}
