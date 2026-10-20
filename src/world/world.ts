import type { CameraState } from '../camera/rigs'
import { hashNumbers } from '../core/hash'
import type { Mat4, Vec3 } from '../core/math'
import { basisScaleOf, composeMatrix, multiply, transformPoint, translationOf } from '../core/math'
import type { Box } from '../physics/capsule-aabb'
import { capsuleFor, capsuleOverlaps, isGrounded } from '../physics/capsule-aabb'
import type { CameraNode, GeometryConfig, PlayerConfig, SceneDoc, SceneNode } from '../schema/scene'

export interface WorldNode {
  id: string
  type: SceneNode['type']
  parent: string | null
  doc: SceneNode
  matrix: Mat4
  worldPos: Vec3
  worldScale: Vec3
  visible: boolean
}

export interface Collider extends Box {
  nodeId: string
}

export interface PlayerState {
  /** FEET position, metres. Matches the SceneDoc spawn convention. */
  pos: Vec3
  vel: Vec3
  grounded: boolean
}

export interface InputState {
  /** World-space movement direction, magnitude clamped to 1 by the physics step. */
  moveX: number
  moveZ: number
  jump: boolean
  /** Rising edge is consumed by the game's Combat module; holding does not repeat. */
  attack: boolean
}

export interface ReloadReport {
  stateReset: 'colliders-changed' | 'player-inside-collider' | null
  step: number
}

export interface World {
  doc: SceneDoc
  nodes: WorldNode[]
  byId: Map<string, WorldNode>
  colliders: Collider[]
  player: PlayerState
  spawn: PlayerState
  camera: CameraState
  cameraInit: CameraState
  input: InputState
  step: number
  prevJump: boolean
  revision: number
  collisionFingerprint: string
  lastReload: ReloadReport | null
}

export function geometryExtent(geometry: GeometryConfig): Vec3 {
  switch (geometry.shape) {
    case 'box':
      return [...geometry.size]
    case 'plane':
      return [geometry.size[0], 0, geometry.size[1]]
    case 'sphere':
      return [geometry.radius * 2, geometry.radius * 2, geometry.radius * 2]
    case 'capsule':
      return [geometry.radius * 2, geometry.height, geometry.radius * 2]
  }
}

function buildNodes(doc: SceneDoc): WorldNode[] {
  const byIdDoc = new Map(doc.nodes.map((node) => [node.id, node]))
  const memo = new Map<string, { matrix: Mat4; visible: boolean }>()

  const resolve = (id: string, guard: Set<string>): { matrix: Mat4; visible: boolean } => {
    const cached = memo.get(id)
    if (cached) return cached

    const node = byIdDoc.get(id)
    if (!node) throw new Error(`node '${id}' vanished between validation and build`)
    if (guard.has(id)) throw new Error(`parent cycle at '${id}' (schema should have rejected this)`)
    guard.add(id)

    const local = composeMatrix(node.transform.pos, node.transform.rot, node.transform.scale)
    let matrix = local
    let visible = node.visible

    if (node.parent) {
      const parent = resolve(node.parent, guard)
      matrix = multiply(parent.matrix, local)
      visible = parent.visible && visible
    }

    const entry = { matrix, visible }
    memo.set(id, entry)
    return entry
  }

  return doc.nodes.map((node) => {
    const { matrix, visible } = resolve(node.id, new Set())
    return {
      id: node.id,
      type: node.type,
      parent: node.parent ?? null,
      doc: node,
      matrix,
      worldPos: translationOf(matrix),
      worldScale: basisScaleOf(matrix),
      visible,
    }
  })
}

/**
 * World AABBs are conservative: a rotated collider is enveloped by its
 * axis-aligned bounds. Documented limitation, not an accident.
 */
function buildColliders(nodes: WorldNode[]): Collider[] {
  const out: Collider[] = []

  for (const node of nodes) {
    const doc = node.doc
    if (doc.type !== 'mesh' || doc.collider.shape !== 'aabb') continue

    const size = doc.collider.size ?? geometryExtent(doc.geometry)
    const half: Vec3 = [size[0] / 2, size[1] / 2, size[2] / 2]

    let min: Vec3 = [Infinity, Infinity, Infinity]
    let max: Vec3 = [-Infinity, -Infinity, -Infinity]

    for (let corner = 0; corner < 8; corner++) {
      const local: Vec3 = [
        corner & 1 ? half[0] : -half[0],
        corner & 2 ? half[1] : -half[1],
        corner & 4 ? half[2] : -half[2],
      ]
      const p = transformPoint(node.matrix, local)
      for (let axis = 0; axis < 3; axis++) {
        min[axis] = Math.min(min[axis], p[axis])
        max[axis] = Math.max(max[axis], p[axis])
      }
    }

    out.push({ nodeId: node.id, min, max })
  }

  return out
}

