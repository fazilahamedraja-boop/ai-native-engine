import type { CameraState } from '../camera/rigs'
import { stateHash } from '../devtools/state'
import type { TestReport, TestResult } from '../devtools/tests'
import { FIXED_DT, stepWorld } from '../physics/step'
import type { InputState, PlayerState, World } from '../world/world'
import { resetWorld } from '../world/world'
import { CollectGame, type CollectGameState } from './collect'
import { GameConfigSchema, type EnemyConfig, type GameConfig } from './schema'

const IDLE: InputState = { moveX: 0, moveZ: 0, jump: false, attack: false }

type Outcome = { passed: boolean; detail: string }
const pass = (detail: string): Outcome => ({ passed: true, detail })
const fail = (detail: string): Outcome => ({ passed: false, detail })

interface DriveInput {
  moveX?: number
  moveZ?: number
  jump?: boolean
  attack?: boolean
}

function advance(world: World, game: CollectGame, input: DriveInput, steps: number): void {
  world.input = { ...IDLE, ...input }
  for (let i = 0; i < steps; i++) {
    stepWorld(world, FIXED_DT)
    game.update(world.player.pos, world.input.attack)
  }
}

function settle(world: World, game: CollectGame, steps = 120): void {
  advance(world, game, {}, steps)
}

/** Definition reset without the 120-step settle, for grace-period tests. */
function hardReset(world: World, game: CollectGame): void {
  resetWorld(world)
  game.reset()
}

function restart(world: World, game: CollectGame): void {
  hardReset(world, game)
  settle(world, game)
}

/** The Phase 4 island route, now ending just outside the sentinel's contact radius. */
function walkToAttack(world: World, game: CollectGame): void {
  advance(world, game, { moveZ: 1 }, 134)
  advance(world, game, { moveX: 1 }, 47)
}

function attackOnce(world: World, game: CollectGame): void {
  advance(world, game, { attack: true }, 1)
}

function releaseAttack(world: World, game: CollectGame): void {
  advance(world, game, { attack: false }, 1)
}

function waitAttackCooldown(world: World, game: CollectGame): void {
  advance(world, game, { attack: false }, game.config.combat.attackCooldownSteps)
}

function sentinelOf(game: CollectGame): EnemyConfig {
  return game.config.enemies[0]
}

