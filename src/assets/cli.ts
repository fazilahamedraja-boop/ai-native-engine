import { readdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { relative, resolve } from 'node:path'
import { VIEWS, isViewName } from '../preview/views'
import { buildAsset } from './build'
import type { BuildOutcome } from './build'
import { inspectAsset } from './inspect'
import { readCharacter, readGlbIndex } from './import/glb'
import { boundsOf } from './mesh'
import { parseAsset } from './schema'
import type { AssetDoc } from './schema'
import type { AssetIssue, Bounds } from './types'
import type { Vec3 } from '../core/math'

const ASSET_ROOT = 'content/assets'
const PREVIEW_ORIGIN = 'http://localhost:5173'

const USAGE = `usage: npm run assets -- <command>

  list                         one line per asset: id, kind, triangles, hash
  validate [id...] [--json]    build and check every asset (default: all)
  inspect <id>                 full JSON report for one asset
  preview <id> [--view v]      print the inspector URL (views: ${VIEWS.join(', ')})
  regen <id> [--accept]        show contract drift; --accept rewrites bounds and sockets
  index <file.glb>             JSON index of a GLB's JSON chunk (no geometry decode)
  character <file.glb>         check a GLB against the character kind contract`

interface LoadedAsset {
  file: string
  relativeFile: string
  raw: Record<string, unknown>
  doc: AssetDoc | null
  outcome: BuildOutcome | null
  errors: AssetIssue[]
}

async function discover(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const full = resolve(dir, entry.name)
      if (entry.isDirectory()) await walk(full)
      else if (entry.name.endsWith('.asset.json')) found.push(full)
    }
  }
  await walk(root)
  return found.sort()
}

async function loadAll(): Promise<LoadedAsset[]> {
  const files = await discover(resolve(ASSET_ROOT))
  const loaded: LoadedAsset[] = []

  for (const file of files) {
    const relativeFile = relative(process.cwd(), file).replaceAll('\\', '/')
    const text = await readFile(file, 'utf8')

    let raw: unknown
    try {
      raw = JSON.parse(text)
    } catch (error) {
      loaded.push({
        file,
        relativeFile,
        raw: {},
        doc: null,
        outcome: null,
        errors: [{ path: '', code: 'invalid_json', message: (error as Error).message }],
      })
      continue
    }

    const parsed = parseAsset(raw)
    if (!parsed.ok) {
      loaded.push({
        file,
        relativeFile,
        raw: raw as Record<string, unknown>,
        doc: null,
        outcome: null,
        errors: parsed.errors,
      })
      continue
    }

    loaded.push({
      file,
      relativeFile,
      raw: raw as Record<string, unknown>,
      doc: parsed.value,
      outcome: buildAsset(parsed.value),
      errors: [],
    })
  }

  return loaded
}

function select(assets: LoadedAsset[], ids: string[]): LoadedAsset[] | null {
  if (ids.length === 0) return assets
  const wanted = new Set(ids)
  const chosen = assets.filter(
    (asset) => (asset.doc !== null && wanted.has(asset.doc.id)) || wanted.has(asset.relativeFile),
  )
  if (chosen.length !== wanted.size) {
    const known = assets.map((asset) => asset.doc?.id ?? asset.relativeFile)
    const missing = ids.filter(
      (id) => !assets.some((asset) => asset.doc?.id === id || asset.relativeFile === id),
    )
    console.error(`unknown asset: ${missing.join(', ')}`)
    console.error(`known: ${known.join(', ') || 'none'}`)
    return null
  }
  return chosen
}

function printIssues(issues: AssetIssue[], prefix = '        '): void {
  for (const issue of issues) {
    console.log(`${prefix}${issue.path || '<root>'}: ${issue.message} [${issue.code}]`)
  }
}

async function commandList(assets: LoadedAsset[]): Promise<number> {
  let failed = 0

  for (const asset of assets) {
    if (asset.doc === null || asset.outcome === null) {
      failed += 1
      console.log(`${asset.relativeFile.padEnd(48)} parse   ${asset.errors[0]?.message ?? 'invalid'}`)
      continue
    }

    const inspection = inspectAsset(asset.doc, asset.outcome, asset.relativeFile)
    if (!inspection.ok || inspection.artifact === null) {
      failed += 1
      console.log(`${asset.doc.id.padEnd(24)} ${asset.doc.kind.padEnd(10)} FAIL    ${inspection.errors[0]?.message ?? ''}`)
      continue
    }

    const stats = inspection.artifact
    console.log(
      `${asset.doc.id.padEnd(24)} ${asset.doc.kind.padEnd(10)} ok      t=${String(stats.triangles).padStart(4)}  ${stats.hash}`,
    )
  }

  return failed === 0 ? 0 : 1
}

