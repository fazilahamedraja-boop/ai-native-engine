# Phase 14 blind diagnosis

## Failure

The acceptance suite fails exactly one of eight cases.

- `evidence/test-output.txt` line 10: `FAIL observation-crate-falls crate_y=0.347 ground_collision=false sleeping=true`
- `evidence/test-output.txt` line 12: `RESULT passed=7 failed=1`

The seven other cases pass (`observation-initial-state`, `observation-plate-opens-gate`,
`observation-gate-passable-after-plate`, `observation-closed-gate-blocks`,
`observation-event-stream`, `observation-reset`, `observation-humanoid-probe`), so the
plate/gate/beacon/player/event logic is intact.

The failing case's own trace (`OBSERVATION_SUMMARY` → `trace.crate_falls`) reports:

```
crate_ground_collision : false
crate_position         : [4.20000743865967, 0.347223967313766, 2.50000476837158]
crate_linear_velocity  : [2.68e-06, -1.05e-05, -8.35e-06]
crate_sleeping         : true
physics_frames         : 629        step : 93
```

The crate *did* fall and *did* come to rest (`observation-reset` shows `crate_y=2.992` at
`step=0`, the failing case shows `crate_y=0.347`), and `crate_sleeping=true` with a
linear velocity of ~1e-5 means it is at rest **on a surface**, not in flight. The single
thing the case complains about is the boolean `crate_ground_collision=false`.

## Contradiction

The falsifiable claim is: **the crate is physically resting on `/root/Main/Ground`, so any
correctly implemented ground-contact probe must return `true`; the observed `false` means
the fixture's ground-contact *report* is broken, not the physics.**

Two observations conflict:

1. **The physics space says the crate and the ground are in contact at that exact spot.**
   `evidence/physics-queries.json` runs the query `crate_resting_height` — "box at the
   height where the crate rests on the ground (4.2, 0.35, 2.5), to find out whether the
   crate is physically touching the ground" — with `collision_mask: 1`, and it returns
   **two** overlapping bodies: `/root/Main/Ground` (`StaticBody3D`) and `/root/Main/Crate`
   (`RigidBody3D`).
2. **The fixture's own probe says it is not.** The same crate position
   `[4.2, 0.3472, 2.5]` is reported with `crate_ground_collision: false`.

The geometry is arithmetically airtight, from `evidence/observation.json`:

| quantity | value | source |
|---|---|---|
| Ground collision shape | `BoxShape3D` size `[24, 0.5, 24]`, global origin `[0, -0.25, 0]` | observation.json `/root/Main/Ground/Collision` |
| Ground **top face** | `y = -0.25 + 0.25 = 0.0` | derived |
| Crate collision shape | `BoxShape3D` size `[0.7, 0.7, 0.7]`, `disabled: false` | observation.json `/root/Main/Crate/Collision` |
| Expected resting centre `y` | `0.0 + 0.35 = 0.35` | derived |
| **Observed crate centre `y`** | **`0.347224`** | observation.json + trace |
| Crate bottom face `y` | `0.347224 - 0.35 = -0.0028` | derived |

