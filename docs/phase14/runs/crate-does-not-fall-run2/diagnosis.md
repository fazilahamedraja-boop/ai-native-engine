# Phase 14 blind diagnosis

Fixture: `C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-CB8URR\project`
Case under investigation: `observation-crate-falls` (acceptance suite, oracle
`res://tests/run_observation.gd`, unmodified).

Sources used for this diagnosis (evidence only — the fixture source was not read
before this file was written):

- `evidence/test-output.txt`
- `evidence/observation.json`
- `evidence/physics-queries.json`
- `evidence/state.json`
- `evidence/before.png`

## Failure

The acceptance suite reports 7 passing cases and one failure:

```
FAIL observation-crate-falls crate_y=3.000 ground_collision=false sleeping=true
RESULT passed=7 failed=1
```

The failing case names three facts about the crate body at the end of the run:

| field            | observed value | expected for "the crate falls" |
|------------------|----------------|--------------------------------|
| `crate_y`        | `3.000`        | a value strictly below the 3.000 spawn height |
| `ground_collision` | `false`      | `true` (crate resting on the ground) |
| `sleeping`       | `true`         | a body that is still simulating / has settled with a ground contact |

The rest of the suite is healthy: `observation-initial-state`,
`observation-plate-opens-gate`, `observation-gate-passable-after-plate`,
`observation-closed-gate-blocks`, `observation-event-stream`,
`observation-reset` and `observation-humanoid-probe` all pass, so the world
loads, the player character is simulated and grounded
(`grounded=true position=[0.0, 0.85000002384186, 5.5]`), the plate/gate logic
works, and the event stream is ordered (`count=4 ordered=true fields_ok=true`).
Only the crate is wrong.

The same crate state appears everywhere else in the evidence:

- `evidence/observation.json` — `/root/Main/Crate` is a `RigidBody3D` with
  `global_transform.origin = [4.19999980926514, 3, 2.5]`, i.e. exactly the
  spawn height, and the run trace records
  `"crate_position":[4.19999980926514,3.0,2.5]`,
  `"crate_linear_velocity":[0.0,0.0,0.0]`, `"crate_sleeping":true`.
- `evidence/state.json` — the snapshot taken at `step=93 / physics_frames=113`
  is consistent with a world that is otherwise running normally
  (`plate_pressed=false`, `gate_open=false`, `beacon_state=red`,
  `player_position=[0, 0.850000023841858, 5.5]`).
- `evidence/test-output.txt` — the `closed_gate_blocks` trace, captured much
  later (`STEP: 155 TICK: 442`), still shows
  `"crate_position":[4.19999980926514,3.0,2.5]`,
  `"crate_linear_velocity":[0.0,0.0,0.0]`, `"crate_sleeping":true`.
- `evidence/before.png` — the orange crate is visibly **suspended in mid-air**
  beside the right-hand wall, well above the sand, with its shadow cast on the
  ground below it, while the blue player capsule stands on the ground.
- `evidence/physics-queries.json` — a box probe at the spawn height
  `(4.2, 3.00, 2.5)` still returns `/root/Main/Crate`
  (`collider_type: RigidBody3D`), and a box probe at the height where the crate
  would rest if it had fallen `(4.2, 0.35, 2.5)` returns **only**
  `/root/Main/Ground` — no crate collider anywhere near the floor.

## Contradiction

**Falsifiable claim:** the crate is a fully-formed, registered rigid body that
is nevertheless *never integrated under gravity*; it is not "falled through the
world" and not "uncollidable" — its rigid-body simulation is suppressed.

The conflict is between two observations that cannot both be true of a
gravity-driven rigid body:

1. **The crate is still at its spawn transform.** `crate_y=3.000` is
   *exactly* the spawn height (not 2.99, not 0.35) after 113+ physics frames
   (and still after 442 engine ticks), with `crate_linear_velocity` exactly
   `[0.0, 0.0, 0.0]`, and the physics-space probe at `(4.2, 3.00, 2.5)` still
   finds the crate collider there.
2. **The crate is a `RigidBody3D` in a world where gravity acts on bodies.**
   `/root/Main/Crate` is class `RigidBody3D` with an **enabled** `CollisionShape3D`
   (`BoxShape3D`, size `0.699999988079071` per axis, `disabled: false`,
   `collision_layer: 1`, `collision_mask: 1`), and the ground it must land on is
   a `StaticBody3D` with a `24 × 0.5 × 24` box whose top face is exactly
   `y = 0` (box centred at local `y = -0.25`). The crate at `x = 4.2, z = 2.5`
   is well inside the ground's ±12 footprint.

