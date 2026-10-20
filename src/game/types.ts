import type { BuiltAsset, MaterialSpec, MeshData } from '../assets/types'
import type { Vec3 } from '../core/math'

export type { GameConfig } from './schema'

/** One validated catalog asset, ready to be drawn by the renderer. */
export interface GameAsset {
  id: string
  artifact: BuiltAsset
  material: MaterialSpec
}

export type GamePhase = 'collecting' | 'return' | 'won' | 'lost'

export interface EnemySnapshot {
  id: string
  health: number
  maxHealth: number
  defeated: boolean
  /** Horizontal distance from the player to the enemy centre. */
  distance: number
  contactRadius: number
  contactCooldown: number
  hitFlash: boolean
}

export interface CombatSnapshot {
  player: { health: number; maxHealth: number; defeated: boolean }
  enemies: EnemySnapshot[]
  attacks: number
  hits: number
  misses: number
  damageDealt: number
  damageTaken: number
  attackCooldown: number
  attackCooldownSteps: number
  attackRange: number
  enemiesDefeated: number
}

export interface GameSnapshot {
  id: string
  phase: GamePhase
  collected: string[]
  total: number
  remaining: number
  /** Horizontal distance from the player to the return zone centre. */
  returnDistance: number
  errors: string[]
  assetTriangles: Record<string, number>
  avatarTriangles: number
  combat: CombatSnapshot
  hash: string
}

/** Per-enemy values the renderer needs without simulating anything. */
export interface EnemyRenderState {
  id: string
  defeated: boolean
  hitFlash: boolean
}

/** A render-only instance of an asset. Never part of World or collision. */
export interface GameVisual {
  id: string
  mesh: MeshData
  material: MaterialSpec
  pos: Vec3
  rotY: number
  scale: number
  kind: 'prop' | 'collectible' | 'enemy'
}
