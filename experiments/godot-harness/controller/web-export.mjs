#!/usr/bin/env node
/**
 * Build a self-contained Web export of the Phase 17 game for the live page.
 *
 * The canonical game only carries the Windows preset. This helper copies the
 * project to a temporary directory, adds a Web preset there, exports it, and
 * publishes the result outside the source tree. It never edits the canonical
 * project or its export presets.
 */

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { GODOT_BIN, HARNESS_ROOT } from './harness.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const LIVE_ROOT =
  process.env.PHASE17_LIVE_ROOT || path.join(os.tmpdir(), 'opencode', 'phase16-progress')

function argValue(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback
}

const source = path.resolve(argValue('--source', path.join(HARNESS_ROOT, 'game')))
const outDir = path.resolve(argValue('--out', path.join(LIVE_ROOT, 'play17')))
const keep = process.argv.includes('--keep')

function sha256File(file) {
  const hash = crypto.createHash('sha256')
  hash.update(fs.readFileSync(file))
  return hash.digest('hex')
}

function run(command, args, label, timeout = 300000) {
  const result = spawnSync(command, args, {
    cwd: HARNESS_ROOT,
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  if (result.error || result.status !== 0) {
    throw new Error(
      `${label} failed (exit ${result.status ?? 'n/a'}): ${result.error || result.stderr || result.stdout}`,
    )
  }
  return result
}

const WEB_PRESET = `
[preset.1]
name="Web"
platform="Web"
runnable=true
advanced_options=false
dedicated_server=false
custom_features=""
export_filter="all_resources"
include_filter=""
exclude_filter="tests/*, artifacts/*"
export_path="build/web/index.html"
patches=PackedStringArray()
encryption_include_filters=""
encryption_exclude_filters=""
seed=0
encrypt_pck=false
encrypt_directory=false
script_export_mode=2

[preset.1.options]
custom_template/debug=""
custom_template/release=""
variant/extensions_support=false
variant/thread_support=false
vram_texture_compression/for_desktop=true
vram_texture_compression/for_mobile=false
html/export_icon=true
html/custom_html_shell=""
html/head_include=""
html/canvas_resize_policy=2
html/focus_canvas_on_start=true
html/experimental_virtual_keyboard=false
progressive_web_app/enabled=false
progressive_web_app/ensure_cross_origin_isolation_headers=true
progressive_web_app/offline_page=""
progressive_web_app/display=1
progressive_web_app/orientation=0
progressive_web_app/icon_144x144=""
progressive_web_app/icon_180x180=""
progressive_web_app/icon_512x512=""
progressive_web_app/background_color=Color(0, 0, 0, 1)
`

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'phase17-web-'))
const project = path.join(work, 'game')
const webBuild = path.join(work, 'web')
try {
  fs.cpSync(source, project, {
    recursive: true,
    filter: (entry) => {
      const relative = path.relative(source, entry)
      const parts = relative.split(path.sep)
      return !parts.some((part) => ['.godot', 'artifacts', 'build'].includes(part))
    },
  })
  fs.appendFileSync(path.join(project, 'export_presets.cfg'), WEB_PRESET, 'utf8')

  run(GODOT_BIN, ['--headless', '--path', project, '--import'], 'Godot import')
  fs.mkdirSync(webBuild, { recursive: true })
  run(
    GODOT_BIN,
    ['--headless', '--path', project, '--export-release', 'Web', path.join(webBuild, 'index.html')],
    'Godot Web export',
    600000,
  )

  const required = ['index.html', 'index.js', 'index.wasm', 'index.pck']
  const missing = required.filter((name) => !fs.existsSync(path.join(webBuild, name)))
  if (missing.length > 0) {
    throw new Error(`Web export is missing: ${missing.join(', ')}`)
  }

  fs.rmSync(outDir, { recursive: true, force: true })
  fs.mkdirSync(outDir, { recursive: true })
  fs.cpSync(webBuild, outDir, { recursive: true })

  const files = Object.fromEntries(
    required.map((name) => [name, { bytes: fs.statSync(path.join(outDir, name)).size, sha256: sha256File(path.join(outDir, name)) }]),
  )
  const sourceHashes = ['scripts/game_world.gd', 'scripts/fighter_rig.gd', 'project.godot'].map((name) => ({
    path: `game/${name}`,
    sha256: sha256File(path.join(source, name)),
  }))
  const manifest = {
    schema: 'phase17.web-export.v1',
    created_at: new Date().toISOString(),
    source,
    output: outDir,
    source_hashes: sourceHashes,
    files,
    note: 'The web preset is added only in this temporary copy; the canonical project keeps its Windows preset.',
  }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  console.log(JSON.stringify(manifest, null, 2))
} finally {
  if (!keep) fs.rmSync(work, { recursive: true, force: true })
}
