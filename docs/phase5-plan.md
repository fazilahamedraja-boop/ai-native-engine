# Phase 5 — Reusable combat: the island sentinel

Status: approved. Acceptance criteria are fixed here before implementation.
The design incorporates the three pre-implementation clarifications: spawn-safe
contact damage, edge-triggered attacks with a defined cooldown, and explicit
collect/return precedence and restart semantics. No implementation code has been
written yet.

## Goal

Extend the existing playable island with one enemy and a minimal health/damage
loop, while proving that the mechanic is reusable configuration plus a pure
module rather than another island-specific branch in the engine.

This phase does **not** add a general gameplay framework, a second game mode, an
enemy AI tree, animation, or a new asset pipeline. It reuses the Phase 4 scene,
input, fixed-step update, inspection, hashing, renderer, and browser test path.

## Findings from the current codebase

These are facts from the repository at `01f87a3`, not assumptions:

1. **The game layer is one optional block.** `GameConfigSchema`
   (`src/game/schema.ts:29-55`) only accepts `mode: "collect-return"` with
   avatar, collectibles, return zone, and props. Unknown properties are rejected
   by `strictObject`; collectible/prop ids must be unique.
2. **Game state is a pure state machine.** `CollectGame`
   (`src/game/collect.ts:25-130`) owns phase, collected ids, snapshot, hash,
   export, and restore. It never reads `World` or THREE. The engine calls
   `game.update(playerPos)` after physics (`src/engine.ts:124-129`).
3. **There is no combat, health, attack, enemy, or damage state anywhere.** A
   repository search finds only physics support-contact uses of "hit". There is
   no player-facing direction, no attack input, and no enemy asset.
4. **Input is movement + jump only.** `InputState`
   (`src/world/world.ts:31-36`) is `{moveX, moveZ, jump}`. `main.ts:115-120`
   maps WASD and Space; `stepWorld` edge-detects jump with `world.prevJump`.
   `Engine.setInput()` accepts a partial input and `#effectiveInput()` rotates
   movement for the third-person camera.
5. **Game objects are visual-only.** Game visuals are not `World` nodes and
   contribute no collider (`src/game/visuals.ts:7-39`,
   `src/render/renderer.ts:115-141`). Collection uses horizontal centre
   distance, not the capsule/AABB solver. Scene collision stays on the explicit
   `collider` boxes, including the island's invisible edge boxes.
6. **The renderer can hide collected objects but has no hit/defeat feedback.**
   `GameVisual` has a `collectible` boolean; `setGameCollected()` toggles mesh
   visibility. There is no per-enemy state, tint, flash, or health display.
7. **Inspection and determinism already cover optional game state.**
   `GameSnapshot` (`src/game/types.ts:15-27`) is attached to `inspect().game`;
   `stateHash(world, game)` appends `game.hashValues()`
   (`src/devtools/state.ts:34-44`). `runGameTests()` saves the live world and
   game, restores them, and reports `statePreserved`
   (`src/game/tests.ts:47-151`).
8. **The existing tests are browser-only for gameplay.** Phase 1 has six
   `runTests()` checks; the island has five game checks (`game-assets`,
   `collect-all`, `return-wins`, `restart`, `determinism`). The asset suite has
   123 Node tests and `assets validate` has 6 manifests.
9. **No enemy-specific asset exists.** The catalog contains `humanoid-01`,
   `placeholder-character`, `pine-nordic-01`, two swords, and
   `rock-granite-01`. Per-instance material patches are not part of the game
   config; asset overrides are per manifest.
10. **There is no player facing state.** The avatar is render-only and has no
    rotation driven by movement. The third-person camera has no pointer-look;
    only the orbit rig accepts drag/wheel input (`main.ts:154-174`). A frontal
    attack arc would therefore need new facing state to be playable.
11. **Baseline is green.** At `01f87a3`:
    - `npm run typecheck` clean.
    - `npm run test:assets`: 123 passed.
    - `npm run size`: raw 731,588 B, gzip 189,850 B (47.5% of 400 kB).
    - Phase 4 review records Phase 1 6/6, island 5/5, game suite 12.7 ms,
      Phase 1 suite 7.3 ms, assets validate 6/6.
