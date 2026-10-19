import * as THREE from 'three'
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js'
import { boundsOf } from '../assets/mesh'
import type { Bounds, BuiltAsset } from '../assets/types'
import type { Vec3 } from '../core/math'
import { bufferGeometryFrom } from '../render/geometry'
import { VIEW_DIRECTIONS } from './views'
import type { ViewName } from './views'

export { VIEWS, isViewName } from './views'
export type { ViewName } from './views'

export const PREVIEW_W = 800
export const PREVIEW_H = 500

export interface CameraFrame {
  pos: Vec3
  target: Vec3
  distance: number
}

/**
 * Fits the asset's bounding sphere into the frame with 12% margin. The bounding
 * sphere is orientation-independent, so switching views never changes scale —
 * which is what makes two captures comparable.
 */
export function frameCamera(bounds: Bounds, view: ViewName, camera: THREE.PerspectiveCamera): CameraFrame {
  const size: Vec3 = [
    bounds.max[0] - bounds.min[0],
    bounds.max[1] - bounds.min[1],
    bounds.max[2] - bounds.min[2],
  ]
  const target: Vec3 = [
    (bounds.min[0] + bounds.max[0]) / 2,
    (bounds.min[1] + bounds.max[1]) / 2,
    (bounds.min[2] + bounds.max[2]) / 2,
  ]
  const radius = Math.max(0.001, Math.hypot(size[0], size[1], size[2]) / 2)

  const vFov = (camera.fov * Math.PI) / 180
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect)
  const distance = Math.max(radius / Math.sin(vFov / 2), radius / Math.sin(hFov / 2)) * 1.12

  const dir = VIEW_DIRECTIONS[view]
  const dirLength = Math.hypot(dir[0], dir[1], dir[2])
  const unit: Vec3 = [dir[0] / dirLength, dir[1] / dirLength, dir[2] / dirLength]
  const pos: Vec3 = [
    target[0] + unit[0] * distance,
    target[1] + unit[1] * distance,
    target[2] + unit[2] * distance,
  ]

  const lookingDown = Math.abs(unit[1]) > 0.99
  camera.up.set(0, lookingDown ? 0 : 1, lookingDown ? -1 : 0)
  camera.position.set(pos[0], pos[1], pos[2])
  camera.near = Math.max(0.001, distance / 100)
  camera.far = distance + radius * 4 + 20
  camera.lookAt(target[0], target[1], target[2])
  camera.updateProjectionMatrix()

  return { pos, target, distance }
}

/**
 * Standalone asset viewport. Deliberately separate from Renderer: the game
 * renderer consumes a World, and a preview has no World. They share only
 * bufferGeometryFrom, so neither can drift into the other's responsibilities.
 */
export class AssetPreview {
  readonly gl: THREE.WebGLRenderer
  readonly scene: THREE.Scene
  readonly camera: THREE.PerspectiveCamera
  readonly canvas: HTMLCanvasElement

  readonly #key = new THREE.DirectionalLight(0xfff2dd, 2.4)
  #mesh: THREE.Mesh | null = null
  #grid: THREE.GridHelper | null = null
  #bounds: Bounds = { min: [0, 0, 0], max: [0, 0, 0] }
  #view: ViewName = 'three-quarter'
  #frame: CameraFrame = { pos: [0, 0, 0], target: [0, 0, 0], distance: 0 }

