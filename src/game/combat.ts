import type { Vec3 } from '../core/math'
import type { CombatConfig, EnemyConfig } from './schema'
import type { CombatSnapshot, EnemyRenderState } from './types'

export interface CombatEnemyState {
  id: string
  health: number
  contactCooldown: number
  hitFlash: number
}

export interface CombatState {
  playerHealth: number
  attackCooldown: number
  prevAttack: boolean
  attacks: number
  hits: number
  damageDealt: number
  damageTaken: number
  enemies: CombatEnemyState[]
}

function horizontalDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[2] - b[2])
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.trunc(value)))
}

function nonNegativeInt(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.trunc(value))
}

/**
 * Pure combat state: health, attack edges/cooldowns, nearest-target hit tests,
 * contact damage, and deterministic counters. It never reads World, THREE, the
 * asset catalog, or the clock. CollectGame composes it and owns collect/return.
 */
export class Combat {
  readonly config: CombatConfig
  readonly enemies: readonly EnemyConfig[]

  #playerHealth: number
  #attackCooldown = 0
  #prevAttack = false
  #attacks = 0
  #hits = 0
  #damageDealt = 0
  #damageTaken = 0
  #enemyStates: CombatEnemyState[] = []

  constructor(config: CombatConfig, enemies: readonly EnemyConfig[]) {
    this.config = config
    this.enemies = enemies
    this.#playerHealth = config.playerHealth
    this.reset()
  }

  get playerDefeated(): boolean {
    return this.#playerHealth <= 0
  }

