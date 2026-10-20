import { z } from 'zod'
import { GameConfigSchema } from '../game/schema'

export const SCENE_VERSION = 1
export const NODE_TYPES = ['group', 'mesh', 'light', 'camera'] as const
export const MAX_DEPTH = 16

const Id = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*$/, 'id must be a lowercase slug matching ^[a-z][a-z0-9_-]*$')

const Vec3 = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()])
const PositiveVec3 = z.tuple([z.number().positive(), z.number().positive(), z.number().positive()])
const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'expected a #rrggbb hex colour')

const Transform = z.strictObject({
  pos: Vec3.default([0, 0, 0]),
  /** Degrees, R = Rx * Ry * Rz. See core/math.ts composeMatrix. */
  rot: Vec3.default([0, 0, 0]),
  scale: PositiveVec3.default([1, 1, 1]),
})

const base = {
  id: Id,
  parent: Id.optional(),
  transform: Transform.prefault({}),
  visible: z.boolean().default(true),
}

const Geometry = z.discriminatedUnion('shape', [
  z.strictObject({ shape: z.literal('box'), size: PositiveVec3 }),
  z.strictObject({ shape: z.literal('plane'), size: z.tuple([z.number().positive(), z.number().positive()]) }),
  z.strictObject({
    shape: z.literal('sphere'),
    radius: z.number().positive(),
    segments: z.number().int().min(3).default(24),
  }),
  z.strictObject({ shape: z.literal('capsule'), radius: z.number().positive(), height: z.number().positive() }),
])

const Material = z
  .strictObject({
    color: Hex.default('#cccccc'),
    roughness: z.number().min(0).max(1).default(0.85),
    metalness: z.number().min(0).max(1).default(0),
  })
  .prefault({})

const Collider = z
  .discriminatedUnion('shape', [
    /** size = FULL extent in local space. Omit to derive from geometry bounds. */
    z.strictObject({ shape: z.literal('aabb'), size: PositiveVec3.optional() }),
    z.strictObject({ shape: z.literal('none') }),
  ])
  .default({ shape: 'none' })

const Group = z.strictObject({ ...base, type: z.literal('group') })

const Mesh = z.strictObject({
  ...base,
  type: z.literal('mesh'),
  geometry: Geometry,
  material: Material,
  collider: Collider,
})

const LightNode = z
  .strictObject({
    ...base,
    type: z.literal('light'),
    kind: z.enum(['ambient', 'directional']),
    color: Hex.default('#ffffff'),
    intensity: z.number().min(0).default(1),
    /** Required for directional, forbidden for ambient. Validated below. */
    dir: Vec3.optional(),
    castShadow: z.boolean().default(false),
  })
  .superRefine((light, ctx) => {
    if (light.kind === 'directional' && !light.dir) {
      ctx.addIssue({ code: 'custom', path: ['dir'], message: "kind 'directional' requires 'dir'" })
    }
    if (light.kind === 'ambient' && light.dir) {
      ctx.addIssue({ code: 'custom', path: ['dir'], message: "kind 'ambient' must not set 'dir'" })
    }
  })

const Orbit = z
  .strictObject({
    target: Vec3.default([0, 1, 0]),
    distance: z.number().positive().default(8),
    yaw: z.number().default(35),
    pitch: z.number().min(-89).max(89).default(20),
  })
  .prefault({})

const ThirdPerson = z
  .strictObject({
    distance: z.number().positive().default(4),
    height: z.number().positive().default(1.8),
    lookHeight: z.number().positive().default(1.2),
  })
  .prefault({})

const CameraNode = z.strictObject({
  ...base,
  type: z.literal('camera'),
  rig: z.enum(['orbit', 'third-person']),
  fov: z.number().min(10).max(120).default(50),
  near: z.number().positive().default(0.1),
  far: z.number().positive().default(200),
  orbit: Orbit,
  thirdPerson: ThirdPerson,
})

const Node = z.discriminatedUnion('type', [Group, Mesh, LightNode, CameraNode])

const Player = z
  .strictObject({
    /** FEET position, metres. */
    spawn: Vec3.default([0, 3, 0]),
    radius: z.number().positive().default(0.35),
    height: z.number().positive().default(1.7),
    speed: z.number().positive().default(4.5),
    jumpSpeed: z.number().positive().default(6),
    /** m/s^2. Game-feel gravity, deliberately not 9.81. */
    gravity: z.number().negative().default(-20),
  })
  .prefault({})

const SceneDoc = z
  .strictObject({
    version: z.literal(SCENE_VERSION),
    id: Id,
    units: z.literal('m').default('m'),
    up: z.literal('+Y').default('+Y'),
    forward: z.literal('+Z').default('+Z'),
    environment: z.strictObject({ background: Hex.default('#0b1020') }).prefault({}),
    player: Player,
    /** Optional game rules. The scene stays a renderable scene without it. */
    game: GameConfigSchema.optional(),
    nodes: z.array(Node).min(1),
  })
  .superRefine(validateGraph)

