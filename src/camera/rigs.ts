import type { Vec3 } from '../core/math'

export type CameraState =
  | { rig: 'orbit'; yaw: number; pitch: number; distance: number; target: Vec3 }
  | { rig: 'third-person'; yaw: number; distance: number; height: number; lookHeight: number }

export interface CameraPose {
  pos: Vec3
  target: Vec3
}

const DEG2RAD = Math.PI / 180

/**
 * Presentation only. The pose is derived from world state + camera state, so a
 * capture is reproducible without the renderer owning any camera logic.
 */
export function cameraPose(state: CameraState, playerPos: Vec3): CameraPose {
  if (state.rig === 'orbit') {
    const yaw = state.yaw * DEG2RAD
    const pitch = state.pitch * DEG2RAD
    const cp = Math.cos(pitch)
    return {
      pos: [
        state.target[0] + state.distance * cp * Math.sin(yaw),
        state.target[1] + state.distance * Math.sin(pitch),
        state.target[2] + state.distance * cp * Math.cos(yaw),
      ],
      target: [...state.target],
    }
  }

  const yaw = state.yaw * DEG2RAD
  return {
    pos: [
      playerPos[0] - state.distance * Math.sin(yaw),
      playerPos[1] + state.height,
      playerPos[2] - state.distance * Math.cos(yaw),
    ],
    target: [playerPos[0], playerPos[1] + state.lookHeight, playerPos[2]],
  }
}

/** Orbit input is clamped so the camera can never roll past the polls or zoom to zero. */
export function orbitWith(state: CameraState, delta: { yaw?: number; pitch?: number; distance?: number; target?: Vec3 }): CameraState {
  if (state.rig !== 'orbit') return state
  const distance = Math.min(40, Math.max(1.5, delta.distance ?? state.distance))
  const pitch = Math.min(89, Math.max(-89, delta.pitch ?? state.pitch))
  return {
    rig: 'orbit',
    yaw: delta.yaw ?? state.yaw,
    pitch,
    distance,
    target: delta.target ?? state.target,
  }
}
