import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, expectClose, expectEqual, runSuite } from '../../devtools/node-tests'
import type { NodeTestCase } from '../../devtools/node-tests'
import { buildAsset } from '../build'
import { swordGenerator } from '../generators/sword'
import { SwordParams } from '../kinds'
import { artifactHash, boundsOf, isWatertight, statsOf } from '../mesh'
import { createRng } from '../rng'
import { parseAsset } from '../schema'
import type { AssetDoc } from '../schema'

const MANIFEST_PATH = 'content/assets/sword/sword-iron-01.asset.json'

function manifestRaw(): Record<string, unknown> {
  try {
    return JSON.parse(readFileSync(resolve(MANIFEST_PATH), 'utf8')) as Record<string, unknown>
  } catch (error) {
    throw new Error(`cannot read ${MANIFEST_PATH} from ${process.cwd()}: ${(error as Error).message}`)
  }
}

function shippedDoc(): AssetDoc {
  const result = parseAsset(manifestRaw())
  if (!result.ok) throw new Error(`shipped manifest failed to parse: ${JSON.stringify(result.errors)}`)
  return result.value
}

function build(params: Partial<SwordParams> = {}) {
  return swordGenerator.build(SwordParams.parse(params), createRng(0))
}

function hashOfSeed(seed: number): string {
  const raw = { ...manifestRaw(), provenance: { ...(manifestRaw().provenance as Record<string, unknown>), seed } }
  const parsed = parseAsset(raw)
  expect(parsed.ok, `seed variant should parse: ${JSON.stringify(parsed.ok ? [] : parsed.errors)}`)
  const outcome = buildAsset(parsed.value)
  expect(outcome.ok, `seed variant should build: ${JSON.stringify(outcome.errors)}`)
  expect(outcome.report !== undefined, 'successful build should carry a report')
  return outcome.report.artifactHash
}

const cases: NodeTestCase[] = [
  {
    name: 'shipped manifest validates',
    run: () => {
      const doc = shippedDoc()
      const outcome = buildAsset(doc)
      expect(outcome.ok, `build failed: ${JSON.stringify(outcome.errors)}`)
      expect(outcome.report !== undefined, 'successful build should carry a report')
      const report = outcome.report
      expect(report.warnings.length === 0, `unexpected warnings: ${JSON.stringify(report.warnings)}`)
      return `hash=${report.artifactHash} v=${report.stats.vertices} t=${report.stats.triangles} gen=${(report.stats.generationMs ?? 0).toFixed(2)}ms`
    },
  },
  {
    name: 'declared bounds match artifact',
    run: () => {
      const doc = shippedDoc()
      const bounds = boundsOf(build().geometry)
      const axes = ['x', 'y', 'z'] as const
      for (let axis = 0; axis < 3; axis++) {
        expectClose(bounds.min[axis], doc.contract.bounds.min[axis], `min.${axes[axis]}`, 1e-6)
        expectClose(bounds.max[axis], doc.contract.bounds.max[axis], `max.${axes[axis]}`, 1e-6)
      }
      return `min=[${bounds.min.map((v) => v.toFixed(3))}] max=[${bounds.max.map((v) => v.toFixed(3))}]`
    },
  },
  {
    name: 'generator deterministic',
    run: () => {
      const first = artifactHash(build())
      const second = artifactHash(build())
      expectEqual(first, second, 'artifact hash across two builds')
      return `hash=${first}`
    },
  },
  {
    name: 'seed is not consumed',
    run: () => {
      // A manufactured object has no randomness; the seed is provenance only.
      const a = hashOfSeed(1)
      const b = hashOfSeed(999999)
      expectEqual(a, b, 'hash across different seeds')
      return `seed 1 and 999999 both ${a}`
    },
  },
  {
    name: 'params change geometry',
    run: () => {
      const broad = artifactHash(build({ bladeWidth: 'broad' }))
      const narrow = artifactHash(build({ bladeWidth: 'narrow' }))
      const noGuard = artifactHash(build({ guard: 'none' }))
      expect(broad !== narrow, 'bladeWidth did not change the artifact')
      expect(broad !== noGuard, 'guard did not change the artifact')
      return `broad=${broad} narrow=${narrow} none=${noGuard}`
    },
  },
  {
    name: 'tip socket follows length',
    run: () => {
      const tips = [0.6, 0.95, 1.4].map((length) => {
        const tip = build({ length }).sockets.tip[1]
        expectClose(tip, length - 0.1, `tip at length ${length}`, 1e-6)
        return tip.toFixed(2)
      })
      return `tipY=${tips.join(', ')}`
    },
  },
  {
    name: 'closed shell within budget',
    run: () => {
      const built = build()
      expect(isWatertight(built.geometry), 'sword is not watertight')
      const stats = statsOf(built.geometry)
      expect(stats.triangles <= 300, `${stats.triangles} triangles exceeds the declared maximum of 300`)
      return `watertight=true triangles=${stats.triangles} vertices=${stats.vertices}`
    },
  },
  {
    name: 'material follows param',
    run: () => {
      const iron = build({ material: 'iron' }).material
      const steel = build({ material: 'steel' }).material
      const bronze = build({ material: 'bronze' }).material
      expectEqual(steel.metalness, 0.9, 'steel metalness')
      expect(bronze.color !== iron.color && bronze.color !== steel.color, 'bronze colour is not distinct')
      return `iron=${iron.color} steel=${steel.color} bronze=${bronze.color}`
    },
  },
]

export function suite() {
  return runSuite('asset-sword', cases)
}
