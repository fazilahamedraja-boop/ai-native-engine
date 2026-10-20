import type { Mat4, Vec3 } from '../../core/math'
import { identity, multiply, transformPoint } from '../../core/math'
import { KIND_SPECS } from '../kinds'
import type { AssetIssue, Bounds, ParseResult } from '../types'

/**
 * GLB indexer for imported characters.
 *
 * Reads the container and the JSON chunk only: no accessor decoding, no THREE,
 * no DOM, no filesystem. Bounds come from declared accessor min/max pushed
 * through node transforms, which is enough to author a manifest and to reject a
 * file that could not be placed, posed or attached to.
 *
 * The BIN chunk is exposed with the parsed document so the decoder can read
 * accessors without parsing the container a second time. Indexing remains the
 * cheap gate; turning accessors into a mesh is `import/decode.ts`.
 */

export const GLB_MAGIC = 0x46546c67
export const GLB_VERSION = 2
export const CHUNK_JSON = 0x4e4f534a
export const CHUNK_BIN = 0x004e4942

/** glTF primitive mode 4. The only mode this importer accepts. */
export const TRIANGLES = 4

export interface GlbNode {
  index: number
  /** Name as authored, or '' when the node is unnamed. */
  name: string
  /** Engine-safe slug of the name; `node_<index>` when unnamed. */
  slug: string
  parent: number | null
  /** Node -> root transform, column-major. */
  world: Mat4
  /** World-space position of the node origin. */
  position: Vec3
  mesh: number | null
  skin: number | null
}

export interface GlbMesh {
  index: number
  name: string
  primitives: number
  /** Solid triangles in one instance of this mesh. */
  triangles: number
  /** Local-space union of the primitives' declared POSITION bounds. */
  bounds: Bounds
}

export interface GlbSkin {
  index: number
  name: string
  joints: number
}

export interface GlbAnimation {
  index: number
  name: string
  channels: number
  /** Last keyframe across the animation's time accessors, seconds. */
  duration: number
}

export interface GlbIndex {
  asset: { version: string; generator: string }
  bytes: number
  jsonBytes: number
  binBytes: number | null
  scene: number | null
  nodes: GlbNode[]
  meshes: GlbMesh[]
  skins: GlbSkin[]
  animations: GlbAnimation[]
  materials: string[]
  /** Triangles actually drawn, summed over node instances. */
  triangles: number
  /** World-space bounds over every mesh instance; null when nothing is drawn. */
  bounds: Bounds | null
  /** Named nodes as slugs, sorted. Unnamed nodes are not included. */
  named: Record<string, Vec3>
  /** Slugs claimed by more than one node; these cannot become sockets. */
  duplicateSlugs: string[]
}

export interface CharacterReading {
  bounds: Bounds
  sockets: Record<string, Vec3>
  triangles: number
  meshes: number
  skins: number
  animations: number
}

/** Sockets every character must expose, taken from the kind contract itself. */
export const CHARACTER_SOCKETS: readonly string[] = KIND_SPECS.character.requiredSockets

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function numericArray(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null
    out.push(entry)
  }
  return out
}

function hex(value: number): string {
  return `0x${value.toString(16).padStart(8, '0')}`
}

/**
 * Normalises a node name to the socket slug grammar. Blender's `Hand.L` and a
 * hand-named `hand_l` collapse to the same socket, which is the point.
 */
export function nodeSlug(name: string, index: number): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
  if (slug === '') return `node_${index}`
  return /^[a-z]/.test(slug) ? slug : `node_${slug}`
}

function union(a: Bounds | null, b: Bounds): Bounds {
  if (a === null) return b
  return {
    min: [Math.min(a.min[0], b.min[0]), Math.min(a.min[1], b.min[1]), Math.min(a.min[2], b.min[2])],
    max: [Math.max(a.max[0], b.max[0]), Math.max(a.max[1], b.max[1]), Math.max(a.max[2], b.max[2])],
  }
}

