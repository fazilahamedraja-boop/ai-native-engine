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
  return true
}

/**
 * Closed-manifold test: every directed edge appears exactly once and its
 * reverse appears exactly once. Separate closed shells (a sword's blade, guard
 * and pommel) each satisfy this independently, which is what we want.
 */
export function isWatertight(mesh: MeshData): boolean {
  const vertexCount = mesh.positions.length / 3
  const edges = new Map<number, number>()
  const key = (a: number, b: number): number => a * vertexCount + b

  for (let i = 0; i < mesh.indices.length; i += 3) {
    const v0 = mesh.indices[i]
    const v1 = mesh.indices[i + 1]
    const v2 = mesh.indices[i + 2]
    const triangle = [v0, v1, v2]
    for (let e = 0; e < 3; e++) {
      const k = key(triangle[e], triangle[(e + 1) % 3])
      edges.set(k, (edges.get(k) ?? 0) + 1)
    }
  }

  for (const [k, count] of edges) {
    if (count !== 1) return false
    const a = Math.floor(k / vertexCount)
    const b = k % vertexCount
    if ((edges.get(key(b, a)) ?? 0) !== 1) return false
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
  for (const name of Object.keys(asset.sockets).sort()) {
    const socket = asset.sockets[name]
    values.push(socket[0], socket[1], socket[2])
  }
  return hashNumbers64(values)
}
