# Phase 5 — Reusable combat: the island sentinel — review

Status: complete. The acceptance criteria were fixed in
[`docs/phase5-plan.md`](phase5-plan.md) and committed as
`411ee6d10fc6d7f2bdaa2438c5dde071713d69a0` on
`2026-10-20T15:33:12+05:30`, before implementation. The implementation commit is
`d914fbd0b247415f9a58481b60fd19a0aba18a45`
(`2026-10-20T15:43:15+05:30`). This review, the README update, and the
`docs/phase5/` captures are the evidence commit that follows it.

## Goal

Extend the existing playable island with one enemy and a minimal health/damage
loop, while proving that the mechanic is reusable configuration plus a pure
module rather than another island-specific branch in the engine. The phase did
not add a general combat framework, a second game mode, enemy AI, animation, a
new asset, a dependency, a global, a server, or an editor.

## Method

- **Criteria before code.** The plan fixed all 16 pass/fail checks before any
  implementation code was written, so the gate could not move to fit the result.
- **Reuse first.** `rock-granite-01` is the sentinel visual. The island scene,
  third-person camera, fixed-step physics, renderer, HUD, inspection, hashing,
  reset path, and browser test runner are the Phase 4 systems.
- **Pure mechanics.** `src/game/combat.ts` owns health, the attack edge and
  cooldown, nearest-target hit checks, contact damage, counters, snapshot/hash,
  and export/restore. It never reads World, THREE, the asset catalog, or the
  clock. `CollectGame` composes it and keeps collect/return/`won`/`lost`.
- **Real input plus fixed steps.** The browser evidence uses actual
  `page.keyboard.down` / `up` events for `W`, `D`, `F`, and `R`, then explicit
  `__engine.step(n)` for deterministic advancement. Headless Chromium throttles
  rAF, so no frame-rate claim is made.
- **Two-layer evidence.** Playwright viewport screenshots include the HUD; the
  engine `capture()` files are canvas-only and exercise the existing capture
  contract. State is read from `inspect().game.combat`, not inferred from pixels
  alone.
- **No input-state ambiguity in captures.** Each real key release is followed by
  an explicit idle `setInput` and one fixed step where needed. The browser key
  log for the isolated capture sequence showed one down/up pair per key.

## What changed

| File | Change |
|---|---|
| `src/game/schema.ts` | Strict `combat` and `enemies` configuration, defaults, positive-integer limits, shared unique-id refinement. |
| `src/game/combat.ts` | New pure `Combat`: player/enemy health, edge-triggered attacks, 12-step cooldown, nearest-target hit test, per-enemy contact cooldown, 8-step flash, counters, hash, export/restore. |
| `src/game/collect.ts` | Composes combat; adds `lost`; `lost` outranks collect/return; both terminal phases freeze all updates; delegates combat snapshot/hash/state. |
| `src/game/types.ts` | `GamePhase` adds `lost`; `CombatSnapshot`, `EnemySnapshot`, `EnemyRenderState`; `GameVisual.kind`. |
| `src/game/visuals.ts` | Emits enemy visuals as `kind: "enemy"`; no new asset or scene node. |
| `src/render/renderer.ts` | Hides defeated enemies and applies an emissive hit flash to the existing material; restores visibility/emissive on reset. |
| `src/engine.ts` | Passes attack input into the game, syncs enemy render state on reset/step/tests, version `0.1.0-phase5`. |
| `src/main.ts` / `index.html` | `F` binding, HP/sentinel/HIT/defeated HUD, terminal `lost` styling, updated hint. |
| `src/world/world.ts` | `InputState.attack`; initialise/reset false. Physics is unchanged. |
| `content/scenes/island.scene.json` | One sentinel at `[5, 0, 10]` with 3 HP, 0.9 m contact radius, 1 damage, scale 1.2, plus the combat block. |
| `src/game/tests.ts` | Twelve browser checks: the original five plus attack, edge/cooldown, defeat, contact/grace/lost, combat determinism, state round-trip, invalid config. |

No `package.json` or lockfile change: runtime dependencies remain `three` and
`zod`. `window.__engine` remains the only game/agent surface; `window.__preview`
remains asset-only. No scene node type or general gameplay API was added.

## Acceptance evidence

### Baseline and existing behavior

```
npm run typecheck                                         clean
npm run test:assets                                       123 passed, 0 failed
node scripts/node-run.mjs src/assets/cli.ts validate      6/6 valid
```

Phase 1 at `/`:

```
__engine.runTests()
passed: true, 6/6, durationMs: 11.0, statePreserved: true, hash cb4685a8
```

The Phase 1 hash is unchanged from Phase 4 (`cb4685a8`). The island suite also
ran from a paused, reset step-0 state:

