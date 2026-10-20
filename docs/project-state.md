# Project state and session handoff

Snapshot: 2026-10-20, after Phase 5. Branch `master`. The current checkpoint is
tagged `checkpoint-2026-10-20`. At the Phase 5 code checkpoint (`c476fbd`) the
worktree was clean, the repository had 37 commits and 99 tracked files, and no
remote was configured. This handoff adds `AGENTS.md`, this document, and a
README pointer. The final session report records whether an off-machine private
remote was added;
`git remote -v` is authoritative for the current state.

This document is the portable starting point for a fresh human or AI session. It
summarizes the architecture, completed phases, verification commands, known
issues, and next steps. The detailed evidence remains in the phase reviews; those
reviews are historical records and must not be rewritten.

## What this project is

A lightweight, AI-authorable 3D game runtime in the browser. The agent edits
text (scenes, asset manifests, game configuration), runs the engine, reads pixels
and numeric state, and self-corrects. The engine is TypeScript + Three.js +
Vite; the simulation is fixed-step and deterministic.

The project is deliberately narrow: scene configuration and a small playable
island, not an editor, MCP server, general gameplay framework, or production
game engine.

## Architecture at a glance

The important boundary is that the simulation and game layers do not import
Three.js. The renderer reads World; it is never a second source of truth.

```
content/scenes/*.json + content/assets/*
        |
        v
src/schema/scene.ts (Zod) --> src/world/world.ts (nodes, colliders, player, camera)
        |                              |
        |                              +--> src/physics/step.ts (fixed 1/60)
        |                              +--> src/camera/rigs.ts
        |                              +--> src/game/collect.ts + combat.ts (pure game state)
        |                              |
        +--> src/render/renderer.ts <--+ (World + render-only game visuals)
                                      |
                                      +--> HUD in src/main.ts / index.html

src/engine.ts is the agent surface. It wires input, stepping, reset, inspection,
capture, scene apply, and tests. src/main.ts boots the page and rAF loop.

src/devtools/state.ts owns snapshots and the state hash; src/devtools/tests.ts
owns the Phase 1 browser suite; src/game/tests.ts owns the game suite.

src/assets/ is the asset contract: manifests -> pure generators or GLB import ->
MeshData -> validation -> src/render/geometry.ts. src/preview/ is the asset-only
preview and window.__preview surface.
```

Key files:

| Path | Responsibility |
|---|---|
| `src/engine.ts` | `window.__engine`: scene, inspect, stats, pause/resume, reset, step, input, capture, tests. |
| `src/main.ts` | Boot, keyboard input, rAF loop, HUD, hot-reload listener. |
| `src/schema/scene.ts` | Scene Zod grammar and graph/collider validation. |
| `src/world/world.ts` | SceneDoc -> World, player/camera/colliders; no THREE. |
| `src/physics/` | Capsule-vs-AABB fixed-step movement and support probing. |
| `src/render/renderer.ts` | World -> flat THREE draw list; avatar and game visuals. |
| `src/assets/` | Manifest contract, generators, GLB import, validation, CLI, catalog. |
| `src/preview/` | Asset preview page and `window.__preview`. |
| `src/game/schema.ts` | Optional `game` block grammar. |
| `src/game/collect.ts` | Pure collect/return/won/lost state machine. |
| `src/game/combat.ts` | Pure health, attack edge/cooldown, contact damage, counters, state. |
| `src/game/visuals.ts` | Game block -> render-only asset instances. |
| `src/game/tests.ts` | Game browser suite. |
| `src/devtools/state.ts` | State snapshot and hash. |
| `src/devtools/tests.ts` | Phase 1 browser suite. |
| `content/scenes/` | Scene documents, including `island.scene.json`. |
| `content/assets/` | Asset manifests and imported GLBs. |
| `vite.config.ts` | Capture sink and scene-watch hot reload. |

Agent/access surface:

- `window.__engine` is the only game/agent surface.
- `window.__preview` is asset-only and is not used for gameplay.
- There is no MCP server, editor, second global, or external service in the
  runtime.
- `inspect()` reads World/game state; `stats()` reports renderer counters;
  `capture()` writes a real PNG through the dev-server sink; `runTests()` runs
  the in-page suites.

## Completed phases

