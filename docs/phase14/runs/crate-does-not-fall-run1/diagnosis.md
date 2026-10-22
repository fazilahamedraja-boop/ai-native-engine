# Phase 14 blind diagnosis

Fixture: `C:\Users\hacke\AppData\Local\Temp\phase14-blind-observation-hIfmfE\project`
Evidence only: `evidence/test-output.txt`, `evidence/observation.json`,
`evidence/physics-queries.json`, `evidence/state.json`, `evidence/before.png`.
No file under the fixture directory has been opened while writing this.

## Failure

The acceptance run reports `RESULT passed=7 failed=1`. The single failing case is
the last one:

```
FAIL observation-crate-falls crate_y=3.000 ground_collision=false sleeping=true
```

The structured snapshot for that case carries the same numbers:

```
"crate_linear_velocity":[0.0,0.0,0.0],
"crate_position":[4.19999980926514,3.0,2.5],
"crate_sleeping":true
```

and the HUD in `before.png` reads `BEACON: RED  CRATE: 3.00 m`.

The crate is a `RigidBody3D` at `/root/Main/Crate`:

- class `RigidBody3D`, global origin `[4.19999980926514, 3, 2.5]`
- `collision_layer = 1`, `collision_mask = 1`
- one `CollisionShape3D` named `Collision`, `disabled = false`, `BoxShape3D`
  size `[0.699999988079071, 0.699999988079071, 0.699999988079071]`

The ground it should land on is `/root/Main/Ground`:

- class `StaticBody3D`, `collision_layer = 1`, `collision_mask = 1`
- `BoxShape3D` size `[24, 0.5, 24]` at local origin `[0, -0.25, 0]`, i.e. the top
  face is at `y = 0`.

A 0.7 m box dropped from `y = 3.0` must come to rest with its centre at
`y = 0.35`. `evidence/physics-queries.json` confirms that is where it would
land, and that it did not:

- `crate_spawn_height` - box at `(4.2, 3.00, 2.5)` -> results: **`/root/Main/Crate`**
  (RigidBody3D) - the crate is still parked at the spawn height and is a live,
  queryable collider there.
- `crate_resting_height` - box at `(4.2, 0.35, 2.5)` -> results: **`/root/Main/Ground`**
  only - nothing but the ground occupies the resting height.

So after 114+ physics frames the crate has not moved a single millimetre
(`crate_y = 3.000`, identical to the spawn height), has exactly zero linear
velocity, is flagged `sleeping = true`, and has never produced a ground
contact.

Everything else in the scene works. The other seven cases pass, including the
player falling and colliding with the very same ground body:

```
"player_collision_start","collider":"/root/Main/Ground","normal":[0,1,0]
```

`state.json` shows `step = 93`, `physics_frames = 114`, and the player resting
at `y = 0.850000023841858` with `grounded = true`; the event stream ticks
advance (`reset` at tick 16, `player_collision_start` at tick 19, `tick_domain:
engine_physics_frames`).

## Contradiction

**Falsifiable claim:** the crate's rigid-body *dynamic simulation* is disabled
by its own configuration, so it never integrates the world's gravity. The
problem is inside the crate's body setup, not in the world, the ground, the
collision shapes, the layers/masks, or the physics step loop.

**The two conflicting observations:**

1. `evidence/physics-queries.json` / `crate_spawn_height`: the crate **is**
   registered in the physics space as a collider at `(4.2, 3.00, 2.5)`, with an
   enabled `BoxShape3D` and `collision_layer = 1`, `collision_mask = 1` that
   matches the ground's layer and mask.
2. `evidence/test-output.txt` (FAIL line and the trace snapshot): the crate
   reports `sleeping = true`, `crate_linear_velocity = [0,0,0]`, and
   `crate_y = 3.000` after more than a hundred physics frames, with
   `ground_collision = false`.

These cannot both hold for an ordinary dynamic body. A `RigidBody3D` that is
live in the space, sits 3 m above a collider that the very same scene proves is
collidable (the player capsule collides with `/root/Main/Ground`), and has
`collision_layer == collision_mask == 1`, must gain downward velocity from
gravity within a single physics frame: gravity is applied by the physics
server to every active rigid body every step. A body that reports
`sleeping = true` with *exactly* zero linear velocity while a sibling body in
the same scene is being integrated by gravity has been put into a
non-simulating state - the engine is treating it as a static/asleep object
rather than a falling one.

`sleeping = true` + zero velocity + no motion is the signature of a body whose
simulation was switched off at configuration time (frozen / forced to sleep /
gravity disabled on that body), as opposed to a body that fell and settled
(which would end at `y = 0.35`, with a ground contact, and could only reach
`sleeping = true` *after* it had arrived).

The strongest confirmation that the crate is *not* merely mis-placed or
mis-sized: it is exactly at its authored spawn height, its collider is enabled
and queryable there, its layer/mask match the ground's, and no other collider
exists anywhere near the spawn point to hold it up.