/** AABB of an AABB after an affine transform: transform the eight corners. */
function transformBounds(matrix: Mat4, bounds: Bounds): Bounds {
  let out: Bounds | null = null
  for (let corner = 0; corner < 8; corner++) {
    const point: Vec3 = [
      corner & 1 ? bounds.max[0] : bounds.min[0],
      corner & 2 ? bounds.max[1] : bounds.min[1],
      corner & 4 ? bounds.max[2] : bounds.min[2],
    ]
    const moved = transformPoint(matrix, point)
    out = union(out, { min: moved, max: moved })
  }
  // Eight corners always produce a box.
  return out as Bounds
}

/** T * R * S, column-major. glTF rotations are quaternions, not Euler angles. */
function trsMatrix(translation: number[], rotation: number[], scale: number[], quatLength: number): Mat4 {
  const [x, y, z, w] = [
    rotation[0] / quatLength,
    rotation[1] / quatLength,
    rotation[2] / quatLength,
    rotation[3] / quatLength,
  ]
  const x2 = x + x
  const y2 = y + y
  const z2 = z + z
  const xx = x * x2
  const xy = x * y2
  const xz = x * z2
  const yy = y * y2
  const yz = y * z2
  const zz = z * z2
  const wx = w * x2
  const wy = w * y2
  const wz = w * z2

  const m: Mat4 = new Array<number>(16).fill(0)
  m[0] = (1 - (yy + zz)) * scale[0]
  m[1] = (xy + wz) * scale[0]
  m[2] = (xz - wy) * scale[0]
  m[4] = (xy - wz) * scale[1]
  m[5] = (1 - (xx + zz)) * scale[1]
  m[6] = (yz + wx) * scale[1]
  m[8] = (xz + wy) * scale[2]
  m[9] = (yz - wx) * scale[2]
  m[10] = (1 - (xx + yy)) * scale[2]
  m[12] = translation[0]
  m[13] = translation[1]
  m[14] = translation[2]
  m[15] = 1
  return m
}

function localMatrix(node: Record<string, unknown>, path: string, errors: AssetIssue[]): Mat4 {
  if (node.matrix !== undefined) {
    const matrix = numericArray(node.matrix, 16)
    if (matrix === null) {
      errors.push({
        path: `${path}.matrix`,
        code: 'node_transform_invalid',
        message: 'node.matrix must be 16 finite numbers',
      })
      return identity()
    }
    return matrix
  }

  const translation = node.translation === undefined ? [0, 0, 0] : numericArray(node.translation, 3)
  const rotation = node.rotation === undefined ? [0, 0, 0, 1] : numericArray(node.rotation, 4)
  const scale = node.scale === undefined ? [1, 1, 1] : numericArray(node.scale, 3)
  if (translation === null || rotation === null || scale === null) {
    errors.push({
      path,
      code: 'node_transform_invalid',
      message: 'translation, rotation and scale must be 3, 4 and 3 finite numbers',
    })
    return identity()
  }

  const quatLength = Math.hypot(rotation[0], rotation[1], rotation[2], rotation[3])
  if (quatLength < 1e-8) {
    errors.push({
      path: `${path}.rotation`,
      code: 'node_transform_invalid',
      message: 'rotation is a zero-length quaternion',
    })
    return identity()
  }

  return trsMatrix(translation, rotation, scale, quatLength)
}

/** Parsed container plus the raw chunks a decoder needs. */
export interface GlbContents {
  doc: Record<string, unknown>
  /** Total file size in bytes. */
  bytes: number
  jsonBytes: number
  /** BIN chunk payload, including any 4-byte padding. */
  bin: Uint8Array | null
}

