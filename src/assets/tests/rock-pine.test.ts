import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Vec3 } from '../../core/math'
import { expect, expectClose, expectEqual, runSuite } from '../../devtools/node-tests'
import type { NodeTestCase } from '../../devtools/node-tests'
import { buildAsset } from '../build'
import { pineGenerator } from '../generators/pine'
import { rockGenerator } from '../generators/rock'
import { PineParams, RockParams } from '../kinds'
import { artifactHash, boundsOf, hasPositiveArea, isWatertight, statsOf } from '../mesh'
import { createRng } from '../rng'
import { parseAsset } from '../schema'
import type { AssetDoc } from '../schema'
import type { MeshData } from '../types'

const ROCK_MANIFEST = 'content/assets/rock/rock-granite-01.asset.json'
const PINE_MANIFEST = 'content/assets/pine/pine-nordic-01.asset.json'

function manifest(path: string): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`cannot read ${path} from ${process.cwd()}: ${(error as Error).message}`)
  }
}

function shipped(path: string): AssetDoc {
  const result = parseAsset(manifest(path))
  if (!result.ok) throw new Error(`${path} failed to parse: ${JSON.stringify(result.errors)}`)
  return result.value
}

function buildRock(params: Partial<RockParams> = {}, seed = 1181) {
  return rockGenerator.build(RockParams.parse(params), createRng(seed))
}

function buildPine(params: Partial<PineParams> = {}) {
  return pineGenerator.build(PineParams.parse(params), createRng(907))
}

function extent(mesh: MeshData, axis: 0 | 1 | 2): number {
  const bounds = boundsOf(mesh)
  return bounds.max[axis] - bounds.min[axis]
}

function boundsEqual(a: ReturnType<typeof boundsOf>, b: ReturnType<typeof boundsOf>): boolean {
  return [0, 1, 2].every((axis) => a.min[axis] === b.min[axis] && a.max[axis] === b.max[axis])
}

/** Counts triangles whose winding disagrees with "normal points away from centre". */
function inwardFaces(mesh: MeshData): number {
  const { positions, indices } = mesh
  const bounds = boundsOf(mesh)
  const center: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]

  let inward = 0
  for (let i = 0; i < indices.length; i += 3) {
    const points = [indices[i], indices[i + 1], indices[i + 2]].map(
      (index): Vec3 => [positions[index * 3], positions[index * 3 + 1], positions[index * 3 + 2]],
    )
    const [a, b, c] = points
    const u: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const v: Vec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]]
    const normal: Vec3 = [
      u[1] * v[2] - u[2] * v[1],
      u[2] * v[0] - u[0] * v[2],
      u[0] * v[1] - u[1] * v[0],
    ]
    const centroid: Vec3 = [(a[0] + b[0] + c[0]) / 3, (a[1] + b[1] + c[1]) / 3, (a[2] + b[2] + c[2]) / 3]
    const away: Vec3 = [centroid[0] - center[0], centroid[1] - center[1], centroid[2] - center[2]]
    if (normal[0] * away[0] + normal[1] * away[1] + normal[2] * away[2] <= 0) inward += 1
  }
  return inward
}

