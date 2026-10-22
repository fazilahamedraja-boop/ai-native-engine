# Phase 16 — implementation plan

This is the plan that was executed, written down with the actual outcomes so a
reader can reproduce it and see where reality differed from the plan.

## 0. Guardrails

- Start from the verified Phase 15 commit `47e9127`
  (`experiment/phase15-agent-adapter`).
- Build in a separate worktree, branch `experiment/phase16-game`.
- Do not merge, push, reset, rebase, retag, or rewrite any Phase 8–15 history.
- Do not modify Phase 8–15 fixtures, tests, evidence, or protected refs.
- Reuse Godot's renderer, physics, scene system, and runtime APIs. Add no
  engine, renderer, physics layer, observation framework, or general gameplay
  framework.
- Run the existing regression suite before touching anything.

## 1. Baseline verification (Stage 0)

| Check | Result |
| --- | --- |
| Branch | `experiment/phase15-agent-adapter` |
| Commit | `47e9127` |
| Worktree | clean |
| Tags | only `checkpoint-2026-10-20` |
| Phase 7–15 worktrees | all present |
| Regression before changes | 65/65 pass, 94.5 s |

Phase 16 worktree: `C:\Users\hacke\ai-native-engine-phase16` on
`experiment/phase16-game`, created from `47e9127`.

## 2. Asset and project inspection (Stage A)

Inspected before assuming anything:

- `content/assets/character/humanoid-01.glb` — 22 rigid meshes, no skin, no
  animation.
- `content/assets/character/placeholder-character.glb` — 9 nodes / 6 meshes,
  no skin, no animation.
- `CesiumMan.glb` — CC BY 4.0 sample, explicitly not product content.
- No sword mesh exists in the repository.
- The placeholder's origin is at the feet, height ≈ 1.63 m. Named nodes:
  `arm_l/arm_r` at `(±0.215, 1.120, 0)`, `hand_l/hand_r` at `y=0.845`,
  `body` at `y=1.125`, `head` at `y=1.515`, `leg_l/leg_r` at `(±0.09, 0.425, 0)`.
- A `visor` child of `head` marks forward.

Decision: copy `placeholder-character.glb` into `game/assets/`, recolour it per
fighter, animate the rigid limbs procedurally, and build the sword from box
primitives. This avoids an art pipeline and keeps the code inspectable.

Project location: `experiments/godot-harness/game/`. It sits inside the harness
root so `resolveProject` works without `--allow-outside-root`; it is separate
from `fixtures/` because fixtures are controlled defects.

## 3. Game implementation (Stage B)

### B1 — player + camera

- `CharacterBody3D` with gravity 18 m/s², ground snapping, walk speed 4.4 m/s,
  acceleration 26 m/s².
- World-axis movement (`W` = −Z), which matches the fixed camera's forward
  direction apart from the shoulder offset's small yaw; turn toward movement
  at 12 rad/s.
- Third-person camera at `player + (1.1, 2.7, 4.7)`, look at
  `player + (0, 1.15, 0)`, blend 0.35/tick.
- Ray pull-in against the world layer, surface plus normal, minimum boom raised
  to a close high angle when fully collapsed.
- Input edge-triggering, HUD health and state.

First iteration used `(0, 3.4, 6.6)`, which put the fighters too far away.
Second iteration used `(0, 2.6, 4.9)`, which made the player occlude the enemy
at melee range. Final iteration added the shoulder offset. Each change was
re-verified with the in-engine suite and a windowed run.

### B2 — sword combat

- Six windup, eight active, fourteen recover, six cooldown ticks.
- `PhysicsShapeQueryParameters3D` with an explicit `BoxShape3D` and explicit
  collision mask `ENEMY_LAYER`; queried only on active ticks.
- `hit_landed` latch, so one swing cannot damage twice.
- Facing matters: the box lives in local forward space.
- Events: `attack_started`, `attack_active`, `attack_recover`,
  `player_hit_enemy`.

### B3 — enemy

