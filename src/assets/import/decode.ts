import { transformPoint } from '../../core/math'
import type { Mat4 } from '../../core/math'
import { boundsDrift, boundsOf } from '../mesh'
import type { AssetIssue, BuiltAsset, MaterialSpec, MeshData, ParseResult } from '../types'
import { CHARACTER_SOCKETS, readSockets } from './glb'
import type { GlbContents, GlbIndex } from './glb'

/**
 * GLB accessor decoder for imported characters.
 *
 * Converts the subset of glTF 2.0 the engine can actually draw into the same
 * MeshData the procedural generators produce: float32 VEC3 positions and
 * normals, indexed or non-indexed triangles, node TRS/matrix transforms, and
 * one opaque metallic-roughness material. Everything else is rejected with an
 * issue rather than approximated.
 *
 * Deliberately not a glTF runtime: no skins, morph targets, texture sampling,
 * material extensions or animation playback. Flat normals are generated when
 * NORMAL is absent, which is what the glTF spec requires of a client.
 */

/** Bumped whenever decoding semantics change, so manifests can pin it. */
export const IMPORTER_VERSION = 1

const FLOAT = 5126
const UBYTE = 5121
const USHORT = 5123
const UINT = 5125

const COMPONENT_SIZE: Record<number, number> = {
  5120: 1,
  5121: 1,
  5122: 2,
  5123: 2,
  5125: 4,
  5126: 4,
}

const TYPE_COMPONENTS: Record<string, number> = {
  SCALAR: 1,
  VEC2: 2,
  VEC3: 3,
  VEC4: 4,
  MAT2: 4,
  MAT3: 9,
  MAT4: 16,
}

const DEFAULT_MATERIAL: MaterialSpec = { color: '#ffffff', roughness: 1, metalness: 1 }

export interface DecodedImport {
  artifact: BuiltAsset
  /** Mesh-bearing nodes that contributed at least one primitive. */
  nodesDrawn: number
  /** Triangles appended across every drawn node instance. */
  trianglesDrawn: number
  /**
   * Features present in the file that decoding ignored. Animations do not alter
   * a static mesh, so they warn instead of failing; anything that could alter
   * appearance is rejected outright.
   */
  warnings: AssetIssue[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function numberTuple(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length !== length) return null
  const out: number[] = []
  for (const entry of value) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null
    out.push(entry)
  }
  return out
}

function unitInterval(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null
  return value
}

function linearToSrgb(value: number): number {
  const clamped = Math.min(1, Math.max(0, value))
  return clamped <= 0.0031308 ? clamped * 12.92 : 1.055 * Math.pow(clamped, 1 / 2.4) - 0.055
}

function hexChannel(value: number): string {
  return Math.round(linearToSrgb(value) * 255)
    .toString(16)
    .padStart(2, '0')
}

/**
 * glTF baseColorFactor is linear; the manifest colour is sRGB, which is what
 * THREE.Color interprets. Converting here keeps the preview's albedo equal to
 * the albedo the DCC tool authored.
 */
function linearHex(r: number, g: number, b: number): string {
  return `#${hexChannel(r)}${hexChannel(g)}${hexChannel(b)}`
}

function materialKey(material: MaterialSpec): string {
  return `${material.color}|${material.roughness}|${material.metalness}|${material.doubleSided === true ? 1 : 0}`
}

