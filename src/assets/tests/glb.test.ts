import { expect, expectClose, expectEqual, runSuite } from '../../devtools/node-tests'
import type { NodeTestCase } from '../../devtools/node-tests'
import type { AssetIssue, ParseResult } from '../types'
import { TRIANGLES, nodeSlug, readCharacter, readGlbIndex } from '../import/glb'
import type { GlbIndex } from '../import/glb'
import { BIN_PAD, CHUNK_BIN, CHUNK_JSON, JSON_PAD, container, glb, jsonChunk, pad4, patched } from './glb-fixture'

/**
 * One head mesh and both hands, all named. Blender's `Hand.L` spelling is used
 * on purpose: the importer normalises it to the socket grammar.
 */
function fixture(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    asset: { version: '2.0', generator: 'fixture' },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [
      { name: 'root', children: [1, 2, 3] },
      { name: 'Head', mesh: 0, translation: [0, 1.5, 0] },
      { name: 'Hand.L', translation: [-0.2, 1, 0] },
      { name: 'Hand.R', translation: [0.2, 1, 0] },
    ],
    meshes: [{ name: 'head_mesh', primitives: [{ attributes: { POSITION: 0 }, mode: TRIANGLES }] }],
    accessors: [{ type: 'VEC3', count: 3, min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] }],
    ...overrides,
  }
}

function indexOf(bytes: Uint8Array): GlbIndex {
  const result = readGlbIndex(bytes)
  if (!result.ok) throw new Error(`fixture failed to index: ${JSON.stringify(result.errors)}`)
  return result.value
}

function expectIssue(result: ParseResult<unknown>, path: string, code?: string): AssetIssue {
  expect(!result.ok, `expected a failure at '${path}', but it indexed cleanly`)
  const match = result.errors.find((issue) => issue.path === path)
  expect(
    match !== undefined,
    `no issue at '${path}'; got ${result.errors.map((issue) => `${issue.path}(${issue.code})`).join(', ')}`,
  )
  if (code !== undefined) expectEqual(match.code, code, `code at '${path}'`)
  return match
}

function boundsOf(index: GlbIndex) {
  const bounds = index.bounds
  expect(bounds !== null, 'expected world bounds')
  return bounds
}

