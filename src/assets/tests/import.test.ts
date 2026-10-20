import { expect, expectEqual, runSuite } from '../../devtools/node-tests'
import type { NodeTestCase } from '../../devtools/node-tests'
import { buildImportedAsset } from '../build'
import type { BuildOutcome, ImportedSource } from '../build'
import { artifactHash, statsOf } from '../mesh'
import { parseAsset } from '../schema'
import type { AssetIssue, BuiltAsset } from '../types'
import { fixture } from './character-fixture'
import type { Fixture, FixtureOptions } from './character-fixture'
import { glb } from './glb-fixture'

/**
 * The manifest pins a fake digest here: these cases are about the build seam,
 * not about SHA-256 itself. The CLI test path hashes the real placeholder.
 */
const HASH = 'a'.repeat(64)

const POSITIONS = [-0.25, 0, 0, 0.25, 0, 0, 0, 0.5, 0]
const NODES = [
  { name: 'Head', mesh: 0 },
  { name: 'Hand.L', translation: [-0.2, 0, 0] },
  { name: 'Hand.R', translation: [0.2, 0, 0] },
]
const BOUNDS = { min: [-0.25, 0, 0], max: [0.25, 0.5, 0] }
const SOCKETS = { head: [0, 0, 0], hand_l: [-0.2, 0, 0], hand_r: [0.2, 0, 0] }
const TESTS = [
  { assert: 'origin-at', value: 'feet-center' },
  { assert: 'sockets-present', value: ['head', 'hand_l', 'hand_r'] },
  { assert: 'max-extent', value: 1 },
  { assert: 'triangles-max', value: 10 },
  { assert: 'area-positive' },
]

interface BuildOptions {
  provenance?: Record<string, unknown>
  contract?: Record<string, unknown>
  tests?: Record<string, unknown>[]
  fixture?: FixtureOptions
  /** Extra top-level glTF keys, e.g. animations. */
  doc?: Record<string, unknown>
}

function manifest(options: BuildOptions = {}): Record<string, unknown> {
  return {
    version: 1,
    id: 'synthetic-character',
    kind: 'character',
    provenance: {
      type: 'imported',
      file: 'character/synthetic.glb',
      sha256: HASH,
      importer: 'glb',
      importerVersion: 1,
      ...options.provenance,
    },
    params: {},
    contract: {
      units: 'm',
      origin: 'feet-center',
      scaleClass: 'character',
      bounds: BOUNDS,
      sockets: SOCKETS,
      ...options.contract,
    },
    tests: options.tests ?? TESTS,
    override: {},
  }
}

function synthetic(extra: FixtureOptions = {}, docExtra: Record<string, unknown> = {}): Fixture {
  const built = fixture({
    positions: POSITIONS,
    meshNode: { name: 'Head', mesh: 0 },
    doc: { nodes: NODES },
    ...extra,
  })
  Object.assign(built.doc, docExtra)
  return built
}

function build(options: BuildOptions = {}, source: Partial<ImportedSource> = {}): BuildOutcome {
  const parsed = parseAsset(manifest(options))
  if (!parsed.ok) {
    throw new Error(`synthetic manifest did not parse: ${parsed.errors.map((issue) => issue.message).join('; ')}`)
  }
  const built = synthetic(options.fixture, options.doc)
  return buildImportedAsset(parsed.value, { bytes: glb(built.doc, built.bin), sha256: HASH, ...source })
}

function expectIssue(outcome: BuildOutcome, path: string, code: string): AssetIssue {
  expect(!outcome.ok, `expected a failure at '${path}'`)
  const issue = outcome.errors.find((candidate) => candidate.path === path && candidate.code === code)
  if (issue === undefined) {
    throw new Error(`no ${code} at '${path}'; got ${outcome.errors.map((candidate) => `${candidate.path}:${candidate.code}`).join(', ')}`)
  }
  return issue
}