12. **Historical limits stay as recorded.** The Phase 3 60 s end-to-end target
    remains unmet, the pine snow effect remains unresolved, and the Phase 4
    limits (no animation, primitive visuals, browser-only game tests) still
    apply.

## Scope

- One enemy in `content/scenes/island.scene.json`, configured by data.
- One player attack input (`F`) and a deterministic hit check.
- Enemy health, player health, damage, defeat, and a `lost` phase.
- A small pure `Combat` module composed by `CollectGame`.
- HUD health/defeat feedback and a renderer hit flash.
- Restart and inspection coverage for the new state.
- Browser tests and real-keyboard evidence.

## Non-goals

No new asset, no new dependency, no new game mode, no animation or attack
animation, no collision body for the enemy, no chase/pathfinding, no enemy
telegraph, no line-of-sight or frontal-arc attack, no inventory, saves, audio,
terrain, editor, MCP server, second global, or general gameplay framework.
Pine snow is not touched. Phase 3 latency results are not redefined.

## Proposed design

### Data model

The island gains one data-driven enemy and a small combat config:

```jsonc
"combat": {
  "playerHealth": 3,
  "attackRange": 2.0,
  "attackDamage": 1,
  "attackCooldownSteps": 12,
  "contactCooldownSteps": 60,
  "hitFlashSteps": 8
},
"enemies": [
  {
    "id": "sentinel",
    "asset": "rock-granite-01",
    "pos": [5, 0, 10],
    "radius": 0.9,
    "health": 3,
    "damage": 1,
    "rotY": 25,
    "scale": 1.2
  }
]
```

- `radius` is the horizontal centre-to-centre contact distance. It is not a
  physics collider; the enemy does not block movement.
- `health` is the maximum and initial health. `damage` is per contact. Both are
  positive integers.
- All durations are integer fixed steps (60 Hz), never seconds or wall-clock
  reads. `attackCooldownSteps` and `contactCooldownSteps` are at least 1;
  `hitFlashSteps` is at least 0.
- `combat` and `enemies` get defaults, so a game scene without them remains
  valid. The island explicitly sets them.
- Enemy ids participate in the existing unique-id check across collectibles,
  props, and enemies. Unknown fields, non-positive health, non-positive
  attack/contact cooldowns, and duplicate ids are rejected by the existing
  atomic scene parse.
- **Spawn-safe contact default:** every enemy's `contactCooldown` starts at
  `contactCooldownSteps` on construction and on reset. That is a fixed grace
  period, not a random or wall-clock delay. A scene that accidentally spawns the
  player inside the sentinel therefore cannot take contact damage on the first
  step.

### Pure combat module

New `src/game/combat.ts`, deliberately independent of `CollectGame`, `World`,
THREE, and the asset catalog:

```ts
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

export class Combat {
  constructor(config: CombatConfig, enemies: readonly EnemyConfig[])
  reset(): void
  update(playerPos: Vec3, attackHeld: boolean): void
  get playerDefeated(): boolean
  snapshot(playerPos: Vec3): CombatSnapshot
  enemyRenderStates(): EnemyRenderState[]
  hashValues(): number[]
  exportState(): CombatState
  restore(state: CombatState): void
}
```

The module owns only reusable mechanics:

- health clamping and defeat,
- attack edge + cooldown,
- nearest alive enemy within `attackRange`,
- contact damage + per-enemy cooldown,
- deterministic counters and hash values.

`CollectGame` composes it. `CollectGame` still owns collect/return phases and
sets `lost` when `combat.playerDefeated` becomes true. A future game mode can
import `Combat` without copying this logic. We are **not** adding a game-mode
registry or generic runtime interface for one implementation; that abstraction
should be extracted only when a second mode exists.

### Attack semantics

- New `attack` field on `InputState`; `F` maps to it in `main.ts`.
- The edge is detected inside `Combat` (`attackHeld && !prevAttack`), not in
  physics. `prevAttack` is updated on every active combat step, including steps
  where a press is ignored because the cooldown is still running. Holding `F`
  therefore produces exactly one rising edge until the key is released.