const cases: NodeTestCase[] = [
  {
    name: 'shipped rock validates',
    run: () => {
      const doc = shipped(ROCK_MANIFEST)
      const outcome = buildAsset(doc)
      expect(outcome.ok, `rock failed: ${JSON.stringify(outcome.errors)}`)
      expect(outcome.artifact !== undefined && outcome.report !== undefined, 'rock should build')
      const stats = statsOf(outcome.artifact.geometry)
      expect(outcome.artifact.geometry.colors !== undefined, 'rock should carry vertex colours for moss')
      return `hash=${outcome.report.artifactHash} t=${stats.triangles} coloured=true`
    },
  },
  {
    name: 'rock is a closed outward shell',
    run: () => {
      const asset = buildRock()
      expect(isWatertight(asset.geometry), 'rock mesh is not closed')
      expect(hasPositiveArea(asset.geometry), 'rock has a degenerate triangle')
      expectEqual(inwardFaces(asset.geometry), 0, 'inward-facing triangles')
      return `watertight=true inward=0 t=${statsOf(asset.geometry).triangles}`
    },
  },
  {
    name: 'rock seed changes the shape',
    run: () => {
      const a = artifactHash(buildRock({}, 1))
      const b = artifactHash(buildRock({}, 2))
      const repeat = artifactHash(buildRock({}, 1))
      expect(a !== b, 'two seeds produced the same rock')
      expectEqual(repeat, a, 'same seed must be reproducible')
      return `${a} != ${b}, repeat matched`
    },
  },
  {
    name: 'moss only changes colour',
    run: () => {
      const bare = buildRock({ moss: 0 })
      const mossy = buildRock({ moss: 0.9 })
      expect(boundsEqual(boundsOf(bare.geometry), boundsOf(mossy.geometry)), 'moss moved a vertex')
      expect(artifactHash(bare) !== artifactHash(mossy), 'moss did not change the artifact hash')
      return 'same bounds, different hash'
    },
  },
  {
    name: 'rock base sits on the ground',
    run: () => {
      const heights = (['small', 'medium', 'boulder'] as const).map((size) => {
        const bounds = boundsOf(buildRock({ size }).geometry)
        expectClose(bounds.min[1], 0, `${size} min y`, 1e-6)
        return `${size}=${bounds.max[1].toFixed(3)}m`
      })
      return heights.join(' ')
    },
  },
  {
    name: 'detail controls triangle count',
    run: () => {
      const counts = [0, 1, 2, 3].map((detail) => statsOf(buildRock({ detail }).geometry).triangles)
      expectEqual(counts.join(','), '20,80,320,1280', 'detail -> triangles')
      return counts.join(' -> ')
    },
  },
  {
    name: 'shipped pine validates',
    run: () => {
      const outcome = buildAsset(shipped(PINE_MANIFEST))
      expect(outcome.ok, `pine failed: ${JSON.stringify(outcome.errors)}`)
      expect(outcome.artifact !== undefined && outcome.report !== undefined, 'pine should build')
      const stats = statsOf(outcome.artifact.geometry)
      return `hash=${outcome.report.artifactHash} t=${stats.triangles}`
    },
  },
  {
    name: 'pine apex lands on the requested height',
    run: () => {
      const measured = ([4, 8, 15] as const).map((height) => {
        const bounds = boundsOf(buildPine({ height }).geometry)
        expectClose(bounds.max[1], height, `${height} m apex`, 1e-4)
        expectClose(bounds.min[1], 0, `${height} m base`, 1e-4)
        return `${height}->${bounds.max[1].toFixed(3)}`
      })
      return measured.join(' ')
    },
  },
  {
    name: 'pine is closed and carries the base socket',
    run: () => {
      const asset = buildPine()
      expect(isWatertight(asset.geometry), 'pine mesh is not closed')
      expect(hasPositiveArea(asset.geometry), 'pine has a degenerate triangle')
      expectEqual(asset.sockets.base?.join(','), '0,0,0', 'base socket')
      return `watertight=true sockets=${Object.keys(asset.sockets).join(',')}`
    },
  },
  {
    name: 'snow adds a cap band without moving the tree',
    run: () => {
      const plain = buildPine({ snow: false })
      const snowy = buildPine({ snow: true })
      expect(boundsEqual(boundsOf(plain.geometry), boundsOf(snowy.geometry)), 'snow changed the bounds')
      expect(statsOf(snowy.geometry).triangles > statsOf(plain.geometry).triangles, 'snow added no geometry')
      expect(artifactHash(plain) !== artifactHash(snowy), 'snow did not change the hash')
      return `t ${statsOf(plain.geometry).triangles} -> ${statsOf(snowy.geometry).triangles}`
    },
  },
  {
    name: 'spread and tiers are visible in the mesh',
    run: () => {
      const narrow = extent(buildPine({ spread: 'narrow' }).geometry, 0)
      const wide = extent(buildPine({ spread: 'wide' }).geometry, 0)
      const few = statsOf(buildPine({ tiers: 3 }).geometry).triangles
      const many = statsOf(buildPine({ tiers: 8 }).geometry).triangles
      expect(wide > narrow * 1.3, `wide ${wide} should exceed narrow ${narrow} by more than 30%`)
      expect(many > few, `more tiers should add geometry: ${few} vs ${many}`)
      return `width ${narrow.toFixed(2)} -> ${wide.toFixed(2)} m, tiers ${few} -> ${many} tri`
    },
  },
]

export function suite() {
  return runSuite('asset-rock-pine', cases)
}
