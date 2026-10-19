import type { CameraState } from './camera/rigs'
import { orbitWith } from './camera/rigs'
import type { InputState, ReloadReport, World } from './world/world'
import { createWorld, rebuildWorld, resetWorld } from './world/world'
import { FIXED_DT, stepWorld } from './physics/step'
import { Renderer, type RenderStats } from './render/renderer'
import type { SceneDoc, SceneIssue } from './schema/scene'
import { parseScene } from './schema/scene'
import type { Snapshot } from './devtools/state'
import { snapshot } from './devtools/state'
import { runTests, type TestReport } from './devtools/tests'

export interface ApplyResult {
  ok: boolean
  errors: SceneIssue[]
  reload?: ReloadReport
}

export interface CaptureResult {
  ok: boolean
  path: string
  bytes: number
  step: number
  hash: string
  width: number
  height: number
}

const IDLE: InputState = { moveX: 0, moveZ: 0, jump: false }

/**
 * The agent surface. Reads World, writes SceneDoc, and never exposes THREE
 * objects. Renderer counters live in stats(), which is explicitly advisory and
 * separate from inspect().
 */
export class Engine {
  readonly version = '0.1.0-phase1'
  readonly world: World
  readonly renderer: Renderer
  paused = false

  #rawInput: InputState = { ...IDLE }

  constructor(container: HTMLElement, doc: SceneDoc) {
    this.world = createWorld(doc)
    this.renderer = new Renderer(container)
    this.renderer.render(this.world)
  }

  // -- scene ---------------------------------------------------------------

  scene(): SceneDoc {
    return this.world.doc
  }

  /** Atomic: on failure the last valid world stays exactly as it was. */
  applyScene(raw: unknown): ApplyResult {
    const parsed = parseScene(raw)
    if (!parsed.ok) return { ok: false, errors: parsed.errors }

    const reload = rebuildWorld(this.world, parsed.doc)
    this.renderer.render(this.world)
    return { ok: true, errors: [], reload }
  }

  // -- simulation ----------------------------------------------------------

  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  reset(): Snapshot {
    resetWorld(this.world)
    this.#rawInput = { ...IDLE }
    this.renderer.render(this.world)
    return snapshot(this.world)
  }

  setInput(partial: Partial<InputState>): InputState {
    this.#rawInput = { ...this.#rawInput, ...partial }
    return { ...this.#rawInput }
  }

  /** Explicit stepping, for tests and captures. Implies pause. */
  step(count = 1): Snapshot {
    this.paused = true
    for (let i = 0; i < count; i++) this.stepOnce()
    this.renderer.render(this.world)
    return snapshot(this.world)
  }

  /** One step with input resolved into world space. Used by the rAF loop too. */
  stepOnce(): void {
    this.world.input = this.#effectiveInput()
    stepWorld(this.world, FIXED_DT)
  }

  #effectiveInput(): InputState {
    const camera = this.world.camera
    if (camera.rig !== 'third-person') return { ...this.#rawInput }

    // Third-person input is camera-relative so W walks toward the view; orbit
    // input stays world-space, which is what the tests script against.
    const yaw = (camera.yaw * Math.PI) / 180
    const cos = Math.cos(yaw)
    const sin = Math.sin(yaw)
    return {
      moveX: this.#rawInput.moveX * cos + this.#rawInput.moveZ * sin,
      moveZ: -this.#rawInput.moveX * sin + this.#rawInput.moveZ * cos,
      jump: this.#rawInput.jump,
    }
  }

  // -- inspection ----------------------------------------------------------

  inspect(): Snapshot {
    return snapshot(this.world)
  }

  stats(): RenderStats {
    return this.renderer.stats()
  }

  setOrbit(delta: { yaw?: number; pitch?: number; distance?: number }): CameraState {
    this.world.camera = orbitWith(this.world.camera, delta)
    this.renderer.render(this.world)
    return this.world.camera
  }

  // -- evidence ------------------------------------------------------------

  async capture(name: string): Promise<CaptureResult> {
    this.renderer.render(this.world)

    const blob = await new Promise<Blob>((resolve, reject) => {
      this.renderer.canvas.toBlob(
        (result) => (result ? resolve(result) : reject(new Error('canvas.toBlob returned null'))),
        'image/png',
      )
    })

    const response = await fetch(`/__capture?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      body: blob,
    })
    if (!response.ok) throw new Error(`capture sink failed: ${response.status} ${response.statusText}`)

    const saved = (await response.json()) as { ok: boolean; path: string; bytes: number }
    return {
      ...saved,
      step: this.world.step,
      hash: snapshot(this.world).hash,
      width: this.renderer.canvas.width,
      height: this.renderer.canvas.height,
    }
  }

  runTests(): TestReport {
    this.paused = true
    const report = runTests(this.world)
    this.renderer.render(this.world)
    return report
  }
}
