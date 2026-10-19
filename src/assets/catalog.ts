import { buildAsset } from './build'
import type { BuildOutcome } from './build'
import { parseAsset } from './schema'
import type { AssetDoc } from './schema'
import type { AssetIssue } from './types'

/**
 * Every manifest under content/assets, bundled at build time.
 *
 * `import.meta.glob` keeps the preview working in a production build without a
 * file server, and makes the set of assets a compile-time fact rather than a
 * runtime directory scan.
 */
const RAW = import.meta.glob('/content/assets/**/*.asset.json', {
  eager: true,
  import: 'default',
}) as Record<string, unknown>

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

let cached: Catalog | null = null

export function catalog(): Catalog {
  if (cached !== null) return cached

  const entries: CatalogEntry[] = []
  const failures: CatalogFailure[] = []

  for (const file of Object.keys(RAW).sort()) {
    const parsed = parseAsset(RAW[file])
    if (!parsed.ok) {
      failures.push({ file, errors: parsed.errors })
      continue
    }
    entries.push({ file, doc: parsed.value, outcome: buildAsset(parsed.value) })
  }

  cached = { entries, failures }
  return cached
}

export function findAsset(id: string): CatalogEntry | undefined {
  return catalog().entries.find((entry) => entry.doc.id === id)
}