export type SceneDoc = z.infer<typeof SceneDoc>
export type SceneNode = z.infer<typeof Node>
export type MeshNode = z.infer<typeof Mesh>
export type LightNode = z.infer<typeof LightNode>
export type CameraNode = z.infer<typeof CameraNode>
export type PlayerConfig = z.infer<typeof Player>
export type ColliderConfig = z.infer<typeof Collider>
export type GeometryConfig = z.infer<typeof Geometry>

export interface SceneIssue {
  path: string
  code: string
  message: string
}

export type SceneParseResult =
  | { ok: true; doc: SceneDoc }
  | { ok: false; errors: SceneIssue[] }

function formatPath(path: readonly PropertyKey[]): string {
  let out = ''
  for (const segment of path) {
    if (typeof segment === 'number') out += `[${segment}]`
    else out += out ? `.${String(segment)}` : String(segment)
  }
  return out
}

function toIssue(issue: z.core.$ZodIssue): SceneIssue[] {
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

function validateGraph(doc: Omit<SceneDoc, never>, ctx: z.RefinementCtx): void {
  const seen = new Set<string>()
  doc.nodes.forEach((node, index) => {
    if (seen.has(node.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodes', index, 'id'],
        message: `duplicate id '${node.id}'`,
      })
    }
    seen.add(node.id)
  })

  const byId = new Map(doc.nodes.map((node, index) => [node.id, { node, index }] as const))

  doc.nodes.forEach((node, index) => {
    const parent = node.parent
    if (parent === undefined) return
    if (parent === node.id) {
      ctx.addIssue({ code: 'custom', path: ['nodes', index, 'parent'], message: 'node cannot parent itself' })
      return
    }
    if (!byId.has(parent)) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodes', index, 'parent'],
        message: `parent '${parent}' does not exist`,
      })
      return
    }
    // Walk up; a repeat means a cycle.
    const walked = new Set<string>([node.id])
    let cursor: string | undefined = parent
    let depth = 0
    while (cursor !== undefined) {
      if (walked.has(cursor)) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'parent'],
          message: `parent chain contains a cycle at '${cursor}'`,
        })
        return
      }
      walked.add(cursor)
      depth += 1
      if (depth > MAX_DEPTH) {
        ctx.addIssue({
          code: 'custom',
          path: ['nodes', index, 'parent'],
          message: `parent chain deeper than ${MAX_DEPTH} levels`,
        })
        return
      }
      cursor = byId.get(cursor)?.node.parent
    }
  })

  doc.nodes.forEach((node, index) => {
    if (node.type !== 'mesh') return

    if (node.geometry.shape === 'capsule' && node.geometry.height <= node.geometry.radius * 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['nodes', index, 'geometry', 'height'],
        message: `capsule height (${node.geometry.height}) must exceed 2 * radius (${node.geometry.radius * 2})`,
      })
    }

    if (node.collider.shape === 'aabb' && node.collider.size === undefined && node.geometry.shape === 'plane') {
      ctx.addIssue({
        code: 'custom',
        path: ['nodes', index, 'collider', 'size'],
        message: 'plane geometry has zero thickness and cannot derive a collider; set collider.size [width, thickness, depth]',
      })
    }
  })

  const cameras = doc.nodes.filter((node) => node.type === 'camera')
  if (cameras.length !== 1) {
    ctx.addIssue({
      code: 'custom',
      path: ['nodes'],
      message: `scene must contain exactly one 'camera' node, found ${cameras.length}`,
    })
  }
}

/**
 * Parses a scene document atomically. Never partially applies: either a fully
 * validated SceneDoc comes back, or a list of issues with exact paths.
 */
export function parseScene(raw: unknown): SceneParseResult {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: [{ path: '', code: 'invalid_type', message: 'scene must be an object' }] }
  }

  const version = (raw as { version?: unknown }).version
  if (version !== SCENE_VERSION) {
    return {
      ok: false,
      errors: [
        {
          path: 'version',
          code: 'unsupported_version',
          message: `scene version ${JSON.stringify(version)} is not supported; engine expects ${SCENE_VERSION}`,
        },
      ],
    }
  }

  const nodesRaw = (raw as { nodes?: unknown }).nodes
  if (Array.isArray(nodesRaw)) {
    for (let i = 0; i < nodesRaw.length; i++) {
      const type = (nodesRaw[i] as { type?: unknown } | null)?.type
      if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) {
        return {
          ok: false,
          errors: [
            {
              path: `nodes[${i}].type`,
              code: 'unsupported_node_type',
              message: `unsupported node type ${JSON.stringify(type)}; supported: ${NODE_TYPES.join(', ')}`,
            },
          ],
        }
      }
    }
  }

  const result = SceneDoc.safeParse(raw)
  if (!result.success) {
    return { ok: false, errors: result.error.issues.flatMap(toIssue) }
  }
  return { ok: true, doc: result.data }
}