- `attackCooldown` ticks down at the start of every active combat step, clamped
  at zero. `attackCooldownSteps = 12` means the next attack may start on the
  twelfth fixed step after the previous attack.
- A press while `attackCooldown > 0` is ignored and is **not** counted as an
  attack. There is no input buffering: a press during cooldown is lost, and the
  player must release and press again after the cooldown reaches zero.
- On a rising edge with `attackCooldown === 0`:
  - increment `attacks`;
  - choose the nearest alive enemy with horizontal distance
    `<= attackRange` (ties resolve by config order);
  - if found, apply `min(enemy.health, attackDamage)` as actual damage,
    increment `hits` and `damageDealt` by that actual amount, set
    `hitFlash = hitFlashSteps` while the enemy remains alive, and set
    `attackCooldown = attackCooldownSteps`;
  - if none, the attack is a recorded miss (`misses = attacks - hits`) and
    still sets `attackCooldown = attackCooldownSteps`.
- Both hits and misses consume the cooldown. That bounds the attack rate and
  keeps misses visible in the deterministic state instead of letting a held or
  spammed key bypass the mechanic.
- Cooldowns freeze while the game is `won` or `lost` because combat updates do
  not run in those phases. `reset()` restores `attackCooldown = 0` and
  `prevAttack = false`.
- **Decision:** the hit check is radial within range, not a frontal cone. There
  is no player facing state, and the third-person camera cannot be rotated, so
  an arc would make a side enemy unhittable. This reuses the same horizontal
  distance convention as collectibles. A frontal/arc attack is deferred until
  facing exists.

### Enemy behavior

The sentinel is stationary and has a contact damage volume:

- Each enemy's `contactCooldown` starts at `contactCooldownSteps` on
  construction and on reset. This is the spawn/reset grace described above.
- Every active combat step decrements each enemy's `contactCooldown` and hit
  flash timer, clamped at zero. The contact cooldown ticks whether or not the
  player is inside the volume, so it behaves as an invulnerability window rather
  than an entry latch. Leaving and re-entering does not reset it.
- After the attack resolution, for each alive enemy: if the player is within
  `enemy.radius` and that enemy's contact cooldown is zero, subtract
  `min(playerHealth, enemy.damage)` from player health, increment
  `damageTaken` by the actual amount, and set the cooldown to
  `contactCooldownSteps`.
- Defeated enemies are skipped for both attacks and contact.
- In normal play the 60-step grace has already elapsed while the player walks to
  the sentinel, so the first contact step deals damage immediately; subsequent
  contact hits are one per 60 fixed steps. If a reset places the player inside
  the volume, no damage occurs on steps 1-59 and the first hit lands on step 60.
- Player health reaching zero sets `playerDefeated`. There is no auto-respawn or
  regen. `CollectGame` converts that to the `lost` phase; `R` resets.
- **Decision:** no chase, no pathfinding, no attack telegraph, no enemy facing.
  This is the simplest behavior that makes the damage loop real and testable.

### Integration with collect/return phases

`CollectGame.update(playerPos, attackHeld)` orders the update explicitly:

1. If `phase` is `won` or `lost`, return immediately. Neither combat nor
   collection changes terminal state.
2. Run `Combat.update(playerPos, attackHeld)`.
3. If `combat.playerDefeated`, set `phase = "lost"` and return. No collection or
   return-zone check runs on that step.
4. Run the existing collectible checks; if every sword is collected, set
   `phase = "return"`.
5. If `phase === "return"` and the player is in the return zone, set
   `phase = "won"`.

Consequences:

- **`lost` outranks `won`.** If player health reaches zero on the same step that
  would collect the last sword, enter the return zone, or defeat the sentinel,
  the result is `lost`. Winning requires positive player health.
- **`won` is only reachable from `return`.** Defeating the sentinel is optional
  and is not a win condition.
- **`won` and `lost` are terminal.** Attacks, contact damage, collection, and
  cooldowns do nothing after either phase. Only `R` / `engine.reset()` leaves
  them.
- **A non-lethal step can both defeat the sentinel and win.** Enemy defeat does
  not alter the collect/return order; if health remains positive and the return
  condition is met, the phase becomes `won`.