function readContainer(bytes: Uint8Array, errors: AssetIssue[]): GlbContents | null {
  if (bytes.length < 12) {
    errors.push({
      path: '',
      code: 'glb_truncated',
      message: `GLB header needs 12 bytes, got ${bytes.length}`,
      expected: 12,
      measured: bytes.length,
    })
    return null
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const magic = view.getUint32(0, true)
  if (magic !== GLB_MAGIC) {
    errors.push({
      path: '',
      code: 'glb_magic',
      message: `not a GLB container: magic ${hex(magic)}, expected ${hex(GLB_MAGIC)} ('glTF')`,
      expected: hex(GLB_MAGIC),
      measured: hex(magic),
    })
  }

  const version = view.getUint32(4, true)
  if (version !== GLB_VERSION) {
    errors.push({
      path: '',
      code: 'glb_version',
      message: `GLB container version ${version} is not supported; expected ${GLB_VERSION}`,
      expected: GLB_VERSION,
      measured: version,
    })
  }

  const declared = view.getUint32(8, true)
  if (declared !== bytes.length) {
    errors.push({
      path: '',
      code: 'glb_length_mismatch',
      message: `header declares ${declared} bytes, file has ${bytes.length}`,
      expected: bytes.length,
      measured: declared,
    })
  }

  // Offsets cannot be trusted once the header disagrees with the file.
  if (errors.length > 0) return null

  let json: Uint8Array | null = null
  let bin: Uint8Array | null = null
  let offset = 12
  let chunkIndex = 0

  while (offset < bytes.length) {
    const path = `chunks[${chunkIndex}]`
    if (offset + 8 > bytes.length) {
      errors.push({
        path,
        code: 'glb_chunk_truncated',
        message: `chunk header at byte ${offset} needs 8 bytes, ${bytes.length - offset} remain`,
      })
      return null
    }

    const length = view.getUint32(offset, true)
    const type = view.getUint32(offset + 4, true)
    const dataStart = offset + 8

    if (dataStart + length > bytes.length) {
      errors.push({
        path,
        code: 'glb_chunk_truncated',
        message: `chunk declares ${length} bytes at byte ${dataStart}, only ${bytes.length - dataStart} remain`,
        expected: bytes.length - dataStart,
        measured: length,
      })
      return null
    }
    if (length % 4 !== 0) {
      errors.push({
        path,
        code: 'glb_chunk_alignment',
        message: `chunk length ${length} is not a multiple of 4`,
      })
    }

    if (type === CHUNK_JSON) {
      if (chunkIndex !== 0) {
        errors.push({ path, code: 'glb_json_chunk_first', message: 'the JSON chunk must be the first chunk' })
      }
      if (json !== null) {
        errors.push({ path, code: 'glb_json_chunk_duplicate', message: 'more than one JSON chunk' })
      } else {
        json = bytes.subarray(dataStart, dataStart + length)
      }
    } else if (type === CHUNK_BIN) {
      if (bin !== null) {
        errors.push({ path, code: 'glb_bin_chunk_duplicate', message: 'more than one BIN chunk' })
      } else {
        bin = bytes.subarray(dataStart, dataStart + length)
      }
    }
    // Unknown chunk types are ignored, as the glTF spec requires.

    offset = dataStart + length
    chunkIndex += 1
  }

  if (json === null) {
    errors.push({ path: '', code: 'glb_json_chunk_missing', message: 'GLB has no JSON chunk' })
    return null
  }

  // JSON is padded with spaces or, from some exporters, NULs.
  const text = new TextDecoder().decode(json).replace(/[\u0000\u0020]+$/, '')
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    errors.push({
      path: '',
      code: 'glb_json_invalid',
      message: `JSON chunk does not parse: ${(error as Error).message}`,
    })
    return null
  }
  if (!isRecord(parsed)) {
    errors.push({ path: '', code: 'gltf_invalid', message: 'glTF JSON must be an object' })
    return null
  }

  return { doc: parsed, bytes: bytes.length, jsonBytes: json.length, bin }
}

interface PositionReading {
  bounds: Bounds
  count: number
}

