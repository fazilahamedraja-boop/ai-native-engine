import { cameraPose } from '../camera/rigs'
import { hashNumbers } from '../core/hash'
import type { Vec3 } from '../core/math'
import type { ReloadReport, World } from '../world/world'

export interface Snapshot {
  step: number
  t: number
  hash: string
  player: { pos: Vec3; vel: Vec3; grounded: boolean }
  camera: {
    rig: 'orbit' | 'third-person'
    pos: Vec3
    target: Vec3
    yaw: number
    distance: number
    pitch?: number
  }
  nodes: Array<{ id: string; type: string; worldPos: Vec3; worldScale: Vec3; visible: boolean }>
  colliders: Array<{ nodeId: string; min: Vec3; max: Vec3 }>
  reload: ReloadReport | null
}

/**
 * The deterministic state contract.
 *
 * Includes camera state because screenshots are part of the agent contract —
 * a capture that cannot be reproduced is not evidence. Node transforms are
 * configuration, not state, and are deliberately excluded.
 */
export function stateHash(world: World): string {
  const flat: number[] = [world.step, ...world.player.pos, ...world.player.vel, world.player.grounded ? 1 : 0]
  const camera = world.camera
  if (camera.rig === 'orbit') {
    flat.push(0, camera.yaw, camera.pitch, camera.distance, ...camera.target)
  } else {
    flat.push(1, camera.yaw, camera.distance, camera.height, camera.lookHeight)
  }
  return hashNumbers(flat)
}

export function snapshot(world: World): Snapshot {
  const pose = cameraPose(world.camera, world.player.pos)
  const camera = world.camera

  return {
    step: world.step,
    t: world.step / 60,
    hash: stateHash(world),
    player: {
      pos: [...world.player.pos],
      vel: [...world.player.vel],
      grounded: world.player.grounded,
    },
    camera:
      camera.rig === 'orbit'
        ? {
            rig: 'orbit',
            pos: pose.pos,
            target: pose.target,
            yaw: camera.yaw,
            pitch: camera.pitch,
            distance: camera.distance,
          }
        : {
            rig: 'third-person',
            pos: pose.pos,
            target: pose.target,
            yaw: camera.yaw,
            distance: camera.distance,
          },
    nodes: world.nodes.map((node) => ({
      id: node.id,
      type: node.type,
      worldPos: node.worldPos,
      worldScale: node.worldScale,
      visible: node.visible,
    })),
    colliders: world.colliders.map((collider) => ({
      nodeId: collider.nodeId,
      min: collider.min,
      max: collider.max,
    })),
    reload: world.lastReload,
  }
}
