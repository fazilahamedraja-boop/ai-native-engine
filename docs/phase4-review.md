# Phase 4 — Playable island gate: review

Status: complete. Criteria were fixed in
[`docs/phase4-plan.md`](phase4-plan.md) and committed as `d16be93` before any
game code was written.

## Goal

Prove the agent can author, run, and verify a small playable 3D game through the
existing `window.__engine` surface, not just edit isolated assets.

The result is one island scene (`content/scenes/island.scene.json`,
`?scene=island`): the player starts on a landing pad, collects three swords, and
returns to the pad to win. The humanoid avatar and the sword/pine/rock artifacts
are drawn from the Phase 2 catalog. Game state is a field of `inspect()` and game
tests are returned by `runTests()`; no second global, server, editor, or access
layer exists.

## Method

- **Criteria before code.** `docs/phase4-plan.md` fixed the eight pass/fail
  checks and the non-goals before implementation, so the gate could not move to
  fit the result.
- **Exact input path.** The acceptance run uses browser keyboard events
  (`page.keyboard.down('w')`, `down('s')`, `press('r')`) to drive the real
  keydown/keyup listeners and `Engine.setInput`, then `__engine.step(n)` for
  deterministic fixed-step motion. Collect is 200 steps of `W`, return is 220
  steps of `S`. The in-page `runTests()` game suite repeats the same sequence
  through `World` directly.
- **Mechanical vs agent time.** Engine/test/capture time is measured separately
  from agent wall-clock, as agreed after Phase 3. No latency optimization was
  attempted in Phase 4.
- **No new dependency.** Runtime dependencies are still `three` and `zod`.
- **No access-layer growth.** Everything is on `window.__engine`; `inspect()` is
  the only state read, `runTests()` the only test entry.

## Pass/fail results

| # | Check | Observed | Result |
|---|---|---|---|
| 1 | Scene and assets boot | `?scene=island` loads; `phase=collecting`, `total=3`, `collected=[]`, `errors=[]`; avatar 264 tri; swords 122/122, pine 172, rock 320 | PASS |
| 2 | Collect through real input | real `W` down + 200 fixed steps -> `phase=return`, 3/3 collected, `pos.z=15.000`, hash `1cb027bc` | PASS |
| 3 | Return and win | real `S` down + 220 fixed steps -> `phase=won`, `returnDistance=1.4641` < radius 1.7, HUD reads the win state, hash `a31def8f` | PASS |
| 4 | Restart | real `R` -> `phase=collecting`, 0 collected, `pos=[0,0.08,0]`, draw calls restored 15 -> 26, i.e. swords visible again | PASS |
| 5 | Determinism | scripted run twice -> identical `inspect().hash` `a31def8f` / `a31def8f`; `runTests()` `statePreserved=true` | PASS |
| 6 | Existing checks green | typecheck clean; 123 asset tests; `assets validate` 6/6; Phase 1 `runTests()` 6/6; bundle 189,850 B gzip (47.5% of 400 kB) | PASS |
| 7 | Evidence | `docs/phase4/start.png`, `collected.png`, `won.png`; engine captures start/collect/won; this review | PASS |
| 8 | No access-layer expansion | only `window.__engine`; `inspect().game` optional; `runTests()` returns the game suite for game scenes; no new global/server/editor | PASS |

## What changed

Implementation checkpoint: `4c3b80a` (`feat: add island collect-and-return game`).