async function commandValidate(assets: LoadedAsset[], args: string[]): Promise<number> {
  const json = args.includes('--json')
  const ids = args.filter((arg) => !arg.startsWith('--'))
  const selected = select(assets, ids)
  if (selected === null) return 2

  if (json) {
    const reports: unknown[] = []
    let failed = 0
    for (const asset of selected) {
      if (asset.doc === null || asset.outcome === null) {
        failed += 1
        reports.push({ file: asset.relativeFile, ok: false, errors: asset.errors })
        continue
      }
      const inspection = inspectAsset(asset.doc, asset.outcome, asset.relativeFile)
      if (!inspection.ok) failed += 1
      reports.push(inspection)
    }
    console.log(JSON.stringify(reports, null, 2))
    return failed === 0 ? 0 : 1
  }

  let failed = 0
  for (const asset of selected) {
    if (asset.doc === null || asset.outcome === null) {
      failed += 1
      console.log(`FAIL  ${asset.relativeFile}`)
      printIssues(asset.errors)
      continue
    }

    const inspection = inspectAsset(asset.doc, asset.outcome, asset.relativeFile)
    if (!inspection.ok) failed += 1
    console.log(`${inspection.ok ? 'PASS' : 'FAIL'}  ${inspection.id}  (${inspection.kind})`)
    printIssues(inspection.errors)
    for (const warning of inspection.warnings) {
      console.log(`        warn ${warning.path}: ${warning.message}`)
    }
  }

  console.log('')
  console.log(`${selected.length - failed}/${selected.length} valid`)
  return failed === 0 ? 0 : 1
}

async function commandInspect(assets: LoadedAsset[], args: string[]): Promise<number> {
  const id = args[0]
  if (id === undefined) {
    console.error(USAGE)
    return 2
  }

  const selected = select(assets, [id])
  if (selected === null) return 2
  const asset = selected[0]

  if (asset.doc === null || asset.outcome === null) {
    console.log(JSON.stringify({ file: asset.relativeFile, ok: false, errors: asset.errors }, null, 2))
    return 1
  }

  const inspection = inspectAsset(asset.doc, asset.outcome, asset.relativeFile)
  console.log(JSON.stringify(inspection, null, 2))
  return inspection.ok ? 0 : 1
}

async function commandPreview(assets: LoadedAsset[], args: string[]): Promise<number> {
  const id = args[0]
  const viewIndex = args.indexOf('--view')
  const view = viewIndex === -1 ? 'three-quarter' : (args[viewIndex + 1] ?? '')

  if (id === undefined || view === '') {
    console.error(USAGE)
    return 2
  }
  if (!isViewName(view)) {
    console.error(`unknown view '${view}'; expected one of ${VIEWS.join(', ')}`)
    return 2
  }

  const selected = select(assets, [id])
  if (selected === null) return 2

  console.log(`${PREVIEW_ORIGIN}/?asset=${encodeURIComponent(id)}&view=${view}`)
  return 0
}

function round6(value: number): number {
  return Number(value.toFixed(6))
}

function roundBounds(bounds: Bounds): Bounds {
  return {
    min: [round6(bounds.min[0]), round6(bounds.min[1]), round6(bounds.min[2])],
    max: [round6(bounds.max[0]), round6(bounds.max[1]), round6(bounds.max[2])],
  }
}

function roundSockets(sockets: Record<string, Vec3>): Record<string, Vec3> {
  const out: Record<string, Vec3> = {}
  for (const name of Object.keys(sockets).sort()) {
    const socket = sockets[name]
    out[name] = [round6(socket[0]), round6(socket[1]), round6(socket[2])]
  }
  return out
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) return nested
    return Object.fromEntries(Object.entries(nested as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
  })
}

function formatBounds(bounds: Bounds): string {
  const n = (values: Vec3): string => values.map((value) => value.toFixed(3)).join(', ')
  return `[${n(bounds.min)}] .. [${n(bounds.max)}]`
}