function readPosition(
  primitive: Record<string, unknown>,
  path: string,
  accessors: readonly unknown[],
  errors: AssetIssue[],
): PositionReading | null {
  const attributes = isRecord(primitive.attributes) ? primitive.attributes : null
  const accessorIndex = attributes?.POSITION
  if (!isIndex(accessorIndex)) {
    errors.push({
      path: `${path}.attributes.POSITION`,
      code: 'position_missing',
      message: 'primitive has no POSITION accessor',
    })
    return null
  }

  const accessor = accessors[accessorIndex]
  if (!isRecord(accessor)) {
    errors.push({
      path: `${path}.attributes.POSITION`,
      code: 'accessor_out_of_range',
      message: `POSITION accessor ${accessorIndex} does not exist (${accessors.length} accessors)`,
      measured: accessorIndex,
    })
    return null
  }

  if (accessor.type !== 'VEC3') {
    errors.push({
      path: `${path}.attributes.POSITION`,
      code: 'position_not_vec3',
      message: `POSITION accessor type is ${JSON.stringify(accessor.type)}, expected 'VEC3'`,
      expected: 'VEC3',
      measured: accessor.type,
    })
    return null
  }

  const min = numericArray(accessor.min, 3)
  const max = numericArray(accessor.max, 3)
  if (min === null || max === null) {
    errors.push({
      path: `${path}.attributes.POSITION`,
      code: 'accessor_bounds_missing',
      message: 'POSITION accessor must declare min and max; the importer does not decode buffers',
    })
    return null
  }
  for (let axis = 0; axis < 3; axis++) {
    if (min[axis] > max[axis]) {
      errors.push({
        path: `${path}.attributes.POSITION`,
        code: 'accessor_bounds_inverted',
        message: `accessor min[${axis}] ${min[axis]} exceeds max[${axis}] ${max[axis]}`,
      })
      return null
    }
  }

  const count = isIndex(accessor.count) ? accessor.count : 0
  if (count === 0) {
    errors.push({
      path: `${path}.attributes.POSITION`,
      code: 'accessor_empty',
      message: 'POSITION accessor declares no vertices',
    })
    return null
  }

  return { bounds: { min: [min[0], min[1], min[2]], max: [max[0], max[1], max[2]] }, count }
}

function readMeshes(rawMeshes: readonly unknown[], accessors: readonly unknown[], errors: AssetIssue[]): {
  meshes: GlbMesh[]
  primitiveBounds: Bounds[][]
} {
  const meshes: GlbMesh[] = []
  const primitiveBounds: Bounds[][] = []

  for (let index = 0; index < rawMeshes.length; index++) {
    const path = `meshes[${index}]`
    const mesh = rawMeshes[index]
    if (!isRecord(mesh)) {
      errors.push({ path, code: 'mesh_invalid', message: 'mesh must be an object' })
      continue
    }

    const primitives = Array.isArray(mesh.primitives) ? mesh.primitives : []
    if (primitives.length === 0) {
      errors.push({ path: `${path}.primitives`, code: 'mesh_without_primitives', message: 'mesh has no primitives' })
      continue
    }

    let triangles = 0
    let bounds: Bounds | null = null
    const localBounds: Bounds[] = []

    for (let p = 0; p < primitives.length; p++) {
      const primitivePath = `${path}.primitives[${p}]`
      const primitive = primitives[p]
      if (!isRecord(primitive)) {
        errors.push({ path: primitivePath, code: 'primitive_invalid', message: 'primitive must be an object' })
        continue
      }

      const mode = primitive.mode === undefined ? TRIANGLES : primitive.mode
      if (mode !== TRIANGLES) {
        errors.push({
          path: `${primitivePath}.mode`,
          code: 'unsupported_primitive_mode',
          message: `primitive mode ${JSON.stringify(mode)} is not supported; only TRIANGLES (${TRIANGLES})`,
          expected: TRIANGLES,
          measured: mode,
        })
        continue
      }

      const position = readPosition(primitive, primitivePath, accessors, errors)
      if (position === null) continue

      let drawn = position.count
      if (primitive.indices !== undefined) {
        if (!isIndex(primitive.indices)) {
          errors.push({
            path: `${primitivePath}.indices`,
            code: 'indices_invalid',
            message: 'indices must be an accessor index',
          })
          continue
        }
        const indexAccessor = accessors[primitive.indices]
        if (!isRecord(indexAccessor) || !isIndex(indexAccessor.count)) {
          errors.push({
            path: `${primitivePath}.indices`,
            code: 'accessor_out_of_range',
            message: `indices accessor ${primitive.indices} does not exist`,
            measured: primitive.indices,
          })
          continue
        }
        drawn = indexAccessor.count
      }

      if (drawn % 3 !== 0) {
        errors.push({
          path: primitivePath,
          code: 'primitive_not_triangles',
          message: `${drawn} vertices do not form whole triangles`,
          measured: drawn,
        })
        continue
      }

      triangles += drawn / 3
      localBounds.push(position.bounds)
      bounds = union(bounds, position.bounds)
    }

    meshes.push({
      index,
      name: typeof mesh.name === 'string' && mesh.name !== '' ? mesh.name : `mesh_${index}`,
      primitives: primitives.length,
      triangles,
      bounds: bounds ?? { min: [0, 0, 0], max: [0, 0, 0] },
    })
    primitiveBounds.push(localBounds)
  }

  return { meshes, primitiveBounds }
}