function readMaterial(raw: unknown, index: number, errors: AssetIssue[]): MaterialSpec | null {
  const path = `materials[${index}]`
  if (!isRecord(raw)) {
    errors.push({ path, code: 'material_invalid', message: 'material must be an object' })
    return null
  }

  if (raw.extensions !== undefined) {
    const extensions = isRecord(raw.extensions) ? Object.keys(raw.extensions) : []
    if (extensions.length > 0) {
      errors.push({
        path: `${path}.extensions`,
        code: 'unsupported_material_extension',
        message: `material extensions are not supported: ${extensions.join(', ')}`,
        measured: extensions,
      })
      return null
    }
  }

  for (const key of ['normalTexture', 'occlusionTexture', 'emissiveTexture']) {
    if (raw[key] !== undefined) {
      errors.push({
        path: `${path}.${key}`,
        code: 'unsupported_texture',
        message: `${key} is not supported; the importer draws untextured materials`,
      })
      return null
    }
  }

  const alphaMode = raw.alphaMode === undefined ? 'OPAQUE' : raw.alphaMode
  if (alphaMode !== 'OPAQUE') {
    errors.push({
      path: `${path}.alphaMode`,
      code: 'unsupported_alpha_mode',
      message: `alphaMode ${JSON.stringify(alphaMode)} is not supported; only OPAQUE is drawn`,
      expected: 'OPAQUE',
      measured: alphaMode,
    })
    return null
  }

  const emissive = raw.emissiveFactor === undefined ? [0, 0, 0] : numberTuple(raw.emissiveFactor, 3)
  if (emissive === null || emissive.some((value) => value !== 0)) {
    errors.push({
      path: `${path}.emissiveFactor`,
      code: 'unsupported_material',
      message: 'emissive materials are not supported',
      measured: raw.emissiveFactor,
    })
    return null
  }

  const pbr = raw.pbrMetallicRoughness === undefined ? {} : raw.pbrMetallicRoughness
  if (!isRecord(pbr)) {
    errors.push({
      path: `${path}.pbrMetallicRoughness`,
      code: 'material_invalid',
      message: 'pbrMetallicRoughness must be an object',
    })
    return null
  }

  if (pbr.extensions !== undefined) {
    const extensions = isRecord(pbr.extensions) ? Object.keys(pbr.extensions) : []
    if (extensions.length > 0) {
      errors.push({
        path: `${path}.pbrMetallicRoughness.extensions`,
        code: 'unsupported_material_extension',
        message: `material extensions are not supported: ${extensions.join(', ')}`,
        measured: extensions,
      })
      return null
    }
  }

  for (const key of ['baseColorTexture', 'metallicRoughnessTexture']) {
    if (pbr[key] !== undefined) {
      errors.push({
        path: `${path}.pbrMetallicRoughness.${key}`,
        code: 'unsupported_texture',
        message: `${key} is not supported; the importer draws untextured materials`,
      })
      return null
    }
  }

  const base = pbr.baseColorFactor === undefined ? [1, 1, 1, 1] : numberTuple(pbr.baseColorFactor, 4)
  if (base === null || base.some((value) => value < 0 || value > 1)) {
    errors.push({
      path: `${path}.pbrMetallicRoughness.baseColorFactor`,
      code: 'material_invalid',
      message: 'baseColorFactor must be four numbers in [0, 1]',
      measured: pbr.baseColorFactor,
    })
    return null
  }

  const metalness = pbr.metallicFactor === undefined ? 1 : unitInterval(pbr.metallicFactor)
  if (metalness === null) {
    errors.push({
      path: `${path}.pbrMetallicRoughness.metallicFactor`,
      code: 'material_invalid',
      message: 'metallicFactor must be in [0, 1]',
      measured: pbr.metallicFactor,
    })
    return null
  }

  const roughness = pbr.roughnessFactor === undefined ? 1 : unitInterval(pbr.roughnessFactor)
  if (roughness === null) {
    errors.push({
      path: `${path}.pbrMetallicRoughness.roughnessFactor`,
      code: 'material_invalid',
      message: 'roughnessFactor must be in [0, 1]',
      measured: pbr.roughnessFactor,
    })
    return null
  }

  if (raw.doubleSided !== undefined && typeof raw.doubleSided !== 'boolean') {
    errors.push({
      path: `${path}.doubleSided`,
      code: 'material_invalid',
      message: 'doubleSided must be a boolean',
      measured: raw.doubleSided,
    })
    return null
  }

  return {
    color: linearHex(base[0], base[1], base[2]),
    roughness,
    metalness,
    ...(raw.doubleSided === true ? { doubleSided: true } : {}),
  }
}

interface BufferReading {
  /** Loaded BIN payload; only buffer 0 exists in a GLB. */
  bytes: Uint8Array
  byteLength: number
}

