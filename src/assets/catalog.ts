import { buildAsset, buildImportedAsset } from './build'
import type { BuildOutcome, ImportedSource } from './build'
import { parseAsset } from './schema'
import type { AssetDoc } from './schema'
import type { AssetIssue, ParseResult } from './types'

/**
 * Every manifest under content/assets, bundled at build time.
 *
 * `import.meta.glob` keeps the preview working in a production build without a
 * file server, and makes the set of assets a compile-time fact rather than a
 * runtime directory scan. GLBs are bundled by URL and fetched, because the
 * pinned SHA-256 must be computed over the exact file bytes.
 */
const RAW = import.meta.glob('/content/assets/**/*.asset.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

const GLB = import.meta.glob('/content/assets/**/*.glb', {
  query: '?url',
  import: 'default',
  eager: true,
}) as Record<string, string>

export interface CatalogEntry {
  file: string
  doc: AssetDoc
  outcome: BuildOutcome
}

export interface CatalogFailure {
  file: string
  errors: AssetIssue[]
}

export interface Catalog {
  entries: CatalogEntry[]
  failures: CatalogFailure[]
}

let cached: Promise<Catalog> | null = null

/**
 * Loads and builds every asset once. Async because imported sources must be
 * fetched and hashed; procedural assets still build synchronously inside.
 */
export function catalog(): Promise<Catalog> {
  cached ??= loadCatalog()
  return cached
}

export async function findAsset(id: string): Promise<CatalogEntry | undefined> {
  const loaded = await catalog()
  return loaded.entries.find((entry) => entry.doc.id === id)
}

async function loadCatalog(): Promise<Catalog> {
  const entries: CatalogEntry[] = []
  const failures: CatalogFailure[] = []

  for (const file of Object.keys(RAW).sort()) {
    const parsed = parseAsset(RAW[file])
    if (!parsed.ok) {
      failures.push({ file, errors: parsed.errors })
      continue
    }

    const doc = parsed.value
    if (doc.provenance.type === 'procedural') {
      entries.push({ file, doc, outcome: buildAsset(doc) })
      continue
    }

    const source = await readSource(doc.provenance.file)
    if (!source.ok) {
      failures.push({ file, errors: source.errors })
      continue
    }
    entries.push({ file, doc, outcome: buildImportedAsset(doc, source.value) })
  }

  return { entries, failures }
}

async function readSource(relativeFile: string): Promise<ParseResult<ImportedSource>> {
  const key = `/content/assets/${relativeFile.replaceAll('\\', '/')}`
  const url = GLB[key]
  if (url === undefined) {
    return {
      ok: false,
      errors: [
        {
          path: 'provenance.file',
          code: 'source_not_bundled',
          message: `no GLB bundle entry for '${relativeFile}'`,
          measured: relativeFile,
        },
      ],
    }
  }

  let bytes: Uint8Array
  try {
    const response = await fetch(url)
    if (!response.ok) {
      return {
        ok: false,
        errors: [
          {
            path: 'provenance.file',
            code: 'source_fetch_failed',
            message: `fetching '${relativeFile}' returned ${response.status} ${response.statusText}`,
            measured: relativeFile,
          },
        ],
      }
    }
    bytes = new Uint8Array(await response.arrayBuffer())
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: 'provenance.file',
          code: 'source_fetch_failed',
          message: `cannot load '${relativeFile}': ${(error as Error).message}`,
          measured: relativeFile,
        },
      ],
    }
  }

  try {
    return { ok: true, value: { bytes, sha256: await sha256Hex(bytes) } }
  } catch (error) {
    return {
      ok: false,
      errors: [
        {
          path: 'provenance.file',
          code: 'source_hash_failed',
          message: `cannot hash '${relativeFile}': ${(error as Error).message}`,
          measured: relativeFile,
        },
      ],
    }
  }
}

/** WebCrypto is available on localhost and HTTPS, which is where previews run. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = globalThis.crypto?.subtle
  if (subtle === undefined) throw new Error('WebCrypto is unavailable; serve the preview from localhost or HTTPS')
  // Copy into a plain ArrayBuffer-backed view: WebCrypto rejects views over SharedArrayBuffer.
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  const digest = await subtle.digest('SHA-256', copy)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')
}