- Pure state machine in `enemy_ai.gd` (no physics queries, no drawing).
- Approach at 2.2 m/s, attack inside 2.3 m.
- Thirty windup, nine active, eighteen recover, twenty-two cooldown ticks.
- Telegraph is observable two ways: emissive red blade and HUD warning.
- Health 5, hit reaction flash, posture, stagger at 100 for 70 ticks, defeat.
- Stagger interrupts windup/active/recover and cannot attack.

### B4 — deflect

- Fourteen-tick window opened by `K`, eight-tick recovery and cooldown.
- Result state machine `idle → active → success | expired`.
- Success requires the enemy active hit to arrive while the window is open.
- Success cancels the enemy attack, awards 55 posture, records
  `parry_success`, and prevents player damage.
- Expiry is recorded; a later hit is a normal hit. A press at the start of the
  windup (30 ticks before the hit) must expire.

### B5 — complete loop

- Entry state, encounter, victory, defeat, restart.
- Restart restores step 0, 4 player HP, 5 enemy HP, cleared events, spawn
  arrangement, snapped camera.
- Outcome freezes combat input except `R`.

## 4. Acceptance suite (Stage D)

`game/tests/run_game_tests.gd`, 18 checks, about 14 s. It drives only the
public harness surface and asserts observed state:

```
game-startup
game-player-moves-and-stays-grounded
game-camera-follows
game-camera-avoids-wall-clipping
game-attack-windup-cannot-damage
game-attack-hits-enemy-once
game-attack-no-damage-outside-window
game-attack-facing-away-misses
game-enemy-damages-player
game-parry-success
game-parry-mistimed-does-not-register
game-enemy-stagger-transition
game-staggered-enemy-cannot-attack
game-enemy-defeat-victory
game-player-defeat
game-restart-restores-initial-state
game-event-stream
game-hud-reflects-state
```

`harness_setup` is used to place bodies and freeze the AI for controlled
scenarios. It cannot deal damage; every hit resolves through the live combat
path. The suite does not claim physics determinism in general, only that these
scenarios resolve identically at 60 Hz.

Run:

```powershell
node controller/harness.mjs test --project game --script res://tests/run_game_tests.gd --json
```

Result: 18 passed, 0 failed, 14,265 ms.

## 5. Agent adapter integration (Stage C)

Constraint: use the real Phase 15 adapter, not a hand-written imitation, and do
not weaken its sandbox.

What was added:

- `controller/game-task.mjs`: a single-task mode that imports the Phase 15
  adapter's exported helpers (`resolveOpencodeBin`, `runOpencode`, `copyDir`,
  `hashTreeOfTests`, `diffAgainstGiven`, `describeChange`, `processExists`,
  `nowStamp`, `SANDBOX_CONFIG_SOURCE`).
- Command shape is unchanged: `opencode run --standalone --format json
  --model ... --auto`, private `XDG_CONFIG_HOME`, cwd inside a temp sandbox,
  same deny-by-default `opencode.json` (no shell, network, webfetch,
  websearch, execute, question, skill, or subagent).
- The game is copied to the sandbox, a controlled regression is injected, the
  project is imported, and the acceptance suite must reproduce the intended
  failure before the agent starts.
- After the run the runner hashes `game/tests/`, rejects any oracle change,
  diffs the project, runs the full acceptance suite in Godot, and writes
  evidence under `docs/phase16/agent-runs/<run>/`.
- Blind mode and the Phase 15 CLI are untouched; the new exports are additive.

The controlled repair: `PARRY_WINDOW_TICKS` changed from 14 to 44, so a press
at the start of the enemy windup survives until the blow lands. The task text
is the bug report (`docs/phase16/agent-tasks/parry-window-repair.md`), not the
answer key.

First attempt failed before the agent started: `spawnSync godot ENOENT`,
because the runner used a bare `godot` while this machine exposes a `.cmd`
shim. Fixed by using the harness's exported `GODOT_BIN` resolver. The failed
run is preserved under `docs/phase16/agent-runs/` as integration evidence.

Second attempt:

