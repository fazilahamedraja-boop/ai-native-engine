import type { Vec3 } from '../core/math'
import type { World } from '../world/world'
import { capsuleFor, isGrounded, resolveMove } from './capsule-aabb'

/** 60 Hz. Every derived jump number in the docs assumes exactly this. */
export const FIXED_DT = 1 / 60

/**
 * One deterministic simulation step.
 *
 * Order is fixed and load-bearing:
 *   input -> horizontal velocity -> jump edge -> gravity -> move -> resolve
 *   -> support probe -> velocity cleanup.
 *
 * Gravity is applied *before* the position update (semi-implicit Euler), which
 * is why the jump apex is 0.850 m and not the continuous 0.900 m.
 */
export function stepWorld(world: World, dt: number = FIXED_DT): void {
  const cfg = world.doc.player
  const input = world.input
  const previous = world.player
  const jumpPressed = input.jump && !world.prevJump

  const magnitude = Math.hypot(input.moveX, input.moveZ)
  const vx = magnitude > 1e-9 ? (input.moveX / magnitude) * cfg.speed : 0
  const vz = magnitude > 1e-9 ? (input.moveZ / magnitude) * cfg.speed : 0

  let vy = previous.vel[1]
  if (jumpPressed && previous.grounded) vy = cfg.jumpSpeed
  vy += cfg.gravity * dt

  const before = capsuleFor(previous.pos, cfg.radius, cfg.height)
  const moved = {
    ...before,
    center: [
      before.center[0] + vx * dt,
      before.center[1] + vy * dt,
      before.center[2] + vz * dt,
    ] as Vec3,
  }

  const resolved = resolveMove(moved, world.colliders)
  const feet: Vec3 = [
    resolved.capsule.center[0],
    resolved.capsule.center[1] - cfg.height / 2,
    resolved.capsule.center[2],
  ]

  const grounded = isGrounded(resolved.capsule, world.colliders)
  if (grounded && vy < 0) vy = 0
  if (resolved.hitCeiling && vy > 0) vy = 0

  world.player = {
    pos: feet,
    // Horizontal velocity is reported from actual displacement so a blocked
    // player reads 0 instead of the commanded speed.
    vel: [(feet[0] - previous.pos[0]) / dt, vy, (feet[2] - previous.pos[2]) / dt],
    grounded,
  }

  world.prevJump = input.jump
  world.step += 1
}
