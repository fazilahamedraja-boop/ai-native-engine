import { expect, expectClose, expectEqual, runSuite } from '../../devtools/node-tests'
import type { NodeTestCase } from '../../devtools/node-tests'
import { artifactHash } from '../mesh'
import { decodeGlb } from '../import/decode'
import type { DecodedImport } from '../import/decode'
import { indexGlb, readGlbContents } from '../import/glb'
import type { AssetIssue, ParseResult } from '../types'
import { glb } from './glb-fixture'

const FLOAT = 5126
const UBYTE = 5121
const USHORT = 5123
const UINT = 5125

interface Fixture {
  doc: Record<string, unknown>
  bin: Uint8Array
}

interface FixtureOptions {
  positions?: number[]
  /** `null` omits the NORMAL attribute. */
  normals?: number[] | null
  /** `null` omits the index accessor. */
  indices?: number[] | null
  indexType?: number
  meshNode?: Record<string, unknown>
  primitive?: Record<string, unknown>
  materials?: unknown[]
  material?: number
  doc?: Record<string, unknown>
}

function floats(values: readonly number[]): Uint8Array {
  const bytes = new Uint8Array(values.length * 4)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => view.setFloat32(index * 4, value, true))
  return bytes
}

function indexBytes(values: readonly number[], componentType: number): Uint8Array {
  const size = componentType === UBYTE ? 1 : componentType === USHORT ? 2 : 4
  const bytes = new Uint8Array(values.length * size)
  const view = new DataView(bytes.buffer)
  values.forEach((value, index) => {
    if (componentType === UBYTE) view.setUint8(index, value)
    else if (componentType === USHORT) view.setUint16(index * 2, value, true)
    else view.setUint32(index * 4, value, true)
  })
  return bytes
}

function minMax(values: readonly number[]): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < values.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      min[axis] = Math.min(min[axis], values[i + axis])
      max[axis] = Math.max(max[axis], values[i + axis])
    }
  }
  return { min, max }
}

/**
 * One triangle, one mesh node and both hands. The mesh node carries the
 * transform under test; the shared layout keeps every case comparable.
 */
function fixture(options: FixtureOptions = {}): Fixture {
  const positions = options.positions ?? [0, 0, 0, 1, 0, 0, 0, 1, 0]
  const normals = options.normals === undefined ? [0, 0, 1, 0, 0, 1, 0, 0, 1] : options.normals
  const indices = options.indices === undefined ? [0, 1, 2] : options.indices
  const indexType = options.indexType ?? USHORT

  const parts: Uint8Array[] = []
  let binLength = 0
  const add = (bytes: Uint8Array): number => {
    const offset = binLength
    parts.push(bytes)
    binLength += bytes.length
    return offset
  }

  const bufferViews: Record<string, unknown>[] = []
  const accessors: Record<string, unknown>[] = []

  const bounds = minMax(positions)
  const positionOffset = add(floats(positions))
  bufferViews.push({ buffer: 0, byteOffset: positionOffset, byteLength: positions.length * 4, target: 34962 })
  accessors.push({
    bufferView: 0,
    componentType: FLOAT,
    count: positions.length / 3,
    type: 'VEC3',
    min: bounds.min,
    max: bounds.max,
  })

  const attributes: Record<string, number> = { POSITION: 0 }
  if (normals !== null) {
    const normalOffset = add(floats(normals))
    bufferViews.push({ buffer: 0, byteOffset: normalOffset, byteLength: normals.length * 4, target: 34962 })
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: FLOAT,
      count: normals.length / 3,
      type: 'VEC3',
    })
    attributes.NORMAL = accessors.length - 1
  }

  let indexAccessor: number | undefined
  if (indices !== null) {
    const bytes = indexBytes(indices, indexType)
    const indexOffset = add(bytes)
    bufferViews.push({ buffer: 0, byteOffset: indexOffset, byteLength: bytes.length, target: 34963 })
    accessors.push({
      bufferView: bufferViews.length - 1,
      componentType: indexType,
      count: indices.length,
      type: 'SCALAR',
    })
    indexAccessor = accessors.length - 1
  }

  const primitive: Record<string, unknown> = {
    attributes,
    ...(indexAccessor === undefined ? {} : { indices: indexAccessor }),
    ...options.primitive,
  }
  if (options.material !== undefined) primitive.material = options.material

  const meshNode = options.meshNode ?? { name: 'Head', mesh: 0, translation: [0, 1.5, 0] }
  const doc: Record<string, unknown> = {
    asset: { version: '2.0', generator: 'decode-fixture' },
    scene: 0,
    scenes: [{ nodes: [0, 1, 2] }],
    buffers: [{ byteLength: binLength }],
    bufferViews,
    accessors,
    materials: options.materials ?? [],
    meshes: [{ name: 'body', primitives: [primitive] }],
    nodes: [meshNode, { name: 'Hand.L', translation: [-0.2, 1, 0] }, { name: 'Hand.R', translation: [0.2, 1, 0] }],
    ...options.doc,
  }

  const bin = new Uint8Array(binLength)
  let cursor = 0
  for (const part of parts) {
    bin.set(part, cursor)
    cursor += part.length
  }

  return { doc, bin }
}