```
__engine.runTests() at ?scene=island
passed: true, 12/12, durationMs: 25.6, statePreserved: true, hash 7e1b50b0
```

Full island result details:

```
game-assets        errors=[] collectibles=3 avatarTri=264 enemies=1 range=2
                   assets=humanoid-01:264, sword-bronze-01:122,
                   sword-iron-01:122, pine-nordic-01:172, rock-granite-01:320
collect-all        phase=return collected=3/3 movedZ=15.000 grounded=true hp=3
return-wins        phase=won collected=3/3 distance=1.464 radius=1.7;
                   terminal=true hp=3 enemy=3
restart            damaged=true defeated=true lost=true clean=true stable=true
                   spawnGap=0.00e+0 contactCooldown=60
                   hashes=33319367/33319367
determinism        hash d9495b43 vs d9495b43; phase=won/won
attack-hit         attacks=1 hits=1 enemyHealth=2 cooldown=12
                   flashStill7=true flashOff8=true
attack-miss-edge   first=1/0/1 held=1 second=2/0/2 ignored=2
                   enemy=3 cooldown=12
enemy-defeat       defeated=true health=0 attacks=3 hits=3 damage=3;
                   fourth=4/3/1 health=0
contact            grace hp59=3 hp60=2 hp120=1 hp180=0 lost=true;
                   terminal=true; entry=true distance=0.951315
combat-determinism hash 73423871 vs 73423871; attacks=3/3 hits=3/3
                   damageTaken=1/1 hp=2/2 enemy=0/0
state-roundtrip    before=549b968d after=549b968d mutated=2fb6f06d;
                   lostTerminal=true wonTerminal=true
invalid-config     health=true duplicateEnemy=true duplicateCollectible=true
                   unknownEnemy=true unknownCombat=true zeroAttack=true
                   negativeContact=true missingReported=true
```

The original Phase 4 path still collects with `W` 200, returns with `S` 220,
wins at distance 1.464 < 1.7, and never touches the sentinel or attack input.
The combat state therefore did not change the collect/return lane. In the detail
strings above, `attack-hit` and `attack-miss-edge` counters are
attacks/hits/misses; `flashStill7` and `flashOff8` are assertion booleans (the
flash is on after 7 steps and off after 8).

### Enemy, inspection, and HUD

At reset (`step 0`, hash `7e1b50b0`):

```json
"combat": {
  "player": { "health": 3, "maxHealth": 3, "defeated": false },
  "enemies": [{
    "id": "sentinel", "health": 3, "maxHealth": 3, "defeated": false,
    "distance": 11.18034, "contactRadius": 0.9,
    "contactCooldown": 60, "hitFlash": false
  }],
  "attacks": 0, "hits": 0, "misses": 0,
  "damageDealt": 0, "damageTaken": 0,
  "attackCooldown": 0, "attackCooldownSteps": 12,
  "attackRange": 2, "enemiesDefeated": 0
}
```

The HUD read `SWORDS 0 / 3` and `HP 3/3 · SENTINEL 3/3`; the hint read
`Walk into the three swords. F attack.` The sentinel asset contributes 320
triangles and `game.errors` is empty.

A missing enemy asset was checked through the live apply path: cloning the scene,
setting `game.enemies[0].asset = "missing-rock"`, and calling `applyScene`
returned `ok: true` with `stateReset: null`, `inspect().game.errors` contained
`missing asset 'missing-rock' (enemy 'sentinel')`, and the HUD switched to
`GAME ASSET ERROR` with that message. The enemy was not silently skipped.

A rejected atomic apply was also checked. Setting
`game.combat.attackCooldownSteps = 0` and calling `applyScene` returned
`ok: false` with path `game.combat.attackCooldownSteps`, code `too_small`; the
step, hash `7e1b50b0`, phase, player health, and sentinel health were unchanged.
The existing apply contract still rejects the whole scene rather than partially
applying it.

### Combat

Real keyboard route:

```
reset -> step 0, hash 7e1b50b0, HP 3/3, sentinel 3/3, contactCooldown 60
W down + step(134) -> pos [0, 0, 10.05], bronze + iron collected
D down + step(47)  -> pos [3.525, 0, 10.05], distance 1.475847,
                      contactCooldown 0, player HP 3/3
F down + step(1) + F up
  -> attacks 1, hits 1, damageDealt 1, sentinel 2/3,
     attackCooldown 12, hitFlash true, player HP 3/3
  -> HUD: SWORDS 2 / 3
           HP 3/3 · SENTINEL 2/3 · HIT
```

