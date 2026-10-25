#!/usr/bin/env node
/**
 * Check GDScript for parse and type errors without reading engine logs.
 *
 * Phase 19 found the expensive version of this problem: a mistyped identifier
 * costs a full Godot launch plus a stderr grep, and the failure surfaces as a
 * generic "timed out waiting for the harness" through
 * `controller/startup-diagnostics.mjs`. Godot already ships a GDScript language
 * server, so the check can be done on the source directly:
 *
 *   node controller/gd-check.mjs                      # check voxel/scripts, tests, harness
 *   node controller/gd-check.mjs voxel/scripts        # check one directory
 *   node controller/gd-check.mjs --attach             # reuse a running editor LSP
 *   node controller/gd-check.mjs --json               # machine-readable record
 *   node controller/gd-check.mjs --fail-on warning    # warnings are failures too
 *
 * The LSP instance is a headless editor on a private port; it is killed when
 * the check ends, including on failure. Exit codes are 0 (clean), 1 (findings
 * at or above `--fail-on`) and 2 (the check itself could not run), so the
 * command is usable as a gate.
 *
 * There is deliberately no `godot --check-only` fallback. Measured on this
 * project, `--check-only --script` reports a bogus `Class "X" hides a global
 * script class` error for every script that declares `class_name` (4 of the 9
 * voxel scripts), so it would fail clean code. When the language server cannot
 * start this tool exits 2 and says so instead of guessing.
 */

import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GODOT_BIN, HARNESS_ROOT } from './harness.mjs'

const PROJECT = path.join(HARNESS_ROOT, 'voxel')

/** LSP diagnostic severity numbers, mapped to the names used in output. */
export const SEVERITY = {
  1: 'error',
  2: 'warning',
  3: 'information',
  4: 'hint',
}

const SEVERITY_RANK = { error: 4, warning: 3, information: 2, hint: 1 }

/**
 * Encode one LSP message with the `Content-Length` header framing the protocol
 * requires. Exported so the framing has a unit test that does not need Godot.
 */
export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

/**
 * Incremental decoder for a stream of LSP frames. TCP delivers arbitrary
 * chunks, so a message can arrive split across reads or several per read.
 */
export class MessageReader {
  constructor() {
    this.buffer = Buffer.alloc(0)
  }

  /** Feed one chunk; returns every message that became complete. */
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk])
    const messages = []
    for (;;) {
      const headerEnd = this.buffer.indexOf('\r\n\r\n')
      if (headerEnd < 0) return messages
      const header = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /content-length:\s*(\d+)/i.exec(header)
      if (!match) throw new Error(`LSP frame has no Content-Length: ${header}`)
      const length = Number(match[1])
      const start = headerEnd + 4
      if (this.buffer.length < start + length) return messages
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      messages.push(JSON.parse(body))
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function uriFor(file) {
  const normalized = path.resolve(file).split(path.sep).join('/')
  return `file:///${normalized.replace(/^\//, '')}`
}

/**
 * Reduce an LSP URI to a comparable key.
 *
 * Godot percent-encodes the colon in a Windows drive (`file:///C%3A/...`),
 * while the URI this client sends is written plainly. Both sides must fold to
 * the same string or every "has this file reported yet" check silently fails.
 */
export function uriKey(uri) {
  return decodeUriPath(uri).toLowerCase()
}

/** Decode an LSP file URI into an absolute Windows path (case preserved). */
export function decodeUriPath(uri) {
  const plain = uri.replace(/^file:\/\/\/?/i, '')
  let decoded = plain
  try {
    decoded = decodeURIComponent(plain)
  } catch {
    // A literal `%` in a path is not valid escape syntax; keep it as-is.
  }
  return decoded.split('\\').join('/')
}

function fileKey(file) {
  return path.resolve(file).split(path.sep).join('/').toLowerCase()
}

/** Recursively collect `.gd` files, skipping engine caches and build output. */
export function collectScripts(targets) {
  const found = []
  const skip = new Set(['.godot', 'build', 'node_modules', '.git'])
  const walk = (entry) => {
    const stat = fs.statSync(entry)
    if (stat.isFile()) {
      if (entry.endsWith('.gd')) found.push(path.resolve(entry))
      return
    }
    for (const name of fs.readdirSync(entry)) {
      if (skip.has(name)) continue
      walk(path.join(entry, name))
    }
  }
  for (const target of targets) {
    // Relative paths are read from the harness root so the command behaves the
    // same from any working directory; absolute paths pass through unchanged.
    const absolute = path.resolve(HARNESS_ROOT, target)
    if (!fs.existsSync(absolute)) throw new Error(`No such script path: ${target}`)
    walk(absolute)
  }
  return [...new Set(found)].sort()
}

/** Ask the OS for a free loopback port, so parallel checks never collide. */
async function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

async function portOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1')
    const done = (value) => {
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => done(true))
    socket.once('timeout', () => done(false))
    socket.once('error', () => done(false))
  })
}