interface NodeReading {
  nodes: GlbNode[]
  /** Slugs claimed by more than one named node. */
  duplicates: string[]
}

function readNodes(
  rawNodes: readonly unknown[],
  meshCount: number,
  skinCount: number,
  errors: AssetIssue[],
): NodeReading {
  const parents: (number | null)[] = new Array<number | null>(rawNodes.length).fill(null)
  const names: string[] = []
  const slugs: string[] = []
  const locals: Mat4[] = []
  const meshRefs: (number | null)[] = []
  const skinRefs: (number | null)[] = []
  const duplicates: string[] = []
  const claimed = new Map<string, number>()

  for (let index = 0; index < rawNodes.length; index++) {
    const path = `nodes[${index}]`
    const node = rawNodes[index]
    if (!isRecord(node)) {
      errors.push({ path, code: 'node_invalid', message: 'node must be an object' })
      names.push('')
      slugs.push(`node_${index}`)
      locals.push(identity())
      meshRefs.push(null)
      skinRefs.push(null)
      continue
    }

    const name = typeof node.name === 'string' ? node.name.trim() : ''
    const slug = nodeSlug(name, index)
    names.push(name)
    slugs.push(slug)
    if (name !== '') {
      const first = claimed.get(slug)
      if (first === undefined) claimed.set(slug, index)
      else if (!duplicates.includes(slug)) duplicates.push(slug)
    }

    const mesh = node.mesh === undefined ? null : node.mesh
    if (mesh !== null && (!isIndex(mesh) || mesh >= meshCount)) {
      errors.push({
        path: `${path}.mesh`,
        code: 'node_mesh_out_of_range',
        message: `node references mesh ${JSON.stringify(mesh)}, but the file has ${meshCount}`,
        measured: mesh,
      })
      meshRefs.push(null)
    } else {
      meshRefs.push(mesh)
    }

    const skin = node.skin === undefined ? null : node.skin
    if (skin !== null && (!isIndex(skin) || skin >= skinCount)) {
      errors.push({
        path: `${path}.skin`,
        code: 'node_skin_out_of_range',
        message: `node references skin ${JSON.stringify(skin)}, but the file has ${skinCount}`,
        measured: skin,
      })
      skinRefs.push(null)
    } else {
      skinRefs.push(skin)
    }

    const children = node.children === undefined ? [] : node.children
    if (!Array.isArray(children)) {
      errors.push({ path: `${path}.children`, code: 'node_children_invalid', message: 'children must be an array' })
    } else {
      for (const child of children) {
        if (!isIndex(child) || child >= rawNodes.length) {
          errors.push({
            path: `${path}.children`,
            code: 'node_child_out_of_range',
            message: `child ${JSON.stringify(child)} is not a node index (${rawNodes.length} nodes)`,
            measured: child,
          })
          continue
        }
        const existing = parents[child]
        if (existing !== null && existing !== index) {
          errors.push({
            path: `${path}.children`,
            code: 'node_multiple_parents',
            message: `node ${child} is already a child of node ${existing}`,
            measured: child,
          })
          continue
        }
        parents[child] = index
      }
    }

    locals.push(localMatrix(node, path, errors))
  }

  // A cycle means no root: walking up never terminates, so reject before transforms.
  const state = new Uint8Array(rawNodes.length) // 0 unknown, 3 on the current path, 1 safe, 2 cyclic
  let cyclic = false
  for (let index = 0; index < rawNodes.length; index++) {
    if (state[index] !== 0) continue
    const path: number[] = []
    let cursor: number | null = index
    while (cursor !== null && state[cursor] === 0) {
      state[cursor] = 3
      path.push(cursor)
      cursor = parents[cursor]
    }
    const inCycle = cursor !== null && state[cursor] === 3
    for (const node of path) state[node] = inCycle ? 2 : 1
    if (inCycle) {
      cyclic = true
      errors.push({
        path: `nodes[${index}]`,
        code: 'node_cycle',
        message: `node ${index} is part of a parent cycle`,
        measured: path,
      })
    }
  }

  // Without roots there is no world order; the caller only needs the errors.
  if (cyclic) return { nodes: [], duplicates }

  // Depth-first order by depth so a parent's world matrix exists before its children.
  const depth = new Int32Array(rawNodes.length).fill(-1)
  for (let index = 0; index < rawNodes.length; index++) {
    if (depth[index] >= 0) continue
    const path: number[] = []
    let cursor: number | null = index
    while (cursor !== null && depth[cursor] < 0) {
      path.push(cursor)
      cursor = parents[cursor]
    }
    let base = cursor === null ? -1 : depth[cursor]
    for (let p = path.length - 1; p >= 0; p--) {
      base += 1
      depth[path[p]] = base
    }
  }

  const world: Mat4[] = new Array<Mat4>(rawNodes.length)
  const order = Array.from({ length: rawNodes.length }, (_value, index) => index).sort(
    (a, b) => depth[a] - depth[b] || a - b,
  )
  for (const index of order) {
    const parent = parents[index]
    world[index] = parent === null ? locals[index] : multiply(world[parent], locals[index])
  }

  const nodes: GlbNode[] = rawNodes.map((_node, index) => ({
    index,
    name: names[index],
    slug: slugs[index],
    parent: parents[index],
    world: world[index],
    position: [world[index][12], world[index][13], world[index][14]],
    mesh: meshRefs[index],
    skin: skinRefs[index],
  }))

  return { nodes, duplicates }
}