A separate real-keyboard hold check started at distance 1.475847 and held `F`
across 120 fixed steps. `world.input.attack` was true throughout, yet the result
was still `attacks=1`, `hits=1`, sentinel 2/3, cooldown 0, flash off, player 3/3.
The held key did not repeat the hit. After releasing `F` for one fixed step, a
press attacked again (`attacks=2`, sentinel 1/3). A further press during the
12-step cooldown was ignored (`attacks` stayed 2 while the cooldown ticked
12 -> 10 over the idle and pressed fixed steps). After the cooldown expired, a
press landed the third hit and defeated the sentinel.

Two further spaced real `F` presses produced the `defeated` capture:

```
step 208, hash dc068aec
attacks 3, hits 3, damageDealt 3, damageTaken 0,
sentinel 0/3 defeated, hitFlash false, player HP 3/3
HUD: SWORDS 2 / 3
     HP 3/3 · SENTINEL DEFEATED
```

The fourth-attack case in `enemy-defeat` is a recorded miss (`4/3/1`) and cannot
revive the enemy.

Contact and loss:

```
reset -> W 134 + D 55 -> pos [4.125, 0, 10.05],
  distance 0.876427, first contact: HP 2/3, damageTaken 1,
  contactCooldown 60
step(60) -> HP 1/3, damageTaken 2
step(60) -> HP 0/3, damageTaken 3, phase lost, step 309, hash e5e6a7d8
HUD: DEFEATED
     HP 0/3 · SENTINEL 3/3
     press R to restart.
```

The deterministic `contact` check also covers the spawn-safe case: after a hard
reset with the player placed inside the sentinel, health is 3 through steps 1-59,
the first damage lands on step 60, and the next hits land at +60 and +120. A lost
game cannot collect a sword, enter the return zone, or win. `won` and `lost` are
terminal until reset.

### Restart, determinism, and state preservation

- `restart` resets from damage, defeat, and `lost` to `collecting`, 0 collected,
  spawn position, HP 3/3, sentinel 3/3, counters 0, attack cooldown 0,
  `prevAttack=false`, contact cooldown 60, flash off, and a visible sentinel.
  Two reset + 120-step settles produced the same hash, `33319367`.
- A real `R` from the lost capture returned to step 0, hash `7e1b50b0`, HP 3/3,
  sentinel 3/3, contact cooldown 60, and the start HUD.
- `combat-determinism` ran the same attack/ignored-press/miss/contact sequence
  twice and produced `73423871` both times, with `attacks=3/3`, `hits=3/3`,
  `damageTaken=1/1`, `hp=2/2`, and the enemy defeated both times.
- `state-roundtrip` restored the exported state exactly (`549b968d` before and
  after), produced a different hash after mutation (`2fb6f06d`), kept a restored
  `lost` state terminal against a sword, and kept a restored `won` state terminal
  against the enemy.
- `runTests()` restored the live world/game (`statePreserved: true`).

The Phase 4 game hashes changed because combat state is now part of the game
hash; this is required by the plan. The Phase 1 hash did not change.

### Captures

| Evidence | Step | State hash | Canvas bytes | Page bytes | State |
|---|---:|---|---:|---:|---|
| `docs/phase5/start-canvas.png` / `start.png` | 0 | `7e1b50b0` | 59,408 | 48,690 | HP 3/3, sentinel 3/3, contact cooldown 60 |
| `docs/phase5/hit-canvas.png` / `hit.png` | 182 | `e89c79e9` | 49,107 | 42,773 | HP 3/3, sentinel 2/3, attack 1, cooldown 12, flash |
| `docs/phase5/defeated-canvas.png` / `defeated.png` | 208 | `dc068aec` | 45,001 | 38,831 | HP 3/3, sentinel 0/3 defeated, 3 hits, 0 damage taken |
| `docs/phase5/lost-canvas.png` / `lost.png` | 309 | `e5e6a7d8` | 49,049 | 42,532 | HP 0/3, sentinel 3/3, damage taken 3, phase lost |

The canvas files are 800x500 and exercise `__engine.capture()`; the full-page
files are 1280x800 Playwright screenshots that include the HUD. The hit HUD reads
`SENTINEL 2/3 · HIT`; the defeated HUD reads `SENTINEL DEFEATED`; the lost HUD
reads `DEFEATED` and `HP 0/3`. The source canvas captures also remain in
`.cache/captures/phase5-*-canvas.png` (gitignored).

### Renderer and bundle

Renderer counters, recorded from `__engine.stats()`:

| State | Draw calls | Triangles | Objects |
|---|---:|---:|---:|
| boot, step 0 | 28 | 5,132 | 17 |
| near sentinel | 20 | 3,780 | 17 |
| hit | 20 | 3,780 | 17 |
| defeated | 18 | 3,140 | 17 |

Draw calls vary with frustum culling as the camera moves; the object count stays
17. No claim is made that these counters imply a frame rate.

Final production bundle (`npm run size`, authoritative `scripts/size.mjs`):