| Phase | Result | Evidence |
|---|---|---|
| 0 | Deterministic render and PNG capture. | History and README. |
| 1 | Versioned scene document, World/physics, orbit and third-person cameras, state-preserving hot reload. | `README.md`, Phase 1 suite. |
| 2 | Asset contract, procedural sword/rock/pine, imported humanoid, CLI, validation, previews. | `docs/phase2-exit.md`. |
| 3 | Five prompt-driven loop benchmarks; the loop closes and catches failures. The 60 s end-to-end target is not met; the mechanical path is 1-2 s. | `docs/phase3-review.md`. |
| 4 | Playable island collect-and-return gate, HUD, restart, deterministic game state. | `docs/phase4-plan.md`, `docs/phase4-review.md`. |
| 5 | One granite sentinel, edge-triggered `F` attack, health/contact/loss, defeat, HUD feedback, 12 browser game checks. | `docs/phase5-plan.md`, `docs/phase5-review.md`. |

Phase 5 is the current product state. The version string is
`0.1.0-phase5`.

## Current playable surface

- `/` loads the Phase 1 scene and the Phase 1 browser suite.
- `/?scene=island` loads the Phase 5 island and the 12-check game suite.
- Controls: `WASD` move, `Space` jump, `F` attack, `R` restart.
- The island collects three swords, returns to the landing pad, and includes one
  stationary granite sentinel. The sentinel and player each have 3 HP.
- `F` is edge-triggered. The attack cooldown is 12 fixed steps; hits and misses
  consume it. Contact damage is gated by a 60-step spawn/reset grace, then one
  hit per 60 steps. `lost` outranks `won`; both are terminal until reset.
- The sentinel reuses `rock-granite-01` and is render-only; it has no physics
  collider. Collision remains on scene AABBs.
- `inspect().game.combat` is the numeric gameplay surface:
  `player.health/maxHealth/defeated`, `enemies[]` (health, distance, contact
  cooldown, flash), `attacks`, `hits`, `misses`, `damageDealt`, `damageTaken`,
  `attackCooldown`, and `enemiesDefeated`.

## Verification commands

Run from the repository root:

```powershell
npm ci                 # only when node_modules is absent
npm run typecheck      # must be clean
npm run test:assets    # 123 passed, 0 failed at the Phase 5 checkpoint
npm run assets -- validate   # 6/6 valid
npm run build
npm run size           # Phase 5: 745,259 B raw / 193,607 B gzip
```

Browser suites require the dev server:

```powershell
npm run dev
# open http://localhost:5173/ and call __engine.runTests()
# open http://localhost:5173/?scene=island and call __engine.runTests()
```

Expected at the Phase 5 checkpoint:

- Phase 1 suite: 6/6, `statePreserved=true`, hash `cb4685a8` after
  `__engine.pause(); __engine.reset()` (step 0). Without a reset the reported
  hash reflects the live step count and will differ; the `determinism` check
  itself still compares two identical internal runs.
- Island suite: 12/12, `statePreserved=true`, hash `7e1b50b0` after
  `__engine.pause(); __engine.reset()` (step 0). Duration varies with the
  machine; 26-43 ms was observed across runs.
- Bundle: 193,607 B gzip, 48.4% of the 400 kB budget.

Headless Chromium throttles rAF. For exact evidence, pause, use real keyboard
events where required, then `__engine.step(n)`. Wait about 1.2 s before reading
the HUD or taking a screenshot. `R` resets and resumes; pause again before
stepping.

## Known issues and deliberate limits

Open acceptance items:

- **Phase 3 60 s target is unmet.** Core full cycles were 152-385 s; the
  mechanical path is 1-2 s. Agent/review latency is the bottleneck, not the
  engine. Do not redefine this target.
- **Pine snow is unresolved.** The generator produces the predicted snow
  geometry, but stacked tiers hide the band. The shipped pine is `snow: false`.
  This is a caught visual failure, not a fixed feature.

Gameplay and content limits:

- One stationary sentinel. No chase, pathfinding, line-of-sight, enemy facing,
  attack telegraph, or multiple-enemy scenario.
- Attacks are radial within 2 m, not a frontal cone. The avatar has no facing
  state, and the third-person camera has no pointer-look.
- No attack, hit-reaction, death, or locomotion animation; no skeletal playback;
  no audio.
- Death is terminal. There is no respawn, regen, checkpoint, or automatic
  restart; `R` is the only recovery.
- No save persistence. Export/restore is in-memory game state only.
- Visuals are primitive: flat-shaded primitives, a blocky unrigged humanoid, a
  flat water plane, an invisible island boundary, and no terrain or fall-in-water
  behavior. The sentinel is an untinted rock with an emissive hit flash.

Platform and test limits:

- The game suite is browser-only (`runTests()` at `?scene=island`); there is no
  CLI or CI wrapper for it.
- No real-time frame-rate claim has been measured. Fixed-step tests are the
  acceptance path; a headed 60 Hz benchmark is still open.