export function collisionFingerprint(colliders: readonly Collider[], player: PlayerConfig): string {
  const flat: number[] = [player.radius, player.height]
  const sorted = [...colliders].sort((a, b) => (a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0))
  for (const collider of sorted) flat.push(...collider.min, ...collider.max)
  return hashNumbers(flat)
}

export function initialCameraState(doc: SceneDoc): CameraState {
  const node = doc.nodes.find((candidate): candidate is CameraNode => candidate.type === 'camera')
  if (!node) throw new Error('scene has no camera (schema should have rejected this)')

  if (node.rig === 'orbit') {
    return {
      rig: 'orbit',
      yaw: node.orbit.yaw,
      pitch: node.orbit.pitch,
      distance: node.orbit.distance,
      target: [...node.orbit.target],
    }
  }

  return {
    rig: 'third-person',
    yaw: node.transform.rot[1],
    distance: node.thirdPerson.distance,
    height: node.thirdPerson.height,
    lookHeight: node.thirdPerson.lookHeight,
  }
}

function spawnState(doc: SceneDoc): PlayerState {
  return { pos: [...doc.player.spawn], vel: [0, 0, 0], grounded: false }
}

export function createWorld(doc: SceneDoc): World {
  const nodes = buildNodes(doc)
  const colliders = buildColliders(nodes)
  const spawn = spawnState(doc)
  const camera = initialCameraState(doc)

  return {
    doc,
    nodes,
    byId: new Map(nodes.map((node) => [node.id, node])),
    colliders,
    player: { pos: [...spawn.pos], vel: [...spawn.vel], grounded: false },
    spawn,
    camera,
    cameraInit: structuredCloneCamera(camera),
    input: { moveX: 0, moveZ: 0, jump: false, attack: false },
    step: 0,
    prevJump: false,
    revision: 1,
    collisionFingerprint: collisionFingerprint(colliders, doc.player),
    lastReload: null,
  }
}

function structuredCloneCamera(camera: CameraState): CameraState {
  return camera.rig === 'orbit'
    ? { ...camera, target: [...camera.target] }
    : { ...camera }
}

export function resetWorld(world: World): void {
  world.step = 0
  world.player = { pos: [...world.spawn.pos], vel: [0, 0, 0], grounded: false }
  world.camera = structuredCloneCamera(world.cameraInit)
  world.input = { moveX: 0, moveZ: 0, jump: false, attack: false }
  world.prevJump = false
}

/**
 * Applies a new document without discarding simulation state unless the
 * effective collision world actually invalidates it.
 */
export function rebuildWorld(world: World, doc: SceneDoc): ReloadReport {
  const nodes = buildNodes(doc)
  const colliders = buildColliders(nodes)
  const fingerprint = collisionFingerprint(colliders, doc.player)

  let stateReset: ReloadReport['stateReset'] = null

  if (fingerprint !== world.collisionFingerprint) {
    const capsule = capsuleFor(world.player.pos, doc.player.radius, doc.player.height)
    const inside = colliders.some((collider) => capsuleOverlaps(capsule, collider))

    if (inside) {
      world.player = { pos: [...doc.player.spawn], vel: [0, 0, 0], grounded: false }
      stateReset = 'player-inside-collider'
    } else {
      stateReset = 'colliders-changed'
      world.player = {
        ...world.player,
        grounded: isGrounded(capsule, colliders),
      }
    }
  }

  const previousCamera = world.doc.nodes.find((node): node is CameraNode => node.type === 'camera')
  world.doc = doc
  world.nodes = nodes
  world.byId = new Map(nodes.map((node) => [node.id, node]))
  world.colliders = colliders
  world.spawn = spawnState(doc)
  world.collisionFingerprint = fingerprint
  world.revision += 1

  const nextCamera = doc.nodes.find((node): node is CameraNode => node.type === 'camera')
  const cameraChanged = !previousCamera || !nextCamera || previousCamera.id !== nextCamera.id || previousCamera.rig !== nextCamera.rig
  if (cameraChanged) {
    world.cameraInit = initialCameraState(doc)
    world.camera = structuredCloneCamera(world.cameraInit)
  }

  const report: ReloadReport = { stateReset, step: world.step }
  world.lastReload = report
  return report
}
