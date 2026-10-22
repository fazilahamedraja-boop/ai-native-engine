#!/usr/bin/env node
/**
 * Small status-file bridge for the Phase 17 live dashboard.
 *
 * The dashboard is intentionally a static page served by a local HTTP server;
 * it polls `status.json` and never gets shell access. The runners import the
 * helpers below, while manual orchestration can call the CLI with
 * `--step`, `--test`, `--capture`, `--agent`, `--set`, or `--log`.
 *
 * The default output directory is the same temporary dashboard root used by
 * the Phase 16 live page. Override it with PHASE17_LIVE_DIR.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const LIVE_DIR =
  process.env.PHASE17_LIVE_DIR ||
  path.join(os.tmpdir(), 'opencode', 'phase16-progress', 'phase17')
const STATUS_PATH = path.join(LIVE_DIR, 'status.json')

function now() {
  return new Date().toISOString()
}

function ensureDir() {
  fs.mkdirSync(LIVE_DIR, { recursive: true })
}

export function readStatus() {
  if (!fs.existsSync(STATUS_PATH)) return null
  try {
    return JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'))
  } catch {
    return null
  }
}

export function writeStatus(status) {
  ensureDir()
  status.updated_at = now()
  const tmp = `${STATUS_PATH}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(status, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, STATUS_PATH)
  return status
}

function baseStatus() {
  if (readStatus()) return readStatus()
  return {
    phase: 17,
    title: 'Dodge-roll',
    subtitle: 'Autonomous feature development, implemented by the agent and verified by the runner.',
    state: 'starting',
    started_at: now(),
    updated_at: now(),
    branch: 'experiment/phase17-dodge',
    commit: null,
    progress: 0,
    current: { id: 'start', label: 'Starting Phase 17', detail: 'Preparing the isolated worktree.' },
    steps: [],
    tests: [],
    agent: { model: null, status: 'idle', attempts: [] },
    captures: [],
    logs: [],
    links: {},
  }
}

export function initLive(patch = {}) {
  const status = { ...baseStatus(), ...patch }
  status.steps ||= []
  status.tests ||= []
  status.agent ||= { model: null, status: 'idle', attempts: [] }
  status.captures ||= []
  status.logs ||= []
  return writeStatus(status)
}

export function upsertStep(step) {
  const status = readStatus() || baseStatus()
  status.steps ||= []
  const entry = { at: now(), ...step }
  const index = status.steps.findIndex((item) => item.id === entry.id)
  if (index >= 0) status.steps[index] = { ...status.steps[index], ...entry }
  else status.steps.push(entry)
  if (entry.status === 'running') {
    status.current = { id: entry.id, label: entry.label, detail: entry.detail || '' }
    status.state = 'running'
  }
  return writeStatus(status)
}

export function upsertTest(test) {
  const status = readStatus() || baseStatus()
  status.tests ||= []
  const entry = { at: now(), ...test }
  const index = status.tests.findIndex((item) => item.id === entry.id)
  if (index >= 0) status.tests[index] = { ...status.tests[index], ...entry }
  else status.tests.push(entry)
  return writeStatus(status)
}

export function addCapture(capture) {
  const status = readStatus() || baseStatus()
  status.captures ||= []
  const entry = { at: now(), ...capture }
  const index = status.captures.findIndex((item) => item.name === entry.name)
  if (index >= 0) status.captures[index] = { ...status.captures[index], ...entry }
  else status.captures.push(entry)
  return writeStatus(status)
}

export function setAgent(patch) {
  const status = readStatus() || baseStatus()
  status.agent = { ...(status.agent || {}), ...patch }
  if (patch.status === 'running') status.state = 'running'
  return writeStatus(status)
}

export function updateLive(patch) {
  const status = readStatus() || baseStatus()
  const merged = { ...status, ...patch }
  return writeStatus(merged)
}

export function logLive(message, level = 'info') {
  const status = readStatus() || baseStatus()
  status.logs ||= []
  status.logs.push({ at: now(), level, message })
  if (status.logs.length > 120) status.logs = status.logs.slice(-120)
  return writeStatus(status)
}

function parseArgs(argv) {
  const options = { command: argv[0] || null }
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--json') options.json = argv[++i]
    else if (arg === '--id') options.id = argv[++i]
    else if (arg === '--label') options.label = argv[++i]
    else if (arg === '--status') options.status = argv[++i]
    else if (arg === '--detail') options.detail = argv[++i]
    else if (arg === '--passed') options.passed = Number(argv[++i])
    else if (arg === '--total') options.total = Number(argv[++i])
    else if (arg === '--duration') options.duration = Number(argv[++i])
    else if (arg === '--name') options.name = argv[++i]
    else if (arg === '--file') options.file = argv[++i]
    else if (arg === '--caption') options.caption = argv[++i]
    else if (arg === '--tick') options.tick = Number(argv[++i])
    else if (arg === '--message') options.message = argv[++i]
    else if (arg === '--level') options.level = argv[++i]
    else throw new Error(`Unknown option: ${arg}`)
  }
  return options
}

if (pathToFileURL(process.argv[1]).href === import.meta.url) {
  const options = parseArgs(process.argv.slice(2))
  if (options.command === 'init') {
    const patch = options.json ? JSON.parse(fs.readFileSync(options.json, 'utf8')) : {}
    console.log(JSON.stringify(initLive(patch), null, 2))
  } else if (options.command === 'step') {
    console.log(JSON.stringify(upsertStep(options), null, 2))
  } else if (options.command === 'test') {
    console.log(JSON.stringify(upsertTest(options), null, 2))
  } else if (options.command === 'capture') {
    console.log(JSON.stringify(addCapture(options), null, 2))
  } else if (options.command === 'agent') {
    console.log(JSON.stringify(setAgent(options), null, 2))
  } else if (options.command === 'set') {
    const patch = options.json ? JSON.parse(fs.readFileSync(options.json, 'utf8')) : {}
    console.log(JSON.stringify(updateLive(patch), null, 2))
  } else if (options.command === 'log') {
    console.log(JSON.stringify(logLive(options.message, options.level), null, 2))
  } else {
    console.error('Usage: phase17-status.mjs init|step|test|capture|agent|set|log [options]')
    process.exitCode = 2
  }
}