  constructor(container: HTMLElement) {
    this.gl = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true })
    this.gl.setPixelRatio(1)
    this.gl.setSize(PREVIEW_W, PREVIEW_H, false)
    this.gl.toneMapping = THREE.ACESFilmicToneMapping
    this.gl.toneMappingExposure = 1.05
    this.gl.shadowMap.enabled = true
    this.gl.shadowMap.type = THREE.PCFShadowMap
    this.canvas = this.gl.domElement
    container.appendChild(this.canvas)

    this.scene = new THREE.Scene()
    this.scene.background = new THREE.Color('#0b1020')
    this.camera = new THREE.PerspectiveCamera(45, PREVIEW_W / PREVIEW_H, 0.01, 200)

    // Metals need something to reflect. Without an environment, a metalness of
    // 0.7 renders as flat grey mud; a studio room costs one startup bake.
    const pmrem = new THREE.PMREMGenerator(this.gl)
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture
    this.scene.environmentIntensity = 0.55
    pmrem.dispose()

    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25))
    this.#key.castShadow = true
    this.#key.shadow.mapSize.set(1024, 1024)
    this.#key.shadow.bias = -0.0005
    this.scene.add(this.#key)
    this.scene.add(this.#key.target)

    const rim = new THREE.DirectionalLight(0x9fb6ff, 0.9)
    rim.position.set(-6, 4, -7)
    this.scene.add(rim)
  }

  get view(): ViewName {
    return this.#view
  }

  get frame(): CameraFrame {
    return this.#frame
  }

  load(asset: BuiltAsset): void {
    if (this.#mesh !== null) {
      this.scene.remove(this.#mesh)
      this.#mesh.geometry.dispose()
      const material = this.#mesh.material
      if (!Array.isArray(material)) material.dispose()
    }

    const mesh = new THREE.Mesh(
      bufferGeometryFrom(asset.geometry),
      new THREE.MeshStandardMaterial({
        color: new THREE.Color(asset.material.color),
        roughness: asset.material.roughness,
        metalness: asset.material.metalness,
      }),
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    this.#mesh = mesh
    this.#bounds = boundsOf(asset.geometry)
    this.scene.add(mesh)

    this.#rebuildGrid()
    this.#placeKey()
    this.setView(this.#view)
  }

  setView(view: ViewName): CameraFrame {
    this.#view = view
    this.#frame = frameCamera(this.#bounds, view, this.camera)
    return this.#frame
  }

  render(): void {
    this.gl.render(this.scene, this.camera)
  }

  async capture(name: string): Promise<{ path: string; bytes: number; width: number; height: number }> {
    this.render()

    const blob = await new Promise<Blob>((resolve, reject) => {
      this.canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('canvas.toBlob returned null'))),
        'image/png',
      )
    })

    const response = await fetch(`/__capture?name=${encodeURIComponent(name)}`, { method: 'POST', body: blob })
    if (!response.ok) throw new Error(`capture sink failed: ${response.status} ${response.statusText}`)

    const saved = (await response.json()) as { ok: boolean; path: string; bytes: number }
    return { ...saved, width: this.canvas.width, height: this.canvas.height }
  }

  #rebuildGrid(): void {
    if (this.#grid !== null) {
      this.scene.remove(this.#grid)
      this.#grid.geometry.dispose()
      this.#grid.material.dispose()
    }

    const size: Vec3 = [
      this.#bounds.max[0] - this.#bounds.min[0],
      this.#bounds.max[1] - this.#bounds.min[1],
      this.#bounds.max[2] - this.#bounds.min[2],
    ]
    const radius = Math.max(0.001, Math.hypot(size[0], size[1], size[2]) / 2)
    const gridSize = Math.max(2, 2 ** Math.ceil(Math.log2(radius * 5)))

    this.#grid = new THREE.GridHelper(gridSize, 10, 0x2b3555, 0x1a2036)
    this.#grid.position.y = 0
    this.scene.add(this.#grid)
  }

  #placeKey(): void {
    const size: Vec3 = [
      this.#bounds.max[0] - this.#bounds.min[0],
      this.#bounds.max[1] - this.#bounds.min[1],
      this.#bounds.max[2] - this.#bounds.min[2],
    ]
    const radius = Math.max(0.001, Math.hypot(size[0], size[1], size[2]) / 2)
    const s = Math.max(1, radius * 2)
    const centerY = (this.#bounds.min[1] + this.#bounds.max[1]) / 2

    this.#key.position.set(s * 1.6, centerY + s * 2.4, s * 1.8)
    this.#key.target.position.set(0, centerY, 0)
    this.#key.target.updateMatrixWorld()

    const shadow = this.#key.shadow.camera
    shadow.left = -s * 1.5
    shadow.right = s * 1.5
    shadow.top = s * 1.5
    shadow.bottom = -s * 1.5
    shadow.near = 0.1
    shadow.far = s * 8
    shadow.updateProjectionMatrix()
  }
}