- `inspect()` reports node world position and scale, not world rotation.
- `regen --accept` rewrites the whole manifest in expanded JSON, producing large
  diffs until a canonical formatter exists.
- Imported characters are static meshes; no skinning, animation, textures,
  morph targets, or advanced materials.
- No shadow-quality tuning, instancing, LOD, or packaging.

## Next steps

1. **Confirm the checkpoint and off-machine copy.** Verify the tag, bundle hash,
   and private remote (if one was approved). Do not push without explicit user
   approval.
2. **Make the engine-direction decision.** The canonical plan's next major
   decision is to reassess the browser engine against a Godot + AI layer using
   measured iteration latency, not intuition. Phase 3's 60 s miss is the relevant
   evidence.
3. **If continuing the browser engine**, prioritize in this order:
   - avatar facing plus a readable attack arc/telegraph;
   - one enemy behavior (chase or telegraphed attack) and a second enemy placement;
   - animation or at least motion feedback for attack/hit/death;
   - save/resume and a non-terminal recovery path;
   - a CI or CLI wrapper for the browser suites.
4. **Resolve the pine snow visual failure** only with a visible before/after
   capture and validation; do not mark it fixed because the geometry exists.
5. **Measure before optimizing.** If frame rate or bundle size becomes a goal,
   record a headed measurement and the exact build/hash first.
6. **Keep the evidence discipline.** Criteria before code, focused commits,
   phase reviews with exact commands, and no rewriting of historical results.

## Phase 8 experiment (separate branch)

This section is present only on `experiment/phase8-godot-harness`. `master` and
`spike/sentry-mode` remain unchanged; the Phase 7 fixture was not edited.

The experiment adds an isolated Godot verification harness under
`experiments/godot-harness/`. It uses a project-local autoload bridge and a
Node controller, not an engine fork or a new MCP server. The verified surface is:

- `run_tests`: headless sentry logic and live gameplay suites with exit codes;
- `start_project` / `stop_project`: owned-process lifecycle, logs, and isolation;
- `inspect_state`: snapshots, scene tree, properties, and bridge events;
- pause, persistent input, requested steps, reset, stable hashes, and windowed
  screenshots;
- a reproducible one-line defect-repair experiment.

Start with `experiments/godot-harness/README.md`. The acceptance review and
limitations are in `docs/phase8-report.md`. The full evidence is under
`docs/phase8/`. Do not merge this branch into `master` without a new decision.

## Backup, recovery, and security

Security posture at the Phase 5 checkpoint:

- No tracked `.env`, private key, credential file, or secret-like token was found
  in the repository.
- `.gitignore` excludes `node_modules/`, `dist/`, `.cache/`, `*.local`, and
  `.DS_Store`.
- `node_modules/` (about 113 MB) and `dist/` are reproducible and are not source.
- The GitHub CLI is authenticated through the OS keyring; no token is stored in
  this repository.

Create and verify a full-history bundle outside the repository:

```powershell
$stamp = Get-Date -Format 'yyyy-MM-dd_HHmmss'
$dir = "C:\Users\hacke\Backups\ai-native-engine\$stamp"
New-Item -ItemType Directory -Force -Path $dir | Out-Null
git bundle create "$dir\ai-native-engine.bundle" --all
git bundle verify "$dir\ai-native-engine.bundle"
Get-FileHash "$dir\ai-native-engine.bundle" -Algorithm SHA256
```

Restore and verify:

```powershell
git clone "$dir\ai-native-engine.bundle" "$dir\restored"
git -C "$dir\restored" fsck --full
git -C "$dir\restored" log --oneline -5
git -C "$dir\restored" tag -n
```

The bundle contains all Git refs and history, including the checkpoint tag. It
does not contain `node_modules/`, `dist/`, or `.cache/`; install dependencies with
`npm ci` and rebuild with `npm run build`.

At the Phase 5 checkpoint there was no remote. If a private remote was approved,
check it with `git remote -v`; the expected backup is a private repository with
`master` and the annotated checkpoint tag pushed. Never push to a public remote
or add credentials to a tracked file.

## Fresh-session checklist

1. Read `README.md`, this file, and the latest phase review
   (`docs/phase5-review.md`).
2. Check `git status --short --branch`, `git log --oneline -5`, and
   `git tag -n`.
3. If `node_modules/` is absent, run `npm ci`.
4. Run `npm run typecheck`, `npm run test:assets`, and
   `npm run assets -- validate`.
5. Start `npm run dev`; run the Phase 1 suite at `/` and the game suite at
   `/?scene=island`.
6. Before changing behavior, read the relevant phase plan and preserve its
   acceptance criteria. Commit focused changes and tag a new checkpoint when the
   state is verified.