function placeAt(world: World, x: number, z: number): void {
  world.player.pos = [x, world.spawn.pos[1], z]
  world.player.vel = [0, 0, 0]
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
      ...game.config.enemies.map((enemy) => enemy.asset),
    ])
    const missing = [...required].filter((id) => (snap.assetTriangles[id] ?? 0) <= 0)
    const sentinel = snap.combat.enemies[0]
    const ok =
      snap.errors.length === 0 &&
      missing.length === 0 &&
      snap.avatarTriangles > 0 &&
      snap.total === 3 &&
      snap.combat.enemies.length === 1 &&
      sentinel !== undefined &&
      sentinel.id === 'sentinel' &&
      sentinel.health === 3 &&
      sentinel.maxHealth === 3 &&
      !sentinel.defeated &&
      Number.isFinite(sentinel.distance) &&
      snap.combat.attackRange === 2
    const assets = [...required].map((id) => `${id}:${snap.assetTriangles[id] ?? 0}`).join(', ')
    const detail =
      `errors=[${snap.errors.join('; ')}] collectibles=${snap.total} avatarTri=${snap.avatarTriangles} ` +
      `enemies=${snap.combat.enemies.length} range=${snap.combat.attackRange} assets=${assets}`
    return ok ? pass(detail) : fail(detail)
  })

  record('collect-all', () => {
    restart(world, game)
    const startZ = world.player.pos[2]
    advance(world, game, { moveZ: 1 }, 200)
    const snap = game.snapshot(world.player.pos)
    const moved = world.player.pos[2] - startZ
    const ok =
      snap.phase === 'return' &&
      snap.collected.length === 3 &&
      snap.remaining === 0 &&
      moved > 12 &&
      world.player.grounded &&
      snap.combat.player.health === 3 &&
      snap.combat.damageTaken === 0 &&
      snap.combat.enemies[0]?.health === 3
    const detail =
      `phase=${snap.phase} collected=${snap.collected.length}/${snap.total} movedZ=${moved.toFixed(3)} ` +
      `grounded=${world.player.grounded} hp=${snap.combat.player.health}`
    return ok ? pass(detail) : fail(detail)
  })

  record('return-wins', () => {
    restart(world, game)
    advance(world, game, { moveZ: 1 }, 200)
    advance(world, game, { moveZ: -1 }, 220)
    const snap = game.snapshot(world.player.pos)
    const won =
      snap.phase === 'won' &&
      snap.returnDistance <= game.config.returnZone.radius + 1e-6 &&
      snap.combat.player.health === 3

    // Won is terminal: teleport into contact and hold attack; nothing changes.
    const enemy = sentinelOf(game)
    placeAt(world, enemy.pos[0], enemy.pos[2])
    advance(world, game, { attack: true }, 120)
    const terminal = game.snapshot(world.player.pos)
    const terminalOk =
      terminal.phase === 'won' &&
      terminal.combat.player.health === 3 &&
      terminal.combat.enemies[0]?.health === 3 &&
      terminal.combat.attacks === 0 &&
      terminal.collected.length === 3

    const ok = won && terminalOk
    const detail =
      `phase=${snap.phase} collected=${snap.collected.length}/${snap.total} ` +
      `distance=${snap.returnDistance.toFixed(3)} radius=${game.config.returnZone.radius}; ` +
      `terminal=${terminalOk} hp=${terminal.combat.player.health} enemy=${terminal.combat.enemies[0]?.health}`
    return ok ? pass(detail) : fail(detail)
  })

  record('restart', () => {
    // Damage and flash.
    restart(world, game)
    walkToAttack(world, game)
    attackOnce(world, game)
    const damaged = game.snapshot(world.player.pos).combat.enemies[0]?.health === 2

    // Defeat.
    releaseAttack(world, game)
    waitAttackCooldown(world, game)
    attackOnce(world, game)
    releaseAttack(world, game)
    waitAttackCooldown(world, game)
    attackOnce(world, game)
    releaseAttack(world, game)
    const defeated = game.snapshot(world.player.pos).combat.enemies[0]?.defeated === true

    // Lost.
    hardReset(world, game)
    const enemy = sentinelOf(game)
    placeAt(world, enemy.pos[0], enemy.pos[2])
    advance(world, game, {}, 180)
    const lost = game.phase === 'lost'

    // Reset from lost, inspect before any settle step.
    hardReset(world, game)
    const snap = game.snapshot(world.player.pos)
    const exported = game.exportState()
    const spawnGap = Math.hypot(
      world.player.pos[0] - world.spawn.pos[0],
      world.player.pos[2] - world.spawn.pos[2],
    )
    const sentinel = snap.combat.enemies[0]
    const render = game.enemyRenderStates()[0]
    const clean =
      snap.phase === 'collecting' &&
      snap.collected.length === 0 &&
      spawnGap < 1e-6 &&
      snap.combat.player.health === 3 &&
      snap.combat.attacks === 0 &&
      snap.combat.hits === 0 &&
      snap.combat.misses === 0 &&
      snap.combat.damageDealt === 0 &&
      snap.combat.damageTaken === 0 &&
      snap.combat.attackCooldown === 0 &&
      sentinel !== undefined &&
      sentinel.health === 3 &&
      sentinel.maxHealth === 3 &&
      !sentinel.defeated &&
      sentinel.contactCooldown === 60 &&
      !sentinel.hitFlash &&
      exported.combat.prevAttack === false &&
      render !== undefined &&
      !render.defeated &&
      !render.hitFlash

    // Reset + settle is reproducible and does not re-damage the player.
    restart(world, game)
    const hashA = stateHash(world, game)
    const settled = game.snapshot(world.player.pos)
    restart(world, game)
    const hashB = stateHash(world, game)
    const stable = hashA === hashB && settled.combat.player.health === 3

    const ok = damaged && defeated && lost && clean && stable
    const detail =
      `damaged=${damaged} defeated=${defeated} lost=${lost} clean=${clean} stable=${stable} ` +
      `spawnGap=${spawnGap.toExponential(2)} contactCooldown=${sentinel?.contactCooldown} hashes=${hashA}/${hashB}`
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

  record('attack-hit', () => {
    restart(world, game)
    walkToAttack(world, game)
    attackOnce(world, game)

    const snap = game.snapshot(world.player.pos)
    const enemy = snap.combat.enemies[0]
    const render = game.enemyRenderStates()[0]
    const hit =
      snap.combat.attacks === 1 &&
      snap.combat.hits === 1 &&
      snap.combat.misses === 0 &&
      snap.combat.damageDealt === 1 &&
      snap.combat.attackCooldown === 12 &&
      snap.combat.player.health === 3 &&
      enemy?.health === 2 &&
      enemy.hitFlash &&
      render?.hitFlash === true &&
      render.defeated === false

    advance(world, game, { attack: false }, 7)
    const flashAfter7 = game.snapshot(world.player.pos).combat.enemies[0]?.hitFlash === true
    advance(world, game, { attack: false }, 1)
    const flashAfter8 = game.snapshot(world.player.pos).combat.enemies[0]?.hitFlash === false

    const ok = hit && flashAfter7 && flashAfter8
    const detail =
      `attacks=${snap.combat.attacks} hits=${snap.combat.hits} enemyHealth=${enemy?.health} ` +
      `cooldown=${snap.combat.attackCooldown} flashStill7=${flashAfter7} flashOff8=${flashAfter8}`
    return ok ? pass(detail) : fail(detail)
  })

  record('attack-miss-edge', () => {
    restart(world, game)

    // Far from the sentinel: a press is a miss and starts the cooldown.
    attackOnce(world, game)
    const first = game.snapshot(world.player.pos).combat

    // Holding across 120 steps must not create another edge.
    advance(world, game, { attack: true }, 120)
    const heldAttacks = game.snapshot(world.player.pos).combat.attacks

    // Release, wait out the cooldown, then press once: one more miss.
    advance(world, game, { attack: false }, 1)
    attackOnce(world, game)
    const second = game.snapshot(world.player.pos).combat

    // A new press while the 12-step cooldown is running is discarded.
    advance(world, game, { attack: false }, 1)
    advance(world, game, { attack: true }, 1)
    const ignoredAttacks = game.snapshot(world.player.pos).combat.attacks
    advance(world, game, { attack: false }, 1)

    const ok =
      first.attacks === 1 &&
      first.hits === 0 &&
      first.misses === 1 &&
      first.damageDealt === 0 &&
      first.attackCooldown === 12 &&
      first.enemies[0]?.health === 3 &&
      !first.enemies[0]?.hitFlash &&
      heldAttacks === 1 &&
      second.attacks === 2 &&
      second.hits === 0 &&
      second.misses === 2 &&
      second.attackCooldown === 12 &&
      ignoredAttacks === 2
    const detail =
      `first=${first.attacks}/${first.hits}/${first.misses} held=${heldAttacks} ` +
      `second=${second.attacks}/${second.hits}/${second.misses} ignored=${ignoredAttacks} ` +
      `enemy=${first.enemies[0]?.health} cooldown=${first.attackCooldown}`
    return ok ? pass(detail) : fail(detail)
  })

  record('enemy-defeat', () => {
    restart(world, game)
    walkToAttack(world, game)

    for (let i = 0; i < 3; i++) {
      attackOnce(world, game)
      releaseAttack(world, game)
      waitAttackCooldown(world, game)
    }

    const snap = game.snapshot(world.player.pos)
    const enemy = snap.combat.enemies[0]
    const render = game.enemyRenderStates()[0]
    const defeated =
      enemy?.health === 0 &&
      enemy.defeated &&
      !enemy.hitFlash &&
      render?.defeated === true &&
      render.hitFlash === false &&
      snap.combat.enemiesDefeated === 1 &&
      snap.combat.attacks === 3 &&
      snap.combat.hits === 3 &&
      snap.combat.damageDealt === 3 &&
      snap.combat.player.health === 3

    attackOnce(world, game)
    const fourth = game.snapshot(world.player.pos).combat
    const noRevive =
      fourth.attacks === 4 &&
      fourth.hits === 3 &&
      fourth.misses === 1 &&
      fourth.damageDealt === 3 &&
      fourth.enemies[0]?.health === 0 &&
      fourth.enemies[0]?.defeated === true

    const ok = defeated && noRevive
    const detail =
      `defeated=${defeated} health=${enemy?.health} attacks=${snap.combat.attacks} ` +
      `hits=${snap.combat.hits} damage=${snap.combat.damageDealt}; ` +
      `fourth=${fourth.attacks}/${fourth.hits}/${fourth.misses} health=${fourth.enemies[0]?.health}`
    return ok ? pass(detail) : fail(detail)
  })

  record('contact', () => {
    // Spawn/reset grace: overlapping the sentinel must not damage on step one.
    hardReset(world, game)
    const enemy = sentinelOf(game)
    placeAt(world, enemy.pos[0], enemy.pos[2])
    const initial = game.snapshot(world.player.pos).combat

    advance(world, game, {}, 59)
    const after59 = game.snapshot(world.player.pos).combat
    advance(world, game, {}, 1)
    const after60 = game.snapshot(world.player.pos).combat
    advance(world, game, {}, 60)
    const after120 = game.snapshot(world.player.pos).combat
    advance(world, game, {}, 60)
    const after180 = game.snapshot(world.player.pos).combat
    const lost = game.phase === 'lost'

    // Once lost, combat is frozen and collection/return cannot override it.
    advance(world, game, {}, 120)
    const afterExtra = game.snapshot(world.player.pos).combat
    const sword = game.config.collectibles[0]
    placeAt(world, sword.pos[0], sword.pos[2])
    advance(world, game, {}, 10)
    const swordPhase = game.phase
    const swordCollected = game.collected.length
    const zone = game.config.returnZone
    placeAt(world, zone.pos[0], zone.pos[2])
    advance(world, game, {}, 10)
    const zonePhase = game.phase

    const grace =
      initial.player.health === 3 &&
      initial.enemies[0]?.contactCooldown === 60 &&
      after59.player.health === 3 &&
      after59.damageTaken === 0 &&
      after59.enemies[0]?.contactCooldown === 1 &&
      after60.player.health === 2 &&
      after60.damageTaken === 1 &&
      after60.enemies[0]?.contactCooldown === 60 &&
      after120.player.health === 1 &&
      after120.damageTaken === 2 &&
      after180.player.health === 0 &&
      after180.damageTaken === 3 &&
      lost

    const terminal =
      afterExtra.player.health === 0 &&
      afterExtra.damageTaken === 3 &&
      afterExtra.enemies[0]?.contactCooldown === 60 &&
      swordPhase === 'lost' &&
      swordCollected === 0 &&
      zonePhase === 'lost'

    // Normal entry after the grace has expired: first contact step damages.
    restart(world, game)
    walkToAttack(world, game)
    advance(world, game, { moveX: 1 }, 7)
    const beforeContact = game.snapshot(world.player.pos).combat
    advance(world, game, { moveX: 1 }, 1)
    const firstContact = game.snapshot(world.player.pos).combat
    const entry =
      beforeContact.player.health === 3 &&
      beforeContact.enemies[0]?.distance !== undefined &&
      beforeContact.enemies[0].distance > 0.9 &&
      firstContact.player.health === 2 &&
      firstContact.damageTaken === 1 &&
      firstContact.enemies[0]?.contactCooldown === 60

    const ok = grace && terminal && entry
    const detail =
      `grace hp59=${after59.player.health} hp60=${after60.player.health} hp120=${after120.player.health} ` +
      `hp180=${after180.player.health} lost=${lost}; terminal=${terminal}; entry=${entry} ` +
      `distance=${beforeContact.enemies[0]?.distance}`
    return ok ? pass(detail) : fail(detail)
  })

  record('combat-determinism', () => {
    const sequence = (): {
      hash: string
      attacks: number
      hits: number
      damageTaken: number
      health: number
      enemyHealth: number
    } => {
      restart(world, game)
      walkToAttack(world, game)
      attackOnce(world, game)
      advance(world, game, { attack: false }, 1)
      advance(world, game, { attack: true }, 1) // ignored while cooling down
      advance(world, game, { attack: false }, 10)
      attackOnce(world, game)
      advance(world, game, { attack: false }, 12)
      advance(world, game, { moveX: 1 }, 8) // first contact hit
      attackOnce(world, game)
      const snap = game.snapshot(world.player.pos)
      return {
        hash: stateHash(world, game),
        attacks: snap.combat.attacks,
        hits: snap.combat.hits,
        damageTaken: snap.combat.damageTaken,
        health: snap.combat.player.health,
        enemyHealth: snap.combat.enemies[0]?.health ?? -1,
      }
    }

    const a = sequence()
    const b = sequence()
    const ok =
      a.hash === b.hash &&
      a.attacks === 3 &&
      a.hits === 3 &&
      a.damageTaken === 1 &&
      a.health === 2 &&
      a.enemyHealth === 0 &&
      a.hits === b.hits &&
      a.damageTaken === b.damageTaken
    const detail =
      `hash ${a.hash} vs ${b.hash}; attacks=${a.attacks}/${b.attacks} hits=${a.hits}/${b.hits} ` +
      `damageTaken=${a.damageTaken}/${b.damageTaken} hp=${a.health}/${b.health} enemy=${a.enemyHealth}/${b.enemyHealth}`
    return ok ? pass(detail) : fail(detail)
  })

  record('state-roundtrip', () => {
    restart(world, game)
    walkToAttack(world, game)
    attackOnce(world, game)
    advance(world, game, { moveX: 1 }, 8) // contact damage and a live cooldown

    const before = stateHash(world, game)
    const exported = game.exportState()
    const mutated = JSON.parse(JSON.stringify(exported)) as CollectGameState
    mutated.phase = 'lost'
    mutated.collected = [game.config.collectibles[0].id]
    mutated.combat.playerHealth = 0
    mutated.combat.attackCooldown = 5
    mutated.combat.prevAttack = true
    mutated.combat.attacks = 99
    mutated.combat.hits = 98
    mutated.combat.damageDealt = 98
    mutated.combat.damageTaken = 3
    mutated.combat.enemies[0].health = 0
    mutated.combat.enemies[0].contactCooldown = 3
    mutated.combat.enemies[0].hitFlash = 2

    game.restore(mutated)
    const mutatedHash = stateHash(world, game)

    const lostCount = game.exportState().collected.length
    const sword = game.config.collectibles[0]
    game.update([sword.pos[0], sword.pos[1], sword.pos[2]], false)
    const lostTerminal = game.phase === 'lost' && game.exportState().collected.length === lostCount

    const wonState = JSON.parse(JSON.stringify(exported)) as CollectGameState
    wonState.phase = 'won'
    game.restore(wonState)
    const wonHealth = game.exportState().combat.playerHealth
    const enemy = sentinelOf(game)
    game.update([enemy.pos[0], enemy.pos[1], enemy.pos[2]], true)
    const wonTerminal = game.phase === 'won' && game.exportState().combat.playerHealth === wonHealth

    game.restore(exported)
    const after = stateHash(world, game)

    const ok = before === after && mutatedHash !== before && lostTerminal && wonTerminal
    const detail =
      `before=${before} after=${after} mutated=${mutatedHash}; lostTerminal=${lostTerminal} wonTerminal=${wonTerminal}`
    return ok ? pass(detail) : fail(detail)
  })

  record('invalid-config', () => {
    const base = JSON.parse(JSON.stringify(game.config)) as GameConfig
    const clone = (): GameConfig => JSON.parse(JSON.stringify(base)) as GameConfig
    const rejects = (mutate: (raw: GameConfig) => void, path: string): boolean => {
      const raw = clone()
      mutate(raw)
      const result = GameConfigSchema.safeParse(raw)
      return !result.success && result.error.issues.some((issue) => issue.path.join('.') === path)
    }

    const health = rejects((raw) => {
      raw.enemies[0].health = 0
    }, 'enemies.0.health')
    const duplicateEnemy = rejects((raw) => {
      raw.enemies.push({ ...raw.enemies[0] })
    }, 'enemies.1.id')
    const duplicateCollectible = rejects((raw) => {
      raw.collectibles[1].id = raw.collectibles[0].id
    }, 'collectibles.1.id')
    const unknownEnemy = rejects((raw) => {
      Object.assign(raw.enemies[0], { unexpected: true })
    }, 'enemies.0')
    const unknownCombat = rejects((raw) => {
      Object.assign(raw.combat, { unexpected: true })
    }, 'combat')
    const zeroAttack = rejects((raw) => {
      raw.combat.attackCooldownSteps = 0
    }, 'combat.attackCooldownSteps')
    const negativeContact = rejects((raw) => {
      raw.combat.contactCooldownSteps = -1
    }, 'combat.contactCooldownSteps')

    const missingRaw = clone()
    missingRaw.enemies[0].asset = 'missing-rock'
    const parsed = GameConfigSchema.parse(missingRaw)
    const missingGame = new CollectGame('missing-enemy', parsed, game.assets)
    const missingSnap = missingGame.snapshot(world.player.pos)
    const missingReported = missingSnap.errors.some(
      (error) => error.includes("missing asset 'missing-rock'") && error.includes("enemy 'sentinel'"),
    )

    const ok =
      health &&
      duplicateEnemy &&
      duplicateCollectible &&
      unknownEnemy &&
      unknownCombat &&
      zeroAttack &&
      negativeContact &&
      missingReported
    const detail =
      `health=${health} duplicateEnemy=${duplicateEnemy} duplicateCollectible=${duplicateCollectible} ` +
      `unknownEnemy=${unknownEnemy} unknownCombat=${unknownCombat} zeroAttack=${zeroAttack} ` +
      `negativeContact=${negativeContact} missingReported=${missingReported}`
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