The crate's bottom face is **2.8 mm below the ground's top face** (0.8 % of the box
height, i.e. inside Godot's default contact slop), so the two solids genuinely
interpenetrate at rest — a contact pair exists in the physics server. The crate is also
`sleeping`, which a free-falling body never is, and the mask=1 shape query at that point
returns the ground *and* the crate, confirming both are where the arithmetic says they are.

So: **contact exists in the physics space, but the fixture reports that it does not.**
The crate's collision layer/mask are `1`/`1` and the ground's are `1`/`1`
(observation.json), i.e. the crate is *enabled* to collide with the ground and demonstrably
does (it stopped at the exact resting height instead of falling through). The fault is
therefore in how `scripts/observation_world.gd` **reports** that contact — the
contact-reporting setup or the probe code — not in the crate's shape, the ground's shape,
the layers, the masks, the spawn height, or the plate/gate logic.

## Hypotheses ruled out

- **"The crate fell through the ground / is still falling."** Ruled out by
  `crate_y=0.347` (= the resting height for a 0.7 m box on a ground topped at `y=0.0`),
  `crate_sleeping=true`, and `crate_linear_velocity` ≈ `[2.7e-6, -1.0e-5, -8.4e-6]`.
  A body that missed the ground would be far below `y=0` or still descending.
- **"The crate never fell; `0.347` is just its spawn height."** Ruled out by
  `observation-reset`: `step=0 ... crate_y=2.992`.
- **"The ground collider is disabled, moved, or missing."** Ruled out by
  observation.json: `/root/Main/Ground/Collision` has `"disabled": false`, size
  `[24, 0.5, 24]`, global origin `[0, -0.25, 0]`; and the mask=1 shape query at
  `(4.2, 0.35, 2.5)` still returns `/root/Main/Ground`.
- **"Layer/mask mismatch between crate and ground."** Ruled out: both are
  `collision_layer: 1`, `collision_mask: 1`; the crate physically stopped at the exact
  resting height and the mask=1 query finds the ground, so the pair *is* colliding.
- **"The crate landed on something else (plate/gate/another body), so `false` is correct."**
  Ruled out: the crate rests at `x=4.2, z=2.5`, far from the plate/gate/goal cluster near
  the player's `z=5.5` → `z=-7.1` corridor, and the only body the query finds at that
  height besides the crate is the ground itself.
- **"The simulation never ran / was paused."** Ruled out: `step=93`,
  `physics_frames=629` (trace) / `113` (state.json), and the crate's y changed from
  `2.992` to `0.347` — the world was stepped.
- **"A regression in the plate/gate/beacon or event-stream logic broke the whole case."**
  Ruled out: the other seven cases, including `observation-plate-opens-gate` and
  `observation-event-stream`, pass.
- **"The crate's collider was resized or the shape disabled."** Ruled out by
  observation.json: `BoxShape3D` size `[0.7, 0.7, 0.7]`, `"disabled": false` — and the
  measured resting height matches that size exactly.

## Proposed correction

Smallest intended change: **one line inside `scripts/observation_world.gd` that restores
the crate's ground-contact reporting** — i.e. make the fixture's crate/ground contact
detection observe the contact that the physics server already holds (re-enable the
crate's contact monitoring / the reported-contact limit, or repair the single faulty
predicate in the probe), so that `crate_ground_collision` becomes `true` while the crate
rests on the ground.

Explicitly *not* to be changed: the crate's `BoxShape3D` size or position, the ground's
`BoxShape3D` size or position, any `collision_layer`/`collision_mask`, the crate's spawn
height, the plate/gate/beacon/player/event logic, and the acceptance script
`res://tests/run_observation.gd` (byte-identical oracle, no test weakening). No new
mechanic, no hard-coded expected value.

Expected runtime change after the fix: the `observation-crate-falls` case reports
`ground_collision=true` with `crate_y≈0.347` and `sleeping=true` unchanged (the crate
still lands in the same place and comes to rest — the fix changes only *reporting*),
and the suite prints `RESULT passed=8 failed=0`.

## Confidence

**High** for the class of defect (the ground-contact *report* in
`scripts/observation_world.gd` is broken while the physics is correct) — the geometric
contradiction above is arithmetic, not inference, and the physics-space query was
specifically designed to discriminate "crate really touches the ground" from "probe says
it does not".

**Medium** for the exact single line, because the distinction between "the crate's
contact-reporting is disabled (`contact_monitor` / `max_contacts_reported`)" and "the
probe's predicate is wrong" cannot be made from the evidence alone — the observation
snapshot exposes `collision_layer`/`collision_mask`/shape data but not
`contact_monitor`/`max_contacts_reported`, and the fixture source was not read before
this diagnosis was written.

Evidence that would raise confidence to certain: reading `scripts/observation_world.gd`
and seeing exactly which single line of the crate/ground contact path is off, then
confirming that flipping only that line flips `crate_ground_collision` to `true` while
`crate_y`, `crate_sleeping`, `crate_position`, the event stream and the other seven
cases stay byte-identical.
