# Phase 15 diagnosis

## Failure

The failing acceptance case is **`observation-crate-falls`**. The run reports `passed=7 failed=1` with `"exit_code": 1` and `"reason": "test cases failed"` (`evidence/test-result.json`). The case detail is:

```
FAIL observation-crate-falls crate_y=3.000 ground_collision=false sleeping=true
```

The crate is still at its spawn height after the scenario has run. The trace snapshot embedded in `evidence/test-output.txt` records `crate_position` = `[4.19999980926514, 3.0, 2.5]`, `crate_linear_velocity` = `[0,0,0]` and `crate_sleeping` = `true`. `evidence/state.json` ends at `physics_frames: 117` (1.95 s at 60 Hz), and `evidence/observation.json` is captured at `engine_tick: 119`. The HUD in `evidence/before.png` independently shows `CRATE: 3.00 m` at `TICK: 115`, and the crate is visibly suspended in mid-air to the right of the gate with empty space beneath it.

The expected fall is well defined by the geometry in `evidence/observation.json`: the Ground is a `StaticBody3D` with a 24 x 0.5 x 24 `BoxShape3D` centred at y = -0.25 (top surface y = 0.0), and the Crate is a 0.7 m box, so its resting centre is y = 0.35. Free fall from 3.0 to 0.35 (2.65 m) takes about 0.74 s, i.e. roughly 44 physics ticks, not 117.

`evidence/physics-queries.json` corroborates the final position:

- `crate_spawn_height`, a box at (4.2, 3.00, 2.5), returns `/root/Main/Crate` — "still up there".
- `crate_resting_height`, a box at (4.2, 0.35, 2.5), returns only `/root/Main/Ground` — the crate is not on the floor.

Note that `observation-reset` passes with `step=0 ... crate_y=3.000 last_event=reset`, so y = 3.0 is the intended *initial* value; the failure is that it is also the final value.

## Contradiction

Falsifiable claim: **the crate is a dynamic, gravity-driven `RigidBody3D`, so from spawn at y = 3.0 it must reach y ≈ 0.35 within ~44 ticks; it cannot remain unsupported at its spawn height.**

Two observations conflict:

1. **The crate's transform/velocity state says it never moved.** `evidence/observation.json` shows `/root/Main/Crate` as `RigidBody3D` with an enabled `CollisionShape3D` (`disabled: false`, `BoxShape3D` size 0.7, origin y = 3.0, identity rotation) on `collision_layer: 1` / `collision_mask: 1`; the trace records velocity `[0,0,0]` and `crate_sleeping: true` at the end of the scenario.
2. **The physics space has no support at that height and the crate is not at the surface.** The query at the spawn height hits the crate, the query at the expected resting height hits only the Ground, and the screenshot shows clear space below the crate. A body that is `sleeping` (i.e. at rest) while 2.65 m above the only surface beneath it is internally contradictory: it is at rest with nothing to rest on.

In short: `sleeping=true` + zero velocity asserts "settled", while `crate_position.y` = 3.000 and the resting-height query assert "not settled". The crate is being excluded from gravity/integration, not resting.

## Hypotheses ruled out

- **Wrong spawn height.** Excluded by `observation-reset`, which passes with `crate_y=3.000` at `step=0`, and by the spawn-height query finding the crate at (4.2, 3.00, 2.5). 3.0 is the designed start.
- **Missing or misconfigured ground / collision-layer mismatch.** Excluded: the Ground exists with its top at y = 0.0, crate and ground both use `collision_layer: 1` / `collision_mask: 1`, the resting-height query returns the Ground, and the player is `grounded=true` with the initial position `[0.0, 0.85000002384186, 5.5]`.
- **The crate is a `StaticBody3D` or has no collider.** Excluded: `evidence/observation.json` classes it as `RigidBody3D` and lists an enabled 0.7 m `BoxShape3D` collision shape.
- **An invisible platform/ledge is holding the crate at y = 3.0.** Excluded by both queries: at 3.0 only the crate itself is returned, and at 0.35 only the Ground is returned; the screenshot shows nothing under the crate at that x/z.
- **The failure is stale data or the initial snapshot only.** Excluded: the final trace snapshot after 117 frames still shows position y = 3.0 and velocity `[0,0,0]`, the physics-space queries were run against the final space, and the HUD at TICK 115 independently reports `CRATE: 3.00 m`.
- **The whole simulation is paused or not ticking.** Excluded: `observation-initial-state`, `observation-plate-opens-gate`, `observation-gate-passable-after-plate`, `observation-closed-gate-blocks`, `observation-event-stream`, `observation-reset` and `observation-humanoid-probe` all pass; plate/gate/beacon transitions, player collisions, goal reach (`z=-7.112`) and event ordering (`count=4 ordered=true fields_ok=true`) all work, and ticks advance (`engine_tick: 119`, `physics_frames: 117`).
- **The crate fell and was teleported back by a reset.** Excluded: the event stream contains no crate-related events (only `reset` and player collisions), and the end-of-scenario position is exactly the spawn transform with zero velocity; the passing `observation-reset` case establishes 3.0 as a step-0 baseline only.

## Proposed correction

Stop holding the crate out of the simulation. The smallest change is at the crate's reset/spawn path: after the fixture restores the crate to `(4.2, 3.0, 2.5)`, do not force it asleep — clear the crate's frozen/asleep state so the next physics tick integrates gravity. Concretely, remove the `freeze = true` / forced `sleeping = true` applied to `/root/Main/Crate` (or, if `freeze` is intentionally set in the scene, exclude the crate from that freeze and call `crate.sleeping = false` after setting its transform), leaving `gravity_scale` at 1.0.

If only one line may change, make it the forced sleep on the crate: `crate.sleeping = false` after the reset transform is applied. No change to spawn position, crate size, ground geometry or collision masks is warranted — all of those are already correct.

With that change the crate should fall ~2.65 m in about 44 ticks, contact the Ground (`ground_collision=true`), come to rest at y ≈ 0.35, and only then legitimately report `sleeping=true`.

## Confidence

Confidence that the crate is being deliberately excluded from gravity/integration (frozen, force-slept, or gravity-disabled) rather than failing due to geometry, masks or queries: **high, ~0.85**. Confidence in the exact mechanism (freeze vs. forced sleep vs. `gravity_scale = 0`): **moderate, ~0.55**, because the crate node's `properties` object in `evidence/observation.json` is empty, so `freeze`, `freeze_mode`, `gravity_scale` and `can_sleep` are not observable here; only `crate_sleeping: true` and zero velocity are.

Evidence that would raise confidence:

- A runtime property dump for `/root/Main/Crate` of `freeze`, `freeze_mode`, `gravity_scale`, `can_sleep` and `sleeping`.
- A per-tick trace of crate y and velocity from tick 0, showing whether it is motionless from the very first tick (freeze/explicit sleep) or becomes `sleeping` only after ~30 idle ticks (zero gravity).
- Confirmation of whether the fixture reset writes `sleeping`/`freeze` on the crate, and the exact value it writes.
