import type { Vec3 } from '../../core/math'

/**
 * Position-keyed value noise.
 *
 * Deterministic by construction: the value at a point depends only on the point
 * and the seed, never on iteration order. That is what lets a rock displace its
 * vertices in place without welding seams — two faces that share a corner
 * compute the same displacement for it.
 */

function hash3(x: number, y: number, z: number, seed: number): number {
  let h = seed ^ Math.imul(x, 374761393) ^ Math.imul(y, 668265263) ^ Math.imul(z, 1274126177)
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  h ^= h >>> 16
  return (h >>> 0) / 4294967295
}

const fade = (t: number): number => t * t * (3 - 2 * t)
const mix = (a: number, b: number, t: number): number => a + (b - a) * t

/** Trilinear value noise in [0,1]. */
export function valueNoise(point: Vec3, seed: number): number {
  const xi = Math.floor(point[0])
  const yi = Math.floor(point[1])
  const zi = Math.floor(point[2])
  const fx = fade(point[0] - xi)
  const fy = fade(point[1] - yi)
  const fz = fade(point[2] - zi)

  const corner = (dx: number, dy: number, dz: number): number => hash3(xi + dx, yi + dy, zi + dz, seed)

  const x00 = mix(corner(0, 0, 0), corner(1, 0, 0), fx)
  const x10 = mix(corner(0, 1, 0), corner(1, 1, 0), fx)
  const x01 = mix(corner(0, 0, 1), corner(1, 0, 1), fx)
  const x11 = mix(corner(0, 1, 1), corner(1, 1, 1), fx)

  return mix(mix(x00, x10, fy), mix(x01, x11, fy), fz)
}

/** Sum of octaves, normalised to [0,1]. */
export function fbm(point: Vec3, seed: number, octaves: number): number {
  let total = 0
  let amplitude = 1
  let frequency = 1
  let normaliser = 0

  for (let octave = 0; octave < octaves; octave++) {
    const sample: Vec3 = [point[0] * frequency, point[1] * frequency, point[2] * frequency]
    total += amplitude * valueNoise(sample, seed + octave * 101)
    normaliser += amplitude
    amplitude *= 0.5
    frequency *= 2.03
  }

  return total / normaliser
}