export function suite() {
  const cases: NodeTestCase[] = [
    {
      name: 'indexes a valid character',
      run: () => {
        const index = indexOf(glb(fixture()))
        expectEqual(index.asset.version, '2.0', 'asset version')
        expectEqual(index.nodes.length, 4, 'nodes')
        expectEqual(index.meshes.length, 1, 'meshes')
        expectEqual(index.triangles, 1, 'triangles')
        expectEqual(index.binBytes, null, 'bin')
        const bounds = boundsOf(index)
        expectClose(bounds.min[1], 1.4, 'bounds min y')
        expectClose(bounds.max[1], 1.6, 'bounds max y')
        return '4 nodes, 1 mesh, 1 tri'
      },
    },
    {
      name: 'normalises socket names',
      run: () => {
        const index = indexOf(glb(fixture()))
        expectEqual(Object.keys(index.named).join(','), 'hand_l,hand_r,head,root', 'named keys')
        expectClose(index.named.hand_l[0], -0.2, 'hand_l x')
        expectClose(index.named.hand_r[0], 0.2, 'hand_r x')
        expectClose(index.named.head[1], 1.5, 'head y')
        return 'Hand.L -> hand_l'
      },
    },
    {
      name: 'applies nested node transforms',
      run: () => {
        const index = indexOf(
          glb(
            fixture({
              nodes: [
                { name: 'root', children: [1], translation: [0, 2, 0] },
                { name: 'Head', mesh: 0, translation: [0, 0.5, 0] },
              ],
            }),
          ),
        )
        expectClose(index.nodes[1].position[1], 2.5, 'world y')
        expectClose(boundsOf(index).min[1], 2.4, 'bounds min y')
        return 'child world y=2.5'
      },
    },
    {
      name: 'applies a matrix transform',
      run: () => {
        const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 3, 0, 0, 1]
        const index = indexOf(glb(fixture({ nodes: [{ name: 'Head', mesh: 0, matrix }] })))
        const bounds = boundsOf(index)
        expectClose(bounds.min[0], 2.9, 'bounds min x')
        expectClose(bounds.max[0], 3.1, 'bounds max x')
        return 'translated by matrix'
      },
    },
    {
      name: 'applies a quaternion rotation',
      run: () => {
        const index = indexOf(
          glb(
            fixture({
              nodes: [{ name: 'Head', mesh: 0, rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2] }],
              accessors: [{ type: 'VEC3', count: 3, min: [0, 0, 0], max: [2, 1, 0] }],
            }),
          ),
        )
        const bounds = boundsOf(index)
        expectClose(bounds.min[0], -1, 'bounds min x')
        expectClose(bounds.max[0], 0, 'bounds max x')
        expectClose(bounds.max[1], 2, 'bounds max y')
        return '+90 deg about Z rotates the AABB'
      },
    },
    {
      name: 'indexes skins and animations',
      run: () => {
        const index = indexOf(
          glb(
            fixture({
              accessors: [
                { type: 'VEC3', count: 3, min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] },
                { type: 'SCALAR', count: 2, min: [0], max: [0.5] },
              ],
              skins: [{ name: 'rig', joints: [0, 1] }],
              animations: [
                {
                  name: 'idle',
                  channels: [{ sampler: 0 }],
                  samplers: [{ input: 1, output: 1 }],
                },
              ],
            }),
          ),
        )
        expectEqual(index.skins[0].joints, 2, 'joints')
        expectEqual(index.animations[0].name, 'idle', 'animation name')
        expectClose(index.animations[0].duration, 0.5, 'duration')
        return 'rig with 2 joints, 0.5 s clip'
      },
    },
    {
      name: 'rejects bad magic',
      run: () => {
        const bytes = glb(fixture())
        bytes[0] = 0
        const issue = expectIssue(readGlbIndex(bytes), '', 'glb_magic')
        expectEqual(issue.measured, '0x46546c00', 'measured magic')
        return 'magic 0x46546c00 reported'
      },
    },
    {
      name: 'rejects unsupported container version',
      run: () => {
        expectIssue(readGlbIndex(patched(glb(fixture()), 4, 1)), '', 'glb_version')
        return 'container version 1 rejected'
      },
    },
    {
      name: 'rejects a length mismatch',
      run: () => {
        const bytes = glb(fixture())
        expectIssue(readGlbIndex(patched(bytes, 8, bytes.length + 4)), '', 'glb_length_mismatch')
        return 'declared length checked against file'
      },
    },
    {
      name: 'rejects a truncated header',
      run: () => {
        expectIssue(readGlbIndex(new Uint8Array(8)), '', 'glb_truncated')
        return '8-byte file rejected'
      },
    },
    {
      name: 'rejects an overrunning chunk',
      run: () => {
        const bytes = glb(fixture())
        const jsonLength = new DataView(bytes.buffer).getUint32(12, true)
        expectIssue(readGlbIndex(patched(bytes, 12, jsonLength + 1000)), 'chunks[0]', 'glb_chunk_truncated')
        return 'chunk length bounded by file'
      },
    },
    {
      name: 'rejects a misaligned chunk',
      run: () => {
        const bytes = container([jsonChunk(fixture()), { type: CHUNK_BIN, data: new Uint8Array(3) }])
        expectIssue(readGlbIndex(bytes), 'chunks[1]', 'glb_chunk_alignment')
        return '3-byte chunk rejected'
      },
    },
    {
      name: 'rejects invalid json',
      run: () => {
        const bytes = container([{ type: CHUNK_JSON, data: pad4(new TextEncoder().encode('{'), JSON_PAD) }])
        expectIssue(readGlbIndex(bytes), '', 'glb_json_invalid')
        return 'parse error surfaced'
      },
    },
    {
      name: 'rejects a bin-first container',
      run: () => {
        const bytes = container([{ type: CHUNK_BIN, data: pad4(new Uint8Array(4), BIN_PAD) }, jsonChunk(fixture())])
        expectIssue(readGlbIndex(bytes), 'chunks[1]', 'glb_json_chunk_first')
        return 'JSON chunk must lead'
      },
    },
    {
      name: 'rejects a missing json chunk',
      run: () => {
        const bytes = container([{ type: CHUNK_BIN, data: pad4(new Uint8Array(4), BIN_PAD) }])
        expectIssue(readGlbIndex(bytes), '', 'glb_json_chunk_missing')
        return 'BIN-only container rejected'
      },
    },
    {
      name: 'rejects gltf 1.0',
      run: () => {
        const bytes = glb(fixture({ asset: { version: '1.0' } }))
        expectIssue(readGlbIndex(bytes), 'asset.version', 'unsupported_gltf_version')
        return 'glTF 1.0 rejected'
      },
    },
    {
      name: 'rejects a file with no meshes',
      run: () => {
        expectIssue(readGlbIndex(glb(fixture({ meshes: [] }))), 'meshes', 'no_meshes')
        return 'empty meshes rejected'
      },
    },
    {
      name: 'rejects a file with no nodes',
      run: () => {
        expectIssue(readGlbIndex(glb(fixture({ nodes: [] }))), 'nodes', 'no_nodes')
        return 'empty nodes rejected'
      },
    },
    {
      name: 'rejects non-triangle primitives',
      run: () => {
        const bytes = glb(
          fixture({
            meshes: [{ primitives: [{ attributes: { POSITION: 0 }, mode: 5 }] }],
          }),
        )
        expectIssue(readGlbIndex(bytes), 'meshes[0].primitives[0].mode', 'unsupported_primitive_mode')
        return 'triangle strip rejected'
      },
    },
    {
      name: 'rejects incomplete triangle data',
      run: () => {
        const bytes = glb(
          fixture({
            accessors: [{ type: 'VEC3', count: 4, min: [-0.1, -0.1, -0.1], max: [0.1, 0.1, 0.1] }],
          }),
        )
        expectIssue(readGlbIndex(bytes), 'meshes[0].primitives[0]', 'primitive_not_triangles')
        return '4 vertices rejected'
      },
    },
    {
      name: 'rejects missing accessor bounds',
      run: () => {
        const bytes = glb(
          fixture({
            accessors: [{ type: 'VEC3', count: 3 }],
          }),
        )
        expectIssue(
          readGlbIndex(bytes),
          'meshes[0].primitives[0].attributes.POSITION',
          'accessor_bounds_missing',
        )
        return 'min/max required without a buffer decode'
      },
    },
    {
      name: 'rejects a dangling accessor',
      run: () => {
        const bytes = glb(
          fixture({
            meshes: [{ primitives: [{ attributes: { POSITION: 9 }, mode: TRIANGLES }] }],
          }),
        )
        expectIssue(
          readGlbIndex(bytes),
          'meshes[0].primitives[0].attributes.POSITION',
          'accessor_out_of_range',
        )
        return 'POSITION 9 of 1 rejected'
      },
    },
    {
      name: 'rejects a non-vec3 position accessor',
      run: () => {
        const bytes = glb(
          fixture({
            accessors: [{ type: 'VEC2', count: 3, min: [0, 0], max: [1, 1] }],
          }),
        )
        expectIssue(
          readGlbIndex(bytes),
          'meshes[0].primitives[0].attributes.POSITION',
          'position_not_vec3',
        )
        return 'VEC2 rejected'
      },
    },
    {
      name: 'rejects a dangling mesh reference',
      run: () => {
        expectIssue(
          readGlbIndex(glb(fixture({ nodes: [{ name: 'Head', mesh: 4 }] }))),
          'nodes[0].mesh',
          'node_mesh_out_of_range',
        )
        return 'mesh 4 of 1 rejected'
      },
    },
    {
      name: 'rejects a node cycle',
      run: () => {
        const bytes = glb(
          fixture({
            nodes: [
              { name: 'a', children: [1] },
              { name: 'b', children: [0] },
            ],
          }),
        )
        expectIssue(readGlbIndex(bytes), 'nodes[0]', 'node_cycle')
        return 'cycle reported'
      },
    },
    {
      name: 'rejects two parents for one node',
      run: () => {
        const bytes = glb(
          fixture({
            nodes: [
              { name: 'a', children: [2] },
              { name: 'b', children: [2] },
              { name: 'Head', mesh: 0 },
            ],
          }),
        )
        expectIssue(readGlbIndex(bytes), 'nodes[1].children', 'node_multiple_parents')
        return 'second parent rejected'
      },
    },
    {
      name: 'rejects an out-of-range scene',
      run: () => {
        expectIssue(readGlbIndex(glb(fixture({ scene: 3 }))), 'scene', 'scene_out_of_range')
        return 'scene 3 of 1 rejected'
      },
    },
    {
      name: 'reads required character sockets',
      run: () => {
        const reading = readCharacter(indexOf(glb(fixture())))
        expect(reading.ok, 'expected a usable character')
        expectEqual(Object.keys(reading.value.sockets).join(','), 'head,hand_l,hand_r', 'socket order')
        expectClose(reading.value.sockets.hand_l[0], -0.2, 'hand_l x')
        expectClose(reading.value.bounds.min[1], 1.4, 'bounds min y')
        return '3 sockets, bounds attached'
      },
    },
    {
      name: 'reports missing character sockets',
      run: () => {
        const bytes = glb(fixture({ nodes: [{ name: 'root', children: [1] }, { name: 'Head', mesh: 0 }] }))
        const reading = readCharacter(indexOf(bytes))
        expectIssue(reading, 'contract.sockets.hand_l', 'missing_socket')
        expectIssue(reading, 'contract.sockets.hand_r', 'missing_socket')
        expect(!reading.ok, 'expected a failure')
        expect(
          !reading.errors.some((issue) => issue.path === 'contract.sockets.head'),
          'head is present and must not be reported',
        )
        return 'hands reported, head accepted'
      },
    },
    {
      name: 'reports ambiguous socket names',
      run: () => {
        const bytes = glb(
          fixture({
            nodes: [
              { name: 'root', children: [1, 2, 3, 4] },
              { name: 'Head', mesh: 0 },
              { name: 'Hand.L', translation: [-0.2, 1, 0] },
              { name: 'Hand.R', translation: [0.2, 1, 0] },
              { name: 'hand_l', translation: [-0.3, 1, 0] },
            ],
          }),
        )
        const index = indexOf(bytes)
        expectEqual(index.duplicateSlugs.join(','), 'hand_l', 'duplicates')
        expectIssue(readCharacter(index), 'contract.sockets.hand_l', 'ambiguous_socket')
        return 'duplicate hand_l rejected'
      },
    },
    {
      name: 'reports a character without geometry',
      run: () => {
        const bytes = glb(fixture({ nodes: [{ name: 'root' }] }))
        const reading = readCharacter(indexOf(bytes))
        expectIssue(reading, '', 'no_drawable_geometry')
        return 'mesh not referenced by any node'
      },
    },
    {
      name: 'slug grammar is stable',
      run: () => {
        expectEqual(nodeSlug('Hand.L', 0), 'hand_l', 'Hand.L')
        expectEqual(nodeSlug('Left Hand', 0), 'left_hand', 'Left Hand')
        expectEqual(nodeSlug('', 7), 'node_7', 'unnamed')
        expectEqual(nodeSlug('3d_model', 0), 'node_3d_model', 'digit prefix')
        return 'Hand.L, Left Hand, unnamed, digit prefix'
      },
    },
  ]

  return runSuite('GLB import', cases)
}