function readSkins(rawSkins: readonly unknown[], nodeCount: number, errors: AssetIssue[]): GlbSkin[] {
  return rawSkins.map((skin, index) => {
    const path = `skins[${index}]`
    if (!isRecord(skin)) {
      errors.push({ path, code: 'skin_invalid', message: 'skin must be an object' })
      return { index, name: `skin_${index}`, joints: 0 }
    }
    const joints = Array.isArray(skin.joints) ? skin.joints : []
    for (const joint of joints) {
      if (!isIndex(joint) || joint >= nodeCount) {
        errors.push({
          path: `${path}.joints`,
          code: 'node_out_of_range',
          message: `joint ${JSON.stringify(joint)} is not a node index (${nodeCount} nodes)`,
          measured: joint,
        })
      }
    }
    return {
      index,
      name: typeof skin.name === 'string' && skin.name !== '' ? skin.name : `skin_${index}`,
      joints: joints.length,
    }
  })
}

function readAnimations(rawAnimations: readonly unknown[], accessors: readonly unknown[]): GlbAnimation[] {
  return rawAnimations.map((animation, index) => {
    if (!isRecord(animation)) return { index, name: `animation_${index}`, channels: 0, duration: 0 }

    const channels = Array.isArray(animation.channels) ? animation.channels : []
    const samplers = Array.isArray(animation.samplers) ? animation.samplers : []
    let duration = 0

    for (const channel of channels) {
      if (!isRecord(channel) || !isIndex(channel.sampler)) continue
      const sampler = samplers[channel.sampler]
      if (!isRecord(sampler) || !isIndex(sampler.input)) continue
      const accessor = accessors[sampler.input]
      if (!isRecord(accessor) || !Array.isArray(accessor.max)) continue
      const last = accessor.max[0]
      if (typeof last === 'number' && Number.isFinite(last)) duration = Math.max(duration, last)
    }

    return {
      index,
      name: typeof animation.name === 'string' && animation.name !== '' ? animation.name : `animation_${index}`,
      channels: channels.length,
      duration,
    }
  })
}