| Item | Value |
| --- | --- |
| Model | `opencode/deepseek-v4.1-flash-free` |
| OpenCode | `2.0.32` |
| Events | 22 |
| Tools used | `edit`, `glob`, `grep`, `read` |
| Before | 1 expected failure |
| Changed | `scripts/game_world.gd` only |
| Diff | `-const PARRY_WINDOW_TICKS := 44` / `+const PARRY_WINDOW_TICKS := 14` |
| Oracle changed | no |
| After | 18/18 pass |
| Orphans | 0 |

The adapter verified the repair itself with the real Godot harness; the result
is not taken from the agent's message.

## 6. Windowed evidence (Stage E)

`controller/game-verify.mjs` starts a real windowed `HarnessSession`, pauses
the tree, steps physics, and captures nine frames. Each capture is
`pause → advance → pause → snapshot → screenshot → snapshot`, so the PNG is
tied to a paused simulation step. Policy reads only public snapshot fields.

Result: 11/11 checks, nine captures, every capture has
`engine_tick == simulation_step == state.step`.

Iterations: the first two runs used the pre-shoulder camera and were
superseded. The authoritative run is
`docs/phase16/evidence/live/phase16-live-2026-10-22T17-21-27-965Z/`.

## 7. Exported build (Stage F)

Export templates installed: `4.7.2.stable`. Added a Windows Desktop preset
(exclude `tests/*`, `artifacts/*`) and exported:

```powershell
godot --headless --path game --export-release "Windows Desktop" <...>\game\build\DeflectArena.exe
```

Output: `DeflectArena.exe` (109,127,680 bytes) + `DeflectArena.pck`
(70,348 bytes).

Verification:

1. `DeflectArena.exe --headless --quit` → exit 0, no errors.
2. Visible launch → process alive, window title `deflect-arena`.
3. Window-content capture with `PrintWindow` (the desktop was covered by an
   unrelated full-screen app, so a screen capture showed the wrong window).
4. `controller/export-verify.mjs` launched the binary with
   `-- --harness-port=<port>` and drove the packaged game over the same bridge:
   clean initial state, movement in 24 frames, sword hit with
   `player_hit_enemy`, restart to step 0, process alive. 6/6 checks.

The full encounter, victory, defeat, and restart loop were verified in the
windowed source run. The exported probe verifies packaging, launch, input, hit
resolution, restart, and rendering; it does not re-drive the entire 287-tick
victory path inside the shipped binary.

## 8. Final regression and documentation (Stage G)

- Phase 8–15 suite re-run unchanged after all edits: 65/65 pass, 94.6 s.
- `docs/phase16/`: design, plan, test results, gameplay verification,
  limitations, final report, evidence manifest.
- Small Conventional Commits; worktree clean; no merge or push.

## 9. Reproduction

From `experiments/godot-harness`:

```powershell
# first checkout only
godot --headless --path game --import

# acceptance suite
node controller/harness.mjs test --project game --script res://tests/run_game_tests.gd --json

# windowed evidence (new directory each run)
node controller/game-verify.mjs --out-dir ..\..\docs\phase16\evidence\live\<run-id>

# agent repair task
node controller/game-task.mjs `
  --task ..\..\docs\phase16\agent-tasks\parry-window-repair.md `
  --defect ..\..\docs\phase16\agent-tasks\parry-window-repair.json

# export and probe
godot --headless --path game --export-release "Windows Desktop" <...>\game\build\DeflectArena.exe
node controller/export-verify.mjs --exe game/build/DeflectArena.exe

# engine regression
npm test
```

## 10. What did not go to plan

- The first camera distance was too far; the second was too close behind the
  player. Both were caught by looking at real frames, not by tests.
- The first agent-task attempt failed on PATH resolution, not on the model.
- A desktop screenshot of the exported build captured an unrelated full-screen
  application. `PrintWindow` was used instead; the misleading capture was
  discarded.
- The apparent "mirrored HUD" in the first screenshots was a font
  antialias/outline halo. A pixel-correlation check showed a 2 px translation,
  not a mirrored render; no UI change was needed.