async function commandRegen(assets: LoadedAsset[], args: string[]): Promise<number> {
  const id = args[0]
  const accept = args.includes('--accept')
  if (id === undefined) {
    console.error(USAGE)
    return 2
  }

  const selected = select(assets, [id])
  if (selected === null) return 2
  const asset = selected[0]

  if (asset.doc === null || asset.outcome === null || asset.outcome.artifact === undefined) {
    console.log(`${asset.relativeFile}: cannot build`)
    printIssues(asset.errors)
    return 1
  }

  const doc = asset.doc
  const artifact = asset.outcome.artifact
  const blocking = (asset.outcome.report?.errors ?? asset.outcome.errors).filter(
    (issue) => issue.path !== 'contract.bounds',
  )
  if (blocking.length > 0) {
    console.log(`${doc.id}: refusing to accept, unrelated failures:`)
    printIssues(blocking)
    return 1
  }

  const measuredBounds = roundBounds(boundsOf(artifact.geometry))
  const measuredSockets = roundSockets(artifact.sockets)
  const boundsDrift = stableJson(measuredBounds) !== stableJson(doc.contract.bounds)
  const socketsDrift = stableJson(measuredSockets) !== stableJson(doc.contract.sockets)

  if (!boundsDrift && !socketsDrift) {
    console.log(`${doc.id}: contract matches artifact`)
    return 0
  }

  console.log(`${doc.id}: contract drift`)
  if (boundsDrift) {
    console.log(`  bounds  declared ${formatBounds(doc.contract.bounds)}`)
    console.log(`          measured ${formatBounds(measuredBounds)}`)
  }
  if (socketsDrift) {
    console.log(`  sockets declared ${stableJson(doc.contract.sockets)}`)
    console.log(`          measured ${stableJson(measuredSockets)}`)
  }

  if (!accept) {
    console.log('re-run with --accept to write')
    return 1
  }

  const contract = { ...(asset.raw.contract as Record<string, unknown>), bounds: measuredBounds, sockets: measuredSockets }
  const next = { ...asset.raw, contract }
  await writeFile(asset.file, `${JSON.stringify(next, null, 2)}\n`, 'utf8')
  console.log(`wrote ${asset.relativeFile}`)
  return 0
}

interface LoadedGlb {
  bytes: Uint8Array
  file: string
  size: number
  sha256: string
}

async function readGlb(file: string): Promise<LoadedGlb | null> {
  const absolute = resolve(file)
  let buffer: Buffer
  try {
    buffer = await readFile(absolute)
  } catch (error) {
    console.error(`cannot read ${file}: ${(error as Error).message}`)
    return null
  }
  return {
    bytes: new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength),
    file: relative(process.cwd(), absolute).replaceAll('\\', '/'),
    size: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
  }
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2))
}

/**
 * The raw index: what the container says, without judging whether it can become
 * a character. Useful for any GLB, including ones that fail the kind contract.
 */
async function commandIndex(args: string[]): Promise<number> {
  const file = args[0]
  if (file === undefined) {
    console.error(USAGE)
    return 2
  }

  const loaded = await readGlb(file)
  if (loaded === null) return 2

  const result = readGlbIndex(loaded.bytes)
  const report = { file: loaded.file, bytes: loaded.size, sha256: loaded.sha256 }
  if (!result.ok) {
    printJson({ ...report, ok: false, errors: result.errors })
    return 1
  }

  printJson({ ...report, ok: true, index: result.value })
  return 0
}

/**
 * The kind gate: placeable, non-empty, required sockets present. This is what a
 * character manifest's contract must agree with, so it prints the measured
 * sockets and bounds in the same shape `regen --accept` would write.
 */
async function commandCharacter(args: string[]): Promise<number> {
  const file = args[0]
  if (file === undefined) {
    console.error(USAGE)
    return 2
  }

  const loaded = await readGlb(file)
  if (loaded === null) return 2

  const report = { file: loaded.file, bytes: loaded.size, sha256: loaded.sha256 }
  const result = readGlbIndex(loaded.bytes)
  if (!result.ok) {
    printJson({ ...report, ok: false, errors: result.errors })
    return 1
  }

  const summary = {
    generator: result.value.asset.generator,
    nodes: result.value.nodes.length,
    meshes: result.value.meshes.length,
    triangles: result.value.triangles,
    skins: result.value.skins.length,
    animations: result.value.animations.length,
  }

  const reading = readCharacter(result.value)
  if (!reading.ok) {
    printJson({ ...report, ok: false, errors: reading.errors, index: summary })
    return 1
  }

  printJson({
    ...report,
    ok: true,
    bounds: roundBounds(reading.value.bounds),
    sockets: roundSockets(reading.value.sockets),
    index: summary,
  })
  return 0
}

export async function main(argv: string[]): Promise<number> {
  const [command = 'list', ...args] = argv

  if (command === 'help' || command === '--help' || command === '-h') {
    console.log(USAGE)
    return 0
  }

  // File commands do not need the manifest catalog.
  if (command === 'index') return commandIndex(args)
  if (command === 'character') return commandCharacter(args)

  let assets: LoadedAsset[]
  try {
    assets = await loadAll()
  } catch (error) {
    console.error(`cannot read ${ASSET_ROOT}: ${(error as Error).message}`)
    return 2
  }

  switch (command) {
    case 'list':
      return commandList(assets)
    case 'validate':
      return commandValidate(assets, args)
    case 'inspect':
      return commandInspect(assets, args)
    case 'preview':
      return commandPreview(assets, args)
    case 'regen':
      return commandRegen(assets, args)
    default:
      console.error(`unknown command '${command}'`)
      console.error(USAGE)
      return 2
  }
}