  reset(): void {
    this.#playerHealth = this.config.playerHealth
    this.#attackCooldown = 0
    this.#prevAttack = false
    this.#attacks = 0
    this.#hits = 0
    this.#damageDealt = 0
    this.#damageTaken = 0
    this.#enemyStates = this.enemies.map((enemy) => ({
      id: enemy.id,
      health: enemy.health,
      // The configured cooldown is also the spawn/reset grace. This is why a
      // player that starts inside the volume cannot be damaged on step one.
      contactCooldown: this.config.contactCooldownSteps,
      hitFlash: 0,
    }))
  }

  /** One active fixed step. Terminal phases are handled by CollectGame. */
  update(playerPos: Vec3, attackHeld: boolean): void {
    if (this.playerDefeated) return

    // Tick first so an attack set to N steps is usable on the Nth later step.
    if (this.#attackCooldown > 0) this.#attackCooldown -= 1
    for (const enemy of this.#enemyStates) {
      if (enemy.contactCooldown > 0) enemy.contactCooldown -= 1
      if (enemy.hitFlash > 0) enemy.hitFlash -= 1
    }

    const pressed = attackHeld && !this.#prevAttack
    this.#prevAttack = attackHeld

    // A press during cooldown is deliberately discarded, not buffered.
    if (pressed && this.#attackCooldown === 0) {
      this.#attacks += 1
      const target = this.#nearestAlive(playerPos)
      if (target) {
        const dealt = Math.min(target.health, this.config.attackDamage)
        target.health -= dealt
        this.#hits += 1
        this.#damageDealt += dealt
        target.hitFlash = target.health > 0 ? this.config.hitFlashSteps : 0
      }
      this.#attackCooldown = this.config.attackCooldownSteps
    }

    // Contact is checked after the attack so a lethal hit on the sentinel can
    // prevent that sentinel's contact damage on the same step.
    for (let i = 0; i < this.enemies.length; i++) {
      const config = this.enemies[i]
      const state = this.#enemyStates[i]
      if (state.health <= 0 || state.contactCooldown > 0) continue
      if (horizontalDistance(playerPos, config.pos) > config.radius) continue

      const taken = Math.min(this.#playerHealth, config.damage)
      this.#playerHealth -= taken
      this.#damageTaken += taken
      state.contactCooldown = this.config.contactCooldownSteps
    }
  }

  #nearestAlive(playerPos: Vec3): CombatEnemyState | undefined {
    let nearest: CombatEnemyState | undefined
    let nearestDistance = Infinity

    for (let i = 0; i < this.enemies.length; i++) {
      const state = this.#enemyStates[i]
      if (state.health <= 0) continue
      const distance = horizontalDistance(playerPos, this.enemies[i].pos)
      if (distance > this.config.attackRange) continue
      // Strictly closer: ties keep the earlier config entry.
      if (distance < nearestDistance) {
        nearest = state
        nearestDistance = distance
      }
    }

    return nearest
  }

  snapshot(playerPos: Vec3): CombatSnapshot {
    const enemies = this.#enemyStates.map((state, index) => {
      const config = this.enemies[index]
      return {
        id: state.id,
        health: state.health,
        maxHealth: config.health,
        defeated: state.health <= 0,
        distance: Number(horizontalDistance(playerPos, config.pos).toFixed(6)),
        contactRadius: config.radius,
        contactCooldown: state.contactCooldown,
        hitFlash: state.hitFlash > 0,
      }
    })

    return {
      player: {
        health: this.#playerHealth,
        maxHealth: this.config.playerHealth,
        defeated: this.playerDefeated,
      },
      enemies,
      attacks: this.#attacks,
      hits: this.#hits,
      misses: this.#attacks - this.#hits,
      damageDealt: this.#damageDealt,
      damageTaken: this.#damageTaken,
      attackCooldown: this.#attackCooldown,
      attackCooldownSteps: this.config.attackCooldownSteps,
      attackRange: this.config.attackRange,
      enemiesDefeated: enemies.filter((enemy) => enemy.defeated).length,
    }
  }

  enemyRenderStates(): EnemyRenderState[] {
    return this.#enemyStates.map((state) => ({
      id: state.id,
      defeated: state.health <= 0,
      hitFlash: state.health > 0 && state.hitFlash > 0,
    }))
  }

  hashValues(): number[] {
    return [
      this.#playerHealth,
      this.#attackCooldown,
      this.#prevAttack ? 1 : 0,
      this.#attacks,
      this.#hits,
      this.#damageDealt,
      this.#damageTaken,
      ...this.#enemyStates.flatMap((enemy) => [enemy.health, enemy.contactCooldown, enemy.hitFlash]),
    ]
  }

  exportState(): CombatState {
    return {
      playerHealth: this.#playerHealth,
      attackCooldown: this.#attackCooldown,
      prevAttack: this.#prevAttack,
      attacks: this.#attacks,
      hits: this.#hits,
      damageDealt: this.#damageDealt,
      damageTaken: this.#damageTaken,
      enemies: this.#enemyStates.map((enemy) => ({ ...enemy })),
    }
  }

  restore(state: CombatState): void {
    this.#playerHealth = clampInt(state.playerHealth, 0, this.config.playerHealth)
    this.#attackCooldown = clampInt(state.attackCooldown, 0, this.config.attackCooldownSteps)
    this.#prevAttack = state.prevAttack === true
    this.#attacks = nonNegativeInt(state.attacks)
    this.#hits = Math.min(this.#attacks, nonNegativeInt(state.hits))
    this.#damageDealt = nonNegativeInt(state.damageDealt)
    this.#damageTaken = nonNegativeInt(state.damageTaken)

    const saved = new Map(state.enemies.map((enemy) => [enemy.id, enemy]))
    this.#enemyStates = this.enemies.map((config) => {
      const enemy = saved.get(config.id)
      const health = clampInt(enemy?.health ?? config.health, 0, config.health)
      return {
        id: config.id,
        health,
        contactCooldown: clampInt(
          enemy?.contactCooldown ?? this.config.contactCooldownSteps,
          0,
          this.config.contactCooldownSteps,
        ),
        hitFlash: health > 0 ? clampInt(enemy?.hitFlash ?? 0, 0, this.config.hitFlashSteps) : 0,
      }
    })
  }
}
