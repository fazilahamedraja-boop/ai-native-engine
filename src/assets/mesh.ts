import { hashNumbers64 } from '../core/hash'
import type { Vec3 } from '../core/math'
import type { Bounds, BuiltAsset, MeshData } from './types'

export interface MeshStats {
  vertices: number
  triangles: number
}

export function statsOf(mesh: MeshData): MeshStats {
  return { vertices: mesh.positions.length / 3, triangles: mesh.indices.length / 3 }
}

export function boundsOf(mesh: MeshData): Bounds {
  if (mesh.positions.length === 0) return { min: [0, 0, 0], max: [0, 0, 0] }

  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]

  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let axis = 0; axis < 3; axis++) {
      const value = mesh.positions[i + axis]
      if (value < min[axis]) min[axis] = value
      if (value > max[axis]) max[axis] = value
    }
  }

  return { min, max }
}

/** Largest per-axis difference between two bounds, in metres. */
export function boundsDrift(a: Bounds, b: Bounds): number {
  let worst = 0
  for (let axis = 0; axis < 3; axis++) {
    worst = Math.max(worst, Math.abs(a.min[axis] - b.min[axis]), Math.abs(a.max[axis] - b.max[axis]))
  }
  return worst
}

export function isFiniteMesh(mesh: MeshData): boolean {
  for (const value of mesh.positions) if (!Number.isFinite(value)) return false
  for (const value of mesh.normals) if (!Number.isFinite(value)) return false
  const vertexCount = mesh.positions.length / 3
  for (const index of mesh.indices) if (index < 0 || index >= vertexCount) return false

  if (mesh.colors !== undefined) {
    if (mesh.colors.length !== mesh.positions.length) return false
    for (const value of mesh.colors) if (!Number.isFinite(value) || value < 0 || value > 1) return false
  }

  return true
}

/**
 * Closed-manifold test: every directed edge appears exactly once and its
 * reverse appears exactly once. Separate closed shells (a sword's blade, guard
 * and pommel) each satisfy this independently, which is what we want.
 *
 * Edges are paired by quantised vertex *position*, not by index, because
 * flat-shaded geometry duplicates vertices along hard edges. Judging cracks by
 * index would report every cube as open.
 */
export function isWatertight(mesh: MeshData): boolean {
  const vertexIds = new Map<string, number>()
  const ids = new Int32Array(mesh.positions.length / 3)

  for (let i = 0; i < ids.length; i++) {
    const key = `${Math.round(mesh.positions[i * 3] * 1e5)},${Math.round(mesh.positions[i * 3 + 1] * 1e5)},${Math.round(mesh.positions[i * 3 + 2] * 1e5)}`
    let id = vertexIds.get(key)
    if (id === undefined) {
      id = vertexIds.size
      vertexIds.set(key, id)
    }
    ids[i] = id
  }

  const edges = new Map<string, number>()
  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = ids[mesh.indices[i]]
    const b = ids[mesh.indices[i + 1]]
    const c = ids[mesh.indices[i + 2]]
    for (const [from, to] of [
      [a, b],
      [b, c],
      [c, a],
    ]) {
      const key = `${from}>${to}`
      edges.set(key, (edges.get(key) ?? 0) + 1)
    }
  }

  for (const [key, count] of edges) {
    if (count !== 1) return false
    const [from, to] = key.split('>')
    if ((edges.get(`${to}>${from}`) ?? 0) !== 1) return false
  }

  return true
}

/** Rejects zero-area triangles, which render as invisible seams. */
export function hasPositiveArea(mesh: MeshData): boolean {
  const p = mesh.positions
  const longest = p.length / 3
  let checked = 0

  for (let i = 0; i < mesh.indices.length; i += 3) {
    const a = mesh.indices[i]
    const b = mesh.indices[i + 1]
    const c = mesh.indices[i + 2]
    if (a >= longest || b >= longest || c >= longest) return false

    const ax = p[a * 3], ay = p[a * 3 + 1], az = p[a * 3 + 2]
    const bx = p[b * 3], by = p[b * 3 + 1], bz = p[b * 3 + 2]
    const cx = p[c * 3], cy = p[c * 3 + 1], cz = p[c * 3 + 2]

    const ux = bx - ax, uy = by - ay, uz = bz - az
    const vx = cx - ax, vy = cy - ay, vz = cz - az
    const nx = uy * vz - uz * vy
    const ny = uz * vx - ux * vz
    const nz = ux * vy - uy * vx
    if (Math.hypot(nx, ny, nz) <= 1e-12) return false
    checked += 1
  }

  return checked > 0
}

/**
 * Identity of a built artifact. Covers geometry and sockets, not the manifest,
 * so a param rename that produces identical output keeps the same hash.
 */
export function artifactHash(asset: BuiltAsset): string {
  const values: number[] = []
  for (const value of asset.geometry.positions) values.push(value)
  for (const value of asset.geometry.normals) values.push(value)
  for (const index of asset.geometry.indices) values.push(index)
  // Only folded in when present, so adding colour support did not change the
  // hash of assets that never had it.
  if (asset.geometry.colors !== undefined) for (const value of asset.geometry.colors) values.push(value)
  for (const name of Object.keys(asset.sockets).sort()) {
    const socket = asset.sockets[name]
    values.push(socket[0], socket[1], socket[2])
  }
  values.push(parseInt(asset.material.color.slice(1), 16), asset.material.roughness, asset.material.metalness)
  return hashNumbers64(values)
}