/**
 * Parses the GLB container and JSON chunk. Structural problems are reported as
 * issues, never thrown: an agent needs a machine-readable reason, not a stack
 * trace. The BIN chunk is returned untouched for the accessor decoder.
 */
export function readGlbContents(bytes: Uint8Array): ParseResult<GlbContents> {
  const errors: AssetIssue[] = []
  const contents = readContainer(bytes, errors)
  // Container errors (misaligned chunks, duplicates, header mismatch) are fatal
  // to indexing even when the JSON chunk itself parsed.
  if (contents === null || errors.length > 0) return { ok: false, errors }
  return { ok: true, value: contents }
}

/**
 * Indexes an already-parsed GLB. Structural problems are reported as issues,
 * never thrown: an agent needs a machine-readable reason, not a stack trace.
 */
export function indexGlb(contents: GlbContents): ParseResult<GlbIndex> {
  const errors: AssetIssue[] = []

  const doc = contents.doc
  const assetRecord = isRecord(doc.asset) ? doc.asset : {}
  const assetVersion = typeof assetRecord.version === 'string' ? assetRecord.version : ''
  if (!/^2\.\d+/.test(assetVersion)) {
    errors.push({
      path: 'asset.version',
      code: 'unsupported_gltf_version',
      message: `glTF asset version ${JSON.stringify(assetVersion)} is not supported; expected 2.x`,
      expected: '2.x',
      measured: assetVersion,
    })
    return { ok: false, errors }
  }
  const generator = typeof assetRecord.generator === 'string' ? assetRecord.generator : ''

  const rawAccessors = Array.isArray(doc.accessors) ? doc.accessors : []
  const rawMeshes = Array.isArray(doc.meshes) ? doc.meshes : []
  if (rawMeshes.length === 0) {
    errors.push({
      path: 'meshes',
      code: 'no_meshes',
      message: 'GLB has no meshes; a character must carry geometry',
    })
  }
  const { meshes, primitiveBounds } = readMeshes(rawMeshes, rawAccessors, errors)
  if (errors.length > 0) return { ok: false, errors }

  const rawSkins = Array.isArray(doc.skins) ? doc.skins : []
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : []
  if (rawNodes.length === 0) {
    errors.push({
      path: 'nodes',
      code: 'no_nodes',
      message: 'GLB has no nodes; a character must be placeable',
    })
    return { ok: false, errors }
  }
  const { nodes, duplicates } = readNodes(rawNodes, rawMeshes.length, rawSkins.length, errors)
  if (errors.length > 0) return { ok: false, errors }

  const skins = readSkins(rawSkins, rawNodes.length, errors)
  const rawAnimations = Array.isArray(doc.animations) ? doc.animations : []
  const animations = readAnimations(rawAnimations, rawAccessors)
  if (errors.length > 0) return { ok: false, errors }

  const rawScenes = Array.isArray(doc.scenes) ? doc.scenes : []
  let scene: number | null = null
  if (doc.scene !== undefined) {
    if (isIndex(doc.scene) && doc.scene < rawScenes.length) scene = doc.scene
    else {
      errors.push({
        path: 'scene',
        code: 'scene_out_of_range',
        message: `default scene ${JSON.stringify(doc.scene)} does not exist (${rawScenes.length} scenes)`,
        measured: doc.scene,
      })
      return { ok: false, errors }
    }
  }

  let bounds: Bounds | null = null
  let triangles = 0
  for (const node of nodes) {
    if (node.mesh === null) continue
    triangles += meshes[node.mesh].triangles
    for (const local of primitiveBounds[node.mesh]) {
      bounds = union(bounds, transformBounds(node.world, local))
    }
  }

  const named: Record<string, Vec3> = {}
  for (const node of [...nodes].sort((a, b) => a.slug.localeCompare(b.slug) || a.index - b.index)) {
    if (node.name === '') continue
    if (named[node.slug] === undefined) named[node.slug] = node.position
  }

  const materials = (Array.isArray(doc.materials) ? doc.materials : []).map((material, index) => {
    if (isRecord(material) && typeof material.name === 'string' && material.name !== '') return material.name
    return `material_${index}`
  })

  return {
    ok: true,
    value: {
      asset: { version: assetVersion, generator },
      bytes: contents.bytes,
      jsonBytes: contents.jsonBytes,
      binBytes: contents.bin?.length ?? null,
      scene,
      nodes,
      meshes,
      skins,
      animations,
      materials,
      triangles,
      bounds,
      named,
      duplicateSlugs: duplicates,
    },
  }
}