```
index-DkVBMypY.js  raw 745,259 B  gzip 193,607 B
gzip total 193,607 B (193.6 kB) of 400 kB budget — 48.4%
```

Against the Phase 4 baseline of 731,588 B raw / 189,850 B gzip, Phase 5 adds
**+13,671 B raw / +3,757 B gzip**. The Phase 5 target of `<= 200,000 B` gzip is
met. Vite's own gzip log uses a different setting; the size script is the
authoritative number, as in earlier phases.

## Timing

- Criteria checkpoint `411ee6d`: `2026-10-20T15:33:12+05:30`.
- Implementation commit `d914fbd`: `2026-10-20T15:43:15+05:30` — **10 min
  03 s** from criteria to code commit.
- The real-keyboard hold check and the final clean capture regeneration happened
  after the code commit; this review and README are the evidence commit.
- Mechanical durations: island suite 25.6 ms, Phase 1 suite 11.0 ms, production
  build 429 ms in the final `npm run size` run. Canvas captures were 45-59 kB
  PNGs.

This timing is recorded for Phase 3 context only. The Phase 3 60 s end-to-end
target remains unmet and is not redefined by Phase 5.

## Findings

1. **Combat stayed a pure module.** `Combat` has no World/THREE/clock access,
   and `CollectGame` composes it without a second game mode. The schema is
   data-driven; the island supplies one enemy and the six combat constants.
2. **The damage loop is genuinely two-way.** The sentinel can be defeated with
   three hits, and it can defeat the player with three contact events. `lost`
   outranks collection and winning on the same step, and both terminal phases are
   frozen until reset.
3. **Spawn safety is explicit.** Contact cooldown starts at 60 on construction
   and reset, and ticks as an invulnerability window. A reset overlap cannot kill
   on step one; normal approach after the grace damages on the first contact.
4. **Held input is bounded.** The rising edge is inside combat, so a held `F`
   produces one attack. Both hits and misses consume the 12-step cooldown; a
   press during cooldown is discarded rather than buffered.
5. **Real input and scripted input agree.** Real `W`/`D`/`F`/`R` events produced
   the same positions, distances, counters, and hashes as the deterministic
   suite. The browser-only suite is still the test runner; no new runner was
   added.
6. **The HUD and inspection agree.** Start, hit, defeated, and lost screenshots
   show the same HP/sentinel state as `inspect().game.combat`. The hit flash is
   visible in the canvas and full-page captures.
7. **State preservation covers the new mechanics.** Health, cooldowns,
   `prevAttack`, counters, enemy health, contact cooldowns, and flash survive
   export/restore; mutation is visible in the hash; terminal phases stay
   terminal.

## Limits (explicitly not built or not verified)

- **One stationary sentinel, no AI.** No chase, pathfinding, telegraph, enemy
  facing, or line-of-sight. Contact damage and the radial 2 m attack are the
  whole behavior.
- **No animation.** The humanoid and rock are static meshes. There is no attack
  animation, hit reaction, death animation, or sound.
- **Radial attack, not a cone.** The avatar has no facing state and the
  third-person camera has no pointer-look, so an arc would make a side enemy
  unhittable. A frontal attack is deferred until facing exists.
- **The sentinel is a reused rock.** It is an untinted `rock-granite-01`
  instance with a red emissive flash. This is deliberately not a new enemy
  asset.
- **Death is terminal.** There is no respawn, regen, checkpoint, or automatic
  restart; `R` is the only recovery.
- **No save persistence.** Export/restore is in-memory game state, not a save
  file or browser storage.
- **Browser-only game tests.** They live in `runTests()` at `?scene=island`;
  there is no CLI or CI wrapper for the game suite.
- **No real-time frame-rate claim.** Fixed-step tests and `step(n)` are the
  acceptance path. Headless Chromium throttles rAF; a headed 60 Hz run was not
  measured as a benchmark.
- **Phase 3 and pine snow remain open.** The Phase 3 60 s end-to-end target is
  still unmet, the pine snow band is still unresolved, and Phase 4 evidence is
  preserved unchanged.
- **One enemy ships.** The schema accepts an enemy array and enforces unique
  ids, but only one sentinel is placed and visually verified.

## Verdict

Phase 5 **passes all 16 criteria**: baseline and Phase 4 behavior, enemy boot and
inspection, successful and missed attacks, edge/cooldown behavior, enemy defeat,
contact grace and player loss, hit feedback, restart, combat determinism, state
preservation, invalid-config rejection, no dependency/access-layer growth, bundle
and timing measurement, and committed evidence.

The island now has a real, inspectable, deterministic health/damage loop built
from the existing systems. It does not claim animation, enemy AI, production
visuals, saves, or a general combat framework. The Phase 3 60 s miss and the pine
snow failure remain open exactly as recorded.