### State and inspection

`GamePhase` becomes `"collecting" | "return" | "won" | "lost"`.

`GameSnapshot` gains a required `combat` field:

```ts
{
  player: { health: 3, maxHealth: 3, defeated: false },
  enemies: [{
    id: "sentinel",
    health: 3,
    maxHealth: 3,
    defeated: false,
    distance: 1.026,
    contactRadius: 0.9,
    contactCooldown: 0,
    hitFlash: false
  }],
  attacks: 0,
  hits: 0,
  misses: 0,
  damageDealt: 0,
  damageTaken: 0,
  attackCooldown: 0,
  attackCooldownSteps: 12,
  attackRange: 2,
  enemiesDefeated: 0
}
```

`CollectGame.snapshot()` includes this object, so
`__engine.inspect().game.combat` is the single structured read. No new global or
inspection method is added.

`Combat.hashValues()` includes player health, attack/contact cooldowns,
`prevAttack`, counters, and each enemy's health/contact cooldown/hit flash.
`CollectGame.hashValues()` keeps the phase and collected flags, then appends
combat values. This makes attacks, ignored presses, misses, damage, defeat,
cooldowns, and the 60-step grace part of the deterministic state.

### Input and engine wiring

- `InputState` adds `attack: boolean`; all IDLE literals and `createWorld` /
  `resetWorld` include `attack: false`.
- `Engine.#effectiveInput()` passes `attack` through unchanged.
- `Engine.stepOnce()` calls
  `game.update(world.player.pos, world.input.attack)`.
- `Engine.reset()` resets the game and restores both collectible and enemy
  render state. The reset also restores the 60-step contact grace.
- `Engine.runTests()` restores the same render state after the suite.
- `Engine.version` becomes `0.1.0-phase5`.

### Rendering and HUD

- `GameVisual` gains `kind: "prop" | "collectible" | "enemy"` instead of the
  collectible-only boolean.
- `buildGameVisuals()` emits the sentinel as an enemy using
  `rock-granite-01`; no new asset is created. The rock is the visual for a
  "granite sentinel".
- The renderer keeps the existing per-mesh material. `setGameEnemies()`:
  - hides defeated enemies;
  - sets `MeshStandardMaterial.emissive` to red while `hitFlash` is active;
  - restores visibility/emissive on reset.
- HUD reads `inspect().game.combat`:
  - `HP 3/3` and `SENTINEL 3/3` during play;
  - `HIT` while the sentinel flash is active;
  - `SENTINEL DEFEATED` after health reaches zero;
  - `DEFEATED` and `press R` in the `lost` phase.
- Add a `#hud[data-phase="lost"]` style. Update the game hint to
  `WASD move · Space jump · F attack · R restart`.

### Restart

`CollectGame.reset()` resets collected ids, phase, player health, all enemy
health/contact cooldowns/hit flash, attack cooldown, `prevAttack`, and all
counters. Contact cooldowns return to the full `contactCooldownSteps` grace, not
zero; attack cooldown returns to zero. `Engine.reset()` also restores the
renderer's hidden/flash state, so a defeated or flashing sentinel returns to its
initial visible state. Restart is allowed from `collecting`, `return`, `won`, or
`lost` and always produces the same post-settle state.

### File-level changes

