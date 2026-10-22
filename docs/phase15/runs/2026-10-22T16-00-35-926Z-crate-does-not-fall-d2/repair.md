# Phase 15 repair

## Change

In `project/scripts/observation_world.gd`, in `_build_crate()`, one value was changed:

```diff
-	crate.gravity_scale = 0.0
+	crate.gravity_scale = 1.0
```

No other file or line was modified. `project/tests/run_observation.gd` and
everything under `project/scenes/` (there is no `scenes/` directory) are
byte-identical to the supplied copy.

## Why this is the defect

The crate is a `RigidBody3D` with a valid 0.7 m `BoxShape3D` collider on
`collision_layer: 1` / `collision_mask: 1`, spawned at `(4.2, 3.0, 2.5)` above
a Ground whose top surface is y = 0.0. Under normal gravity it must fall 2.65 m
to rest at y = 0.35. Instead the trace records y = 3.000, zero linear velocity,
and `crate_sleeping = true` after 117 physics frames, and the physics queries
find the crate at spawn height but not at resting height.

`gravity_scale = 0.0` disables gravity for that body. With no gravity and zero
initial velocity the body never accelerates, so the physics server correctly
reports it as `sleeping` at its spawn transform. This is exactly the
"excluded from gravity/integration" condition identified in `diagnosis.md`;
the observable symptom (`sleeping = true` at an unsupported height) is a
consequence, not the cause. The reset path already clears `crate.sleeping`
(line 143), so re-enabling gravity is sufficient; no freeze flag, sleep override,
spawn change, geometry change, or collision-mask change is needed.

## Why it is the smallest correct correction

The defect is a single mis-set scalar. Restoring Godot's default value (`1.0`)
changes only whether gravity acts on the crate, leaving mass, damping, sleep
behaviour, `contact_monitor`, geometry, spawn position, ground, and collision
masks untouched. Deleting the line would also work but is a larger edit than
correcting the value. No other source location controls crate gravity (the only
other `sleeping` write is the reset path, which already clears sleep), so this
one token addresses the entire failure.

## Expected acceptance behaviour

With gravity re-enabled, free fall of 2.65 m takes about 0.74 s (~44 ticks at
60 Hz), well inside `CRATE_SETTLE_FRAMES = 90`. The crate reaches y ≈ 0.35,
generates a `crate_collision_start` for `/root/Main/Ground` through its enabled
contact monitor, and then legitimately sleeps. `observation-crate-falls` should
therefore see `crate_y < 0.6` and `crate_ground_collision = true`.
`observation-reset` remains valid: after only 3 ticks the crate has fallen a
few millimetres (y ≈ 2.99), still above its required 2.8 threshold.
