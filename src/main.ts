import { catalog } from './assets/catalog'
import { effectiveMaterial } from './assets/build'
import { Engine } from './engine'
import type { GameAsset } from './game/types'
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
const hud = document.getElementById('hud')
const hint = document.getElementById('hint')
if (!container || !overlay || !hud || !hint) throw new Error('index.html is missing #app, #errors, #hud or #hint')

const appEl: HTMLElement = container
const errorsEl: HTMLElement = overlay
const hudEl: HTMLElement = hud
const hintEl: HTMLElement = hint

function report(errors: SceneIssue[]): void {
  if (errors.length === 0) {
    errorsEl.classList.remove('visible')
    errorsEl.textContent = ''
    return
  }
  errorsEl.classList.add('visible')
  errorsEl.textContent = ['scene rejected — last valid scene still running:', ...errors.map((issue) => `  ${issue.path || '<root>'}: ${issue.message} [${issue.code}]`)].join('\n')
}

async function loadGameAssets(): Promise<ReadonlyMap<string, GameAsset>> {
  const loaded = await catalog()
  const assets = new Map<string, GameAsset>()

  for (const entry of loaded.entries) {
    const outcome = entry.outcome
    if (!outcome.ok || outcome.artifact === undefined) continue
    assets.set(entry.doc.id, {
      id: entry.doc.id,
      artifact: outcome.artifact,
      material: effectiveMaterial(outcome.artifact, entry.doc.override.material),
    })
  }

  if (loaded.failures.length > 0) console.warn('[game] some assets failed to build', loaded.failures)
  return assets
}

function syncHud(engine: Engine): void {
  const game = engine.inspect().game
  if (game === undefined) {
    hudEl.hidden = true
    return
  }

  hudEl.hidden = false
  hudEl.dataset.phase = game.errors.length > 0 ? 'error' : game.phase

  if (game.errors.length > 0) {
    hudEl.textContent = `GAME ASSET ERROR\n${game.errors.join('\n')}`
    return
  }

  const combat = game.combat
  const healthLine = `HP ${combat.player.health}/${combat.player.maxHealth}`
  const enemy = combat.enemies[0]
  const enemyLine =
    enemy === undefined
      ? 'NO SENTINEL'
      : enemy.defeated
        ? 'SENTINEL DEFEATED'
        : `SENTINEL ${enemy.health}/${enemy.maxHealth}${enemy.hitFlash ? ' · HIT' : ''}`

  if (game.phase === 'lost') {
    hudEl.textContent = `DEFEATED\n${healthLine} · ${enemyLine}\npress R to restart.`
    return
  }

  if (game.phase === 'collecting') {
    hudEl.textContent = `SWORDS ${game.collected.length} / ${game.total}\n${healthLine} · ${enemyLine}\nWalk into the three swords. F attack.`
    return
  }

  if (game.phase === 'return') {
    hudEl.textContent = `ALL SWORDS FOUND\n${healthLine} · ${enemyLine}\nReturn to the landing pad.`
    return
  }

  hudEl.textContent = `ESCAPED\n${game.total} / ${game.total} swords · ${healthLine} · ${enemyLine}\npress R to restart.`
}

async function boot(): Promise<void> {
  const sceneName = params.get('scene') ?? 'phase1'
  if (!/^[a-z0-9-]+$/.test(sceneName)) throw new Error(`invalid scene name '${sceneName}'`)

  const sceneFile = `/content/scenes/${sceneName}.scene.json`
  const response = await fetch(sceneFile, { cache: 'no-store' })
  if (!response.ok) throw new Error(`cannot load scene: ${response.status}`)

  const raw: unknown = await response.json()
  const parsed = parseScene(raw)
  if (!parsed.ok) {
    report(parsed.errors)
    throw new Error(`scene failed validation: ${parsed.errors.map((issue) => issue.path).join(', ')}`)
  }

  const hasGame = parsed.doc.game !== undefined
  const assets = hasGame ? await loadGameAssets() : undefined
  const engine = new Engine(appEl, parsed.doc, assets)
  window.__engine = engine

  if (hasGame) {
    hintEl.textContent = 'WASD move · Space jump · F attack · R restart'
    syncHud(engine)
  } else {
    hintEl.textContent = 'WASD move · space jump · drag orbit · wheel zoom'
    hudEl.hidden = true
  }

  const keys = new Set<string>()
  const sync = (): void => {
    const forward = (keys.has('KeyW') ? 1 : 0) - (keys.has('KeyS') ? 1 : 0)
    const strafe = (keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0)
    engine.setInput({ moveX: strafe, moveZ: forward, jump: keys.has('Space'), attack: keys.has('KeyF') })
  }

  window.addEventListener('keydown', (event) => {
    if (event.code === 'Space') event.preventDefault()
    if (event.code === 'KeyR' && hasGame) {
      event.preventDefault()
      engine.reset()
      engine.resume()
      sync()
      syncHud(engine)
      return
    }
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
  // Nothing here reloads the page, so simulation state survives. Ignore files
  // other than the scene this tab booted.
  const hot = import.meta.hot as unknown as { on(event: string, handler: (payload: SceneUpdate) => void): void } | undefined
  hot?.on('scene-update', (payload) => {
    if (!payload.file.replaceAll('\\', '/').endsWith(sceneFile)) return

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
    syncHud(engine)
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
    if (hasGame) syncHud(engine)
    requestAnimationFrame(frame)
  }

  requestAnimationFrame(frame)
  console.info(`[engine] ${sceneName} ready — window.__engine is the agent surface`)
}

// Two entry modes share this page: the scene/game (?scene=island) and the asset
// inspector (?asset=<id>). Keeping one HTML entry means one build and one
// capture sink.
const params = new URLSearchParams(window.location.search)
if (params.has('asset')) {
  void bootPreview(appEl, errorsEl, params)
} else {
  void boot()
}