| File | Change |
|---|---|
| `src/game/schema.ts` | `Enemy` and `Combat` strict objects; `enemies`/`combat` on the game block; unique-id refinement; step-based cooldowns. |
| `src/game/combat.ts` | New pure `Combat` module: health, attack edge/cooldown, nearest-target hit test, contact damage, counters, snapshot/hash/export/restore. |
| `src/game/collect.ts` | Compose `Combat`; add `lost`; pass attack input; include enemy assets/errors/triangles; delegate snapshot/hash/export/restore; expose enemy render states. |
| `src/game/types.ts` | `GamePhase` adds `"lost"`; `CombatSnapshot`/`EnemySnapshot`/`EnemyRenderState`; `GameSnapshot.combat`; `GameVisual.kind`. |
| `src/game/visuals.ts` | Build enemy visuals; use `kind` for props/collectibles/enemies. |
| `src/game/tests.ts` | Extend `game-assets`, restart, determinism, and state preservation; add attack/miss/defeat/contact/lost/config/asset tests; save/restore combat state. |
| `src/world/world.ts` | Add `attack` to `InputState`; initialise/reset it false. No physics step changes. |
| `src/engine.ts` | Attack wiring; enemy collect/defeat render sync on reset/step/tests; version bump. |
| `src/main.ts` | `F` key, game hint, combat HUD, lost phase. |
| `index.html` | Lost-phase HUD style; controls hint if needed. |
| `src/render/renderer.ts` | `GameVisual.kind`; `setGameEnemies()` for defeat visibility and hit flash; reset state. |
| `src/devtools/state.ts` | No structural change; existing game hash/snapshot automatically carry combat. |
| `content/scenes/island.scene.json` | One `sentinel` at `[5, 0, 10]`; combat config; keep swords, props, return zone, and Phase 4 path intact. |
| `README.md` | Phase 5 status, controls, `inspect().game.combat`, test list, known limits. |
| `docs/phase5-review.md`, `docs/phase5/*.png` | Evidence and limitations after implementation. |

No new dependency, global, MCP server, scene node type, asset manifest, or
asset generator.

## Tests and acceptance criteria

Phase 5 passes only if every numbered criterion is observed.

### Existing behavior

1. **Baseline remains green.** `npm run typecheck` clean; `npm run test:assets`
   123/123; `assets validate` 6/6; Phase 1 `runTests()` 6/6; island still
   collects all three swords with the existing `W` 200-step path and wins with
   the existing `S` 220-step path.
2. **Phase 4 path is not disturbed.** The sentinel sits at `[5, 0, 10]`, outside
   the `x = 0` collect/return lane (contact radius 0.9). Existing collect,
   return, restart, and determinism checks still pass without adding attack
   input.

### Enemy and inspection

3. **Enemy boots and is inspectable.** `?scene=island`
   `inspect().game.combat` has exactly one `sentinel` with
   `health = maxHealth = 3`, `defeated = false`, finite `distance`, and
   `attackRange = 2`. The enemy asset has a positive triangle count, and
   `game.errors` is empty.
4. **Structured read agrees with observed state.** After each browser step, the
   HUD's HP/sentinel text and the capture's visual state match
   `inspect().game.combat`.

### Combat

5. **Successful attack.** With the player inside attack range but outside
   contact range (1.5 m in the scripted test; the browser route uses
   `W` 134 + `D` 47 steps, which lands at about 1.48 m), one real `F` press +
   one fixed step yields `attacks = 1`, `hits = 1`, `damageDealt = 1`,
   sentinel `health = 2/3`, `attackCooldown = 12`, `hitFlash = true`, and
   player health unchanged.
6. **Missed attack, edge trigger, and cooldown.** From spawn (far outside
   range), one `F` press yields `attacks = 1`, `hits = 0`, `misses = 1`,
   sentinel `health = 3/3`, no `damageDealt`, and `attackCooldown = 12`.
   Holding `F` for 120 further fixed steps still yields `attacks = 1`. A
   release and a new press before the 12-step cooldown expires does not add an
   attack. After the cooldown is zero, a release + press attacks again. A miss
   consumes the same cooldown as a hit.
7. **Enemy defeat.** Three spaced attacks yield sentinel `health = 0`,
   `defeated = true`, `enemiesDefeated = 1`, `hits = 3`, `damageDealt = 3`, and
   `hitFlash = false`. A fourth attack after cooldown is a recorded miss and
   does not damage or revive it; the mesh is hidden, the enemy render state is
   defeated, and HUD reads `SENTINEL DEFEATED`.
8. **Contact damage, spawn grace, and player defeat.** On reset, every enemy's
   `contactCooldown` is 60. A reset that places the player inside the sentinel
   takes no damage on steps 1-59 and exactly one damage on step 60. In normal
   play, where the grace expired while walking, the first contact step damages
   immediately and the next hits are one per 60 fixed steps. Three damage events
   set `player.health = 0`, `damageTaken = 3`, and `phase = "lost"`; further
   updates do nothing, teleporting to a sword or the return zone cannot collect
   or win, and HUD reads `DEFEATED`. This is a deliberate test of the risk side
   of the loop.
