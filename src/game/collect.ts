import { statsOf } from '../assets/mesh'
import { hashNumbers } from '../core/hash'
import type { Vec3 } from '../core/math'
import type { GameAsset, GameConfig, GamePhase, GameSnapshot } from './types'

export interface CollectGameState {
  phase: GamePhase
  collected: string[]
}

const PHASE_VALUE: Record<GamePhase, number> = {
  collecting: 0,
  return: 1,
  won: 2,
}

function near(a: Vec3, b: Vec3, radius: number): boolean {
  return Math.hypot(a[0] - b[0], a[2] - b[2]) <= radius
}

/**
 * Pure collect/return state. It never reads World or touches THREE; the engine
 * steps it immediately after physics and snapshots it for the agent/HUD.
 */
export class CollectGame {
  readonly id: string
  readonly config: GameConfig
  readonly assets: ReadonlyMap<string, GameAsset>
  readonly errors: string[]

  #collected = new Set<string>()
  #phase: GamePhase = 'collecting'
  #assetTriangles: Record<string, number> = {}
  #avatarTriangles = 0

  constructor(id: string, config: GameConfig, assets: ReadonlyMap<string, GameAsset>) {
    this.id = id
    this.config = config
    this.assets = assets

    const required = new Map<string, Set<string>>()
    const require = (assetId: string, usage: string): void => {
      const usages = required.get(assetId) ?? new Set<string>()
      usages.add(usage)
      required.set(assetId, usages)
    }

    require(config.avatar.asset, 'avatar')
    config.collectibles.forEach((item) => require(item.asset, `collectible '${item.id}'`))
    config.props.forEach((prop) => require(prop.asset, `prop '${prop.id}'`))

    const missing: string[] = []
    for (const [assetId, usages] of required) {
      const asset = assets.get(assetId)
      if (asset === undefined) {
        missing.push(`missing asset '${assetId}' (${[...usages].join(', ')})`)
        continue
      }
      const triangles = statsOf(asset.artifact.geometry).triangles
      this.#assetTriangles[assetId] = triangles
      if (assetId === config.avatar.asset) this.#avatarTriangles = triangles
    }
    this.errors = missing
  }

  get phase(): GamePhase {
    return this.#phase
  }

  get collected(): string[] {
    return this.config.collectibles.filter((item) => this.#collected.has(item.id)).map((item) => item.id)
  }

  reset(): void {
    this.#collected.clear()
    this.#phase = 'collecting'
  }

  /** Called once per fixed physics step, after the player has moved. */
  update(playerPos: Vec3): void {
    if (this.#phase === 'won') return

    if (this.#phase === 'collecting') {
      for (const item of this.config.collectibles) {
        if (!this.#collected.has(item.id) && near(playerPos, item.pos, item.radius)) {
          this.#collected.add(item.id)
        }
      }
      if (this.#collected.size === this.config.collectibles.length) this.#phase = 'return'
    }

    if (this.#phase === 'return' && near(playerPos, this.config.returnZone.pos, this.config.returnZone.radius)) {
      this.#phase = 'won'
    }
  }

  snapshot(playerPos: Vec3): GameSnapshot {
    const collected = this.collected
    const distance = Math.hypot(playerPos[0] - this.config.returnZone.pos[0], playerPos[2] - this.config.returnZone.pos[2])
    return {
      id: this.id,
      phase: this.#phase,
      collected,
      total: this.config.collectibles.length,
      remaining: this.config.collectibles.length - collected.length,
      returnDistance: Number(distance.toFixed(6)),
      errors: [...this.errors],
      assetTriangles: { ...this.#assetTriangles },
      avatarTriangles: this.#avatarTriangles,
      hash: hashNumbers(this.hashValues()),
    }
  }

  hashValues(): number[] {
    return [
      PHASE_VALUE[this.#phase],
      ...this.config.collectibles.map((item) => (this.#collected.has(item.id) ? 1 : 0)),
    ]
  }

  exportState(): CollectGameState {
    return { phase: this.#phase, collected: this.collected }
  }

  restore(state: CollectGameState): void {
    const valid = new Set(this.config.collectibles.map((item) => item.id))
    this.#collected = new Set(state.collected.filter((id) => valid.has(id)))
    this.#phase = state.phase
  }
}
