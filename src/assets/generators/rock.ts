import type { Vec3 } from '../../core/math'
import { RockParams } from '../kinds'
import type { GeneratorOf } from '../registry'
import type { MaterialSpec } from '../types'
import { fbm } from './noise'
import { cross, icosphere, sub, TriangleSoup, unit } from './primitives'

export const ROCK_VERSION = 1

/** Nominal longest axis, metres. The displaced result lands within a few percent. */
const NOMINAL: Record<RockParams['size'], number> = { small: 0.35, medium: 0.8, boulder: 1.6 }

/**
 * Colours are sRGB and carried per vertex, so one material can hold stone and
 * moss. `material.color` stays white: it is a tint that multiplies them.
 */
const STONE: Vec3 = [0.40, 0.41, 0.39]
const MOSS: Vec3 = [0.18, 0.26, 0.12]
const MATERIAL: MaterialSpec = { color: '#ffffff', roughness: 0.92, metalness: 0 }

const AMPLITUDE: Record<RockParams['family'], number> = { angular: 0.3, rounded: 0.15, stacked: 0.22 }

/**
 * A deformed icosphere. The seed changes the noise field, so two rocks from the
 * same params differ — unlike the sword, a rock consumes randomness. Displacing
 * by position (not by index) keeps shared corners welded.
 */
export const rockGenerator: GeneratorOf<RockParams> = {
  kind: 'rock',
  version: ROCK_VERSION,
  params: RockParams,

  build(params, rng) {
    const nominal = NOMINAL[params.size]
    const seed = rng.int(1_000_000)
    const amplitude = AMPLITUDE[params.family]
    const { vertices, faces } = icosphere(params.detail)

    const shaped = vertices.map((direction): Vec3 => {
      const sample = fbm(
        [direction[0] * 1.7 + 5.3, direction[1] * 1.7 + 11.7, direction[2] * 1.7 + 2.9],
        seed,
        3,
      )
      let radius = 1 + (sample - 0.5) * 2 * amplitude

      if (params.family === 'stacked') {
        // Two lobes: the vertical profile pinches at the equator and the top.
        const t = (direction[1] + 1) / 2
        radius *= 0.74 + 0.32 * Math.abs(Math.cos(Math.PI * 2 * t))
      }

      // Squash the underside so the rock sits on a broad face, not a point.
      const y = direction[1] * radius * (direction[1] < 0 ? 0.55 : 1)
      return [(direction[0] * radius * nominal) / 2, (y * nominal) / 2, (direction[2] * radius * nominal) / 2]
    })

    // Origin is base-center: centre on X/Z, then drop the lowest point to y=0.
    const min: Vec3 = [Infinity, Infinity, Infinity]
    const max: Vec3 = [-Infinity, -Infinity, -Infinity]
    for (const point of shaped) {
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], point[axis])
        max[axis] = Math.max(max[axis], point[axis])
      }
    }
    const shift: Vec3 = [-(min[0] + max[0]) / 2, -min[1], -(min[2] + max[2]) / 2]
    const placed = shaped.map((point): Vec3 => [
      point[0] + shift[0],
      point[1] + shift[1],
      point[2] + shift[2],
    ])

    const soup = new TriangleSoup()
    for (const [a, b, c] of faces) {
      const va = placed[a]
      const vb = placed[b]
      const vc = placed[c]
      const normal = unit(cross(sub(vb, va), sub(vc, va)))
      // Moss only takes hold on faces with some sky above them.
      const mossy = normal[1] > 0.25 && rng.chance(params.moss)
      soup.tint(mossy ? MOSS : STONE)
      soup.triangle(va, vb, vc)
    }

    return { geometry: soup.build(), sockets: {}, material: MATERIAL }
  },
}
