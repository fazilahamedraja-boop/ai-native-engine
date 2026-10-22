# Phase 15 diagnosis

## Failure

The acceptance case **`observation-crate-falls`** fails:

```
FAIL observation-crate-falls crate_y=3.000 ground_collision=false sleeping=true
```

This is the only failure: `RESULT passed=7 failed=1`, `exit_code: 1`. The other seven cases pass, including `observation-reset`, which reports the same initial crate state (`crate_y=3.000`).

The crate is a `RigidBody3D` at `[4.19999980926514, 3.0, 2.5]`, and it is still exactly there at the end of the scenario. The trace snapshot for the `closed_gate_blocks` run records `crate_position: [4.19999980926514, 3.0, 2.5]`, `crate_linear_velocity: [0.0, 0.0, 0.0]`, and `crate_sleeping: true` at step 155 / tick 442, while the scenario itself is only at step 93 / 117 physics frames. The HUD in `before.png` confirms `CRATE: 3.00 m`, and the screenshot shows the orange crate suspended in mid-air above the floor beside the gate.

## Contradiction

**Falsifiable claim:** the crate is a dynamic `RigidBody3D` under normal gravity, so by the time the scenario is sampled it must have fallen from its spawn height of 3.0 m to rest on the ground at about y = 0.35 m (half of its 0.7 m box) and produced a ground collision.

**Two observations conflict:**

1. Everything needed for it to fall is present: the crate is class `RigidBody3D`, its `CollisionShape3D` is `disabled: false` with a 0.7 m `BoxShape3D`, gravity should apply, and `physics-queries.json` `crate_resting_height` finds `/root/Main/Ground` directly beneath it at (4.2, 0.35, 2.5).
2. Yet its measured position never changes from `[4.2, 3.0, 2.5]`, its linear velocity is exactly `[0.0, 0.0, 0.0]`, its height is still `3.000`, and it reports `sleeping=true`. `crate_spawn_height` finds the crate at (4.2, 3.00, 2.5), so it has not moved away from the spawn point.

A body that is awake and subject to gravity cannot remain at exactly its spawn position with exactly zero velocity for 117+ physics frames at 60 ticks/s. The observations are only consistent if the crate never simulated as a dynamic body at all, e.g. it is frozen or starts asleep.

## Hypotheses ruled out

- **No ground, or ground too low/misplaced.** `/root/Main/Ground` is a `StaticBody3D` with a `BoxShape3D` of size `[24, 0.5, 24]` whose global origin is `y = -0.25`, giving a top surface at `y = 0`. The `crate_resting_height` query at (4.2, 0.35, 2.5) returns `/root/Main/Ground`, so a floor exists directly below the crate.
- **Crate and ground on incompatible collision layers/masks.** The crate has `collision_layer: 1, collision_mask: 1`; the ground has the same. Filtering would not prevent the contact.
- **Missing or disabled crate collider.** The crate's `CollisionShape3D` has `disabled: false` and a `BoxShape3D` of size `[0.7, 0.7, 0.7]`.
- **Crate actually fell but the telemetry is stale or refers to another crate.** The physics query at the spawn height (4.2, 3.00, 2.5) returns `/root/Main/Crate`, while the query at the resting height (4.2, 0.35, 2.5) returns only `/root/Main/Ground`. The crate therefore really is still at 3.0 m, matching the measured transform.
- **The crate is static/animated rather than physical.** The observed node class is `RigidBody3D`, not `StaticBody3D` or `AnimatableBody3D`.
- **`sleeping=true` is normal because the crate settled.** Sleeping is expected only after a body has come to rest on support. Here the crate has zero displacement and zero velocity from spawn, with `ground_collision=false`; there is no settling trajectory and no contact, so this is an initial asleep/frozen state, not post-rest sleep.
- **The crate is resting on an invisible ledge at y = 3.** The `crate_spawn_height` query at that exact box returns only `/root/Main/Crate`; no other collider supports it, and the screenshot shows open air below it.

## Proposed correction

Make the crate start as an awake, non-frozen dynamic body in its `RigidBody3D` setup: clear the initial sleep state (`sleeping = false`) and make sure it is not frozen (`freeze = false`, or `freeze_mode` not left at a static/frozen mode), and confirm `gravity_scale = 1`. If the body is deliberately frozen at spawn for reset reasons, unfreeze it when the `reset` event is emitted. This is the smallest change; it leaves the ground, layers, collider, spawn position, and all passing gate/plate/goal behaviour untouched.

With gravity restored, the crate should fall from `y = 3.0` to rest at about `y = 0.35` and the test's `ground_collision` flag should become true.

## Confidence

High (roughly 0.9) that the crate is being kept asleep/frozen at its spawn transform rather than failing to fall because of geometry, collision layers, or a missing collider: the position, velocity, and query results all agree, and the crate is the correct node class with a valid collider and a floor beneath it. Moderate (roughly 0.6) about which specific property causes it (`freeze`, `sleeping`, `can_sleep`, or `gravity_scale`), since the source is not available.

Extra evidence that would raise confidence: a property dump of `/root/Main/Crate` including `freeze`, `freeze_mode`, `gravity_scale`, `can_sleep`, `sleeping`, `mass`, and `linear_velocity`; a per-tick record of `crate_y` from tick 0 (to show it never leaves 3.0); and the crate's instantiation/reset code showing whether the frozen or sleeping state is set explicitly.