| Area | Change |
|---|---|
| `src/game/schema.ts` | Zod `game` block: `mode: "collect-return"`, avatar asset/scale, collectibles with position/radius/rotation/scale, return zone, static props, unique game ids. |
| `src/game/collect.ts` | Pure `CollectGame` state machine: collect by horizontal distance, `collecting -> return -> won`, snapshot/hash/export/restore, missing-asset errors and per-asset triangle counts. |
| `src/game/visuals.ts` | Text game block -> render-only asset instances; no World or collision involvement. |
| `src/game/tests.ts` | Five browser tests: `game-assets`, `collect-all`, `return-wins`, `restart`, `determinism`; saves/restores world + game state and `statePreserved`. |
| `src/game/types.ts` | `GameAsset`, `GameVisual`, `GameSnapshot`, `GamePhase`. |
| `src/schema/scene.ts` | Optional `game` field validated by the new schema. |
| `src/devtools/state.ts` | Optional `game` in `Snapshot`; game values folded into `stateHash` when a game exists; Phase 1 hashes unchanged. |
| `src/render/renderer.ts` | Asset-backed game visuals (vertex colours, override materials, shadows), asset-backed avatar, collected meshes hidden, game objects disposed on reconfigure; default Phase 1 capsule path unchanged. |
| `src/engine.ts` | Optional game wiring: build on scene apply, step after physics, reset, `inspect()`, `capture()` hash, `runTests()` branch; version `0.1.0-phase4`. |
| `src/main.ts` | `?scene=<name>` loading with an allowlist, asset catalog load for game scenes, HUD sync, `R` restart, scene hot reload filtered to the active scene. |
| `index.html` | HUD element and phase styling. |
| `content/scenes/island.scene.json` | The island: water plane, sand platform, landing pad, beacon, three swords, six pine/rock props, third-person camera, invisible edge colliders; the game block. |

## Evidence

### Boot

```js
__engine.inspect().game
// { phase: "collecting", collected: [], total: 3, remaining: 3,
//   returnDistance: 0, errors: [], avatarTriangles: 264,
//   assetTriangles: { humanoid-01: 264, sword-bronze-01: 122, sword-iron-01: 122,
//                     pine-nordic-01: 172, rock-granite-01: 320 },
//   id: "island", hash: "69691905" }
__engine.stats() // { drawCalls: 26, triangles: 4492, objects: 16 }
```

### Real browser input

Playwright keyboard events, then deterministic fixed steps:

```
W down + step(200) -> pos [0, 0, 15.000], phase return, 3/3, hash 1cb027bc
S down + step(220) -> pos [0, 0.08, -1.464], phase won, distance 1.4641, hash a31def8f
R press + step(120) -> pos [0, 0.08, 0], phase collecting, 0/3
```

The real-input collect and return hashes are identical to the scripted
`runTests()` sequence, so the keyboard listener, third-person input rotation, the
fixed-step loop, and the state machine agree.

### In-page tests

```js
// ?scene=island
__engine.runTests()
// passed: true, 5/5, durationMs: 12.7, statePreserved: true
// game-assets      errors=[] collectibles=3 avatarTri=264
// collect-all      phase=return collected=3/3 movedZ=15.000 grounded=true
// return-wins      phase=won collected=3/3 distance=1.464 radius=1.7
// restart          wonBefore=true phase=collecting collected=0 spawnGap=0.00e+0
// determinism      hash a31def8f vs a31def8f; phase=won/won

// ?  (Phase 1 regression)
__engine.runTests()
// passed: true, 6/6, durationMs: 7.3, statePreserved: true, hash cb4685a8
```

### Captures

| Capture | Step | State hash | Bytes | File |
|---|---|---|---|---|
| `start` | 120 | `22bd7253` | 56,190 | `docs/phase4/start.png` |
| `phase4-collected` | 320 | `1cb027bc` | 33,331 | `.cache/captures/phase4-collected.png` (gitignored) |
| `phase4-won` | 540 | `a31def8f` | 48,890 | `.cache/captures/phase4-won.png` (gitignored) |

`docs/phase4/start.png`, `collected.png`, and `won.png` are Playwright viewport
screenshots that include the HUD; the engine `capture()` files above are the
canvas-only evidence and confirm the capture contract still works with game
state. The collected screenshot reads `ALL SWORDS FOUND / Return to the landing
pad.`; the won screenshot reads `ESCAPED / 3 / 3 swords · press R to restart.`

### Commands and numbers

```
npm run typecheck                          clean
npm run test:assets                        123 passed, 0 failed
node scripts/node-run.mjs src/assets/cli.ts validate   6/6 valid
npm run size                               raw 731,588 B, gzip 189,850 B (47.5% of 400 kB)
```

