import { decodeGlb } from '../import/decode'
import type { DecodedImport } from '../import/decode'
import { indexGlb, readGlbContents } from '../import/glb'
import type { ParseResult } from '../types'

/**
 * Synthetic character GLB builder shared by the decoder and build suites.
 *
 * One triangle, one mesh-bearing Head node and both hands. The mesh node carries
 * whatever transform the case is testing; everything else stays fixed so a
 * failure points at the feature under test, not at fixture drift.
 */

export const FLOAT = 5126
export const UBYTE = 5121
export const USHORT = 5123
export const UINT = 5125

export interface Fixture {
  doc: Record<string, unknown>
  bin: Uint8Array
}

export interface FixtureOptions {
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

export function floats(values: readonly number[]): Uint8Array {
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

export function fixture(options: FixtureOptions = {}): Fixture {
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

export function decodeBytes(bytes: Uint8Array): ParseResult<DecodedImport> {
  const contents = readGlbContents(bytes)
  if (!contents.ok) return contents
  const index = indexGlb(contents.value)
  if (!index.ok) return index
  return decodeGlb(contents.value, index.value)
}

export function records(doc: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return doc[key] as Record<string, unknown>[]
}
