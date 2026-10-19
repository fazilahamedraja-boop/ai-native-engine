import { expect, expectClose, expectEqual, runSuite } from '../../devtools/node-tests'
import type { NodeTestCase } from '../../devtools/node-tests'
import { buildAsset } from '../build'
import { artifactHash } from '../mesh'
import { createRng } from '../rng'
import { parseAsset } from '../schema'
import type { AssetDoc } from '../schema'
import type { AssetIssue, BuiltAsset, MeshData } from '../types'
import { validateArtifact } from '../validate'

const CONTRACT = {
  origin: 'grip',
  scaleClass: 'handheld',
  bounds: { min: [-0.11, -0.09, -0.02], max: [0.11, 0.95, 0.02] },
  sockets: { grip: [0, 0, 0], tip: [0, 0.95, 0], blade_mid: [0, 0.55, 0] },
}

function swordRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'sword-iron-01',
    kind: 'sword',
    provenance: { type: 'procedural', generator: 'sword', generatorVersion: 1, seed: 4821 },
    params: {},
    contract: CONTRACT,
    tests: [],
    override: {},
    ...overrides,
  }
}

function parsed(overrides: Record<string, unknown> = {}): AssetDoc {
  const result = parseAsset(swordRaw(overrides))
  if (!result.ok) throw new Error(`fixture failed to parse: ${JSON.stringify(result.errors)}`)
  return result.value
}

/**
 * Characters are imported, never generated, so this manifest can never become
 * buildable — it is a stable way to exercise the unknown-generator path.
 */
function characterRaw(): Record<string, unknown> {
  return {
    version: 1,
    id: 'character-kael',
    kind: 'character',
    provenance: { type: 'procedural', generator: 'character', generatorVersion: 1, seed: 1 },
    params: {},
    contract: {
      origin: 'feet-center',
      scaleClass: 'character',
      bounds: { min: [-0.4, 0, -0.25], max: [0.4, 1.8, 0.25] },
      sockets: { head: [0, 1.7, 0], hand_l: [-0.35, 1.1, 0], hand_r: [0.35, 1.1, 0] },
    },
    tests: [],
    override: {},
  }
}

/** Anything that either failed with issues, or succeeded and has none to show. */
type IssueCarrier = { ok: boolean; errors: AssetIssue[] } | { ok: true }

function expectIssue(result: IssueCarrier, path: string, code?: string): AssetIssue {
  expect(!result.ok, `expected a failure at '${path}', but it parsed cleanly`)
  const match = result.errors.find((issue) => issue.path === path)
  expect(match !== undefined, `no issue at '${path}'; got ${result.errors.map((i) => `${i.path}(${i.code})`).join(', ')}`)
  if (code !== undefined) {
    expectEqual(match.code, code, `code at '${path}'`)
  }
  return match
}

/**
 * Closed 2 m cube centred on the origin, winding consistent, normals outward.
 * Used only to exercise the validator; it is not a registered generator.
 */
function fixtureCube(): MeshData {
  const positions = new Float32Array([
    -1, -1, -1, 1, -1, -1, 1, 1, -1, -1, 1, -1, -1, -1, 1, 1, -1, 1, 1, 1, 1, -1, 1, 1,
  ])
  const indices = new Uint32Array([
    4, 5, 6, 4, 6, 7, // +z
    1, 0, 3, 1, 3, 2, // -z
    0, 4, 7, 0, 7, 3, // -x
    5, 1, 2, 5, 2, 6, // +x
    3, 7, 6, 3, 6, 2, // +y
    0, 1, 5, 0, 5, 4, // -y
  ])

  const normals = new Float32Array(positions.length)
  for (let i = 0; i < positions.length; i += 3) {
    const len = Math.hypot(positions[i], positions[i + 1], positions[i + 2])
    normals[i] = positions[i] / len
    normals[i + 1] = positions[i + 1] / len
    normals[i + 2] = positions[i + 2] / len
  }

  return { positions, normals, indices }
}

const CUBE_MATERIAL = { color: '#cccccc', roughness: 0.8, metalness: 0 }

function cubeAsset(sockets: Record<string, [number, number, number]> = { grip: [0, 0, 0], tip: [0, 1, 0] }): BuiltAsset {
  return { geometry: fixtureCube(), sockets, material: CUBE_MATERIAL }
}

const CUBE_BOUNDS = { min: [-1, -1, -1], max: [1, 1, 1] }