## Timing

Measured separately from the mechanical path, as agreed after Phase 3:

- Phase 4 start (criteria commit `d16be93`): `2026-10-20T14:23:19+05:30`.
- First full green verification: `2026-10-20T14:35:27+05:30` — **12 min 8 s**.
- Implementation checkpoint `4c3b80a`: `2026-10-20T14:35:57+05:30` — **12 min
  38 s** from criteria to code commit, including all code, content, browser
  verification, and captures.
- The review page, README update, and this evidence commit are additional agent
  time on top of that interval.

Mechanical pieces were not a bottleneck: `runTests()` game suite 12.7 ms, Phase 1
suite 7.3 ms, production build 338 ms, capture round-trips 33-49 kB PNGs. Phase 4
produced no evidence that engine speed needs work; the Phase 3 60 s question is
about agent/review latency and is not re-opened here.

## Findings

1. **Prompt-to-playable worked inside the existing boundaries.** One scene
   document, one optional schema block, one pure state machine, renderer
   visuals, a HUD, and tests delivered a playable collect-and-return loop
   without new runtime dependencies or a second control surface.
2. **The first render exposed real play problems, and content-only edits fixed
   them.** The swords initially sat on the camera axis and read as one thin
   stick; the boundary walls read as an arena. Offsetting the swords, shrinking
   the island, replacing the visible walls with invisible edge colliders, and
   letting the water plane show changed the picture without touching the
   simulation or the game tests.
3. **The asset contract carried into gameplay unchanged.** The humanoid's
   feet-center origin made the avatar sit on the physics feet with no offset
   logic, and the sword/pine/rock artifacts rendered from catalog data with their
   overrides and vertex colours intact.
4. **Game state is inspectable and deterministic.** `inspect().game` gives the
   agent phase, collected ids, remaining count, return distance, asset triangle
   counts and errors; the state hash includes the game, so the determinism test
   compares two full playthroughs, not positions alone.
5. **Real input agrees with the scripted path.** Real `W`/`S`/`R` events produce
   the same hashes as the scripted tests, which means the key listeners and
   third-person input rotation are on the tested path rather than beside it.

## Limits (explicitly not verified or not built)

- **Visual fidelity is low.** Flat-shaded primitives, a blocky unrigged humanoid,
  no textures, no animation, no terrain sculpting, and a flat water plane.
  "Island" is read from a sand platform, pines, rocks, and a water plane, not
  from a terrain system.
- **The island edge is invisible.** Four `visible: false` collider boxes stop
  the player at the beach; there is no fall-in-water behavior. The water is
  decorative.
- **Real-time keyboard play in headless Chromium was rAF-throttled.** A
  3.6 s `W` hold advanced only 18 fixed steps (~5 rAF frames/s), so the exact
  collect/return evidence uses real key events plus deterministic `step()`
  rather than wall-clock play. A headed browser at 60 Hz is expected to move at
  the configured 4.5 m/s; that was not measured as a frame-rate benchmark.
- **One scene, one game mode.** `collect-return` is the only mode; the `game`
  block is not a general gameplay authoring system. No combat, inventory, saves,
  audio, skeletal animation, or editor.
- **Game tests are browser-only.** They live in `runTests()` for game scenes;
  there is no CLI or CI wrapper for them.
- **Pine snow is still unresolved.** The game pine is `snow: false`, exactly as
  the Phase 4 plan requires. The Phase 3 visual failure is not counted as
  fixed.
- **Automatic hot reload of a game scene is not covered.** The listener filters
  to the active scene and reconfigures the game, but no test asserts a live
  `island.scene.json` edit while playing.

## Verdict

Phase 4 **passes all eight criteria**: boot, real-input collect, return/win,
restart, determinism including game state, all existing checks green, evidence
committed, and no access-layer expansion.

The gate result is: **the engine can produce a small playable game from prompts
through the existing agent surface.** It does not claim production visuals,
latency, or a general gameplay system. The pine snow failure, manifest
formatting churn, and the Phase 3 60 s end-to-end miss remain open exactly as
recorded before this phase.
