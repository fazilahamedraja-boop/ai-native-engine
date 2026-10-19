import type { Vec3 } from '../core/math'
import { add, clamp, length, scale, sub } from '../core/math'

export interface Box {
  min: Vec3
  max: Vec3
}

/** Vertical capsule: a segment along Y plus a radius. */
export interface Capsule {
  center: Vec3
  radius: number
  halfSegment: number
}

export interface Penetration {
  depth: number
  normal: Vec3
}

const EPS = 1e-9
export const GROUND_EPS = 0.02
export const COS_45 = Math.SQRT1_2

export function capsuleFor(feet: Vec3, radius: number, height: number): Capsule {
  return {
    center: [feet[0], feet[1] + height / 2, feet[2]],
    radius,
    halfSegment: height / 2 - radius,
  }
}

function clampPoint(p: Vec3, box: Box): Vec3 {
  return [clamp(p[0], box.min[0], box.max[0]), clamp(p[1], box.min[1], box.max[1]), clamp(p[2], box.min[2], box.max[2])]
}

/**
 * Closest point on a vertical segment to an AABB, then the closest point on the
 * box to that segment point. The delta between them is the capsule's escape
 * vector.
 */
export function capsulePenetration(cap: Capsule, box: Box): Penetration | null {
  const bottom = cap.center[1] - cap.halfSegment
  const top = cap.center[1] + cap.halfSegment

  let segY: number
  if (top < box.min[1]) segY = top
  else if (bottom > box.max[1]) segY = bottom
  else segY = clamp(cap.center[1], box.min[1], box.max[1])

  const segPoint: Vec3 = [cap.center[0], segY, cap.center[2]]
  const boxPoint = clampPoint(segPoint, box)
  const delta = sub(segPoint, boxPoint)
  const dist = length(delta)

  if (dist >= cap.radius) return null

  if (dist < EPS) {
    // Segment point is inside the box: no escape direction exists, so push the
    // shortest way out vertically. Only reachable when a scene spawns geometry
    // on top of the player.
    return { depth: cap.radius + (box.max[1] - segPoint[1]), normal: [0, 1, 0] }
  }

  return { depth: cap.radius - dist, normal: scale(delta, 1 / dist) }
}

/** True when the capsule overlaps at all — used to decide hot-reload safety. */
export function capsuleOverlaps(cap: Capsule, box: Box): boolean {
  return capsulePenetration(cap, box) !== null
}

/**
 * Support contact, not "we hit something": the bottom sphere must be within
 * radius + epsilon of a surface whose outward normal points up.
 */
export function supportNormal(cap: Capsule, box: Box, eps = GROUND_EPS): Vec3 | null {
  const bottom: Vec3 = [cap.center[0], cap.center[1] - cap.halfSegment, cap.center[2]]
  const boxPoint = clampPoint(bottom, box)
  const delta = sub(bottom, boxPoint)
  const dist = length(delta)

  if (dist > cap.radius + eps) return null
  if (dist < EPS) return [0, 1, 0]
  return scale(delta, 1 / dist)
}

export function isGrounded(cap: Capsule, boxes: readonly Box[], eps = GROUND_EPS): boolean {
  for (const box of boxes) {
    const normal = supportNormal(cap, box, eps)
    if (normal && normal[1] >= COS_45) return true
  }
  return false
}

/** Applies a displacement then pushes out of every penetrating box. */
export function resolveMove(cap: Capsule, boxes: readonly Box[], iterations = 4): { capsule: Capsule; hitWall: boolean; hitFloor: boolean; hitCeiling: boolean } {
  let center = cap.center
  let hitWall = false
  let hitFloor = false
  let hitCeiling = false

  for (let i = 0; i < iterations; i++) {
    let deepest: Penetration | null = null
    for (const box of boxes) {
      const pen = capsulePenetration({ ...cap, center }, box)
      if (pen && (!deepest || pen.depth > deepest.depth)) deepest = pen
    }
    if (!deepest) break

    center = add(center, scale(deepest.normal, deepest.depth))
    if (deepest.normal[1] > COS_45) hitFloor = true
    else if (deepest.normal[1] < -COS_45) hitCeiling = true
    else hitWall = true
  }

  return { capsule: { ...cap, center }, hitWall, hitFloor, hitCeiling }
}
