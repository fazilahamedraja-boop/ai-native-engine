import type { SceneRuntime, Snapshot } from '../render/scene'

export interface CaptureResult {
  ok: boolean
  path: string
  bytes: number
  t: number
  hash: string
  width: number
  height: number
}

export interface EngineApi {
  readonly version: string
  /** Deterministic state at an optional simulated time, plus draw stats. */
  inspect(t?: number): Snapshot
  /** Advance N fixed steps from the current position. */
  step(count?: number): Snapshot
  reset(): Snapshot
  /** Render at an optional time, POST the PNG to the dev server, return its path. */
  capture(name: string, t?: number): Promise<CaptureResult>
  /** Same frame as a data URL, for when no file sink is available. */
  dataUrl(t?: number): string
}

export function createApi(runtime: SceneRuntime): EngineApi {
  const at = (t?: number): SceneRuntime => {
    if (t !== undefined) runtime.seek(t)
    return runtime
  }

  return {
    version: '0.0.1-phase0',

    inspect(t) {
      const r = at(t)
      r.render()
      return r.snapshot()
    },

    step(count = 1) {
      runtime.stepBy(count)
      runtime.render()
      return runtime.snapshot()
    },

    reset() {
      runtime.reset()
      runtime.render()
      return runtime.snapshot()
    },

    async capture(name, t) {
      const r = at(t)
      r.render()

      const blob = await new Promise<Blob>((resolve, reject) => {
        r.canvas.toBlob(
          (b) => (b ? resolve(b) : reject(new Error('canvas.toBlob returned null'))),
          'image/png',
        )
      })

      const response = await fetch(`/__capture?name=${encodeURIComponent(name)}`, {
        method: 'POST',
        body: blob,
      })
      if (!response.ok) {
        throw new Error(`capture sink failed: ${response.status} ${response.statusText}`)
      }

      const saved = (await response.json()) as { ok: boolean; path: string; bytes: number }
      const snap = r.snapshot()
      return {
        ...saved,
        t: snap.t,
        hash: snap.hash,
        width: snap.renderer.width,
        height: snap.renderer.height,
      }
    },

    dataUrl(t) {
      const r = at(t)
      r.render()
      return r.canvas.toDataURL('image/png')
    },
  }
}