function cubeDoc(tests: AssetDoc['tests'] = [], sockets = { grip: [0, 0, 0] as [number, number, number], tip: [0, 1, 0] as [number, number, number] }): AssetDoc {
  return parsed({
    contract: { ...CONTRACT, bounds: CUBE_BOUNDS, sockets },
    tests,
  })
}

const cases: NodeTestCase[] = [
  {
    name: 'manifest defaults',
    run: () => {
      const doc = parsed()
      expectEqual(doc.params.length, 0.95, 'length')
      expectEqual(doc.params.bladeWidth, 'broad', 'bladeWidth')
      expectEqual(doc.params.guard, 'cross', 'guard')
      expectEqual(doc.params.material, 'iron', 'material')
      return `length=${doc.params.length} bladeWidth=${doc.params.bladeWidth} guard=${doc.params.guard}`
    },
  },
  {
    name: 'unsupported kind rejected',
    run: () => {
      const issue = expectIssue(parseAsset(swordRaw({ kind: 'crate' })), 'kind', 'unsupported_kind')
      expect(issue.message.includes('sword, rock, pine, character'), `message should list the ontology: ${issue.message}`)
      return issue.message
    },
  },
  {
    name: 'param enum rejected',
    run: () => {
      const issue = expectIssue(parseAsset(swordRaw({ params: { bladeWidth: 'wide' } })), 'params.bladeWidth')
      return issue.message
    },
  },
  {
    name: 'param range rejected',
    run: () => {
      const issue = expectIssue(parseAsset(swordRaw({ params: { length: 3 } })), 'params.length')
      return issue.message
    },
  },
  {
    name: 'unknown param rejected',
    run: () => {
      const issue = expectIssue(parseAsset(swordRaw({ params: { steel: true } })), 'params.steel', 'unknown_property')
      return issue.message
    },
  },
  {
    name: 'kind origin enforced',
    run: () => {
      const issue = expectIssue(
        parseAsset(swordRaw({ contract: { ...CONTRACT, origin: 'center' } })),
        'contract.origin',
        'kind_contract_mismatch',
      )
      return issue.message
    },
  },
  {
    name: 'required socket enforced',
    run: () => {
      const sockets = { grip: [0, 0, 0], blade_mid: [0, 0.55, 0] }
      const issue = expectIssue(
        parseAsset(swordRaw({ contract: { ...CONTRACT, sockets } })),
        'contract.sockets.tip',
        'missing_socket',
      )
      return issue.message
    },
  },
  {
    name: 'override is appearance-only',
    run: () => {
      const issue = expectIssue(
        parseAsset(swordRaw({ override: { geometry: { shape: 'box' } } })),
        'override.geometry',
        'unknown_property',
      )
      return issue.message
    },
  },
  {
    name: 'generator must match kind',
    run: () => {
      const issue = expectIssue(
        parseAsset(
          swordRaw({ provenance: { type: 'procedural', generator: 'rock', generatorVersion: 1, seed: 1 } }),
        ),
        'provenance.generator',
        'unknown_generator',
      )
      return issue.message
    },
  },
  {
    name: 'imported only for characters',
    run: () => {
      const issue = expectIssue(
        parseAsset(
          swordRaw({
            provenance: { type: 'imported', file: 'x.glb', sha256: 'a'.repeat(64), importer: 'glb', importerVersion: 1 },
          }),
        ),
        'provenance.type',
        'unsupported_provenance',
      )
      return issue.message
    },
  },
  {
    name: 'version rejected',
    run: () => {
      const issue = expectIssue(parseAsset(swordRaw({ version: 2 })), 'version', 'unsupported_version')
      return issue.message
    },
  },
  {
    name: 'inverted bounds rejected',
    run: () => {
      const issue = expectIssue(
        parseAsset(swordRaw({ contract: { ...CONTRACT, bounds: { min: [1, 0, 0], max: [0, 0, 0] } } })),
        'contract.bounds.min[0]',
      )
      return issue.message
    },
  },
  {
    name: 'rng reproducible',
    run: () => {
      const a = createRng(7)
      const b = createRng(7)
      const c = createRng(8)
      const sample = (rng: ReturnType<typeof createRng>): number[] => Array.from({ length: 8 }, () => rng.next())
      const left = sample(a)
      const right = sample(b)
      const other = sample(c)
      expect(left.every((value, i) => value === right[i]), 'same seed produced a different sequence')
      expect(left.some((value, i) => value !== other[i]), 'different seeds produced the same sequence')
      return `first=${left[0].toFixed(6)} distinctFromSeed8=${left[0] !== other[0]}`
    },
  },
  {
    name: 'artifact validates',
    run: () => {
      const report = validateArtifact(cubeDoc([{ assert: 'watertight' }, { assert: 'area-positive' }]), cubeAsset(), 1.25)
      expect(report.ok, `expected a clean report, got ${JSON.stringify(report.errors)}`)
      expectEqual(report.stats.vertices, 8, 'vertices')
      expectEqual(report.stats.triangles, 12, 'triangles')
      expectClose(report.stats.generationMs ?? 0, 1.25, 'generationMs')
      return `hash=${report.artifactHash} v=${report.stats.vertices} t=${report.stats.triangles}`
    },
  },
  {
    name: 'bounds drift caught',
    run: () => {
      const doc = parsed({ contract: { ...CONTRACT, bounds: { min: [-1, -1, -1], max: [1.01, 1, 1] } } })
      const report = validateArtifact(doc, cubeAsset())
      const issue = expectIssue(report, 'contract.bounds', 'assert_failed')
      expect(issue.measured !== undefined, 'drift issue should carry measured bounds')
      return issue.message
    },
  },
  {
    name: 'empty artifact rejected',
    run: () => {
      const empty: BuiltAsset = {
        geometry: { positions: new Float32Array(0), normals: new Float32Array(0), indices: new Uint32Array(0) },
        sockets: { grip: [0, 0, 0], tip: [0, 1, 0] },
        material: CUBE_MATERIAL,
      }
      const report = validateArtifact(cubeDoc(), empty)
      const issue = expectIssue(report, 'artifact', 'assert_failed')
      return issue.message
    },
  },
  {
    name: 'open mesh caught',
    run: () => {
      const geometry = fixtureCube()
      const open: BuiltAsset = {
        geometry: { ...geometry, indices: geometry.indices.slice(0, geometry.indices.length - 6) },
        sockets: { grip: [0, 0, 0], tip: [0, 1, 0] },
        material: CUBE_MATERIAL,
      }
      const report = validateArtifact(cubeDoc([{ assert: 'watertight' }]), open)
      const issue = expectIssue(report, 'tests[0]', 'assert_failed')
      return issue.message
    },
  },
  {
    name: 'missing socket caught',
    run: () => {
      const report = validateArtifact(cubeDoc([{ assert: 'sockets-present', value: ['grip', 'tip', 'nope'] }]), cubeAsset())
      const issue = expectIssue(report, 'tests[0]', 'assert_failed')
      return issue.message
    },
  },
  {
    name: 'origin grip enforced',
    run: () => {
      const report = validateArtifact(
        cubeDoc([{ assert: 'origin-at', value: 'grip' }]),
        cubeAsset({ grip: [0.5, 0, 0], tip: [0, 1, 0] }),
      )
      const issue = expectIssue(report, 'tests[0]', 'assert_failed')
      return issue.message
    },
  },
  {
    name: 'socket outside bounds warns',
    run: () => {
      const report = validateArtifact(cubeDoc(), cubeAsset({ grip: [0, 0, 0], tip: [0, 1, 0], stray: [5, 0, 0] }))
      expect(report.ok, 'a stray socket should warn, not fail')
      expectEqual(report.warnings.length, 1, 'warning count')
      expectEqual(report.warnings[0].path, 'contract.sockets.stray', 'warning path')
      return report.warnings[0].message
    },
  },
  {
    name: 'artifact hash tracks geometry',
    run: () => {
      const base = artifactHash(cubeAsset())
      const nudged = fixtureCube()
      nudged.positions[0] += 0.001
      const moved = artifactHash({ geometry: nudged, sockets: { grip: [0, 0, 0], tip: [0, 1, 0] }, material: CUBE_MATERIAL })
      expect(base !== moved, 'a 1 mm vertex move did not change the hash')
      expectEqual(base.length, 16, 'hash length')
      return `base=${base} moved=${moved}`
    },
  },
  {
    name: 'unregistered generator reported',
    run: () => {
      const character = parseAsset(characterRaw())
      expect(character.ok, `character fixture should parse: ${JSON.stringify(character.ok ? [] : character.errors)}`)
      const outcome = buildAsset(character.value)
      expect(!outcome.ok, 'expected build to fail without a character generator')
      expectEqual(outcome.errors[0].code, 'unknown_generator', 'code')
      return outcome.errors[0].message
    },
  },
]

export function suite() {
  return runSuite('asset-contract', cases)
}
