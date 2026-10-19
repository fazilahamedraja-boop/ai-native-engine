import { Engine } from './engine'
import { FIXED_DT } from './physics/step'
import { bootPreview } from './preview/main'
import { parseScene, type SceneIssue } from './schema/scene'

declare global {
  interface Window {
    __engine: Engine
  }
}

interface SceneUpdate {
  file: string
  text: string
}

const container = document.getElementById('app')
const overlay = document.getElementById('errors')
if (!container || !overlay) throw new Error('index.html is missing #app or #errors')

const appEl: HTMLElement = container
const errorsEl: HTMLElement = overlay

function report(errors: SceneIssue[]): void {
  if (errors.length === 0) {
    errorsEl.classList.remove('visible')
    errorsEl.textContent = ''
    return
  }
  errorsEl.classList.add('visible')
  errorsEl.textContent = ['scene rejected — last valid scene still running:', ...errors.map((issue) => `  ${issue.path || '<root>'}: ${issue.message} [${issue.code}]`)].join('\n')
}

async function boot(): Promise<void> {
  const response = await fetch('/content/scenes/phase1.scene.json', { cache: 'no-store' })
  if (!response.ok) throw new Error(`cannot load scene: ${response.status}`)

  const raw: unknown = await response.json()
  const parsed = parseScene(raw)
  if (!parsed.ok) {
    report(parsed.errors)
    throw new Error(`scene failed validation: ${parsed.errors.map((issue) => issue.path).join(', ')}`)
  }

  const engine = new Engine(appEl, parsed.doc)
  window.__engine = engine

  const keys = new Set<string>()
  const sync = (): void => {
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0)
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0)
    engine.setInput({ moveX: strafe, moveZ: forward, jump: keys.has('Space') })
  }

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') event.preventDefault()
    keys.add(event.code)
    sync()
  })
  window.addEventListener('keyup', (event) => {
    keys.delete(event.code)
    sync()
  })

  let dragging = false
  let lastX = 0
  let lastY = 0
  const canvas = engine.renderer.canvas

  canvas.addEventListener('pointerdown', (event) => {
    dragging = true
    lastX = event.clientX
    lastY = event.clientY
    canvas.setPointerCapture(event.pointerId)
  })
  canvas.addEventListener('pointerup', () => {
    dragging = false
  })
  canvas.addEventListener('pointermove', (event) => {
    if (!dragging) return
    const camera = engine.world.camera
    if (camera.rig !== 'orbit') return
    engine.setOrbit({
      yaw: camera.yaw - (event.clientX - lastX) * 0.35,
      pitch: camera.pitch + (event.clientY - lastY) * 0.35,
    })
    lastX = event.clientX
    lastY = event.clientY
  })
  canvas.addEventListener(
    'wheel',
    (event) => {
      const camera = engine.world.camera
      if (camera.rig !== 'orbit') return
      event.preventDefault()
      engine.setOrbit({ distance: camera.distance + Math.sign(event.deltaY) * 0.8 })
    },
    { passive: false },
  )

  // Live update: the watcher in vite.config.ts pushes validated scene text.
  // Nothing here reloads the page, so simulation state survives.
  const hot = import.meta.hot as unknown as { on(event: string, handler: (payload: SceneUpdate) => void): void } | undefined
  hot?.on('scene-update', (payload) => {
    let rawScene: unknown
    try {
      rawScene = JSON.parse(payload.text)
    } catch (error) {
      report([{ path: '', code: 'invalid_json', message: (error as Error).message }])
      return
    }

    const result = engine.applyScene(rawScene)
    if (!result.ok) {
      report(result.errors)
      return
    }
    report([])
    console.info('[scene] applied', { reload: result.reload, step: engine.world.step })
  })

  let last = performance.now()
  let accumulator = 0

  const frame = (now: number): void => {
    const elapsed = Math.min(0.25, (now - last) / 1000)
    last = now

    if (!engine.paused) {
      accumulator += elapsed
      let guard = 0
      while (accumulator >= FIXED_DT && guard < 6) {
        engine.stepOnce()
        accumulator -= FIXED_DT
        guard += 1
      }
      if (accumulator > FIXED_DT * 6) accumulator = 0
    }

    engine.renderer.render(engine.world)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
  console.info('[engine] phase 1 ready — window.__engine is the agent surface')
}

// Two entry modes share this page: the game (?nothing) and the asset inspector
// (?asset=<id>). Keeping one HTML entry means one build and one capture sink.
const params = new URLSearchParams(window.location.search)
if (params.has('asset')) {
  void bootPreview(appEl, errorsEl, params)
} else {
  void boot()
}
