import * as THREE from 'three'
import { cameraPose } from '../camera/rigs'
import type { Vec3 } from '../core/math'
import type { CameraNode, MeshNode } from '../schema/scene'
import type { World } from '../world/world'

export const VIEW_W = 800
export const VIEW_H = 500

export interface RenderStats {
  drawCalls: number
  triangles: number
  objects: number
}

function geometryFor(node: MeshNode): THREE.BufferGeometry {
  const g = node.geometry
  switch (g.shape) {
    case 'box':
      return new THREE.BoxGeometry(g.size[0], g.size[1], g.size[2])
    case 'plane':
      // XY plane facing +Z, matching the engine convention: rotate -90 deg on X for a floor.
      return new THREE.PlaneGeometry(g.size[0], g.size[1])
    case 'sphere':
      return new THREE.SphereGeometry(g.radius, g.segments, Math.max(3, Math.round(g.segments / 2)))
    case 'capsule': {
      const straight = Math.max(0.001, g.height - g.radius * 2)
      return new THREE.CapsuleGeometry(g.radius, straight, 6, 16)
    }
  }
}

/**
 * Consumes World and produces pixels. Holds every THREE object; owns none of
 * the simulation. Rebuilt wholesale on scene revision — cheap at this scale and
 * impossible to get out of sync.
 */
export class Renderer {
  readonly gl: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly canvas: HTMLCanvasElement

  #revision = 0
  #objects: THREE.Object3D[] = []

  /**
   * The player avatar. Render-only: it is not a World node, contributes no
   * collider, and its transform is derived from world.player.pos every frame.
   * Nothing in the simulation can read it back.
   */
  readonly #player = new THREE.Group()
  #playerMesh: THREE.Mesh | null = null
  #playerRadius = -1
  #playerHeight = -1

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.gl.setPixelRatio(1)
    this.gl.setSize(VIEW_W, VIEW_H, false)
    this.gl.toneMapping = THREE.ACESFilmicToneMapping
    this.gl.toneMappingExposure = 1.15
    this.gl.shadowMap.enabled = true
    this.gl.shadowMap.type = THREE.PCFShadowMap
    this.canvas = this.gl.domElement
    container.appendChild(this.canvas)

    this.scene = new THREE.Scene()
    this.camera = new THREE.PerspectiveCamera(50, VIEW_W / VIEW_H, 0.1, 200)

    this.#player.name = 'player-avatar'
    this.scene.add(this.#player)
  }

  /**
   * Pulls the avatar onto the physics feet position. Split out from render() so
   * tests can assert the derivation without drawing 40 frames.
   */
  syncPlayer(world: World): void {
    const { radius, height } = world.doc.player

    if (radius !== this.#playerRadius || height !== this.#playerHeight) {
      if (this.#playerMesh) {
        this.#player.remove(this.#playerMesh)
        this.#playerMesh.geometry.dispose()
        const material = this.#playerMesh.material
        if (!Array.isArray(material)) material.dispose()
        this.#playerMesh = null
      }

      const mesh = new THREE.Mesh(
        new THREE.CapsuleGeometry(radius, Math.max(0.001, height - radius * 2), 6, 16),
        new THREE.MeshStandardMaterial({ color: 0xe8e3d5, roughness: 0.55, metalness: 0.05 }),
      )
      mesh.castShadow = true
      mesh.receiveShadow = true
      this.#playerMesh = mesh
      this.#player.add(mesh)
      this.#playerRadius = radius
      this.#playerHeight = height
    }

    // Group origin is the capsule centre; feet sit half a height below it.
    this.#player.position.set(world.player.pos[0], world.player.pos[1] + height / 2, world.player.pos[2])
  }

  /** Renderer-side feet position, read back out of the scene graph. */
  avatarFeet(): Vec3 {
    this.#player.updateWorldMatrix(true, false)
    const p = new THREE.Vector3()
    this.#player.getWorldPosition(p)
    return [p.x, p.y - this.#playerHeight / 2, p.z]
  }

  /** Screen-space position of the avatar's centre, in pixels. */
  projectAvatar(): { x: number; y: number; ndcZ: number } {
    this.#player.updateWorldMatrix(true, false)
    const p = new THREE.Vector3()
    this.#player.getWorldPosition(p)
    this.camera.updateMatrixWorld()
    p.project(this.camera)
    return {
      x: Number((((p.x + 1) / 2) * VIEW_W).toFixed(2)),
      y: Number((((1 - p.y) / 2) * VIEW_H).toFixed(2)),
      ndcZ: Number(p.z.toFixed(4)),
    }
  }

  sync(world: World): void {
    if (this.#revision === world.revision) return
    this.#revision = world.revision

    for (const object of this.#objects) this.scene.remove(object)
    this.#objects = []

    this.scene.background = new THREE.Color(world.doc.environment.background)

    for (const node of world.nodes) {
      if (!node.visible) continue
      const doc = node.doc

      if (doc.type === 'mesh') {
        const mesh = new THREE.Mesh(
          geometryFor(doc),
          new THREE.MeshStandardMaterial({
            color: new THREE.Color(doc.material.color),
            roughness: doc.material.roughness,
            metalness: doc.material.metalness,
          }),
        )
        mesh.castShadow = true
        mesh.receiveShadow = true
        this.#place(mesh, node.matrix)
        this.add(mesh)
        continue
      }

      if (doc.type === 'light') {
        if (doc.kind === 'ambient') {
          this.add(new THREE.AmbientLight(new THREE.Color(doc.color), doc.intensity))
        } else {
          const light = new THREE.DirectionalLight(new THREE.Color(doc.color), doc.intensity)
          const dir = doc.dir ?? [-0.4, -1, -0.3]
          const len = Math.hypot(dir[0], dir[1], dir[2]) || 1
          light.position.set((-dir[0] / len) * 20, (-dir[1] / len) * 20, (-dir[2] / len) * 20)
          light.castShadow = doc.castShadow
          if (doc.castShadow) {
            light.shadow.mapSize.set(1024, 1024)
            const cam = light.shadow.camera
            cam.left = -12
            cam.right = 12
            cam.top = 12
            cam.bottom = -12
            cam.near = 1
            cam.far = 60
          }
          this.add(light)
        }
      }
    }
  }

  #place(object: THREE.Object3D, matrix: number[]): void {
    object.matrixAutoUpdate = false
    object.matrixWorldAutoUpdate = false
    object.matrix.fromArray(matrix)
    object.matrixWorld.copy(object.matrix)
  }

  add(object: THREE.Object3D): void {
    this.#objects.push(object)
    this.scene.add(object)
  }

  render(world: World): void {
    this.sync(world)
    this.syncPlayer(world)

    const cameraNode = world.nodes.find((node) => node.doc.type === 'camera')?.doc as CameraNode | undefined
    if (cameraNode) {
      this.camera.fov = cameraNode.fov
      this.camera.near = cameraNode.near
      this.camera.far = cameraNode.far
      this.camera.updateProjectionMatrix()
    }

    const pose = cameraPose(world.camera, world.player.pos)
    this.camera.position.set(pose.pos[0], pose.pos[1], pose.pos[2])
    this.camera.lookAt(pose.target[0], pose.target[1], pose.target[2])

    this.gl.render(this.scene, this.camera)
  }

  stats(): RenderStats {
    return {
      drawCalls: this.gl.info.render.calls,
      triangles: this.gl.info.render.triangles,
      objects: this.#objects.length,
    }
  }
}
