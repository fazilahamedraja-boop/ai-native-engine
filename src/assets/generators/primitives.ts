import type { Vec3 } from '../../core/math'
import type { MeshData } from '../types'

export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const mul = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
]
export const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2])

export function unit(a: Vec3): Vec3 {
  const n = len(a)
  if (n < 1e-12) throw new Error('cannot normalise a zero vector')
  return mul(a, 1 / n)
}

/** Orthonormal basis around an axis, for building rings of vertices. */
export function basisFor(axis: Vec3): { u: Vec3; v: Vec3 } {
  const helper: Vec3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
  const u = unit(cross(axis, helper))
  return { u, v: cross(axis, u) }
}

/** A ring of `segments` points around `center`, perpendicular to `axis`. */
export function ring(center: Vec3, axis: Vec3, radius: number, segments: number): Vec3[] {
  const { u, v } = basisFor(axis)
  return Array.from({ length: segments }, (_, i) => {
    const angle = (i / segments) * Math.PI * 2
    return add(center, add(mul(u, Math.cos(angle) * radius), mul(v, Math.sin(angle) * radius)))
  })
}

/** Unit icosahedron subdivided `detail` times, vertices welded on the sphere. */
export function icosphere(detail: number): { vertices: Vec3[]; faces: Array<[number, number, number]> } {
  if (!Number.isInteger(detail) || detail < 0 || detail > 4) {
    throw new Error(`icosphere detail must be an integer in 0..4, got ${detail}`)
  }

  const golden = (1 + Math.sqrt(5)) / 2
  const vertices: Vec3[] = (
    [
      [-1, golden, 0], [1, golden, 0], [-1, -golden, 0], [1, -golden, 0],
      [0, -1, golden], [0, 1, golden], [0, -1, -golden], [0, 1, -golden],
      [golden, 0, -1], [golden, 0, 1], [-golden, 0, -1], [-golden, 0, 1],
    ] as Vec3[]
  ).map(unit)

  let faces: Array<[number, number, number]> = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]

  for (let level = 0; level < detail; level++) {
    const midpoints = new Map<string, number>()
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      const cached = midpoints.get(key)
      if (cached !== undefined) return cached
      const va = vertices[a]
      const vb = vertices[b]
      const index = vertices.length
      vertices.push(unit([(va[0] + vb[0]) / 2, (va[1] + vb[1]) / 2, (va[2] + vb[2]) / 2]))
      midpoints.set(key, index)
      return index
    }

    const next: Array<[number, number, number]> = []
    for (const [a, b, c] of faces) {
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca])
    }
    faces = next
  }

  return { vertices, faces }
}

/**
 * Flat-shaded triangle soup.
 *
 * Vertices are emitted per face rather than welded, so hard edges keep their
 * own normals. Watertightness is therefore judged on vertex *positions*, not on
 * shared indices — see mesh.ts isWatertight.
 */
export class TriangleSoup {
  readonly #positions: number[] = []
  readonly #normals: number[] = []
  readonly #indices: number[] = []
  readonly #colors: number[] = []
  #hasColors = false
  #color: Vec3 = [1, 1, 1]

  /**
   * Sets the colour for every triangle emitted until the next call. Colours are
   * opt-in per soup: one tint() makes the whole mesh carry vertex colours.
   */
  tint(color: Vec3): void {
    this.#color = color
    this.#hasColors = true
  }

  triangle(a: Vec3, b: Vec3, c: Vec3): void {
    const normal = cross(sub(b, a), sub(c, a))
    if (len(normal) < 1e-12) throw new Error('generator emitted a degenerate triangle')
    const n = unit(normal)
    const base = this.#positions.length / 3
    for (const point of [a, b, c]) this.#positions.push(point[0], point[1], point[2])
    for (let i = 0; i < 3; i++) {
      this.#normals.push(n[0], n[1], n[2])
      this.#colors.push(this.#color[0], this.#color[1], this.#color[2])
    }
    this.#indices.push(base, base + 1, base + 2)
  }

  /** a, b, c, d must be counter-clockwise seen from outside. */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void {
    this.triangle(a, b, c)
    this.triangle(a, c, d)
  }

  box(center: Vec3, size: Vec3): void {
    const [cx, cy, cz] = center
    const hx = size[0] / 2
    const hy = size[1] / 2
    const hz = size[2] / 2
    const v = (sx: number, sy: number, sz: number): Vec3 => [cx + sx * hx, cy + sy * hy, cz + sz * hz]

    this.quad(v(-1, -1, 1), v(1, -1, 1), v(1, 1, 1), v(-1, 1, 1))
    this.quad(v(1, -1, -1), v(-1, -1, -1), v(-1, 1, -1), v(1, 1, -1))
    this.quad(v(1, -1, 1), v(1, -1, -1), v(1, 1, -1), v(1, 1, 1))
    this.quad(v(-1, -1, -1), v(-1, -1, 1), v(-1, 1, 1), v(-1, 1, -1))
    this.quad(v(-1, 1, 1), v(1, 1, 1), v(1, 1, -1), v(-1, 1, -1))
    this.quad(v(-1, -1, -1), v(1, -1, -1), v(1, -1, 1), v(-1, -1, 1))
  }

  /** Closed cylinder or truncated cone along from -> to, with both caps. */
  cylinder(from: Vec3, to: Vec3, radiusBottom: number, radiusTop: number, segments: number): void {
    if (segments < 3) throw new Error(`a cylinder needs at least 3 segments, got ${segments}`)
    if (radiusBottom <= 0 || radiusTop <= 0) throw new Error('cylinder radii must be positive')

    const axis = unit(sub(to, from))
    const helper: Vec3 = Math.abs(axis[1]) > 0.9 ? [1, 0, 0] : [0, 1, 0]
    const u = unit(cross(axis, helper))
    const v = cross(axis, u)

    const ring = (center: Vec3, radius: number): Vec3[] =>
      Array.from({ length: segments }, (_, i) => {
        const angle = (i / segments) * Math.PI * 2
        return add(center, add(mul(u, Math.cos(angle) * radius), mul(v, Math.sin(angle) * radius)))
      })

    const bottom = ring(from, radiusBottom)
    const top = ring(to, radiusTop)

    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      this.quad(bottom[i], bottom[j], top[j], top[i])
    }
    for (let i = 1; i < segments - 1; i++) {
      this.triangle(bottom[0], bottom[i + 1], bottom[i])
      this.triangle(top[0], top[i], top[i + 1])
    }
  }

  build(): MeshData {
    const mesh: MeshData = {
      positions: new Float32Array(this.#positions),
      normals: new Float32Array(this.#normals),
      indices: new Uint32Array(this.#indices),
    }
    if (this.#hasColors) mesh.colors = new Float32Array(this.#colors)
    return mesh
  }
}
