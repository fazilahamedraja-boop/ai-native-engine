import type { Vec3 } from '../core/math'

/**
 * The closed ontology.
 *
 * A kind is added only when a real asset needs it and it carries at least one
 * param axis no other kind has. If adding a kind also requires touching the
 * validator, the ontology is wrong and we stop and revisit instead.
 */
export const KINDS = ['sword', 'rock', 'pine', 'character'] as const
export type Kind = (typeof KINDS)[number]

/** Where the asset's local origin sits. */
export const ORIGINS = ['base-center', 'grip', 'feet-center', 'center'] as const
export type Origin = (typeof ORIGINS)[number]

/** Rough size band for placement code that has not loaded the asset yet. */
export const SCALE_CLASSES = ['handheld', 'prop', 'character'] as const
export type ScaleClass = (typeof SCALE_CLASSES)[number]

export interface Bounds {
  min: Vec3
  max: Vec3
}

/** Geometry in asset space, metres. Plain arrays: no THREE in this layer. */
export interface MeshData {
  positions: Float32Array
  normals: Float32Array
  indices: Uint32Array
  /**
   * Optional per-vertex RGB in sRGB [0,1], one triple per vertex. Multiplies the
   * material colour, which is how one asset carries a brown trunk, green
   * foliage and a snow cap without three materials. Stored as sRGB like every
   * other colour in a manifest; the renderer converts at the boundary.
   */
  colors?: Float32Array
}

/** Surface defaults produced by a generator or importer. */
export interface MaterialSpec {
  color: string
  roughness: number
  metalness: number
}

/** What a generator or an importer returns. */
export interface BuiltAsset {
  geometry: MeshData
  /** Named attachment points in asset space, metres. */
  sockets: Record<string, Vec3>
  /** Default appearance; a manifest override patches it per instance. */
  material: MaterialSpec
}

/**
 * Per-instance appearance patch. Deliberately narrow: an instance may never
 * change geometry, bounds or sockets, so the contract cannot be broken from
 * outside the asset.
 */
export interface MaterialPatch {
  color?: string
  roughness?: number
  metalness?: number
}

/** Same shape as SceneIssue, plus the measured/expected pair when relevant. */
export interface AssetIssue {
  path: string
  code: string
  message: string
  expected?: unknown
  measured?: unknown
}

export type ParseResult<T> = { ok: true; value: T } | { ok: false; errors: AssetIssue[] }