function readBuffer(doc: Record<string, unknown>, contents: GlbContents, errors: AssetIssue[]): BufferReading | null {
  const rawBuffers = Array.isArray(doc.buffers) ? doc.buffers : []
  if (rawBuffers.length === 0) {
    errors.push({
      path: 'buffers',
      code: 'buffer_missing',
      message: 'the file has no buffers, so accessors cannot be read',
    })
    return null
  }
  if (rawBuffers.length > 1) {
    errors.push({
      path: 'buffers[1]',
      code: 'unsupported_buffer',
      message: 'only one embedded buffer is supported in a GLB',
      measured: rawBuffers.length,
    })
    return null
  }

  const buffer = rawBuffers[0]
  if (!isRecord(buffer)) {
    errors.push({ path: 'buffers[0]', code: 'buffer_invalid', message: 'buffer must be an object' })
    return null
  }
  if (buffer.uri !== undefined) {
    errors.push({
      path: 'buffers[0].uri',
      code: 'unsupported_buffer_uri',
      message: 'external and data-URI buffers are not supported; use a GLB with an embedded BIN chunk',
      measured: buffer.uri,
    })
    return null
  }
  if (!isIndex(buffer.byteLength) || buffer.byteLength === 0) {
    errors.push({
      path: 'buffers[0].byteLength',
      code: 'buffer_invalid',
      message: 'buffer.byteLength must be a positive integer',
      measured: buffer.byteLength,
    })
    return null
  }
  if (contents.bin === null) {
    errors.push({
      path: 'buffers[0]',
      code: 'bin_chunk_missing',
      message: 'buffer 0 has no URI but the GLB has no BIN chunk',
    })
    return null
  }
  if (buffer.byteLength > contents.bin.length) {
    errors.push({
      path: 'buffers[0].byteLength',
      code: 'buffer_out_of_range',
      message: `buffer declares ${buffer.byteLength} bytes but the BIN chunk has ${contents.bin.length}`,
      expected: contents.bin.length,
      measured: buffer.byteLength,
    })
    return null
  }

  return { bytes: contents.bin, byteLength: buffer.byteLength }
}

interface AccessorLayout {
  count: number
  components: number
  componentType: number
  componentSize: number
  elementSize: number
  stride: number
  /** Offset of element 0 relative to the start of the BIN chunk. */
  start: number
}

interface AccessorOptions {
  type: string
  componentTypes: readonly number[]
  /** False for index accessors: a bufferView stride must not be defined. */
  allowStride: boolean
}