A rigid body with gravity enabled acquires downward velocity on the first
physics frame and would have cleared `y = 3.000` within ~0.1 s; it could never
be *exactly* back at `3.000` with an exactly-zero velocity vector after 113+
frames. The only consistent reading is that gravity/integration is switched
off for this one body (e.g. the body is frozen, explicitly put to sleep, or
has its gravity scale / integrator neutralised), which also explains
`crate_sleeping=true` and `ground_collision=false` (it never touched the
floor, and `ground_collision` is reported from the crate's floor contact).

**Falsifiable prediction of the diagnosis:** if the crate's rigid-body
simulation is restored, then within ≈30 physics ticks its `crate_y` must drop
below `3.000` with a non-zero downward velocity, and within ≈1 s it must come
to rest at `y ≈ 0.35` (half of the 0.7 crate cube resting on a floor whose top
face is `y = 0`) with `ground_collision=true`. That resting height is exactly
the height the probe at `(4.2, 0.35, 2.5)` used, and that probe currently
returns only `Ground` — so the prediction is checkable with the same physics
query after the fix.

## Hypotheses ruled out

1. **The crate has no collider / is not in the physics space.** Excluded:
   `observation.json` lists `/root/Main/Crate` with one enabled
   `CollisionShape3D` (`BoxShape3D` 0.7³) and `collision_layer: 1`,
   `collision_mask: 1`, and the spawn-height physics probe returns the crate
   as a `RigidBody3D` collider.
2. **The crate fell through the floor (missing ground / tunnelling).** Excluded:
   the crate's `y` is `3.000`, never below its spawn height, and the resting
   probe at `(4.2, 0.35, 2.5)` returns the `Ground` collider — the floor
   surface exists and is solid exactly where the crate should land.
3. **The ground is on top of the crate / the crate spawned inside geometry.**
   Excluded: the ground box is centred at `y = -0.25` with 0.5 thickness, so
   its top face is `y = 0`; the crate's spawn centre `y = 3.0` sits 3 m above
   it, and its `x/z` are inside the ground's ±12 extent.
4. **The crate's contacts are simply not reported** (e.g. `contact_monitor` off
   or `max_contacts_reported = 0`). This would explain `ground_collision=false`
   but *not* the crate still being at `y = 3.000` with zero velocity, and not the
   empty probe at the resting height. Excluded as the sole cause.
5. **The crate is a dynamic body with zero/infinite mass, so gravity cannot
   move it.** Excluded: gravity accelerates bodies independently of mass, so
   mass alone cannot keep a body at `3.000` with `linear_velocity = 0`.
6. **The observation was taken at a bad moment / the crate was reset.**
   Excluded: the acceptance run's own trace at `STEP: 155 / TICK: 442` still
   shows `crate_position [4.2, 3.0, 2.5]`, `crate_linear_velocity [0,0,0]`,
   `crate_sleeping true`, i.e. the crate is stuck in the *test* run too, not
   only in the observation snapshot.
7. **The world/scene failed to load or the harness crashed.** Excluded: seven
   other cases pass, the humanoid probe reports
   `mesh_count=22 bones=["root","spine","chest","head"]`, the event stream is
   ordered, and the player is grounded on the floor.
8. **Global zero gravity in the project settings.** Not fully excluded by these
   artifacts alone (the player is a `CharacterBody3D` and may apply its own
   gravity), but it cannot be the *smallest* correction: the task states the
   only file that differs from the pristine fixture is
   `scripts/observation_world.gd`, and the defect is scoped to the crate
   body. Ranking: the per-body suppression (freeze / sleep / gravity-scale /
   custom-integrator) is far more likely, and reading the source after this
   diagnosis will confirm it.

## Proposed correction

Restore the crate's default rigid-body dynamics by removing the **single
line** in `scripts/observation_world.gd` that suppresses the crate's rigid-body
simulation, and change nothing else.

Expected shape of the offending line (one of these, to be confirmed by reading
the source after this diagnosis is written):

```gdscript
crate.freeze = true            # or freeze_mode = RigidBody3D.FREEZE_MODE_STATIC
crate.sleeping = true          # body parked in the physics server, never woken
crate.gravity_scale = 0.0      # gravity neutralised for this body
crate.custom_integrator = true # script-driven integration, but no gravity applied
```

The correction is: **delete that line** (or set the offending property back to
its Godot default — `freeze = false`, `sleeping = false`, `gravity_scale = 1.0`,
`custom_integrator = false`) and leave every other behaviour in the fixture
untouched. No new gameplay mechanics, no test changes, no hard-coded expected
values: the crate must fall because gravity acts on it, and the acceptance test
must observe the fall on its own.

Why this is the smallest correct correction:

- The evidence localises the fault to exactly one body's simulation flag; every
  other subsystem in the fixture passes its cases.
- Restoring one property re-enables the built-in Godot behaviour the fixture is
  supposed to demonstrate (a crate that falls onto the ground and reports a
  ground contact), which is what the `observation-crate-falls` case measures.
- Removing the flag also removes the derived symptoms (`sleeping=true`,
  `ground_collision=false`) without touching the plate/gate/player/event code.

## Confidence

**High (~0.8) for the defect class** — "the crate's rigid-body simulation is
suppressed, so gravity never moves it" — supported independently by four
artifacts that agree: the failing assertion values
(`crate_y=3.000 ground_collision=false sleeping=true`), the measured transform
and zero velocity in `observation.json`, the two physics probes (crate still at
spawn height, nothing at the resting height), and the screenshot showing the
crate hanging in mid-air with the player on the ground.

**Medium on the exact mechanism** — `freeze` vs. `sleeping` vs.
`gravity_scale = 0` vs. `custom_integrator` all reproduce the same evidence;
the source will disambiguate this immediately after this diagnosis is saved.

**Residual risk / what would raise confidence to ~1.0:** re-running the exact
acceptance command must produce `RESULT passed=8 failed=0` with exit code 0,
and the crate probe at `(4.2, 0.35, 2.5)` must then return the crate collider
alongside `Ground`. If instead the crate falls but stops short of the floor, or
overshoots below `0.35`, the correction would be incomplete (e.g. a second
factor such as a wrong spawn height or a `freeze_mode`/`mass` companion
setting) and the diagnosis must be revisited.
