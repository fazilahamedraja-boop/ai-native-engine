# Phase 4 — The gate: island collect-and-return

Status: acceptance criteria fixed before implementation.

## Goal

Prove the agent can author, run, and verify a small playable 3D game through the
existing `__engine` surface, not just edit isolated assets.

The game is one island scene: the player starts on a landing pad, collects three
swords placed along the island, then returns to the pad to win. It uses the
Phase 2 humanoid as the avatar and the Phase 2 sword/pine/rock artifacts as
visible game objects. Rendering, physics, scene validation, input, inspection,
capture, and tests stay inside the existing engine boundaries.

## Scope

- One new scene: `content/scenes/island.scene.json`, loaded with
  `http://localhost:5173/?scene=island`.
- One optional `game` block in that scene document, validated by Zod:
  avatar asset/scale, collectible asset/position/radius, return zone, and static
  asset props.
- A small pure collect/return state machine, stepped immediately after physics.
- One DOM HUD over the canvas, plus `R` to restart.
- Existing Phase 1 scene and its six tests remain the default at `/`.
- Browser tests through `__engine.runTests()`; game state included in
  `__engine.inspect()` and in the state hash.
- Evidence: start, all-collected, and won captures, plus the review page.

## Non-goals

No combat, inventory, save files, audio, skeletal animation, terrain heightmaps,
asset composition editor, new scene node types, MCP server, editor UI, or
latency optimization. No new access layer. Pine snow remains unresolved and is
not part of the game; the pine uses `snow: false`.

## Pass/fail criteria

Phase 4 passes only if every numbered check is observed:

1. **Scene and assets boot.** `?scene=island` loads a valid scene; `inspect()`
   returns `game.phase === "collecting"`, 3 collectibles, 0 collected,
   `game.errors === []`, and positive triangle counts for the avatar and every
   configured asset.
2. **Collection works through real input.** Reset, settle, hold `W` for 200
   fixed steps: `game.phase` becomes `"return"`, `game.collected` has all three
   ids, and the player has actually moved forward (not teleported).
3. **Return and win.** From the collected state, hold `S` for 220 fixed steps:
   `game.phase === "won"` and the player is within the return radius. The HUD
   reads the win state.
4. **Restart works.** `R` (and `engine.reset()`) restores phase `collecting`,
   zero collected, the spawn position, and visible swords.
5. **Determinism.** The same scripted collect-and-return run twice produces the
   same `inspect().hash`, including game state.
6. **Existing checks stay green.** `npm run typecheck`, `npm run test:assets`
   (123 tests), `assets validate` (6/6), Phase 1 `?` `runTests()` (6/6), and the
   production bundle under the 400 kB gzip budget.
7. **Evidence exists.** Start, collected, and won captures are under
   `docs/phase4/`, and `docs/phase4-review.md` records the commands, numbers,
   screenshots, scope cuts, and anything not verified.
8. **No access-layer expansion.** The public agent surface remains
   `window.__engine`; game state is a field of `inspect()` and game tests are
   returned by `runTests()`. No second global, server, or editor is added.

## Verification commands

```powershell
npm run typecheck
npm run test:assets
node scripts/node-run.mjs src/assets/cli.ts validate
npm run size
```

Browser checks with the dev server:

```js
// ?scene=island
__engine.inspect().game
__engine.runTests()

// ? (Phase 1 regression)
__engine.runTests()
```

The scripted checks use `pause()`, `reset()`, `setInput()`, and `step()` so the
game is verified without relying on wall-clock timing or human reaction time.

## Measurement

Agent/review latency is tracked separately from the mechanical game path, as
agreed after Phase 3. Phase 4 records wall-clock from criteria commit to
implementation commit, plus the scripted test and capture times. No Phase 3 or
Phase 4 latency work is done unless the Phase 4 evidence shows it is a practical
bottleneck.

## Known limitations to carry forward

- Pine `snow` is still a caught visual failure and is not resolved.
- `regen --accept` manifest formatting churn is still technical debt.
- The humanoid is static; there is no animation framework.
- Asset props are visual only; collision remains on scene colliders.
- The game configuration is part of the island scene document, not a general
  gameplay authoring system.
