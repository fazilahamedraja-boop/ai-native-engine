# Phase 15 repair

## Exact change

File: `project/scripts/observation_world.gd`, in `_build_crate()`.

Removed this single line:

```gdscript
crate.gravity_scale = 0.0
```

The surrounding code is otherwise unchanged:

```gdscript
crate = RigidBody3D.new()
crate.name = "Crate"
crate.position = CRATE_SPAWN
crate.mass = 1.0
crate.linear_damp = 0.15
crate.angular_damp = 0.15
crate.can_sleep = true
crate.contact_monitor = true
crate.max_contacts_reported = 8
```

No files under `project/tests/` and nothing under `project/scenes/` were
modified.

## Root cause

`RigidBody3D.gravity_scale` defaults to `1.0`. Assigning `0.0` to it removes
gravity from the crate entirely, so the body receives no force at any physics
tick. This is exactly consistent with the recorded evidence:

- the crate world `y` stays bit-identically at the spawn value `3.0` across
  ticks 118 and 442;
- `crate_linear_velocity` is exactly `[0, 0, 0]`;
- `crate_sleeping` is `true` because a body with no applied force can settle
  into the sleep state immediately;
- `ground_collision` is `false` because the crate never moves toward the ground.

The diagnosis listed `gravity_scale = 0.0` among the candidate mechanisms that
the available evidence could not distinguish, and explicitly required that the
body "must use normal gravity" and that `gravity_scale` must not be zeroed. The
source confirms that this is the actual mechanism. The other part of the
diagnosis's proposed correction—waking the body after respawn—is already
present in `reset_game()`:

```gdscript
crate.global_position = CRATE_SPAWN
crate.linear_velocity = Vector3.ZERO
crate.angular_velocity = Vector3.ZERO
crate.sleeping = false
```

So no additional wake logic is needed; only the zero gravity scale was wrong.

## Why this is the smallest correct correction

- It removes exactly one defective assignment. The crate then uses the engine
  default `gravity_scale = 1.0`, i.e. normal gravity, which the diagnosis
  requires.
- It does not alter the ground, crate collider, collision layers/masks, mass,
  damping, contact monitoring, spawn height, or physics tick rate—all of which
  the diagnosis verified were correct.
- No new code, flags, or workarounds are introduced. Every other property of
  the rigid body was already configured correctly for falling and contact
  reporting (`contact_monitor = true`, `max_contacts_reported = 8`).

## Expected effect on the acceptance suite

`tests/run_observation.gd` resets the world, advances 3 frames, then advances
`CRATE_SETTLE_FRAMES = 90` frames and requires:

```gdscript
var ok: bool = y < 0.6 and crate_ground_collision
```

With gravity restored, the crate free-falls the 2.65 m gap from `y = 3.0` to the
ground top at `y = 0` (resting center `y ≈ 0.35`) in roughly 44 ticks at 60 Hz,
well within 90 frames. `crate_collision_start` is emitted for `/root/Main/Ground`
through the already-connected `body_entered` signal, so both `y < 0.6` and
`crate_ground_collision` are satisfied. The reset case's `crate_y > 2.8` check
after only 3 frames also remains satisfied (the crate falls about 0.012 m in
that time).
