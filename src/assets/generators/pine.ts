import type { Vec3 } from '../../core/math'
import { PineParams } from '../kinds'
import type { GeneratorOf } from '../registry'
import type { MaterialSpec } from '../types'
import { TriangleSoup, ring } from './primitives'

export const PINE_VERSION = 1

const FOLIAGE: Vec3 = [0.17, 0.31, 0.18]
const UNDERSIDE: Vec3 = [0.11, 0.18, 0.12]
const BARK: Vec3 = [0.28, 0.20, 0.13]
const SNOW: Vec3 = [0.88, 0.90, 0.93]
const MATERIAL: MaterialSpec = { color: '#ffffff', roughness: 0.88, metalness: 0 }

const UP: Vec3 = [0, 1, 0]

/**
 * One closed cone. The base cap is what makes it a shell: without it the bottom
 * ring's edges are unpaired and the whole pine fails the watertight check.
 */
function cone(
  soup: TriangleSoup,
  baseY: number,
  apexY: number,
  radius: number,
  segments: number,
  snowLine: number,
): void {
  const base: Vec3 = [0, baseY, 0]
  const apex: Vec3 = [0, apexY, 0]
  const bottom = ring(base, UP, radius, segments)

  if (snowLine > 0) {
    const waistY = baseY + (apexY - baseY) * (1 - snowLine)
    const waist = ring([0, waistY, 0], UP, radius * snowLine, segments)
    soup.tint(FOLIAGE)
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      soup.quad(bottom[i], bottom[j], waist[j], waist[i])
    }
    soup.tint(SNOW)
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      soup.triangle(waist[i], waist[j], apex)
    }
  } else {
    soup.tint(FOLIAGE)
    for (let i = 0; i < segments; i++) {
      const j = (i + 1) % segments
      soup.triangle(bottom[i], bottom[j], apex)
    }
  }

  soup.tint(UNDERSIDE)
  for (let i = 0; i < segments; i++) {
    soup.triangle(base, bottom[(i + 1) % segments], bottom[i])
  }
}

/**
 * Stacked cones over a trunk. Tiers are laid out so the topmost apex is exactly
 * `height`, which is the contract the manifest declares.
 */
export const pineGenerator: GeneratorOf<PineParams> = {
  kind: 'pine',
  version: PINE_VERSION,
  params: PineParams,

  build(params) {
    const height = params.height
    const tiers = params.tiers
    const segments = 12
    const spread = params.spread === 'wide' ? 0.3 : 0.21
    const baseRadius = spread * height
    const trunkHeight = 0.45 * height

    const soup = new TriangleSoup()
    soup.tint(BARK)
    soup.cylinder([0, 0, 0], [0, trunkHeight, 0], 0.022 * height, 0.014 * height, 8)

    // Foliage occupies 0.12H..1.0H. Each tier is about 0.3H tall regardless of
    // how many there are, and the topmost apex lands on `height` exactly, so the
    // declared bound is a consequence of the layout rather than a fudge.
    const foliageStart = 0.12 * height
    const foliageSpan = 0.88 * height

    for (let tier = 0; tier < tiers; tier++) {
      const t = tiers === 1 ? 0 : tier / (tiers - 1)
      const baseY = foliageStart + foliageSpan * (tier / tiers) * 0.82
      const apexY = foliageStart + foliageSpan * (0.2 + (0.8 * (tier + 1)) / tiers)
      const radius = baseRadius * (1 - 0.72 * t)
      cone(soup, baseY, apexY, radius, segments, params.snow ? 0.22 : 0)
    }

    return {
      geometry: soup.build(),
      sockets: { base: [0, 0, 0] },
      material: MATERIAL,
    }
  },
}
