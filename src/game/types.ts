import type { BuiltAsset, MaterialSpec, MeshData } from '../assets/types'
import type { Vec3 } from '../core/math'

export type { GameConfig } from './schema'

/** One validated catalog asset, ready to be drawn by the renderer. */
export interface GameAsset {
  id: string
  artifact: BuiltAsset
  material: MaterialSpec
}

export type GamePhase = 'collecting' | 'return' | 'won'

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
  hash: string
}

/** A render-only instance of an asset. Never part of World or collision. */
export interface GameVisual {
  id: string
  mesh: MeshData
  material: MaterialSpec
  pos: Vec3
  rotY: number
  scale: number
  collectible: boolean
}
