# Phase 15 diagnosis

## Failure

The failing acceptance case is **`observation-crate-falls`** (7 passed, 1 failed, `exit_code: 1`). Its reported detail is:

```
FAIL observation-crate-falls crate_y=3.000 ground_collision=false sleeping=true
```

The crate never leaves its spawn height. `/root/Main/Crate` has world origin `[4.19999980926514, 3, 2.5]` in `observation.json` (`engine_tick: 118`) and the same `crate_position` in the `OBSERVATION_SUMMARY` snapshot taken at `step: 155` / `tick: 442`. In that snapshot `crate_linear_velocity` is `[0.0, 0.0, 0.0]`, `crate_sleeping` is `true`, and `ground_collision` is `false`. `state.json` shows the scenario did advance (`step: 93`, `physics_frames: 117`), and the screenshot HUD independently shows `CRATE: 3.00 m` with the crate visibly suspended above the ground.

`observation-reset` passes with `crate_y=3.000`, confirming that `y = 3.0` is the intended spawn height, not a plausible resting height.

## Contradiction

Falsifiable claim: **a dynamic `RigidBody3D` with an enabled collider, matching collision layers, clear air beneath it, and more than 100 physics frames of simulation must fall; after ~7 seconds (tick 442 at 60 ticks/s) it cannot still be at the exact spawn coordinate with zero velocity and `sleeping=true`.**

Two groups of observations conflict:

1. The setup is physically valid and unobstructed:
   - `/root/Main/Crate` is a `RigidBody3D` with `collision_layer: 1` and `collision_mask: 1`.
   - Its child `CollisionShape3D` is enabled (`disabled: false`) with a `BoxShape3D` of size `[0.699999988079071, 0.699999988079071, 0.699999988079071]`.
   - `/root/Main/Ground` is a `StaticBody3D` with layer 1 / mask 1 and a `BoxShape3D` of size `[24, 0.5, 24]` at global `y = -0.25`, so its top surface is `y = 0` and a crate resting on it would be centered at `y ≈ 0.35`.
   - The physics query at the spawn point `(4.2, 3.00, 2.5)` returns only `/root/Main/Crate` with `shape_index: 0`; the query at the resting height `(4.2, 0.35, 2.5)` returns only `/root/Main/Ground`. There is a 2.65 m air gap below the crate and nothing supporting it.

2. The state says it never simulated at all:
   - World `y` is exactly `3.0` (bit-identical to the spawn value) at `tick: 118` and still at `tick: 442`.
   - `crate_linear_velocity` is exactly `[0, 0, 0]`.
   - `crate_sleeping` is `true` and `ground_collision` is `false`.

Free fall over 2.65 m takes about 0.74 s (~44 ticks at 60 Hz), so by tick 442 the crate should have hit the ground, reported contact, and be resting at `y ≈ 0.35`. Instead it is still at its spawn transform. A rigid body cannot legitimately enter a sleep state while suspended in empty space at its spawn coordinate; `sleeping=true` here means it was inactive from the start (or was put to sleep without ever moving).

## Hypotheses ruled out

- **Missing or disabled collider.** The crate has an enabled `CollisionShape3D` (`disabled: false`) with a `BoxShape3D`, and the spawn query reports the crate's `shape_index: 0`.
- **Layer/mask filtering.** Crate and ground both use `collision_layer: 1` and `collision_mask: 1`, so a contact would be detected if the crate reached the ground.
- **Missing, undersized, or mispositioned ground.** The ground box is `[24, 0.5, 24]` centered at `y = -0.25`, giving a top surface at `y = 0`, and the resting-height query at `y = 0.35` hits `/root/Main/Ground`.
- **Not enough simulation time.** `state.json` records `physics_frames: 117`; the summary snapshot is at `tick: 442` (~7.4 s at 60 Hz), far beyond the ~44 ticks needed. Additionally the crate's `y` is unchanged to the bit and its velocity is exactly zero, which excludes a partial fall.
- **The crate is static or kinematic.** Its class is explicitly `RigidBody3D`.
- **Crate supported or blocked by another body.** The spawn query returns only the crate; there is no collider between the crate and the ground, and the screenshot shows empty space beneath it.
- **Telemetry or test-read error.** The node transform, the two runtime snapshots, the HUD (`CRATE: 3.00 m`), the screenshot, and the physics query all independently agree that the crate is at `y = 3.0` above the ground.
- **Global physics failure / frozen scene.** The player collides with the ground at tick 22 (`player_collision_start`), and `observation-plate-opens-gate`, `observation-gate-passable-after-plate`, and `observation-closed-gate-blocks` all pass with simulated plate, gate, and movement behavior.
- **`ground_collision=false` as the root cause.** It is consistent with never touching the ground, and even if contact reporting were misconfigured it could not explain the unmoved `y` or the zero velocity.

## Proposed correction

The crate is being created/reset in an inactive physics state. The smallest change is to wake it after it is placed at its spawn transform:

- Ensure `freeze = false` (remove the assignment that freezes it, if present).
- Ensure `sleeping = false` after setting the spawn position and zeroing velocities, so the position assignment does not leave it asleep.
- Do not disable `custom_integrator` handling incorrectly and do not zero `gravity_scale`; the body must use normal gravity.

Concretely: after the reset/spawn code assigns the crate's position `(4.2, 3.0, 2.5)` and clears its velocities, explicitly wake the body (clear `freeze`/`sleeping`). No change is needed to the ground, collision layers, shape dimensions, or physics tick rate, since the evidence shows all of those are consistent with the expected rest pose at `y ≈ 0.35`. With the body awake, it should fall for ~44 ticks, emit a ground contact, and settle at `y ≈ 0.35`.

## Confidence

**High (~0.85)** that the root cause is that the crate's rigid body is inactive (frozen/asleep) from spawn, because the position is bit-exactly the spawn value, velocity is exactly zero, and `sleeping` is already `true` while the body is unsupported.

Confidence is lower (~0.6) about the precise flag/mechanism, because `observation.json` exposes an empty `properties` object for `/root/Main/Crate`, so the evidence cannot distinguish `freeze=true`, an explicit `sleeping=true`, `gravity_scale=0`, and `custom_integrator=true`. Additional evidence that would raise confidence:

- A dump of the crate's `freeze`, `freeze_mode`, `sleeping`, `gravity_scale`, `custom_integrator`, `can_sleep`, `contact_monitor`, and `max_contacts_reported` values at tick 0.
- A per-frame trace of crate `y`, linear velocity, and sleep state for the first ~60 physics frames.
- The crate's script/scene property assignments at spawn and on reset (which property is written and in what order).
- Whether any other `RigidBody3D` in the same world falls normally, which would confirm the deactivation is body-specific rather than a project-wide gravity setting.
- After the wake fix, whether `ground_collision` becomes `true`; if `y` falls but contact remains `false`, the crate also needs `contact_monitor`/`max_contacts_reported` enabled.
