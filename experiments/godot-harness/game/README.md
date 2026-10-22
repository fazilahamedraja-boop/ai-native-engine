# Deflect Arena (Phase 16)

A small, complete third-person duel built on the verified Godot harness. One
player, one enemy, one arena. Attack, deflect, break the enemy's posture, win or
die, restart.

This is product code, not a fixture. It lives inside the harness root so
`resolveProject` can find it without `--allow-outside-root`, but it is kept
separate from `fixtures/` because `fixtures/` holds controlled defects.

## Run

```powershell
# first checkout only: import the GLB and build .godot/
godot --headless --path game --import

# play
godot --path game
```

Controls:

| Input | Action |
| --- | --- |
| `W` `A` `S` `D` | move (world axes, aligned with the fixed camera) |
| `J` or left mouse | attack |
| `K` | deflect (parry) |
| `Space` | dodge-roll |
| `R` | restart |

The window is 1280x720 at 60 physics Hz.

## Test

From `experiments/godot-harness`:

```powershell
node controller/harness.mjs test --project game --script res://tests/run_game_tests.gd --json
```

The suite is 18 behavioural checks covering the 12 required Phase 16 acceptance
criteria plus camera wall clipping, stagger safety, the event stream, and the
HUD. It drives the public harness surface (`harness_reset`,
`harness_setup`, `set_harness_input`, `_advance`) and asserts observed state,
never "a function ran".

Windowed evidence (real viewport, screenshots correlated with paused snapshots):

```powershell
node controller/game-verify.mjs --out-dir ..\..\docs\phase16\evidence\live\<run-id>
```

The output directory must stay inside `docs/phase16`.

## Layout

```text
game/
  project.godot              project config, autoload, collision layer names
  main.tscn                  scene root (GameWorld)
  scripts/game_world.gd      arena, player, camera, combat resolution, HUD, harness API
  scripts/enemy_ai.gd        pure enemy state machine (timings, posture, stagger)
  scripts/fighter_rig.gd     rigid-limb animation, materials, sword mesh, telegraph
  harness/bridge.gd          Phase 13 bridge, copied byte-identically
  tests/run_game_tests.gd    18-check acceptance oracle
  assets/placeholder-character.glb  body mesh (no skeleton, no animations)
  README.md                  this file
```

## Combat model

Everything resolves on fixed physics ticks, so a test scenario is reproducible
without depending on wall-clock timing.

| Rule | Value |
| --- | --- |
| Player attack | 6 windup + 8 active + 14 recover + 6 cooldown |
| Player deflect window | 14 ticks, 8-tick cooldown |
| Player dodge | 18 active + 10 recovery + 45 cooldown, 9.0 m/s |
| Player i-frames | dodge active ticks 3..13 |
| Player health | 4 |
| Enemy attack | 30 windup + 9 active + 18 recover + 22 cooldown |
| Enemy health | 5 |
| Posture | 100 max, +16 per sword hit, +55 per deflect, decays 0.35/tick |
| Stagger | 70 ticks at 100 posture |

A hit is only queried during the active ticks, with an explicit box shape and
an explicit collision mask (`WORLD=1`, `PLAYER=2`, `ENEMY=4`). A player attack
records at most one hit per swing (`hit_landed` latch). A mistimed deflect
expires and the enemy blow lands normally.

## Harness surface

`GameWorld` exposes:

- `harness_reset()` — clean initial state (step 0).
- `harness_setup(dict)` — controlled positions/health/posture/AI toggle for
  tests. Damage still flows through the real combat code.
- `set_harness_input(dict)` — accepts the controller schema
  (`{forward, strafe, jump, restart, actions:{attack, parry, dodge}}`) and flat
  `attack`/`parry`/`dodge` keys for direct in-engine calls.
- `snapshot()` — player/enemy/camera/combat/outcome state.
- `harness_events(since_tick)` — structured event log.
- `_physics_process` — consumes `harness_input` when `harness_mode` is on;
  edge actions are cleared after each tick.

The bridge is generic and unchanged from Phase 13. The game implements the
optional `snapshot()` / `harness_events()` / `harness_reset()` / `create_*`
hooks the bridge already probes for.

## Asset provenance

`assets/placeholder-character.glb` is a copy of
`content/assets/character/placeholder-character.glb` from this repository. It
has no skeleton and no animation clips; the game animates named rigid limb
nodes procedurally. No third-party art was added. The sword is built from
`BoxMesh` primitives at runtime.

## Known limits

See `docs/phase16/known-limitations.md`. Short version: placeholder art, one
enemy, fixed camera angle (no orbit), no audio, no persistence.
