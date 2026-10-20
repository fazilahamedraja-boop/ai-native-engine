import { boundsOf, statsOf } from './mesh'
import type { BuildOutcome } from './build'
import type { AssetDoc } from './schema'
import type { AssetIssue, Bounds, MaterialSpec } from './types'
import type { Vec3 } from '../core/math'

/**
 * The machine-readable view of one asset.
 *
 * Shared by `npm run assets -- inspect` and the preview page, so the agent sees
 * the same fields whether it is reading JSON in a terminal or a live page.
 */
export interface AssetInspection {
  file?: string
  id: string
  kind: string
  ok: boolean
  provenance: AssetDoc['provenance']
  params: Record<string, unknown>
  contract: AssetDoc['contract']
  artifact: {
    hash: string
    vertices: number
    triangles: number
    generationMs?: number
    bounds: Bounds
    sockets: Record<string, Vec3>
    material: MaterialSpec
  } | null
  tests: AssetDoc['tests']
  override: AssetDoc['override']
  errors: AssetIssue[]
  warnings: AssetIssue[]
}

export function inspectAsset(doc: AssetDoc, outcome: BuildOutcome, file?: string): AssetInspection {
  const artifact = outcome.artifact
  const stats = artifact === undefined ? null : statsOf(artifact.geometry)

  return {
    ...(file === undefined ? {} : { file }),
    id: doc.id,
    kind: doc.kind,
    ok: outcome.ok,
    provenance: doc.provenance,
    params: doc.params,
    contract: doc.contract,
    artifact:
      artifact === null || artifact === undefined || stats === null
        ? null
        : {
            hash: outcome.report?.artifactHash ?? '',
            vertices: stats.vertices,
            triangles: stats.triangles,
            generationMs: outcome.report?.stats.generationMs,
            bounds: boundsOf(artifact.geometry),
            sockets: artifact.sockets,
            material: artifact.material,
          },
    tests: doc.tests,
    override: doc.override,
    errors: outcome.errors,
    warnings: outcome.report?.warnings ?? [],
  }
}