function readLayout(
  doc: Record<string, unknown>,
  accessorIndex: unknown,
  path: string,
  options: AccessorOptions,
  buffer: BufferReading,
  errors: AssetIssue[],
): AccessorLayout | null {
  if (!isIndex(accessorIndex)) {
    errors.push({
      path,
      code: 'accessor_invalid',
      message: 'attribute must reference an accessor index',
      measured: accessorIndex,
    })
    return null
  }

  const accessors = Array.isArray(doc.accessors) ? doc.accessors : []
  const accessor = accessors[accessorIndex]
  if (!isRecord(accessor)) {
    errors.push({
      path,
      code: 'accessor_out_of_range',
      message: `accessor ${accessorIndex} does not exist (${accessors.length} accessors)`,
      measured: accessorIndex,
    })
    return null
  }

  if (accessor.type !== options.type) {
    errors.push({
      path,
      code: 'accessor_type',
      message: `accessor type is ${JSON.stringify(accessor.type)}, expected '${options.type}'`,
      expected: options.type,
      measured: accessor.type,
    })
    return null
  }

  const componentType = accessor.componentType
  if (!isIndex(componentType) || !(componentType in COMPONENT_SIZE) || !options.componentTypes.includes(componentType)) {
    errors.push({
      path,
      code: 'accessor_component_type',
      message: `componentType ${JSON.stringify(componentType)} is not supported here; expected ${options.componentTypes.join(' or ')}`,
      expected: options.componentTypes,
      measured: componentType,
    })
    return null
  }

  if (!isIndex(accessor.count) || accessor.count === 0) {
    errors.push({
      path,
      code: 'accessor_empty',
      message: 'accessor.count must be a positive integer',
      measured: accessor.count,
    })
    return null
  }

  if (accessor.normalized === true) {
    errors.push({
      path,
      code: 'accessor_normalized',
      message: 'normalized accessors are not supported for this attribute',
    })
    return null
  }

  if (accessor.sparse !== undefined) {
    errors.push({
      path: `${path}.sparse`,
      code: 'unsupported_sparse_accessor',
      message: 'sparse accessors are not supported',
    })
    return null
  }

  if (!isIndex(accessor.bufferView)) {
    errors.push({
      path,
      code: 'accessor_without_buffer',
      message: 'accessor must reference a bufferView',
      measured: accessor.bufferView,
    })
    return null
  }

  const views = Array.isArray(doc.bufferViews) ? doc.bufferViews : []
  const view = views[accessor.bufferView]
  if (!isRecord(view)) {
    errors.push({
      path,
      code: 'buffer_view_out_of_range',
      message: `bufferView ${accessor.bufferView} does not exist (${views.length} views)`,
      measured: accessor.bufferView,
    })
    return null
  }

  if (!isIndex(view.buffer) || view.buffer !== 0) {
    errors.push({
      path: `${path}.bufferView`,
      code: 'unsupported_buffer',
      message: 'accessor bufferView must reference the embedded buffer 0',
      measured: view.buffer,
    })
    return null
  }

  const viewOffset = view.byteOffset === undefined ? 0 : view.byteOffset
  const viewLength = view.byteLength
  if (!isIndex(viewOffset) || !isIndex(viewLength) || viewLength === 0) {
    errors.push({
      path: `${path}.bufferView`,
      code: 'buffer_view_invalid',
      message: 'bufferView.byteOffset and byteLength must be non-negative integers, byteLength positive',
      measured: { byteOffset: viewOffset, byteLength: viewLength },
    })
    return null
  }

  const viewEnd = viewOffset + viewLength
  if (viewEnd > buffer.byteLength) {
    errors.push({
      path: `${path}.bufferView`,
      code: 'buffer_view_out_of_range',
      message: `bufferView ends at byte ${viewEnd}, buffer has ${buffer.byteLength}`,
      expected: buffer.byteLength,
      measured: viewEnd,
    })
    return null
  }

  const accessorOffset = accessor.byteOffset === undefined ? 0 : accessor.byteOffset
  if (!isIndex(accessorOffset)) {
    errors.push({
      path: `${path}.byteOffset`,
      code: 'accessor_invalid',
      message: 'accessor.byteOffset must be a non-negative integer',
      measured: accessorOffset,
    })
    return null
  }

  const components = TYPE_COMPONENTS[options.type]
  const componentSize = COMPONENT_SIZE[componentType]
  const elementSize = components * componentSize

  let stride = elementSize
  if (view.byteStride !== undefined) {
    const byteStride = view.byteStride
    if (!options.allowStride) {
      errors.push({
        path: `${path}.bufferView.byteStride`,
        code: 'accessor_stride_not_allowed',
        message: 'index accessors must not use an interleaved bufferView',
      })
      return null
    }
    if (!isIndex(byteStride) || byteStride < elementSize || byteStride % 4 !== 0 || byteStride % componentSize !== 0) {
      errors.push({
        path: `${path}.bufferView.byteStride`,
        code: 'accessor_stride_invalid',
        message: `byteStride ${JSON.stringify(byteStride)} must be at least ${elementSize} and a multiple of 4`,
        expected: { min: elementSize, multipleOf: 4 },
        measured: byteStride,
      })
      return null
    }
    stride = byteStride
  }

  const absoluteStart = viewOffset + accessorOffset
  if (absoluteStart % componentSize !== 0) {
    errors.push({
      path: `${path}.byteOffset`,
      code: 'accessor_misaligned',
      message: `element start ${absoluteStart} is not a multiple of the ${componentSize}-byte component`,
      measured: absoluteStart,
    })
    return null
  }

  const accessorEnd = accessorOffset + stride * (accessor.count - 1) + elementSize
  if (accessorEnd > viewLength) {
    errors.push({
      path,
      code: 'accessor_out_of_range',
      message: `accessor needs ${accessorEnd} bytes of a ${viewLength}-byte bufferView`,
      expected: viewLength,
      measured: accessorEnd,
    })
    return null
  }

  return {
    count: accessor.count,
    components,
    componentType,
    componentSize,
    elementSize,
    stride,
    start: absoluteStart,
  }
}

function readVec3(data: DataView, layout: AccessorLayout): Float32Array {
  const out = new Float32Array(layout.count * 3)
  for (let i = 0; i < layout.count; i++) {
    const base = layout.start + i * layout.stride
    out[i * 3] = data.getFloat32(base, true)
    out[i * 3 + 1] = data.getFloat32(base + 4, true)
    out[i * 3 + 2] = data.getFloat32(base + 8, true)
  }
  return out
}