/** One language-server connection: framing, request ids, and a notification sink. */
class LspClient {
  constructor(socket) {
    this.socket = socket
    this.reader = new MessageReader()
    this.nextId = 1
    this.pending = new Map()
    this.notificationHandlers = []
    this.stderr = []
    socket.on('data', (chunk) => {
      for (const message of this.reader.push(chunk)) this.dispatch(message)
    })
    socket.on('error', () => {})
    socket.on('close', () => {
      for (const { reject } of this.pending.values()) reject(new Error('LSP socket closed'))
      this.pending.clear()
    })
  }

  dispatch(message) {
    if (message.id !== undefined && message.method) {
      // Godot sends client-directed requests we have no opinion about; answer
      // them so the server never blocks waiting on us.
      this.send({ jsonrpc: '2.0', id: message.id, result: null })
      return
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, reject } = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (message.error) reject(new Error(message.error.message || 'LSP error'))
      else resolve(message.result)
      return
    }
    if (message.method) {
      for (const handler of this.notificationHandlers) handler(message)
    }
  }

  send(message) {
    if (!this.socket.destroyed) this.socket.write(encodeFrame(message))
  }

  request(method, params) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method, params) {
    this.send({ jsonrpc: '2.0', method, params })
  }

  onNotification(handler) {
    this.notificationHandlers.push(handler)
  }

  close() {
    this.socket.destroy()
  }
}

