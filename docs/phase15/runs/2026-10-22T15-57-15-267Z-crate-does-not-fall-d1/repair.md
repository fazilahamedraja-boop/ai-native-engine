# Phase 15 repair

## Defect

In `project/scripts/observation_world.gd`, `_build_crate()` disabled gravity on the
crate:

```gdscript
crate.gravity_scale = 0.0
```

This is the mechanism the diagnosis identified (the "gravity has been disabled"
case). With `gravity_scale = 0.0`, the crate is a valid dynamic `RigidBody3D`
with a correct 0.7 m box collider, layer/mask 1, and empty space beneath it, but
it never accelerates downward. It therefore stays at its spawn position
`[4.2, 3.0, 2.5]` with zero velocity, never touches Ground, and reports
`sleeping=true` — exactly the observed failure
(`crate_y=3.000 ground_collision=false sleeping=true`).

## Change

A single value change:

```diff
 	crate.mass = 1.0
-	crate.gravity_scale = 0.0
+	crate.gravity_scale = 1.0
```

`1.0` is the `RigidBody3D` default gravity scale, restoring normal gravity for
this body only.

## Why this is the smallest correct correction

- The defect is a single wrong property value on the single defective body; no
  scene restructuring, collision-shape change, layer/mask change, or reset logic
  change is needed.
- `reset_game()` already clears the crate's linear/angular velocity and sets
  `sleeping = false`, so restoring gravity is sufficient for the crate to begin
  falling from tick 0 after every reset.
- Nothing else in the project sets `gravity_scale` or overrides physics gravity.
  The player's custom gravity (`observation_player.gd`) and the scene's physics
  tick rate (60) are unrelated and already verified by the other seven passing
  cases.
- No files under `project/tests/` were touched; no `project/scenes/` directory
  exists in this fixture (the world is built from `main.tscn` +
  `observation_world.gd`).

## Expected result

After the change, the crate falls 2.65 m from centre y=3.0 to the ground-contact
centre y=0.35 in roughly 44 ticks (well within `CRATE_SETTLE_FRAMES = 90`),
emitting `crate_collision_start` for `/root/Main/Ground`. This makes
`observation-crate-falls` pass (`crate_y < 0.6` and ground collision seen) while
preserving the other acceptance cases, including `observation-reset`, which only
requires the crate to still be near spawn (`y > 2.8`) three frames after reset.