function readIndices(data: DataView, layout: AccessorLayout): Uint32Array {
  const out = new Uint32Array(layout.count)
  for (let i = 0; i < layout.count; i++) {
    const at = layout.start + i * layout.stride
    if (layout.componentType === UBYTE) out[i] = data.getUint8(at)
    else if (layout.componentType === USHORT) out[i] = data.getUint16(at, true)
    else out[i] = data.getUint32(at, true)
  }
  return out
}

/**
 * Cofactor / determinant is the inverse-transpose for a 3x3 upper-left block,
 * which is the correct normal transform under rotation, non-uniform scale,
 * shear and mirroring. The determinant sign is what makes mirrored winding
 * decisions agree with the transformed normals.
 */
function normalMatrix(world: Mat4): { cofactors: number[]; determinant: number } {
  const a = world[0], b = world[4], c = world[8]
  const d = world[1], e = world[5], f = world[9]
  const g = world[2], h = world[6], i = world[10]

  const determinant = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g)
  const cofactors = [
    e * i - f * h,
    -(d * i - f * g),
    d * h - e * g,
    -(b * i - c * h),
    a * i - c * g,
    -(a * h - b * g),
    b * f - c * e,
    -(a * f - c * d),
    a * e - b * d,
  ]

  return { cofactors, determinant }
}