function connect(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1')
    const fail = setTimeout(() => {
      socket.destroy()
      reject(new Error(`LSP server did not accept a connection on :${port}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(fail)
      resolve(new LspClient(socket))
    })
    socket.once('error', (error) => {
      clearTimeout(fail)
      reject(error)
    })
  })
}

function startServer(port) {
  const child = spawn(
    GODOT_BIN,
    ['--headless', '--editor', '--lsp-port', String(port), '--path', PROJECT],
    { cwd: HARNESS_ROOT, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
  )
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk.toString()))
  return {
    child,
    stderr,
    stop() {
      if (!child.killed) child.kill()
    },
  }
}

async function waitForServer(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await portOpen(port)) return true
    await sleep(200)
  }
  return false
}

/**
 * Run the language server over `files` and return normalised diagnostics.
 *
 * Resolves early once every opened file has reported and the stream has gone
 * quiet; otherwise returns whatever arrived before the deadline and reports
 * `complete: false` rather than pretending the files are clean.
 */
export async function checkWithLsp({ files, port, attach, timeoutMs = 30000, settleMs = 1200, log }) {
  let server = null
  let actualPort = port
  if (!attach) {
    actualPort = port || (await freePort())
    server = startServer(actualPort)
    if (!(await waitForServer(actualPort, Math.min(timeoutMs, 45000)))) {
      server.stop()
      throw new Error(
        `Godot did not open an LSP port on :${actualPort}.${server.stderr.length ? ` stderr: ${server.stderr.join('').slice(-800)}` : ''}`,
      )
    }
  }

  let client = null
  try {
    client = await connect(actualPort, 8000)
    const published = new Map()
    let lastMessage = Date.now()
    let capabilitiesSeen = false

    client.onNotification((message) => {
      lastMessage = Date.now()
      if (message.method === 'gdscript/capabilities') capabilitiesSeen = true
      if (message.method !== 'textDocument/publishDiagnostics') return
      const uri = message.params?.uri
      if (!uri) return
      published.set(uriKey(uri), { path: decodeUriPath(uri), items: message.params.diagnostics || [] })
    })

    log?.(`connecting to language server on :${actualPort}`)
    await client.request('initialize', {
      processId: process.pid,
      clientInfo: { name: 'gd-check' },
      rootUri: uriFor(PROJECT),
      workspaceFolders: [{ uri: uriFor(PROJECT), name: path.basename(PROJECT) }],
      capabilities: {},
    })
    client.notify('initialized', {})

    // The editor scans the project after initialize. Opening a document before
    // that scan lands produces no diagnostics at all, so wait for the server to
    // announce its capabilities instead of guessing a sleep.
    const readyDeadline = Date.now() + 15000
    while (!capabilitiesSeen && Date.now() < readyDeadline) await sleep(100)

    for (const file of files) {
      client.notify('textDocument/didOpen', {
        textDocument: {
          uri: uriFor(file),
          languageId: 'gdscript',
          version: 1,
          text: fs.readFileSync(file, 'utf8'),
        },
      })
      await sleep(20)
    }

    const deadline = Date.now() + timeoutMs
    let complete = false
    while (Date.now() < deadline) {
      const allReported = files.every((file) => published.has(fileKey(file)))
      const quietFor = Date.now() - lastMessage
      if (allReported && quietFor >= settleMs) {
        complete = true
        break
      }
      // Godot answers the files it has something to say about and stays silent
      // about the rest, so a long quiet period is also a valid stop once the
      // server has begun reporting at all.
      if (!allReported && published.size > 0 && quietFor >= settleMs * 2) {
        complete = true
        break
      }
      await sleep(100)
    }
    if (files.every((file) => published.has(fileKey(file)))) complete = true

    const diagnostics = []
    for (const { path: reported, items } of published.values()) {
      const file = path.relative(HARNESS_ROOT, reported.split('/').join(path.sep))
      for (const item of items) {
        const severity = SEVERITY[item.severity] || 'information'
        const text = String(item.message || '')
        const coded = /^\(([A-Z_0-9]+)\):\s*(.*)$/s.exec(text)
        diagnostics.push({
          file,
          line: (item.range?.start?.line ?? 0) + 1,
          column: (item.range?.start?.character ?? 0) + 1,
          severity,
          code: coded ? coded[1] : null,
          message: coded ? coded[2] : text,
          source: item.source || null,
        })
      }
    }
    diagnostics.sort(
      (a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column,
    )
    return { diagnostics, complete, port: actualPort }
  } finally {
    client?.close()
    server?.stop()
  }
}

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')
    ? process.argv[index + 1]
    : fallback
}

async function main() {
  const json = process.argv.includes('--json')
  const attach = process.argv.includes('--attach')
  const failOn = argValue('--fail-on', 'error')
  if (!SEVERITY_RANK[failOn]) throw new Error(`--fail-on expects error, warning, information or hint`)

  const positional = process.argv.slice(2).filter((arg, index, all) => {
    if (arg.startsWith('--')) return false
    const previous = all[index - 1]
    return !['--fail-on', '--port', '--timeout'].includes(previous)
  })
  const targets =
    positional.length > 0
      ? positional
      : ['voxel/scripts', 'voxel/tests', 'voxel/harness']
          .map((entry) => path.join(HARNESS_ROOT, entry))
          .filter((entry) => fs.existsSync(entry))

  const files = collectScripts(targets)
  if (files.length === 0) throw new Error('No .gd files under the requested paths')

  const started = Date.now()
  const result = await checkWithLsp({
    files,
    port: Number(argValue('--port', '0')) || 0,
    attach,
    timeoutMs: Number(argValue('--timeout', '30000')),
    log: json ? null : (line) => console.log(`[gd-check] ${line}`),
  })

  const counts = { error: 0, warning: 0, information: 0, hint: 0 }
  for (const item of result.diagnostics) counts[item.severity] += 1
  const threshold = SEVERITY_RANK[failOn]
  const failing = result.diagnostics.filter((item) => SEVERITY_RANK[item.severity] >= threshold)
  const durationMs = Date.now() - started

  if (json) {
    console.log(
      JSON.stringify(
        {
          tool: 'gd-check',
          version: 1,
          mode: attach ? 'lsp-attach' : 'lsp',
          project: path.relative(HARNESS_ROOT, PROJECT).split(path.sep).join('/'),
          files: files.map((file) => path.relative(HARNESS_ROOT, file).split(path.sep).join('/')),
          failOn,
          complete: result.complete,
          counts,
          diagnostics: result.diagnostics,
          durationMs,
          generatedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    )
  } else {
    for (const item of result.diagnostics) {
      console.log(`${item.file}:${item.line}:${item.column} ${item.severity} ${item.code || '-'} ${item.message}`)
    }
    const scope = 'lsp'
    console.log(
      `[gd-check] ${files.length} files (${scope}) in ${durationMs} ms: ` +
        `${counts.error} errors, ${counts.warning} warnings, ${counts.information} info, ${counts.hint} hints` +
        (result.complete ? '' : ' (incomplete: some files never reported)'),
    )
    if (failing.length > 0) {
      console.log(`[gd-check] FAIL at --fail-on ${failOn}: ${failing.length} finding(s)`)
    } else if (result.complete) {
      console.log(`[gd-check] OK at --fail-on ${failOn}`)
    } else {
      console.log('[gd-check] INCOMPLETE: not every file was analysed; do not treat this as clean')
    }
  }

  if (failing.length > 0) return 1
  return result.complete ? 0 : 2
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error) => {
      console.error(`[gd-check] ${error.message}`)
      process.exit(2)
    },
  )
}