/** Convenience for callers that only need the index, such as the CLI gate. */
export function readGlbIndex(bytes: Uint8Array): ParseResult<GlbIndex> {
  const contents = readGlbContents(bytes)
  if (!contents.ok) return contents
  return indexGlb(contents.value)
}

/**
 * Resolves required socket names against named nodes. Shared by the cheap kind
 * gate and the decoder so both reject ambiguity identically.
 */
export function readSockets(index: GlbIndex, names: readonly string[]): ParseResult<Record<string, Vec3>> {
  const errors: AssetIssue[] = []
  const sockets: Record<string, Vec3> = {}

  for (const name of names) {
    if (index.duplicateSlugs.includes(name)) {
      errors.push({
        path: `contract.sockets.${name}`,
        code: 'ambiguous_socket',
        message: `more than one node normalises to '${name}'`,
        measured: index.duplicateSlugs,
      })
      continue
    }
    const position = index.named[name]
    if (position === undefined) {
      errors.push({
        path: `contract.sockets.${name}`,
        code: 'missing_socket',
        message: `no node named '${name}' in ${index.nodes.length} nodes`,
        expected: name,
      })
      continue
    }
    sockets[name] = position
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: sockets }
}

/**
 * Minimal character gate: placeable, non-empty, and carrying every socket the
 * kind contract promises. Appearance and animation are deliberately not judged.
 */
export function readCharacter(index: GlbIndex): ParseResult<CharacterReading> {
  const errors: AssetIssue[] = []

  if (index.bounds === null) {
    errors.push({
      path: '',
      code: 'no_drawable_geometry',
      message: 'no node references a mesh, so the character cannot be placed',
    })
  }
  if (index.triangles === 0) {
    errors.push({ path: '', code: 'no_triangles', message: 'the character draws no triangles' })
  }

  const socketResult = readSockets(index, CHARACTER_SOCKETS)
  if (!socketResult.ok) errors.push(...socketResult.errors)

  if (errors.length > 0 || index.bounds === null || !socketResult.ok) return { ok: false, errors }

  return {
    ok: true,
    value: {
      bounds: index.bounds,
      sockets: socketResult.value,
      triangles: index.triangles,
      meshes: index.meshes.length,
      skins: index.skins.length,
      animations: index.animations.length,
    },
  }
}