function decodeNode(
  node: GlbIndex['nodes'][number],
  rawMesh: Record<string, unknown>,
  doc: Record<string, unknown>,
  data: DataView,
  buffer: BufferReading,
  materials: readonly (MaterialSpec | null)[],
  out: { positions: number[]; normals: number[]; indices: number[] },
  chosen: { material: MaterialSpec | null },
  errors: AssetIssue[],
): boolean {
  const meshPath = `meshes[${node.mesh}]`
  const primitives = Array.isArray(rawMesh.primitives) ? rawMesh.primitives : []
  let drew = false

  const { cofactors, determinant } = normalMatrix(node.world)
  if (Math.abs(determinant) < 1e-12) {
    errors.push({
      path: `nodes[${node.index}].world`,
      code: 'degenerate_transform',
      message: 'node transform is singular, so positions and normals cannot be mapped',
      measured: determinant,
    })
    return false
  }
  const mirrored = determinant < 0

  for (let p = 0; p < primitives.length; p++) {
    const primitivePath = `${meshPath}.primitives[${p}]`
    const primitive = primitives[p]
    if (!isRecord(primitive)) {
      errors.push({ path: primitivePath, code: 'primitive_invalid', message: 'primitive must be an object' })
      continue
    }

    if (primitive.extensions !== undefined) {
      const extensions = isRecord(primitive.extensions) ? Object.keys(primitive.extensions) : []
      if (extensions.length > 0) {
        errors.push({
          path: `${primitivePath}.extensions`,
          code: 'unsupported_extension',
          message: `primitive extensions are not supported: ${extensions.join(', ')}`,
          measured: extensions,
        })
        continue
      }
    }

    if (primitive.targets !== undefined) {
      const targets = Array.isArray(primitive.targets) ? primitive.targets : null
      if (targets === null || targets.length > 0) {
        errors.push({
          path: `${primitivePath}.targets`,
          code: 'unsupported_morph_target',
          message: 'morph targets are not supported',
          measured: Array.isArray(primitive.targets) ? primitive.targets.length : primitive.targets,
        })
        continue
      }
    }

    const attributes = isRecord(primitive.attributes) ? primitive.attributes : {}
    for (const name of ['COLOR_0', 'JOINTS_0', 'WEIGHTS_0']) {
      if (attributes[name] !== undefined) {
        errors.push({
          path: `${primitivePath}.attributes.${name}`,
          code: 'unsupported_attribute',
          message: `${name} is not supported; colour and skinning attributes are not drawn`,
        })
      }
    }
    if (errors.some((issue) => issue.path.startsWith(`${primitivePath}.attributes.`))) continue

    const positionLayout = readLayout(
      doc,
      attributes.POSITION,
      `${primitivePath}.attributes.POSITION`,
      { type: 'VEC3', componentTypes: [FLOAT], allowStride: true },
      buffer,
      errors,
    )
    if (positionLayout === null) continue
    const positions = readVec3(data, positionLayout)
    const vertexCount = positions.length / 3

    let normalLayout: AccessorLayout | null = null
    if (attributes.NORMAL !== undefined) {
      normalLayout = readLayout(
        doc,
        attributes.NORMAL,
        `${primitivePath}.attributes.NORMAL`,
        { type: 'VEC3', componentTypes: [FLOAT], allowStride: true },
        buffer,
        errors,
      )
      if (normalLayout === null) continue
    }

    let indices: Uint32Array
    if (primitive.indices !== undefined) {
      const indexLayout = readLayout(
        doc,
        primitive.indices,
        `${primitivePath}.indices`,
        { type: 'SCALAR', componentTypes: [UBYTE, USHORT, UINT], allowStride: false },
        buffer,
        errors,
      )
      if (indexLayout === null) continue
      indices = readIndices(data, indexLayout)
    } else {
      indices = new Uint32Array(vertexCount)
      for (let i = 0; i < vertexCount; i++) indices[i] = i
    }

    if (indices.length % 3 !== 0) {
      errors.push({
        path: primitivePath,
        code: 'primitive_not_triangles',
        message: `${indices.length} indices do not form whole triangles`,
        measured: indices.length,
      })
      continue
    }

    let outOfRange: number | null = null
    for (const index of indices) {
      if (index >= vertexCount) {
        outOfRange = index
        break
      }
    }
    if (outOfRange !== null) {
      errors.push({
        path: `${primitivePath}.indices`,
        code: 'index_out_of_range',
        message: `index ${outOfRange} refers past ${vertexCount} vertices`,
        expected: vertexCount,
        measured: outOfRange,
      })
      continue
    }

    let spec: MaterialSpec = DEFAULT_MATERIAL
    if (primitive.material !== undefined) {
      if (!isIndex(primitive.material) || primitive.material >= materials.length) {
        errors.push({
          path: `${primitivePath}.material`,
          code: 'material_out_of_range',
          message: `material ${JSON.stringify(primitive.material)} does not exist (${materials.length} materials)`,
          measured: primitive.material,
        })
        continue
      }
      const decoded = materials[primitive.material]
      if (decoded === null) continue
      spec = decoded
    }

    if (chosen.material === null) chosen.material = spec
    else if (materialKey(chosen.material) !== materialKey(spec)) {
      errors.push({
        path: `${primitivePath}.material`,
        code: 'mixed_materials',
        message:
          'one imported asset must use a single material; geometry with different materials cannot be merged honestly',
        expected: chosen.material,
        measured: spec,
      })
      continue
    }

    const normals = normalLayout === null ? null : readVec3(data, normalLayout)
    const vertexOffset = out.positions.length / 3

    if (normals !== null) {
      for (let i = 0; i < vertexCount; i++) {
        const point = transformPoint(node.world, [positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]])
        out.positions.push(point[0], point[1], point[2])

        const nx = cofactors[0] * normals[i * 3] + cofactors[1] * normals[i * 3 + 1] + cofactors[2] * normals[i * 3 + 2]
        const ny = cofactors[3] * normals[i * 3] + cofactors[4] * normals[i * 3 + 1] + cofactors[5] * normals[i * 3 + 2]
        const nz = cofactors[6] * normals[i * 3] + cofactors[7] * normals[i * 3 + 1] + cofactors[8] * normals[i * 3 + 2]
        const length = Math.hypot(nx, ny, nz)
        if (length < 1e-8) {
          errors.push({
            path: `${primitivePath}.attributes.NORMAL`,
            code: 'invalid_normal',
            message: `vertex ${i} normal has zero length after the node transform`,
            measured: i,
          })
          return false
        }
        out.normals.push(nx / length, ny / length, nz / length)
      }

      for (let t = 0; t < indices.length; t += 3) {
        const a = indices[t]
        const b = indices[t + 1]
        const c = indices[t + 2]
        // Mirroring flips handedness; reverse the winding so front faces keep
        // pointing the same way as the transformed normals.
        if (mirrored) out.indices.push(vertexOffset + a, vertexOffset + c, vertexOffset + b)
        else out.indices.push(vertexOffset + a, vertexOffset + b, vertexOffset + c)
      }
    } else {
      // No NORMAL: glTF requires clients to compute flat normals. De-index the
      // primitive so each triangle owns its three vertex normals.
      for (let t = 0; t < indices.length; t += 3) {
        let a = indices[t]
        let b = indices[t + 1]
        let c = indices[t + 2]
        if (mirrored) {
          const swap = b
          b = c
          c = swap
        }

        const p0 = transformPoint(node.world, [positions[a * 3], positions[a * 3 + 1], positions[a * 3 + 2]])
        const p1 = transformPoint(node.world, [positions[b * 3], positions[b * 3 + 1], positions[b * 3 + 2]])
        const p2 = transformPoint(node.world, [positions[c * 3], positions[c * 3 + 1], positions[c * 3 + 2]])

        const ux = p1[0] - p0[0], uy = p1[1] - p0[1], uz = p1[2] - p0[2]
        const vx = p2[0] - p0[0], vy = p2[1] - p0[1], vz = p2[2] - p0[2]
        const nx = uy * vz - uz * vy
        const ny = uz * vx - ux * vz
        const nz = ux * vy - uy * vx
        const length = Math.hypot(nx, ny, nz)
        if (length < 1e-12) {
          errors.push({
            path: primitivePath,
            code: 'degenerate_triangle',
            message: `triangle ${t / 3} has zero area, so it has no normal`,
            measured: t / 3,
          })
          return false
        }

        const vertex = out.positions.length / 3
        out.positions.push(p0[0], p0[1], p0[2], p1[0], p1[1], p1[2], p2[0], p2[1], p2[2])
        out.normals.push(nx / length, ny / length, nz / length, nx / length, ny / length, nz / length, nx / length, ny / length, nz / length)
        out.indices.push(vertex, vertex + 1, vertex + 2)
      }
    }

    drew = true
  }

  return drew
}