## Hypotheses ruled out

1. **The ground is missing, disabled, or on another layer.**
   Excluded by `evidence/physics-queries.json` (`crate_resting_height` returns
   `/root/Main/Ground` as a collider at the landing height) and by the player's
   `player_collision_start` event whose `collider` is `/root/Main/Ground` with
   `normal [0,1,0]`. The ground collides.
2. **The crate has no collider, or its shape is disabled.**
   Excluded by `observation.json` (`CollisionShape3D`, `disabled = false`,
   `BoxShape3D` 0.7 m) and by the `crate_spawn_height` query, which returns the
   crate itself as a collider. Also, a missing shape cannot explain the crate
   staying at `y = 3.000`: without contact the body would still fall.
3. **The crate cannot reach the ground because of a layer/mask mismatch.**
   Excluded by measurement: crate `collision_layer = 1`, `collision_mask = 1`;
   ground `collision_layer = 1`, `collision_mask = 1`. They can see each other.
4. **The physics world is not stepping / the scene is frozen.**
   Excluded by `state.json` (`step = 93`, `physics_frames = 114`), by the
   advancing event ticks in `observation.json` (16 -> 19, `engine_physics_frames`
   domain), and by the player having settled onto the ground at
   `y = 0.850000023841858` with `grounded = true` - a moving world.
5. **The crate is blocked or wedged by some other body at the spawn height.**
   Excluded by the `crate_spawn_height` query, whose only result is the crate
   itself. Nothing else is in the space at that point to support it; and a
   support would leave a contact, not `ground_collision = false` with zero
   velocity and `sleeping = true`.
6. **The crate fell and was put back / teleported to the spawn point.**
   Excluded by the motion signature: a body that is teleported every frame is
   awake (`sleeping = false`) and its observed state is `sleeping = true` with
   exactly `[0,0,0]` velocity at exactly the spawn height for the whole run
   (tick 115 in `observation.json`, tick 442 in the trace snapshot). Nothing
   ever moved.
7. **The crate's mass/size is wrong so gravity is negligible.**
   Excluded by magnitude: even a 10^6 kg body under `9.8 m/s^2` falls metres in
   114 frames of simulation; the observed displacement is exactly `0.0`.
8. **The test oracle is wrong / the expectation is unreasonable.**
   Excluded: the expectation ("the crate falls") matches the fixture's own
   HUD contract (`CRATE: 3.00 m` is a *height readout* that is supposed to
   change as the crate falls) and the physics query file's own `crate_resting_height`
   probe (0.35 m) encodes the intended landing height. The oracle is not to be
   touched.

## Proposed correction

**Smallest intended change: one line in `scripts/observation_world.gd`** that
re-enables the crate's gravity-driven rigid-body simulation - i.e. remove or
invert whatever single configuration line puts `/root/Main/Crate` into a
non-simulating state (a frozen/`sleeping` rigid body, or a body whose gravity
scale was zeroed), so that the crate integrates gravity, travels from
`y = 3.00` to its resting `y = 0.35`, and registers a contact with
`/root/Main/Ground`.

Expected runtime change after the fix:

- `observation-crate-falls` reports `crate_y` ≈ `0.35` (was `3.000`),
  `ground_collision=true` (was `false`), and the crate is no longer stuck at
  the spawn height.
- The HUD line `CRATE: 3.00 m` becomes `CRATE: 0.35 m`.
- `crate_spawn_height` query would no longer return `/root/Main/Crate`, while
  `crate_resting_height` would return both `Ground` and `Crate`.
- The seven previously passing cases must keep passing
  (`RESULT passed=8 failed=0`).

Nothing else is touched: no test is weakened or deleted, no new gameplay
mechanics are added, no expected value is hard-coded, and the oracle
`res://tests/run_observation.gd` stays byte-identical.

## Confidence

**Medium-high on the defect class, and the contradiction above is solid
(falsifiable and directly measured); the exact one-line site is to be confirmed
against the fixture source, which was deliberately not opened before this
document.**

What raises confidence:

- the exact source line that disables the crate's simulation (read after this
  diagnosis is written);
- the re-run acceptance output showing `RESULT passed=8 failed=0` with
  `crate_y` ≈ `0.35` and `ground_collision=true`;
- a post-fix physics query showing the crate at the resting height and absent
  from the spawn height, and the HUD showing `CRATE: 0.35 m`.

What would lower it (and what I would then re-check):

- if the crate still did not move after the change, the "body disabled" class
  would be wrong and the next suspect would be a per-frame transform override
  in the script's `_physics_process`/`_process` that re-pins the crate to its
  spawn position (excluded here only by inference from `sleeping = true` plus
  zero velocity);
- if `crate_y` moved but `ground_collision` stayed `false`, the defect would be
  in the contact-reporting path (contact monitor / `max_contacts_reported`)
  rather than in the simulation itself.
