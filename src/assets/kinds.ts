import { z } from 'zod'
import type { Kind, Origin, ScaleClass } from './types'

/**
 * Param schemas are owned here, not by the generators, so the manifest can be
 * validated without loading a single generator. Every knob is an enum or a
 * bounded number with a default: no free-form floats, no arbitrary strings.
 */

export const SwordParams = z.strictObject({
  /** Tip-to-pommel, metres. */
  length: z.number().min(0.6).max(1.4).default(0.95),
  bladeWidth: z.enum(['narrow', 'broad']).default('broad'),
  guard: z.enum(['none', 'cross', 'disc']).default('cross'),
  material: z.enum(['iron', 'steel', 'bronze']).default('iron'),
})
export type SwordParams = z.infer<typeof SwordParams>

export const RockParams = z.strictObject({
  /** Nominal longest axis in metres. */
  size: z.enum(['small', 'medium', 'boulder']).default('medium'),
  family: z.enum(['angular', 'rounded', 'stacked']).default('angular'),
  /** Facet subdivision level. 0 is a raw polyhedron. */
  detail: z.number().int().min(0).max(3).default(2),
  /** Fraction of faces carrying moss. */
  moss: z.number().min(0).max(1).default(0.2),
})
export type RockParams = z.infer<typeof RockParams>

export const PineParams = z.strictObject({
  height: z.number().min(4).max(15).default(8),
  tiers: z.number().int().min(3).max(8).default(5),
  spread: z.enum(['narrow', 'wide']).default('narrow'),
  snow: z.boolean().default(false),
})
export type PineParams = z.infer<typeof PineParams>

/** Imported characters carry no knobs; the file is the whole recipe. */
export const CharacterParams = z.strictObject({})
export type CharacterParams = z.infer<typeof CharacterParams>

export type ParamParse =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; issues: z.core.$ZodIssue[] }

export interface KindSpec {
  readonly kind: Kind
  readonly origin: Origin
  readonly scaleClass: ScaleClass
  /** Sockets the kind guarantees. Validation fails if the artifact lacks them. */
  readonly requiredSockets: readonly string[]
  readonly params: {
    readonly defaults: Record<string, unknown>
    parse(raw: unknown): ParamParse
  }
}

function bind<T extends Record<string, unknown>>(schema: z.ZodType<T>): (raw: unknown) => ParamParse {
  return (raw) => {
    const result = schema.safeParse(raw)
    return result.success ? { ok: true, value: result.data } : { ok: false, issues: result.error.issues }
  }
}

export const KIND_SPECS: Record<Kind, KindSpec> = {
  sword: {
    kind: 'sword',
    origin: 'grip',
    scaleClass: 'handheld',
    requiredSockets: ['grip', 'tip'],
    params: { defaults: SwordParams.parse({}), parse: bind(SwordParams) },
  },
  rock: {
    kind: 'rock',
    origin: 'base-center',
    scaleClass: 'prop',
    requiredSockets: [],
    params: { defaults: RockParams.parse({}), parse: bind(RockParams) },
  },
  pine: {
    kind: 'pine',
    origin: 'base-center',
    scaleClass: 'prop',
    requiredSockets: ['base'],
    params: { defaults: PineParams.parse({}), parse: bind(PineParams) },
  },
  character: {
    kind: 'character',
    origin: 'feet-center',
    scaleClass: 'character',
    requiredSockets: ['head', 'hand_l', 'hand_r'],
    params: { defaults: CharacterParams.parse({}), parse: bind(CharacterParams) },
  },
}

/**
 * Guards the ontology itself, at import time. A 'grip' origin is only meaningful
 * if the kind also promises a socket named 'grip', and an origin kind must be
 * one the validator knows how to check.
 */
for (const spec of Object.values(KIND_SPECS)) {
  if (spec.origin === 'grip' && !spec.requiredSockets.includes('grip')) {
    throw new Error(`kind '${spec.kind}' uses origin 'grip' but does not require a 'grip' socket`)
  }
}
