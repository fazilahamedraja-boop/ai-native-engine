# Phase 15 repair

## Change

In `project/scripts/observation_world.gd`, inside `_build_crate()`:

```diff
-	crate.gravity_scale = 0.0
+	crate.gravity_scale = 1.0
```

That is the only edit made. No other file was touched; `project/tests/` and
`project/scenes/` were left byte-identical (there is no `scenes/` directory in
this project; the scene `main.tscn` was not modified).

## Why this is the defect

The crate is constructed as a dynamic `RigidBody3D` with:

- a valid, enabled `CollisionShape3D` (`BoxShape3D` 0.7 m),
- collision layer/mask 1/1 matching the `Ground` `StaticBody3D`,
- spawn position `CRATE_SPAWN = (4.2, 3.0, 2.5)`, with ground top surface at
  `y = 0` directly below it,
- `sleeping` cleared on every `reset_game()`/`harness_reset()`, and
- `contact_monitor = true` with `max_contacts_reported = 8` so
  `crate_collision_start` can be emitted.

The one property that prevents all of that from producing motion is
`gravity_scale = 0.0`. In Godot, `RigidBody3D.gravity_scale` is a multiplier on
the world gravity applied to that body; at `0.0` the crate receives no
gravitational acceleration at all. It therefore stays exactly at its spawn
transform with exactly zero linear/angular velocity, reports `sleeping = true`
(nothing ever woke or moved it), and never generates a contact with `/Ground`.
This matches every observation in `diagnosis.md`: position fixed at
`[4.2, 3.0, 2.5]`, velocity `[0, 0, 0]`, `crate_y = 3.000`, and
`ground_collision = false`, while the spawn-height physics query returns
`/root/Main/Crate` and the resting-height query returns only `/root/Main/Ground`.

The diagnosis's ruled-out hypotheses remain consistent with this: the ground,
collision layers, collider, node class, and spawn transform are all correct. The
suggested fix direction (restore a normal awake dynamic body under gravity) was
correct; the source shows the concrete cause is `gravity_scale`, not
`freeze`/`sleeping` (the reset path already sets `sleeping = false`, and no
freeze properties are set).

## Why it is the smallest correct correction

Changing only the single numeric literal `0.0` to `1.0` restores the default
gravity multiplier on the crate and nothing else:

- Spawn height, mass, damping, sleep settings, contact monitoring, collider,
  materials, and the crate's reset handling are unchanged.
- The ground, gate, plate, beacon, player, and humanoid paths are untouched, so
  the seven already-passing cases cannot be perturbed.
- It does not require any change to the acceptance script or the scene.

## Expected verification behaviour

With `gravity_scale = 1.0` and the project's 60 Hz physics tick rate:

- `observation-reset` still passes: after only 3 physics frames (~0.05 s) the
  crate has fallen about `0.5 * 9.8 * 0.05^2 ≈ 0.012 m`, so `crate_y ≈ 2.988`,
  which satisfies the test's `> 2.8` requirement.
- `observation-crate-falls` now passes: after 90 frames (~1.5 s) the crate has
  had ample time to fall 2.65 m from `y = 3.0` to rest at `y ≈ 0.35`
  (half its 0.7 m height), and `contact_monitor` will emit
  `crate_collision_start` for `/root/Main/Ground`, making the test's
  `ground_collision` flag true. The reported `crate_y` will be `< 0.6`.
