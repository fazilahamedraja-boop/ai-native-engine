import * as THREE from 'three'
import { hashNumbers } from '../core/hash'

export const FIXED_DT = 1 / 60
export const VIEW_W = 800
export const VIEW_H = 500

export interface SnapshotNode {
  id: string
  pos: [number, number, number]
  rot: [number, number, number]
  scale: [number, number, number]
}

export interface Snapshot {
  step: number
  t: number
  hash: string
  camera: { pos: [number, number, number]; target: [number, number, number] }
  nodes: SnapshotNode[]
  renderer: { width: number; height: number; triangles: number; calls: number }
}

const CAMERA_POS: [number, number, number] = [3.2, 2.4, 4.2]
const CAMERA_TARGET: [number, number, number] = [0, 0.6, 0]

/**
 * The whole simulation is a pure function of the step counter.
 *
 * Nothing here reads wall-clock time. Seeking to a time and stepping to the
 * same time produce identical state, which is what makes agent screenshots
 * reproducible instead of decorative.
 */
export class SceneRuntime {
  readonly renderer: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly canvas: HTMLCanvasElement

  readonly #cube: THREE.Mesh
  readonly #ground: THREE.Mesh
  #step = 0

  constructor(container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
    })
    this.renderer.setPixelRatio(1)
    this.renderer.setSize(VIEW_W, VIEW_H, false)
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping
    this.renderer.toneMappingExposure = 1.0
    this.canvas = this.renderer.domElement
    container.appendChild(this.canvas)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color(0x0b1020)

    this.camera = new THREE.PerspectiveCamera(45, VIEW_W / VIEW_H, 0.1, 100)
    this.camera.position.set(...CAMERA_POS)
    this.camera.lookAt(...CAMERA_TARGET)

    const ambient = new THREE.AmbientLight(0x5a6ea8, 1.1)
    this.scene.add(ambient)

    const key = new THREE.DirectionalLight(0xfff0dd, 2.6)
    key.position.set(4, 7, 3)
    this.scene.add(key)

    this.#ground = new THREE.Mesh(
      new THREE.PlaneGeometry(20, 20),
      new THREE.MeshStandardMaterial({ color: 0x18203a, roughness: 1 }),
    )
    this.#ground.name = 'ground'
    this.#ground.rotation.x = -Math.PI / 2
    this.scene.add(this.#ground)

    this.#cube = new THREE.Mesh(
      new THREE.BoxGeometry(1, 1, 1),
      new THREE.MeshStandardMaterial({ color: 0xd2603a, roughness: 0.45, metalness: 0.1 }),
    )
    this.#cube.name = 'cube'
    this.#cube.position.set(0, 0.5, 0)
    this.scene.add(this.#cube)

    this.#applyState()
  }

  get step(): number {
    return this.#step
  }

  get t(): number {
    return this.#step * FIXED_DT
  }

  #applyState(): void {
    // Pure in #step: 0.5 rad/s around Y, fixed tilt.
    this.#cube.rotation.set(0.35, this.t * 0.5, 0)
  }

  seek(t: number): void {
    this.#step = Math.max(0, Math.round(t / FIXED_DT))
    this.#applyState()
  }

  stepBy(count = 1): void {
    this.#step = Math.max(0, this.#step + Math.trunc(count))
    this.#applyState()
  }

  reset(): void {
    this.#step = 0
    this.#applyState()
  }

  render(): void {
    this.renderer.render(this.scene, this.camera)
  }

  snapshot(): Snapshot {
    const nodes: SnapshotNode[] = [this.#cube, this.#ground].map((mesh) => ({
      id: mesh.name,
      pos: mesh.position.toArray() as [number, number, number],
      rot: [mesh.rotation.x, mesh.rotation.y, mesh.rotation.z],
      scale: mesh.scale.toArray() as [number, number, number],
    }))

    const flat: number[] = [this.#step]
    for (const node of nodes) {
      flat.push(...node.pos, ...node.rot, ...node.scale)
    }
    flat.push(...CAMERA_POS, ...CAMERA_TARGET)

    return {
      step: this.#step,
      t: this.t,
      hash: hashNumbers(flat),
      camera: { pos: [...CAMERA_POS], target: [...CAMERA_TARGET] },
      nodes,
      renderer: {
        width: VIEW_W,
        height: VIEW_H,
        triangles: this.renderer.info.render.triangles,
        calls: this.renderer.info.render.calls,
      },
    }
  }
}