const cases: NodeTestCase[] = [
  {
    name: 'builds and validates a pinned imported character',
    run: () => {
      const outcome = build()
      expect(outcome.ok, `build failed: ${outcome.errors.map((issue) => `${issue.path}:${issue.code}`).join(', ')}`)
      const artifact = outcome.artifact
      if (artifact === undefined) throw new Error('a successful build returned no artifact')
      const stats = statsOf(artifact.geometry)
      expectEqual(stats.vertices, 3, 'vertices')
      expectEqual(stats.triangles, 1, 'triangles')
      expectEqual(outcome.report?.warnings.length, 0, 'warnings')
      expectEqual(outcome.report?.artifactHash, artifactHash(artifact), 'report hash')
      return `hash=${outcome.report?.artifactHash} t=${stats.triangles}`
    },
  },
  {
    name: 'rejects a source hash mismatch',
    run: () => {
      const outcome = build({}, { sha256: 'b'.repeat(64) })
      return expectIssue(outcome, 'provenance.sha256', 'source_hash_mismatch').message
    },
  },
  {
    name: 'rejects an invalid source digest',
    run: () => {
      const outcome = build({}, { sha256: 'not-a-digest' })
      return expectIssue(outcome, 'provenance.sha256', 'invalid_source_hash').message
    },
  },
  {
    name: 'rejects a different importer version',
    run: () => {
      const outcome = build({ provenance: { importerVersion: 2 } })
      return expectIssue(outcome, 'provenance.importerVersion', 'importer_version_mismatch').message
    },
  },
  {
    name: 'imported build path rejects procedural provenance',
    run: () => {
      const parsed = parseAsset({
        ...manifest(),
        provenance: { type: 'procedural', generator: 'character', generatorVersion: 1, seed: 1 },
      })
      expect(parsed.ok, `procedural character should parse: ${parsed.ok ? '' : JSON.stringify(parsed.errors)}`)
      if (!parsed.ok) return ''
      const built = synthetic()
      const outcome = buildImportedAsset(parsed.value, { bytes: glb(built.doc, built.bin), sha256: HASH })
      return expectIssue(outcome, 'provenance.type', 'unsupported_provenance').message
    },
  },
  {
    name: 'rejects declared bounds that drifted',
    run: () => {
      const outcome = build({ contract: { bounds: { min: [-0.25, 0, 0], max: [0.3, 0.5, 0] } } })
      return expectIssue(outcome, 'contract.bounds', 'assert_failed').message
    },
  },
  {
    name: 'rejects a declared socket that moved',
    run: () => {
      const outcome = build({ contract: { sockets: { ...SOCKETS, head: [0, 0.1, 0] } } })
      return expectIssue(outcome, 'contract.sockets.head', 'socket_mismatch').message
    },
  },
  {
    name: 'rejects a declared socket the artifact lacks',
    run: () => {
      const outcome = build({ contract: { sockets: { ...SOCKETS, muzzle: [0, 0, 0] } } })
      return expectIssue(outcome, 'contract.sockets.muzzle', 'socket_missing').message
    },
  },
  {
    name: 'ignored animations warn but do not fail the build',
    run: () => {
      const outcome = build({ doc: { animations: [{ name: 'idle', channels: [], samplers: [] }] } })
      expect(outcome.ok, `build failed: ${outcome.errors.map((issue) => `${issue.path}:${issue.code}`).join(', ')}`)
      const warning = outcome.report?.warnings.find((candidate) => candidate.code === 'animations_ignored')
      expect(warning !== undefined, 'expected an animations_ignored warning')
      return warning?.message ?? ''
    },
  },
  {
    name: 'rejects a truncated GLB with a matching digest',
    run: () => {
      const parsed = parseAsset(manifest())
      if (!parsed.ok) throw new Error('synthetic manifest did not parse')
      const built = synthetic()
      const bytes = glb(built.doc, built.bin).slice(0, 8)
      const outcome = buildImportedAsset(parsed.value, { bytes, sha256: HASH })
      expect(!outcome.ok, 'expected a truncated container to fail')
      const issue = outcome.errors.find((candidate) => candidate.code === 'glb_truncated')
      expect(issue !== undefined, `no glb_truncated; got ${outcome.errors.map((candidate) => candidate.code).join(', ')}`)
      return issue?.message ?? ''
    },
  },
  {
    name: 'double-sided material is part of the artifact hash',
    run: () => {
      const geometry = {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
      }
      const base: BuiltAsset = {
        geometry,
        sockets: { head: [0, 0, 0] },
        material: { color: '#ffffff', roughness: 0.5, metalness: 0 },
      }
      const absent = artifactHash(base)
      expectEqual(artifactHash({ ...base, material: { ...base.material, doubleSided: false } }), absent, 'false matches absent')
      const twoSided = artifactHash({ ...base, material: { ...base.material, doubleSided: true } })
      expect(absent !== twoSided, 'doubleSided did not change the hash')
      return `${absent} -> ${twoSided}`
    },
  },
]

export function suite() {
  return runSuite('GLB import build', cases)
}
