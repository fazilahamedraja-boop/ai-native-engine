import { z } from 'zod'
import { KIND_SPECS } from './kinds'
import { KINDS, ORIGINS, SCALE_CLASSES } from './types'
import type { AssetIssue, ParseResult } from './types'

export const ASSET_VERSION = 1

const Id = z.string().regex(/^[a-z][a-z0-9_-]*$/, 'id must be a lowercase slug matching ^[a-z][a-z0-9_-]*$')
const SocketName = z.string().regex(/^[a-z][a-z0-9_]*$/, 'socket names must be lowercase slugs')
const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb hex colour')

const BoundsSchema = z.strictObject({ min: Vec3Schema, max: Vec3Schema }).superRefine((bounds, ctx) => {
  for (let axis = 0; axis < 3; axis++) {
    if (bounds.min[axis] > bounds.max[axis]) {
      ctx.addIssue({
        code: 'custom',
        path: ['min', axis],
        message: `bounds.min[${axis}] (${bounds.min[axis]}) exceeds bounds.max[${axis}] (${bounds.max[axis]})`,
      })
    }
  }
})

const Contract = z.strictObject({
  units: z.literal('m').default('m'),
  origin: z.enum(ORIGINS),
  scaleClass: z.enum(SCALE_CLASSES),
  /**
   * Declared, not derived. A generator change that silently grows an asset must
   * fail validation instead of quietly moving every placement built on it.
   */
  bounds: BoundsSchema,
  sockets: z.record(SocketName, Vec3Schema).default({}),
})

const Override = z
  .strictObject({
    /** Appearance only: geometry, bounds and sockets are owned by the asset. */
    material: z
      .strictObject({
        color: Hex.optional(),
        roughness: z.number().min(0).max(1).optional(),
        metalness: z.number().min(0).max(1).optional(),
      })
      .optional(),
  })
  .default({})

/**
 * `bounds-match`, `finite` and `non-empty` are implicit and always run. These
 * are the extra promises an asset makes about itself.
 */
const Assertion = z.discriminatedUnion('assert', [
  z.strictObject({ assert: z.literal('origin-at'), value: z.enum(ORIGINS) }),
  z.strictObject({ assert: z.literal('sockets-present'), value: z.array(z.string().min(1)).min(1) }),
  z.strictObject({ assert: z.literal('max-extent'), value: z.number().positive() }),
  z.strictObject({ assert: z.literal('triangles-max'), value: z.number().int().positive() }),
  z.strictObject({ assert: z.literal('watertight') }),
  z.strictObject({ assert: z.literal('area-positive') }),
])

const Procedural = z.strictObject({
  type: z.literal('procedural'),
  generator: z.string().min(1),
  generatorVersion: z.number().int().min(1),
  seed: z.number().int().min(0).max(4294967295),
})

const Imported = z.strictObject({
  type: z.literal('imported'),
  /** Path relative to content/assets/. */
  file: z.string().min(1),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'expected a lowercase hex sha256'),
  importer: z.literal('glb'),
  importerVersion: z.number().int().min(1),
})

const AssetDocSchema = z.strictObject({
  version: z.literal(ASSET_VERSION),
  id: Id,
  kind: z.enum(KINDS),
  provenance: z.discriminatedUnion('type', [Procedural, Imported]),
  /** Validated per kind below; holds the parsed value with defaults filled in. */
  params: z.record(z.string(), z.unknown()).default({}),
  contract: Contract,
  tests: z.array(Assertion).default([]),
  override: Override,
})

export type AssetDoc = z.infer<typeof AssetDocSchema>
export type Assertion = z.infer<typeof Assertion>
export type Provenance = z.infer<typeof Procedural> | z.infer<typeof Imported>

function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out ? `.${String(segment)}` : String(segment)
  }
  return out
}

function toIssue(issue: z.core.$ZodIssue): AssetIssue[] {
  if (issue.code === 'unrecognized_keys') {
    const base = formatPath(issue.path)
    return issue.keys.map((key) => ({
      path: base ? `${base}.${key}` : key,
      code: 'unknown_property',
      message: `unknown property '${key}'`,
    }))
  }
  return [{ path: formatPath(issue.path), code: issue.code, message: issue.message }]
}

/**
 * Parses an asset manifest atomically, then checks it against its kind.
 *
 * Structural errors come from Zod; ontology errors (wrong origin, missing
 * required socket, generator that does not match the kind) are added afterwards
 * so their paths point at the offending concept rather than at the union type.
 */
export function parseAsset(raw: unknown): ParseResult<AssetDoc> {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: [{ path: '', code: 'invalid_type', message: 'asset manifest must be an object' }] }
  }

  const version = (raw as { version?: unknown }).version
  if (version !== ASSET_VERSION) {
    return {
      ok: false,
      errors: [
        {
          path: 'version',
          code: 'unsupported_version',
          message: `asset version ${JSON.stringify(version)} is not supported; engine expects ${ASSET_VERSION}`,
        },
      ],
    }
  }

  const kind = (raw as { kind?: unknown }).kind
  if (typeof kind !== 'string' || !(KINDS as readonly string[]).includes(kind)) {
    return {
      ok: false,
      errors: [
        {
          path: 'kind',
          code: 'unsupported_kind',
          message: `unsupported kind ${JSON.stringify(kind)}; supported: ${KINDS.join(', ')}`,
        },
      ],
    }
  }

  const parsed = AssetDocSchema.safeParse(raw)
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.flatMap(toIssue) }
  }

  const doc = parsed.data
  const spec = KIND_SPECS[doc.kind]
  const errors: AssetIssue[] = []

  const params = spec.params.parse(doc.params)
  if (!params.ok) {
    for (const issue of params.issues.flatMap(toIssue)) {
      errors.push({ ...issue, path: issue.path ? `params.${issue.path}` : 'params' })
    }
  }

  if (doc.contract.origin !== spec.origin) {
    errors.push({
      path: 'contract.origin',
      code: 'kind_contract_mismatch',
      message: `kind '${doc.kind}' requires origin '${spec.origin}', got '${doc.contract.origin}'`,
      expected: spec.origin,
      measured: doc.contract.origin,
    })
  }

  if (doc.contract.scaleClass !== spec.scaleClass) {
    errors.push({
      path: 'contract.scaleClass',
      code: 'kind_contract_mismatch',
      message: `kind '${doc.kind}' requires scaleClass '${spec.scaleClass}', got '${doc.contract.scaleClass}'`,
      expected: spec.scaleClass,
      measured: doc.contract.scaleClass,
    })
  }

  for (const socket of spec.requiredSockets) {
    if (!(socket in doc.contract.sockets)) {
      errors.push({
        path: `contract.sockets.${socket}`,
        code: 'missing_socket',
        message: `kind '${doc.kind}' requires socket '${socket}'`,
        expected: socket,
      })
    }
  }

  if (doc.provenance.type === 'procedural' && doc.provenance.generator !== doc.kind) {
    errors.push({
      path: 'provenance.generator',
      code: 'unknown_generator',
      message: `kind '${doc.kind}' is generated by '${doc.kind}', got '${doc.provenance.generator}'`,
      expected: doc.kind,
      measured: doc.provenance.generator,
    })
  }

  if (doc.provenance.type === 'imported' && doc.kind !== 'character') {
    errors.push({
      path: 'provenance.type',
      code: 'unsupported_provenance',
      message: `only 'character' may be imported; kind '${doc.kind}' must be procedural`,
    })
  }

  if (errors.length > 0 || !params.ok) return { ok: false, errors }

  return { ok: true, value: { ...doc, params: params.value } }
}
