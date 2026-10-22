# Phase 15 diagnosis

## Failure

The failing acceptance case is **`observation-crate-falls`** (the only failure; `RESULT passed=7 failed=1`):

```
FAIL observation-crate-falls crate_y=3.000 ground_collision=false sleeping=true
```

The same state is reported elsewhere in the evidence. The `closed_gate_blocks` trace snapshot at step 155 / tick 442 records `crate_position=[4.19999980926514, 3.0, 2.5]`, `crate_linear_velocity=[0.0, 0.0, 0.0]`, `crate_sleeping=true`, and no ground collision. `evidence/state.json` ends at step 93 with 115 physics frames, and `before.png` at step 93 / tick 113 still shows `CRATE: 3.00 m` with the orange crate visibly suspended in mid-air.

The fixture geometry makes the expected result unambiguous:

- `evidence/observation.json`: `/root/Main/Crate` is a `RigidBody3D` at origin `[4.19999980926514, 3, 2.5]`, with a non-disabled 0.7 m `BoxShape3D`, `collision_layer=1`, `collision_mask=1`.
- `/root/Main/Ground` is a `StaticBody3D` with a 24 x 0.5 x 24 `BoxShape3D` centred at y=-0.25, so its top surface is y=0.0.
- A crate-sized body resting on that surface has its centre at y=0.35 — exactly the `crate_resting_height` query point.

At 60 physics ticks/s, falling the 2.65 m from centre y=3.0 to y=0.35 takes `sqrt(2 * 2.65 / 9.81) ≈ 0.735 s ≈ 44 ticks`. The run had 115 physics frames, so elapsed time is not the reason it has not landed.

## Contradiction

**Falsifiable claim:** the crate is a dynamic `RigidBody3D` in free space above the ground, so it must fall under gravity, reach centre y≈0.35, and report a Ground collision.

Two observations conflict with that claim:

1. **Support/geometry observation** (`evidence/physics-queries.json`): the `crate_spawn_height` query at `(4.2, 3.00, 2.5)` returns only `/root/Main/Crate` itself — nothing supports it — while the `crate_resting_height` query at `(4.2, 0.35, 2.5)` returns `/root/Main/Ground`. The crate's bottom (y=2.65) is therefore 2.65 m above the ground surface (y=0.0).
2. **Runtime-state observation** (test output, `evidence/observation.json`, `evidence/state.json`): after 115 physics frames, and in the trace at tick 442, the crate is still at its exact spawn position `[4.19999980926514, 3.0, 2.5]`, with `crate_linear_velocity=[0.0, 0.0, 0.0]`, `crate_sleeping=true` and `ground_collision=false`; `observation-reset` also reports `crate_y=3.000` at step 0.

An awake, gravity-affected body with 2.65 m of free fall cannot remain at y=3.0 with zero velocity for 115 frames; if it had landed it would be at y≈0.35 and the spawn-height query would no longer find it there. The crate is not being integrated as a dynamic body at all. The `sleeping=true` is a symptom, not a landed state: `ground_collision=false` shows it never touched anything, so it was frozen or force-slept before it could begin falling, rather than falling asleep after coming to rest.

## Hypotheses ruled out

- **"It already fell and is resting on the ground."** Excluded by `crate_y=3.000` (spawn height) rather than 0.35, by `ground_collision=false` and `crate_linear_velocity=[0.0, 0.0, 0.0]`, and by the `crate_resting_height` query returning Ground rather than the Crate.
- **"It is supported by a hidden platform or another collider."** Excluded by the `crate_spawn_height` query returning only the Crate, by `node_count=3` in `evidence/observation.json` (only `/root/Main`, `/root/Main/Crate`, `/root/Main/Ground`), and by `before.png`, which shows empty air beneath the floating crate.
- **"Collision layers/masks prevent contact with the ground."** Excluded by both bodies having `collision_layer=1` and `collision_mask=1`. In addition, a mask mismatch would let the crate fall through the ground, not hover at spawn.
- **"It is a static body or has no collision shape."** Excluded by `"class": "RigidBody3D"`, the non-disabled `BoxShape3D` (0.7 x 0.7 x 0.7) at `/root/Main/Crate/Collision`, and its layer/mask of 1.
- **"Physics/gravity is not running at all."** Excluded by the advancing simulation (step 0 -> 93, `physics_frames=115`, tick 16 -> 442), by the player colliding with `/root/Main/Ground` (`player_collision_start`, `grounded=true`, `collision=true`), and by `gate_collision_seen=true`. A project-wide zero-gravity override is not demonstrated by these observations, but there is no positive evidence for it (see Confidence).
- **"The scenario resets the crate back to spawn every frame."** Excluded by the event stream containing a single `reset` at sequence 1 / step 0, with no repeated reset events; `crate_y` is 3.000 at step 0 and unchanged at steps 93 and 155.

## Proposed correction

Make the crate simulate from the first physics tick, instead of freezing or force-sleeping it at spawn/reset. The smallest change is to clear the crate's frozen/sleeping state on the existing `RigidBody3D`:

- Remove/undo `freeze = true` on the Crate (`freeze = false`), and wake it once after it is positioned at spawn (`sleeping = false` / an explicit wake-up).
- If inspection shows the body is force-slept rather than frozen, the equivalent single-property change is `sleeping = false`.
- If its gravity has been disabled instead, restore `gravity_scale = 1.0` (default).

No scene restructuring is needed: the Crate is already a correctly shaped, correctly layered dynamic body with Ground beneath it. After the change, within roughly 45+ ticks of reset the crate centre should be ≈0.35 with `ground_collision=true`, after which sleeping becomes legitimate.

## Confidence

**High** that the crate is not being simulated: every independent source (acceptance detail, trace snapshot, `state.json`, `observation.json`, physics-space queries, screenshot) agrees it remains at spawn with zero velocity, asleep, and without any ground contact, with empty space beneath it.

**Medium-high** that freeze/forced sleep is the exact mechanism. `evidence/observation.json` records the Crate's `properties` as `{}`, so `freeze`, `freeze_mode`, `gravity_scale`, `can_sleep`, `sleeping`, `custom_integrator` and `axis_lock_*` are not exposed. `sleeping=true` on a body that has never collided is consistent with a frozen or force-slept `RigidBody3D`; a `gravity_scale = 0` body would look observationally identical here.

Extra evidence that would raise confidence:

- A tick-0 dump of Crate's `freeze`, `freeze_mode`, `gravity_scale`, `can_sleep`, `sleeping`, `custom_integrator` and axis locks.
- A per-tick trace of crate position/velocity for the first ~50 ticks after reset, showing whether it never moves from tick 0 (frozen/zero gravity) or moves and is teleported back (reset interference).
- A physics query at an intermediate height (e.g. `(4.2, 1.5, 2.5)`) confirming empty space between spawn and ground.
- A run with `freeze` cleared (or with an explicit wake-up) showing the crate lands at y≈0.35 with a Ground collision.
