import type { Vec3 } from '../../core/math'
import { SwordParams } from '../kinds'
import type { GeneratorOf } from '../registry'
import type { MaterialSpec } from '../types'
import { TriangleSoup } from './primitives'

export const SWORD_VERSION = 1

const MATERIALS: Record<SwordParams['material'], MaterialSpec> = {
  iron: { color: '#8b9099', roughness: 0.55, metalness: 0.7 },
  steel: { color: '#c9ced6', roughness: 0.3, metalness: 0.9 },
  bronze: { color: '#b18b58', roughness: 0.45, metalness: 0.75 },
}

const BLADE_WIDTH: Record<SwordParams['bladeWidth'], number> = { narrow: 0.045, broad: 0.07 }

/**
 * Fixed proportions, metres. `length` is tip-to-pommel, so the pommel hangs
 * POMMEL_DEPTH below the grip origin and the tip sits at length - POMMEL_DEPTH.
 *
 * A sword is a manufactured object: there is no randomness, so the seed is not
 * consumed. Determinism is still asserted by the suite.
 */
const POMMEL_DEPTH = 0.1
const POMMEL_RADIUS = 0.026
const GRIP_RADIUS = 0.016
const GUARD_Y = 0.145
const GUARD_WIDTH = 0.22
const BLADE_BASE = 0.15
const BLADE_THICKNESS = 0.012
const TAPER_LENGTH = 0.2

export const swordGenerator: GeneratorOf<SwordParams> = {
  kind: 'sword',
  version: SWORD_VERSION,
  params: SwordParams,

  build(params) {
    const soup = new TriangleSoup()
    const tipY = params.length - POMMEL_DEPTH
    const width = BLADE_WIDTH[params.bladeWidth]

    if (tipY <= BLADE_BASE + 0.05) {
      throw new Error(`length ${params.length} leaves no blade above the guard`)
    }

    // Pommel and grip: closed shells that overlap slightly inside the guard.
    soup.cylinder([0, -POMMEL_DEPTH, 0], [0, -0.075, 0], POMMEL_RADIUS, POMMEL_RADIUS, 10)
    soup.cylinder([0, -0.08, 0], [0, 0.16, 0], GRIP_RADIUS, GRIP_RADIUS, 8)

    if (params.guard === 'cross') {
      soup.box([0, GUARD_Y, 0], [GUARD_WIDTH, 0.022, 0.036])
    } else if (params.guard === 'disc') {
      soup.cylinder([0, GUARD_Y - 0.01, 0], [0, GUARD_Y + 0.01, 0], 0.05, 0.05, 12)
    }

    // Diamond cross-section, counter-clockwise seen from +Y: +X, -Z, -X, +Z.
    const ring = (y: number, w: number): Vec3[] => [
      [w / 2, y, 0],
      [0, y, -BLADE_THICKNESS / 2],
      [-w / 2, y, 0],
      [0, y, BLADE_THICKNESS / 2],
    ]

    const taperY = Math.max(BLADE_BASE + 0.06, tipY - TAPER_LENGTH)
    const base = ring(BLADE_BASE, width)
    const shoulder = ring(taperY, width * 0.82)

    for (let i = 0; i < 4; i++) {
      const j = (i + 1) % 4
      soup.quad(base[i], base[j], shoulder[j], shoulder[i])
    }

    // Cap the base so the blade is a closed shell even with guard: 'none'.
    for (let i = 1; i < 3; i++) soup.triangle(base[0], base[i + 1], base[i])

    const apex: Vec3 = [0, tipY, 0]
    for (let i = 0; i < 4; i++) soup.triangle(shoulder[i], shoulder[(i + 1) % 4], apex)

    return {
      geometry: soup.build(),
      sockets: {
        grip: [0, 0, 0],
        blade_mid: [0, (BLADE_BASE + tipY) / 2, 0],
        tip: [0, tipY, 0],
      },
      material: MATERIALS[params.material],
    }
  },
}