9. **Hit feedback.** A successful hit sets the sentinel's `hitFlash` for the
   fixed 8-step window, renders a visible emissive flash, and shows `HIT` in the
   HUD. A miss or a defeated sentinel does not flash as alive.

### Restart, determinism, preservation

10. **Restart is complete.** After damage, defeat, and `lost`, `R` /
    `engine.reset()` restores phase `collecting`, 0 collected, spawn position,
    player health 3/3, sentinel health 3/3 and visible, `defeated = false`,
    all counters 0, attack cooldown 0, `prevAttack = false`, contact cooldown
    back to 60, and `hitFlash` off. A reset + 120-step settle produces the same
    state hash as a fresh reset + 120-step settle.
11. **Determinism covers combat.** The same scripted attack, ignored press,
    miss, and contact sequence run twice produces the same `inspect().hash`.
    The existing collect/return determinism test still produces identical
    hashes. The game suite reports `statePreserved = true` after it restores the
    live world and game.
12. **State preservation includes combat.** `exportState()` / `restore()`
    round-trips player health, enemy health, contact cooldowns, attack cooldown,
    `prevAttack`, counters, and hit flash; the hash before and after a
    mutation + restore is identical. A restored `lost`/defeated state remains
    terminal and a restored `won` state remains terminal.

### Invalid input and assets

13. **Invalid config is rejected, not silently accepted.** `parseScene` /
    `GameConfigSchema` rejects enemy `health <= 0`, duplicate
    enemy/collectible ids, unknown enemy/combat fields, and zero or negative
    attack/contact cooldowns, with exact issue paths. A missing enemy asset
    appears in `game.errors` and the HUD error state; it is not silently
    skipped. Existing atomic scene apply behavior is unchanged.
14. **No dependency or access-layer growth.** Runtime dependencies remain
    `three` and `zod`; the only scene/game agent surface remains
    `window.__engine`; state is read through `inspect()` and tests through
    `runTests()`, input through `setInput()`, evidence through `capture()`.
    The existing asset-only `window.__preview` surface is unchanged and is not
    used for gameplay. No new global, MCP server, editor, or scene node type is
    added.

### Measurement and evidence

15. **Bundle and performance are measured, not assumed.** `npm run size`
    records raw/gzip bytes against the Phase 4 baseline (731,588 B raw /
    189,850 B gzip) and the 400 kB budget. Phase 5 target: gzip
    `<= 200,000 B`; raw delta reported. `runTests()` records the island suite
    and Phase 1 suite durations; target `< 100 ms` for the game suite and
    `< 50 ms` for Phase 1, with the actual numbers reported even if slower.
    Draw calls/triangles/objects are recorded at boot, hit, and defeat.
16. **Evidence exists.** `docs/phase5-review.md` records commands, hashes,
    test output, captures (`start`, `hit`, `defeated`, `lost`), timing,
    limitations, and the unchanged Phase 3/pine-snow status. Captures include
    the HUD; canvas captures exercise the existing `capture()` contract.

## Measurement rules

- All acceptance mechanics use fixed steps (`FIXED_DT = 1/60`) and explicit
  `__engine.step(n)`. Headless Chromium rAF throttling is not a pass/fail
  signal.
- The 60-step contact grace is a game rule, not a frame-rate claim. Tests assert
  no damage on steps 1-59 after a reset and exactly one hit on step 60.
- Real-time frame rate is **not** accepted as a Phase 5 criterion. If it is
  measured, it is reported separately and not compared to 60 Hz.
- Scripted game tests are browser tests in `runTests()`, consistent with Phase
  4. No new test runner or CI wrapper is added in this phase.
- Exact Phase 4 hash strings will change when combat state is added to the
  hash. The requirement is deterministic behavior under identical inputs, not
  preservation of old hash values.

## Risks and unresolved design decisions

