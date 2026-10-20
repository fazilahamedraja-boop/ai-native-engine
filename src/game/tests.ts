import type { CameraState } from '../camera/rigs'
import { stateHash } from '../devtools/state'
import type { TestReport, TestResult } from '../devtools/tests'
import { FIXED_DT, stepWorld } from '../physics/step'
import type { PlayerState, World } from '../world/world'
import { resetWorld } from '../world/world'
import type { CollectGame } from './collect'

const IDLE = { moveX: 0, moveZ: 0, jump: false }

type Outcome = { passed: boolean; detail: string }
const pass = (detail: string): Outcome => ({ passed: true, detail })
const fail = (detail: string): Outcome => ({ passed: false, detail })

interface DriveInput {
  moveX?: number
  moveZ?: number
  jump?: boolean
}

function settle(world: World, game: CollectGame, steps = 120): void {
  world.input = { ...IDLE }
  for (let i = 0; i < steps; i++) {
    stepWorld(world, FIXED_DT)
    game.update(world.player.pos)
  }
}

function restart(world: World, game: CollectGame): void {
  resetWorld(world)
  game.reset()
  settle(world, game)
}

function advance(world: World, game: CollectGame, input: DriveInput, steps: number): void {
  world.input = { ...IDLE, ...input }
  for (let i = 0; i < steps; i++) {
    stepWorld(world, FIXED_DT)
    game.update(world.player.pos)
  }
}

/**
 * Game acceptance tests. They drive the real physics/input path, update the
 * same state machine as the rAF loop, and restore the live world/game after.
 */
export function runGameTests(world: World, game: CollectGame): TestReport {
  const started = performance.now()
  const hashBefore = stateHash(world, game)

  const saved = {
    step: world.step,
    player: { pos: [...world.player.pos], vel: [...world.player.vel], grounded: world.player.grounded } as PlayerState,
    camera: JSON.parse(JSON.stringify(world.camera)) as CameraState,
    input: { ...world.input },
    prevJump: world.prevJump,
    lastReload: world.lastReload,
    game: game.exportState(),
  }

  const results: TestResult[] = []
  const record = (name: string, fn: () => Outcome): void => {
    try {
      results.push({ name, ...fn() })
    } catch (error) {
      results.push({ name, passed: false, detail: `threw: ${(error as Error).message}` })
    }
  }

  record('game-assets', () => {
    const snap = game.snapshot(world.player.pos)
    const required = new Set([
      game.config.avatar.asset,
      ...game.config.collectibles.map((item) => item.asset),
      ...game.config.props.map((prop) => prop.asset),
    ])
    const missing = [...required].filter((id) => (snap.assetTriangles[id] ?? 0) <= 0)
    const ok = snap.errors.length === 0 && missing.length === 0 && snap.avatarTriangles > 0 && snap.total === 3
    const assets = [...required].map((id) => `${id}:${snap.assetTriangles[id] ?? 0}`).join(', ')
    const detail = `errors=[${snap.errors.join('; ')}] collectibles=${snap.total} avatarTri=${snap.avatarTriangles} assets=${assets}`
    return ok ? pass(detail) : fail(detail)
  })

  record('collect-all', () => {
    restart(world, game)
    const startZ = world.player.pos[2]
    advance(world, game, { moveZ: 1 }, 200)
    const snap = game.snapshot(world.player.pos)
    const moved = world.player.pos[2] - startZ
    const ok = snap.phase === 'return' && snap.collected.length === 3 && snap.remaining === 0 && moved > 12 && world.player.grounded
    const detail = `phase=${snap.phase} collected=${snap.collected.length}/${snap.total} movedZ=${moved.toFixed(3)} grounded=${world.player.grounded}`
    return ok ? pass(detail) : fail(detail)
  })

  record('return-wins', () => {
    restart(world, game)
    advance(world, game, { moveZ: 1 }, 200)
    advance(world, game, { moveZ: -1 }, 220)
    const snap = game.snapshot(world.player.pos)
    const ok = snap.phase === 'won' && snap.returnDistance <= game.config.returnZone.radius + 1e-6
    const detail = `phase=${snap.phase} collected=${snap.collected.length}/${snap.total} distance=${snap.returnDistance.toFixed(3)} radius=${game.config.returnZone.radius}`
    return ok ? pass(detail) : fail(detail)
  })

  record('restart', () => {
    restart(world, game)
    advance(world, game, { moveZ: 1 }, 200)
    advance(world, game, { moveZ: -1 }, 220)
    const won = game.phase === 'won'
    restart(world, game)
    const snap = game.snapshot(world.player.pos)
    const spawnGap = Math.hypot(
      world.player.pos[0] - world.spawn.pos[0],
      world.player.pos[2] - world.spawn.pos[2],
    )
    const ok = won && snap.phase === 'collecting' && snap.collected.length === 0 && spawnGap < 1e-6
    const detail = `wonBefore=${won} phase=${snap.phase} collected=${snap.collected.length} spawnGap=${spawnGap.toExponential(2)}`
    return ok ? pass(detail) : fail(detail)
  })

  record('determinism', () => {
    const sequence = (): { hash: string; phase: string } => {
      restart(world, game)
      advance(world, game, { moveZ: 1 }, 200)
      advance(world, game, { moveZ: -1 }, 220)
      return { hash: stateHash(world, game), phase: game.phase }
    }

    const a = sequence()
    const b = sequence()
    const ok = a.hash === b.hash && a.phase === 'won' && b.phase === 'won'
    const detail = `hash ${a.hash} vs ${b.hash}; phase=${a.phase}/${b.phase}`
    return ok ? pass(detail) : fail(detail)
  })

  world.step = saved.step
  world.player = saved.player
  world.camera = saved.camera
  world.input = saved.input
  world.prevJump = saved.prevJump
  world.lastReload = saved.lastReload
  game.restore(saved.game)

  return {
    passed: results.every((result) => result.passed),
    results,
    durationMs: Number((performance.now() - started).toFixed(2)),
    statePreserved: stateHash(world, game) === hashBefore,
    hash: stateHash(world, game),
  }
}