/**
 * Decodes a GLB into MeshData. Structural problems are issues, never throws.
 * The index must have been produced from the same contents.
 */
export function decodeGlb(contents: GlbContents, index: GlbIndex): ParseResult<DecodedImport> {
  const errors: AssetIssue[] = []
  const warnings: AssetIssue[] = []
  const doc = contents.doc

  const required = Array.isArray(doc.extensionsRequired) ? doc.extensionsRequired : []
  const used = Array.isArray(doc.extensionsUsed) ? doc.extensionsUsed : []
  if (required.length > 0) {
    errors.push({
      path: 'extensionsRequired',
      code: 'unsupported_extension',
      message: `required extensions are not supported: ${required.join(', ')}`,
      measured: required,
    })
  }
  if (used.length > 0) {
    errors.push({
      path: 'extensionsUsed',
      code: 'unsupported_extension',
      message: `glTF extensions are not supported: ${used.join(', ')}`,
      measured: used,
    })
  }
  if (errors.length > 0) return { ok: false, errors }

  if (index.skins.length > 0) {
    errors.push({
      path: 'skins',
      code: 'unsupported_skin',
      message: 'skins are not supported; export the character in a static pose without an armature',
      measured: index.skins.length,
    })
  }
  for (const node of index.nodes) {
    if (node.skin !== null) {
      errors.push({
        path: `nodes[${node.index}].skin`,
        code: 'unsupported_skin',
        message: 'skinned nodes are not supported; export the character in a static pose without an armature',
        measured: node.skin,
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  const rawMeshes = Array.isArray(doc.meshes) ? doc.meshes : []
  for (let i = 0; i < rawMeshes.length; i++) {
    const mesh = rawMeshes[i]
    if (isRecord(mesh) && Array.isArray(mesh.weights) && mesh.weights.length > 0) {
      errors.push({
        path: `meshes[${i}].weights`,
        code: 'unsupported_morph_target',
        message: 'mesh morph weights are not supported',
        measured: mesh.weights.length,
      })
    }
  }
  const rawNodes = Array.isArray(doc.nodes) ? doc.nodes : []
  for (let i = 0; i < rawNodes.length; i++) {
    const node = rawNodes[i]
    if (isRecord(node) && Array.isArray(node.weights) && node.weights.length > 0) {
      errors.push({
        path: `nodes[${i}].weights`,
        code: 'unsupported_morph_target',
        message: 'node morph weights are not supported',
        measured: node.weights.length,
      })
    }
  }
  if (errors.length > 0) return { ok: false, errors }

  if (index.animations.length > 0) {
    warnings.push({
      path: 'animations',
      code: 'animations_ignored',
      message: `${index.animations.length} animation clip(s) are indexed but not played; the manifest describes the static mesh`,
      measured: index.animations.length,
    })
  }

  const buffer = readBuffer(doc, contents, errors)
  if (buffer === null) return { ok: false, errors }

  const rawMaterials = Array.isArray(doc.materials) ? doc.materials : []
  const materials: (MaterialSpec | null)[] = []
  for (let i = 0; i < rawMaterials.length; i++) materials.push(readMaterial(rawMaterials[i], i, errors))
  if (errors.length > 0) return { ok: false, errors }

  const data = new DataView(buffer.bytes.buffer, buffer.bytes.byteOffset, buffer.bytes.byteLength)
  const out = { positions: [] as number[], normals: [] as number[], indices: [] as number[] }
  const chosen: { material: MaterialSpec | null } = { material: null }
  let nodesDrawn = 0
  let trianglesDrawn = 0

  for (const node of index.nodes) {
    if (node.mesh === null) continue
    const rawMesh = rawMeshes[node.mesh]
    if (!isRecord(rawMesh)) {
      errors.push({
        path: `meshes[${node.mesh}]`,
        code: 'mesh_invalid',
        message: 'mesh must be an object',
      })
      continue
    }

    const before = out.indices.length
    const drew = decodeNode(node, rawMesh, doc, data, buffer, materials, out, chosen, errors)
    if (drew) {
      nodesDrawn += 1
      trianglesDrawn += (out.indices.length - before) / 3
    }
  }

  if (errors.length > 0) return { ok: false, errors }

  if (out.indices.length === 0) {
    errors.push({
      path: '',
      code: 'no_drawable_geometry',
      message: 'no mesh-bearing node produced a triangle',
    })
    return { ok: false, errors }
  }

  const geometry: MeshData = {
    positions: new Float32Array(out.positions),
    normals: new Float32Array(out.normals),
    indices: new Uint32Array(out.indices),
  }

  for (let i = 0; i < geometry.positions.length; i++) {
    if (!Number.isFinite(geometry.positions[i])) {
      errors.push({
        path: 'accessors.POSITION',
        code: 'non_finite_position',
        message: `vertex ${Math.floor(i / 3)} has a non-finite position component`,
        measured: i,
      })
      break
    }
  }
  for (let i = 0; i < geometry.normals.length; i++) {
    if (!Number.isFinite(geometry.normals[i])) {
      errors.push({
        path: 'accessors.NORMAL',
        code: 'non_finite_normal',
        message: `vertex ${Math.floor(i / 3)} has a non-finite normal component`,
        measured: i,
      })
      break
    }
  }

  if (geometry.indices.length / 3 !== index.triangles) {
    errors.push({
      path: '',
      code: 'triangle_count_mismatch',
      message: `decoded ${geometry.indices.length / 3} triangles but the index counted ${index.triangles}`,
      expected: index.triangles,
      measured: geometry.indices.length / 3,
    })
  }

  const socketResult = readSockets(index, CHARACTER_SOCKETS)
  if (!socketResult.ok) errors.push(...socketResult.errors)

  if (errors.length > 0 || !socketResult.ok) return { ok: false, errors }

  const measuredBounds = boundsOf(geometry)
  if (index.bounds !== null) {
    const drift = boundsDrift(measuredBounds, index.bounds)
    if (drift > 1e-4) {
      warnings.push({
        path: 'accessors.POSITION',
        code: 'declared_bounds_mismatch',
        message: `decoded bounds differ from declared accessor min/max by ${drift.toExponential(2)} m; the manifest must use decoded bounds`,
        expected: index.bounds,
        measured: measuredBounds,
      })
    }
  }

  return {
    ok: true,
    value: {
      artifact: {
        geometry,
        sockets: socketResult.value,
        material: chosen.material ?? DEFAULT_MATERIAL,
      },
      nodesDrawn,
      trianglesDrawn,
      warnings,
    },
  }
}
