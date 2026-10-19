import type { z } from 'zod'
import type { Rng } from './rng'
import type { BuiltAsset, Kind } from './types'

/**
 * A generator is a pure function of (params, seed, version).
 *
 * `version` must be bumped whenever the same params would produce different
 * output. Manifests pin the version they were authored against, so a silent
 * change becomes a build error instead of a scene that quietly looks wrong.
 */
export interface GeneratorOf<P extends Record<string, unknown>> {
  readonly kind: Kind
  readonly version: number
  /** The same schema the manifest was validated against. */
  readonly params: z.ZodType<P>
  build(params: P, rng: Rng): BuiltAsset
}

interface RegisteredGenerator {
  readonly version: number
  build(params: Record<string, unknown>, rng: Rng): BuiltAsset
}

const REGISTRY = new Map<Kind, RegisteredGenerator>()

export function registerGenerator<P extends Record<string, unknown>>(generator: GeneratorOf<P>): void {
  if (REGISTRY.has(generator.kind)) {
    throw new Error(`a generator for kind '${generator.kind}' is already registered`)
  }
  REGISTRY.set(generator.kind, {
    version: generator.version,
    // Re-parse here so a generator can never be handed fields the manifest
    // schema would have rejected.
    build: (params, rng) => generator.build(generator.params.parse(params), rng),
  })
}

export function getGenerator(kind: Kind): RegisteredGenerator | undefined {
  return REGISTRY.get(kind)
}

export function registeredKinds(): Kind[] {
  return [...REGISTRY.keys()].sort()
}
