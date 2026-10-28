/**
 * Build a portable Windows application with @electron/packager.
 *
 *   npm run package:win
 *
 * The Studio backend resolves the Godot harness and canonical projects relative
 * to its own location, so the staged layout mirrors the repository:
 *
 *   app/
 *     package.json            (main: studio/desktop/main.mjs)
 *     studio/                 server, public, templates, desktop
 *     experiments/godot-harness/
 *     docs/phase19/evidence/  (read-only dashboard data)
 *
 * `node_modules` and this machine's `studio/.data` are not copied: the packaged
 * app is portable and creates fresh projects inside `studio/.data` next to the
 * executable. The existing evidence dashboard then reads real evidence files,
 * not the local development history.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import packager from '@electron/packager'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const STUDIO = path.resolve(HERE, '..')
const REPO = path.resolve(STUDIO, '..')
const WORK = path.join(STUDIO, '.packaging')
const STAGE = path.join(WORK, 'app')
const OUT = path.join(STUDIO, 'desktop-dist')
const ELECTRON_VERSION = '45.0.0'
const APP_VERSION = JSON.parse(fs.readFileSync(path.join(STUDIO, 'package.json'), 'utf8')).version

const SKIP_STUDIO_TOP = new Set(['node_modules', '.data', 'desktop-dist', '.packaging', 'test'])
const SKIP_ANYWHERE = new Set(['__pycache__', '.pytest_cache', '.godot'])

function copyDirectory(source, target, { skipTop = new Set(), skipAnywhere = new Set() } = {}) {
  fs.mkdirSync(target, { recursive: true })
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (skipTop.has(entry.name) || skipAnywhere.has(entry.name)) continue
    const from = path.join(source, entry.name)
    const to = path.join(target, entry.name)
    if (entry.isDirectory()) {
      copyDirectory(from, to, { skipAnywhere })
    } else if (entry.isFile()) {
      fs.copyFileSync(from, to)
    }
  }
}

function requireFile(file, label) {
  if (!fs.existsSync(file)) throw new Error(`${label} is missing: ${file}`)
}

console.log('Preparing a clean stage…')
fs.rmSync(WORK, { recursive: true, force: true })
fs.mkdirSync(STAGE, { recursive: true })

console.log('Copying Studio…')
copyDirectory(STUDIO, path.join(STAGE, 'studio'), { skipTop: SKIP_STUDIO_TOP, skipAnywhere: SKIP_ANYWHERE })

console.log('Copying Godot harness…')
copyDirectory(
  path.join(REPO, 'experiments', 'godot-harness'),
  path.join(STAGE, 'experiments', 'godot-harness'),
  { skipAnywhere: SKIP_ANYWHERE },
)

const evidenceRoot = path.join(REPO, 'docs', 'phase19', 'evidence')
if (fs.existsSync(evidenceRoot)) {
  console.log('Copying read-only evidence dashboard data…')
  copyDirectory(evidenceRoot, path.join(STAGE, 'docs', 'phase19', 'evidence'))
} else {
  console.warn('No Phase 19 evidence directory found; the dashboard will start empty.')
}

const stageManifest = {
  name: 'ai-game-studio-desktop',
  productName: 'AI Game Studio',
  version: APP_VERSION,
  private: true,
  type: 'module',
  description: 'AI Game Studio desktop application',
  author: 'AI Game Studio',
  main: 'studio/desktop/main.mjs',
}
fs.writeFileSync(path.join(STAGE, 'package.json'), `${JSON.stringify(stageManifest, null, 2)}\n`, 'utf8')

// Fail before a long packaging run if the layout is wrong.
for (const [file, label] of [
  [path.join(STAGE, 'studio', 'desktop', 'main.mjs'), 'desktop main'],
  [path.join(STAGE, 'studio', 'server', 'index.mjs'), 'Studio server'],
  [path.join(STAGE, 'studio', 'templates', 'arena', 'project.godot'), 'arena template'],
  [path.join(STAGE, 'experiments', 'godot-harness', 'controller', 'harness.mjs'), 'Godot harness'],
]) {
  requireFile(file, label)
}

console.log(`Packaging AI Game Studio ${APP_VERSION} with Electron ${ELECTRON_VERSION}…`)
const appPaths = await packager({
  dir: STAGE,
  name: 'AI Game Studio',
  platform: 'win32',
  arch: 'x64',
  out: OUT,
  overwrite: true,
  icon: path.join(STUDIO, 'desktop', 'icon.ico'),
  electronVersion: ELECTRON_VERSION,
  appVersion: APP_VERSION,
  asar: false,
  prune: false,
  appCopyright: 'AI Game Studio',
  win32metadata: {
    CompanyName: 'AI Game Studio',
    FileDescription: 'AI Game Studio — local AI game development',
    ProductName: 'AI Game Studio',
    OriginalFilename: 'AI Game Studio.exe',
  },
})

const packaged = appPaths[0]
const exe = path.join(packaged, 'AI Game Studio.exe')
if (!fs.existsSync(exe)) throw new Error(`Packager finished but ${exe} is missing.`)

fs.writeFileSync(
  path.join(OUT, 'README.txt'),
  [
    'AI Game Studio — portable Windows build',
    '',
    'Run: "AI Game Studio\\AI Game Studio.exe"',
    '',
    'The application starts its own Studio backend on a random loopback port and',
    'opens the desktop workspace. It does not require Node.js or npm.',
    '',
    'Requirements:',
    '- Windows 10/11 x64.',
    '- Godot 4.7 on PATH (the "godot" shim) or GODOT_BIN set to the Godot 4.7',
    '  executable before launching.',
    '- The OpenCode CLI available where the Studio expects it (OPENCODE_BIN or the',
    '  default %APPDATA%\\npm location) for AI generation runs.',
    '',
    'Projects created in this portable build live in:',
    '  resources\\app\\studio\\.data\\projects',
    'Keep the folder somewhere writable (not Program Files) so projects, jobs and',
    'artifacts can be written. Verified project files are never modified without',
    'an explicit approval in the app.',
    '',
  ].join('\r\n'),
  'utf8',
)

const sizeMb = (() => {
  let total = 0
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.isFile()) total += fs.statSync(full).size
    }
  }
  walk(packaged)
  return (total / (1024 * 1024)).toFixed(0)
})()

console.log('')
console.log(`Packaged: ${exe}`)
console.log(`Size:     ${sizeMb} MB`)
console.log(`Stage:    ${STAGE}`)