| # | Decision / risk | Proposed choice | Why | If changed |
|---|---|---|---|---|
| 1 | Enemy visual | Reuse `rock-granite-01` as a "granite sentinel" | No new asset; distinct from the humanoid avatar; 320 tris; base-center origin | A humanoid enemy needs a tinted instance or new asset, adding schema/render work |
| 2 | Attack shape | Radial range (2 m), nearest target, no arc | No player facing; third-person camera cannot rotate; matches collectible distance convention | A frontal/arc attack needs facing state and a way to turn |
| 3 | Enemy body | No collider; contact damage volume | Keeps game objects visual-only and avoids dynamic collision bodies | A solid enemy needs World collider wiring and changes the Phase 4 path |
| 4 | Enemy behavior | Stationary, contact damage only | Smallest behavior that creates a two-way damage loop | Chase AI needs movement, collision handling, and more determinism tests |
| 5 | Player health/death | 3 HP, terminal `lost` phase that outranks `won`, manual `R` | Makes damage meaningful without a respawn system and makes precedence explicit | Enemy-only health is smaller but the loop is one-way |
| 6 | Missing asset timing | Runtime `game.errors` + HUD error | Scene parsing has no catalog access; existing behavior already reports missing assets | Parse-time rejection would require injecting the catalog into `applyScene` |
| 7 | Hit flash duration | 8 fixed steps (~133 ms) plus HUD `HIT` | Visible in captures; HUD is the durable feedback | Longer flash is a one-constant change; no animation system |
| 8 | Hash change | Add combat state/counters to the game hash | Attacks, ignored presses, misses, cooldowns, and defeat must be deterministic evidence | Excluding counters would hide misses from the state contract |
| 9 | Browser-only tests | Extend `runTests()` | Consistent with Phase 4; no new runner/dependency | A Node combat suite would need new test infrastructure |
| 10 | Real-time performance | Report separately, not gate | Headless rAF is throttled; fixed-step is the verified path | A headed 60 Hz benchmark would be additional evidence |
| 11 | Spawn contact safety | Initialize contact cooldown to the configured 60 on construct/reset; require at least 1 | Prevents immediate contact damage even if a spawn overlaps the sentinel, while a normal approach still hits on first contact after the grace expires | A separate arming/grace field would add schema and export/restore state for no shipped need |
| 12 | Repeated attack from a held key | Rising edge plus 12-step cooldown; both hits and misses consume it | Holding `F` cannot repeat; presses during cooldown are ignored, not queued | Input buffering would add queued state and more edge cases |

## Estimated implementation scope

- New pure module: one file, roughly 150 lines.
- Game schema/state/visual/test changes: roughly 250 lines.
- Engine/input/renderer/HUD/scene changes: roughly 80 lines.
- Tests: roughly 180 lines, around 13-14 game checks.
- Docs: plan + review + captures.
- No new dependency, asset, scene node type, global, or MCP surface.
- Expected agent implementation/verification time: roughly 20-30 minutes of
  implementation plus 10-15 minutes of browser verification and evidence. This
  is an estimate, not a target; Phase 3's 60 s end-to-end result remains unmet.

## Completion verification

The approved implementation is verified with:

```powershell
npm run typecheck
npm run test:assets
node scripts/node-run.mjs src/assets/cli.ts validate
npm run size
```

Browser checks with the dev server:

```js
// ? (Phase 1 regression)
__engine.runTests()                 // 6/6, statePreserved true

// ?scene=island
__engine.inspect().game.combat
__engine.runTests()                 // existing + Phase 5 checks, statePreserved true

// exact combat acceptance
__engine.pause(); __engine.reset(); __engine.step(120)
// real keyboard W/D to the sentinel, F down + step(1) + F up, repeat
// inspect: attacks/hits/damage/enemy health/defeat/hitFlash
// real R: reset fields and hash
```

Then `npm run dev` + Playwright keyboard events and viewport screenshots for
`docs/phase5/start.png`, `hit.png`, `defeated.png`, and `lost.png`, plus
`__engine.capture()` canvas evidence. The review records all numbers and the
limits that remain.

## Approval gate

Approved by the user on 2026-10-20. This plan is committed first as the fixed
Phase 5 criteria checkpoint, then implementation begins. No new dependency,
global, asset, scene node type, or general combat framework is added. The Phase
3 60 s miss, pine snow failure, and Phase 4 evidence remain untouched.