function decode(bytes: Uint8Array): ParseResult<DecodedImport> {
  const contents = readGlbContents(bytes)
  if (!contents.ok) return contents
  const index = indexGlb(contents.value)
  if (!index.ok) return index
  return decodeGlb(contents.value, index.value)
}

function decodeFixture(options: FixtureOptions = {}): DecodedImport {
  const built = fixture(options)
  const result = decode(glb(built.doc, built.bin))
  if (!result.ok) throw new Error(`fixture failed to decode: ${JSON.stringify(result.errors)}`)
  return result.value
}

function expectIssue(result: ParseResult<unknown>, path: string, code?: string): AssetIssue {
  expect(!result.ok, `expected a failure at '${path}', but it decoded cleanly`)
  const match = result.errors.find((issue) => issue.path === path)
  expect(
    match !== undefined,
    `no issue at '${path}'; got ${result.errors.map((issue) => `${issue.path}(${issue.code})`).join(', ')}`,
  )
  if (code !== undefined) expectEqual(match.code, code, `code at '${path}'`)
  return match
}

function arrays(values: Float32Array | Uint32Array): number[] {
  return Array.from(values)
}

function records(doc: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return doc[key] as Record<string, unknown>[]
}

const cases: NodeTestCase[] = [
  {
    name: 'decodes an indexed triangle with normals',
    run: () => {
      const decoded = decodeFixture()
      const geometry = decoded.artifact.geometry
      expectEqual(geometry.positions.length / 3, 3, 'vertices')
      expectEqual(geometry.indices.length / 3, 1, 'triangles')
      expectEqual(arrays(geometry.positions).join(','), '0,1.5,0,1,1.5,0,0,2.5,0', 'positions')
      expectEqual(arrays(geometry.normals).join(','), '0,0,1,0,0,1,0,0,1', 'normals')
      expectEqual(geometry.indices.join(','), '0,1,2', 'indices')
      expectEqual(decoded.artifact.material.color, '#ffffff', 'default material colour')
      expectEqual(decoded.artifact.material.roughness, 1, 'default roughness')
      expectEqual(decoded.artifact.material.metalness, 1, 'default metalness')
      expectEqual(Object.keys(decoded.artifact.sockets).join(','), 'head,hand_l,hand_r', 'sockets')
      expectClose(decoded.artifact.sockets.hand_l[0], -0.2, 'hand_l x')
      return '3 verts, 1 tri, 3 sockets'
    },
  },
  {
    name: 'decodes a non-indexed triangle',
    run: () => {
      const decoded = decodeFixture({ indices: null })
      expectEqual(decoded.artifact.geometry.indices.join(','), '0,1,2', 'implicit indices')
      expectEqual(decoded.artifact.geometry.positions.length / 3, 3, 'vertices')
      return 'implicit 0,1,2'
    },
  },
  {
    name: 'applies translation, rotation and scale',
    run: () => {
      const decoded = decodeFixture({
        meshNode: {
          name: 'Head',
          mesh: 0,
          translation: [1, 2, 3],
          rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
          scale: [2, 2, 2],
        },
      })
      const p = arrays(decoded.artifact.geometry.positions)
      expectClose(p[0], 1, 'p0 x')
      expectClose(p[1], 2, 'p0 y')
      expectClose(p[3], 1, 'p1 x')
      expectClose(p[4], 4, 'p1 y')
      expectClose(p[6], -1, 'p2 x')
      expectClose(p[7], 2, 'p2 y')
      expectClose(arrays(decoded.artifact.geometry.normals)[2], 1, 'normal z')
      return '+90 deg Z, x2, translated'
    },
  },
  {
    name: 'non-uniform scale keeps normals unit',
    run: () => {
      const decoded = decodeFixture({
        normals: [0, 0.6, 0.8, 0, 0.6, 0.8, 0, 0.6, 0.8],
        meshNode: { name: 'Head', mesh: 0, translation: [0, 1.5, 0], scale: [4, 1, 0.5] },
      })
      const n = arrays(decoded.artifact.geometry.normals)
      const length = Math.hypot(n[0], n[1], n[2])
      expectClose(length, 1, 'unit length', 1e-6)
      expectClose(n[0], 0, 'x')
      expectClose(n[1] / n[2], 0.375, 'y/z ratio', 1e-6)
      return `length=${length.toFixed(6)} y/z=0.375`
    },
  },
  {
    name: 'computes flat normals when NORMAL is absent',
    run: () => {
      const decoded = decodeFixture({
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0],
        normals: null,
        indices: [0, 1, 2, 0, 2, 3],
        meshNode: { name: 'Head', mesh: 0 },
      })
      const geometry = decoded.artifact.geometry
      expectEqual(geometry.positions.length / 3, 6, 'de-indexed vertices')
      expectEqual(geometry.indices.length / 3, 2, 'triangles')
      for (let i = 0; i < geometry.normals.length; i += 3) {
        expectClose(geometry.normals[i], 0, `normal ${i / 3} x`)
        expectClose(geometry.normals[i + 1], 0, `normal ${i / 3} y`)
        expectClose(geometry.normals[i + 2], 1, `normal ${i / 3} z`)
      }
      return 'two faces, +Z normals'
    },
  },
  {
    name: 'honours accessor and bufferView offsets',
    run: () => {
      const built = fixture({ normals: null, indices: null })
      const positions = floats([0, 0, 0, 1, 0, 0, 0, 1, 0])
      const bin = new Uint8Array(8 + positions.length)
      bin.set(positions, 8)
      built.doc.buffers = [{ byteLength: bin.length }]
      built.doc.bufferViews = [{ buffer: 0, byteOffset: 4, byteLength: 4 + positions.length, target: 34962 }]
      const accessor = records(built.doc, 'accessors')[0]
      accessor.byteOffset = 4
      built.doc.accessors = [accessor]

      const decoded = decode(glb(built.doc, bin))
      expect(decoded.ok, `expected success, got ${JSON.stringify(decoded.ok ? [] : decoded.errors)}`)
      expectEqual(arrays(decoded.value.artifact.geometry.positions).join(','), '0,1.5,0,1,1.5,0,0,2.5,0', 'positions')
      return 'view +4, accessor +4'
    },
  },
  {
    name: 'rejects a misaligned accessor',
    run: () => {
      const built = fixture({ normals: null, indices: null })
      records(built.doc, 'accessors')[0].byteOffset = 2
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].attributes.POSITION.byteOffset',
        'accessor_misaligned',
      )
      return issue.message
    },
  },
  {
    name: 'reads interleaved position and normal data',
    run: () => {
      const interleaved = [
        0, 0, 0, 0, 0, 1,
        1, 0, 0, 0, 0, 1,
        0, 1, 0, 0, 0, 1,
      ]
      const bin = floats(interleaved)
      const built = fixture({ normals: null, indices: null })
      built.doc.buffers = [{ byteLength: bin.length }]
      built.doc.bufferViews = [{ buffer: 0, byteOffset: 0, byteLength: bin.length, byteStride: 24, target: 34962 }]
      built.doc.accessors = [
        { bufferView: 0, byteOffset: 0, componentType: FLOAT, count: 3, type: 'VEC3', min: [0, 0, 0], max: [1, 1, 0] },
        { bufferView: 0, byteOffset: 12, componentType: FLOAT, count: 3, type: 'VEC3' },
      ]
      records(built.doc, 'meshes')[0].primitives = [{ attributes: { POSITION: 0, NORMAL: 1 } }]
      records(built.doc, 'nodes')[0] = { name: 'Head', mesh: 0 }

      const decoded = decode(glb(built.doc, bin))
      expect(decoded.ok, `expected success, got ${JSON.stringify(decoded.ok ? [] : decoded.errors)}`)
      expectEqual(arrays(decoded.value.artifact.geometry.positions).join(','), '0,0,0,1,0,0,0,1,0', 'positions')
      expectEqual(arrays(decoded.value.artifact.geometry.normals).join(','), '0,0,1,0,0,1,0,0,1', 'normals')
      return 'stride 24, normal at +12'
    },
  },
  {
    name: 'rejects a stride smaller than the element',
    run: () => {
      const built = fixture({ normals: null, indices: null })
      records(built.doc, 'bufferViews')[0].byteStride = 8
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].attributes.POSITION.bufferView.byteStride',
        'accessor_stride_invalid',
      )
      return issue.message
    },
  },
  {
    name: 'rejects a stride that is not a multiple of 4',
    run: () => {
      const built = fixture({ normals: null, indices: null })
      records(built.doc, 'bufferViews')[0].byteStride = 14
      expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].attributes.POSITION.bufferView.byteStride',
        'accessor_stride_invalid',
      )
      return 'stride 14 rejected'
    },
  },
  {
    name: 'rejects an accessor past its bufferView',
    run: () => {
      const built = fixture()
      records(built.doc, 'accessors')[0].count = 4
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].attributes.POSITION',
        'accessor_out_of_range',
      )
      return issue.message
    },
  },
  {
    name: 'rejects an out-of-range index',
    run: () => {
      const built = fixture({ indices: [0, 1, 5] })
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].indices',
        'index_out_of_range',
      )
      expectEqual(issue.measured, 5, 'measured index')
      return issue.message
    },
  },
  {
    name: 'rejects a buffer larger than the BIN chunk',
    run: () => {
      const built = fixture()
      records(built.doc, 'buffers')[0].byteLength = built.bin.length + 8
      const issue = expectIssue(decode(glb(built.doc, built.bin)), 'buffers[0].byteLength', 'buffer_out_of_range')
      return issue.message
    },
  },
  {
    name: 'rejects an external buffer URI',
    run: () => {
      const built = fixture()
      records(built.doc, 'buffers')[0].uri = 'https://example.invalid/body.bin'
      const issue = expectIssue(decode(glb(built.doc, built.bin)), 'buffers[0].uri', 'unsupported_buffer_uri')
      return issue.message
    },
  },
  {
    name: 'rejects a missing BIN chunk',
    run: () => {
      const built = fixture()
      const issue = expectIssue(decode(glb(built.doc)), 'buffers[0]', 'bin_chunk_missing')
      return issue.message
    },
  },
  {
    name: 'rejects a sparse accessor',
    run: () => {
      const built = fixture()
      records(built.doc, 'accessors')[0].sparse = {
        count: 1,
        indices: { bufferView: 0, componentType: UBYTE },
        values: { bufferView: 0 },
      }
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].attributes.POSITION.sparse',
        'unsupported_sparse_accessor',
      )
      return issue.message
    },
  },
  {
    name: 'rejects a normalized accessor',
    run: () => {
      const built = fixture()
      records(built.doc, 'accessors')[0].normalized = true
      expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].attributes.POSITION',
        'accessor_normalized',
      )
      return 'normalized positions rejected'
    },
  },
  {
    name: 'rejects float indices',
    run: () => {
      const built = fixture()
      records(built.doc, 'accessors')[2].componentType = FLOAT
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].indices',
        'accessor_component_type',
      )
      return issue.message
    },
  },
  {
    name: 'reads uint8 and uint32 indices',
    run: () => {
      const small = decodeFixture({ indexType: UBYTE })
      const wide = decodeFixture({ indexType: UINT })
      expectEqual(small.artifact.geometry.indices.join(','), '0,1,2', 'uint8')
      expectEqual(wide.artifact.geometry.indices.join(','), '0,1,2', 'uint32')
      return 'uint8 and uint32 both decode'
    },
  },
  {
    name: 'unsupported primitive mode stops at the indexer',
    run: () => {
      const built = fixture({ primitive: { mode: 5 } })
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].mode',
        'unsupported_primitive_mode',
      )
      return issue.message
    },
  },
  {
    name: 'mirrored transforms reverse winding',
    run: () => {
      const decoded = decodeFixture({
        meshNode: { name: 'Head', mesh: 0, translation: [0, 1.5, 0], scale: [-1, 1, 1] },
      })
      const geometry = decoded.artifact.geometry
      expectEqual(geometry.indices.join(','), '0,2,1', 'reversed winding')

      const p = geometry.positions
      const [a, b, c] = geometry.indices
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2]
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2]
      const nx = uy * vz - uz * vy
      const ny = uz * vx - ux * vz
      const nz = ux * vy - uy * vx
      const length = Math.hypot(nx, ny, nz)
      expectClose(nx / length, 0, 'face normal x')
      expectClose(ny / length, 0, 'face normal y')
      expectClose(nz / length, 1, 'face normal z')
      return 'face and vertex normals agree'
    },
  },
  {
    name: 'rejects a singular node transform',
    run: () => {
      const built = fixture({ meshNode: { name: 'Head', mesh: 0, scale: [0, 1, 1] } })
      const issue = expectIssue(decode(glb(built.doc, built.bin)), 'nodes[0].world', 'degenerate_transform')
      return issue.message
    },
  },
  {
    name: 'rejects skins',
    run: () => {
      const built = fixture({ doc: { skins: [{ joints: [0] }] } })
      const issue = expectIssue(decode(glb(built.doc, built.bin)), 'skins', 'unsupported_skin')
      return issue.message
    },
  },
  {
    name: 'rejects morph targets',
    run: () => {
      const built = fixture({ primitive: { targets: [{}] } })
      expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[0].targets',
        'unsupported_morph_target',
      )
      return 'morph target rejected'
    },
  },
  {
    name: 'rejects textures',
    run: () => {
      const built = fixture({
        materials: [{ pbrMetallicRoughness: { baseColorTexture: { index: 0 } } }],
        material: 0,
      })
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'materials[0].pbrMetallicRoughness.baseColorTexture',
        'unsupported_texture',
      )
      return issue.message
    },
  },
  {
    name: 'rejects non-opaque materials',
    run: () => {
      const built = fixture({ materials: [{ alphaMode: 'BLEND' }], material: 0 })
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'materials[0].alphaMode',
        'unsupported_alpha_mode',
      )
      return issue.message
    },
  },
  {
    name: 'rejects mixed materials',
    run: () => {
      const built = fixture({
        materials: [
          { pbrMetallicRoughness: { baseColorFactor: [1, 0, 0, 1] } },
          { pbrMetallicRoughness: { baseColorFactor: [0, 0, 1, 1] } },
        ],
        material: 0,
      })
      const primitive = records(built.doc, 'meshes')[0].primitives
      const first = (primitive as Record<string, unknown>[])[0]
      ;(primitive as Record<string, unknown>[]).push({ ...first, material: 1 })
      const issue = expectIssue(
        decode(glb(built.doc, built.bin)),
        'meshes[0].primitives[1].material',
        'mixed_materials',
      )
      return issue.message
    },
  },
  {
    name: 'converts linear base colour and material defaults',
    run: () => {
      const decoded = decodeFixture({
        materials: [
          {
            doubleSided: true,
            pbrMetallicRoughness: {
              baseColorFactor: [0.5, 0.25, 0.1, 1],
              metallicFactor: 0,
              roughnessFactor: 0.7,
            },
          },
        ],
        material: 0,
      })
      const material = decoded.artifact.material
      expectEqual(material.color, '#bc8959', 'linear -> sRGB')
      expectEqual(material.roughness, 0.7, 'roughness')
      expectEqual(material.metalness, 0, 'metalness')
      expectEqual(material.doubleSided, true, 'doubleSided')
      return `${material.color} rough=${material.roughness} metal=${material.metalness}`
    },
  },
  {
    name: 'rejects glTF extensions',
    run: () => {
      const built = fixture({ doc: { extensionsUsed: ['KHR_draco_mesh_compression'] } })
      const issue = expectIssue(decode(glb(built.doc, built.bin)), 'extensionsUsed', 'unsupported_extension')
      return issue.message
    },
  },
  {
    name: 'warns about ignored animation clips',
    run: () => {
      const built = fixture({ doc: { animations: [{ name: 'idle', channels: [], samplers: [] }] } })
      const result = decode(glb(built.doc, built.bin))
      expect(result.ok, `expected success, got ${JSON.stringify(result.ok ? [] : result.errors)}`)
      expectEqual(result.value.warnings.length, 1, 'warnings')
      expectEqual(result.value.warnings[0].code, 'animations_ignored', 'warning code')
      return result.value.warnings[0].message
    },
  },
  {
    name: 'warns when decoded bounds disagree with declared bounds',
    run: () => {
      const built = fixture()
      const accessor = records(built.doc, 'accessors')[0]
      accessor.min = [-1, -1, -1]
      accessor.max = [2, 3, 1]
      const result = decode(glb(built.doc, built.bin))
      expect(result.ok, `expected success, got ${JSON.stringify(result.ok ? [] : result.errors)}`)
      expectEqual(result.value.warnings[0].code, 'declared_bounds_mismatch', 'warning code')
      return result.value.warnings[0].message
    },
  },
  {
    name: 'rejects non-finite positions',
    run: () => {
      const built = fixture({ positions: [Number.NaN, 0, 0, 1, 0, 0, 0, 1, 0] })
      // Declared bounds stay finite: the NaN is only in the BIN payload, which
      // is exactly the case the indexer cannot see.
      const accessor = records(built.doc, 'accessors')[0]
      accessor.min = [0, 0, 0]
      accessor.max = [1, 1, 0]
      const issue = expectIssue(decode(glb(built.doc, built.bin)), 'accessors.POSITION', 'non_finite_position')
      return issue.message
    },
  },
  {
    name: 'decoding is deterministic',
    run: () => {
      const built = fixture({
        materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.2, 0.3, 0.4, 1] } }],
        material: 0,
      })
      const bytes = glb(built.doc, built.bin)
      const first = decode(bytes)
      const second = decode(bytes)
      expect(first.ok && second.ok, 'both decodes should succeed')
      if (!first.ok || !second.ok) return 'unreachable'
      const a = first.value.artifact
      const b = second.value.artifact
      expectEqual(arrays(a.geometry.positions).join(','), arrays(b.geometry.positions).join(','), 'positions')
      expectEqual(arrays(a.geometry.normals).join(','), arrays(b.geometry.normals).join(','), 'normals')
      expectEqual(artifactHash(a), artifactHash(b), 'hash')
      return `hash=${artifactHash(a)}`
    },
  },
]

export function suite() {
  return runSuite('GLB decode', cases)
}
