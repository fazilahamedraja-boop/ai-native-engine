# Phase 14 blind diagnosis

Fixture: `C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-2pqKfw\project`
Engine: `Godot Engine v4.7.2.stable.official.ed1daf0bf`
Run: `crate-contact-not-published-run1`
Derived from evidence only: `evidence/test-output.txt`, `evidence/observation.json`,
`evidence/physics-queries.json`, `evidence/state.json`, `evidence/before.png`.

## Failure

The acceptance suite reports 7 passes and 1 failure:

```
FAIL observation-crate-falls crate_y=0.347 ground_collision=false sleeping=true
RESULT passed=7 failed=1
```

The single failing case is the crate-drop case. The three values it prints are:

* `crate_y=0.347` — the crate **did** fall and **did** reach its resting height.
* `sleeping=true` — the crate came to rest and the physics engine put it to sleep.
* `ground_collision=false` — the fixture **never observed or published a crate/ground
  contact**, so the case is marked `ok:false`.

The recorded event stream confirms the contact was never published. `evidence/observation.json`
at `engine_tick: 115` has `event_count: 2` and `event_types: ["reset", "player_collision_start"]`
— the only two events in the whole run are the harness reset and the player touching
`/root/Main/Ground` (collider `"/root/Main/Ground"`, normal `[0, 1, 0]`). `evidence/before.png`
corroborates this: the HUD reads `CRATE: 0.35 m`, `TICK: 112`, and `EVENTS: 2`. There is no
crate-contact event of any name in the stream, so this is not a "published under a different
type" problem — nothing was published.

`evidence/state.json` shows `step: 93`, `physics_frames: 114` — roughly 1.9 s of simulated
time had elapsed by the time of the snapshot, i.e. the crate had ample opportunity to land.

## Contradiction

**Falsifiable claim:** the crate is *physically resting in contact with the ground*, and
yet the fixture reports that it is *not* in contact with the ground. Exactly one of these
two statements must be false, and the physics-space evidence says the first one is true.

The two conflicting observations are:

1. **Crate is in physical contact with the ground.** `evidence/physics-queries.json`
   issues a box query named `crate_resting_height` at the crate's own resting transform
   `(4.2, 0.35, 2.5)` with `collision_mask: 1`, and the space returns **two** colliders:
   `/root/Main/Ground` (`StaticBody3D`) and `/root/Main/Crate` (`RigidBody3D`). The ground
   shape overlaps the crate shape. This is an independent, engine-level confirmation of
   contact at the crate's live position.
2. **Fixture says there is no contact.** `ground_collision=false`, and the full event stream
   is `["reset", "player_collision_start"]` — no crate contact event exists.

The geometry agrees with observation (1) and leaves no room for a "stopped short / bad
resting height" escape hatch:

* Ground: `StaticBody3D` at origin `[0, 0, 0]`, `CollisionShape3D` with `BoxShape3D`
  `size: [24, 0.5, 24]` whose shape origin is `[0, -0.25, 0]` ⇒ **top face at y = 0.0**.
* Crate: `RigidBody3D` at `[4.20000553131104, 0.347224950790405, 2.50000500679016]`,
  `CollisionShape3D` (`disabled: false`) with `BoxShape3D` `size: [0.7, 0.7, 0.7]`
  ⇒ half-height 0.35 ⇒ **resting centre y = 0.35**.
* Measured `crate_y = 0.3472` ≈ 0.35 (2.7 mm of solver tolerance), and the HUD renders
  `CRATE: 0.35 m`. The crate is sitting *on* the ground, not floating above it.

So the failure is **not** a physics failure. The fall happened, the landing happened, the
contact exists in the physics space, and the body is asleep — which in Godot only occurs
*after* the contact has been resolved. What is missing is the *reporting* of that contact:
the fixture never observes it and never publishes it as an event, so the
`observation-crate-falls` case sees `ground_collision=false`.

## Hypotheses ruled out

| Hypothesis | Evidence that excludes it |
|---|---|
| The crate never falls / is frozen or held in the air | Test line 8 (`observation-reset`) records `crate_y=2.992` at `step=0`; the failing case measures `crate_y=0.347`. It moved ~2.65 m and landed. HUD: `CRATE: 0.35 m`. |
| The crate stops at the wrong height (bad shape size, wrong ground height, half-extent error) | Resting height computed from measured shapes is exactly 0.35 (0.7/2 above a ground top face at y=0). Measured `0.3472`. The screenshot shows the crate sitting on the sand. |
| A collision shape is missing or disabled on the crate or the ground | `observation.json` shows crate `Collision` `CollisionShape3D` with `disabled: false`, `BoxShape3D` size `[0.7, 0.7, 0.7]`; ground `Collision` `CollisionShape3D` with `disabled: false`, `BoxShape3D` size `[24, 0.5, 24]`. |
| Collision layer/mask mismatch stops crate↔ground interaction | Crate: `collision_layer: 1`, `collision_mask: 1`. Ground: `collision_layer: 1`, `collision_mask: 1`. The query with `collision_mask: 1` finds both bodies. |
| The physics engine never resolved the contact | The crate is `sleeping: true` and `crate_linear_velocity` ≈ `[0, 0, 0]` — Godot only sleeps a body after its contacts have been solved; and the direct-space query returns the ground at the resting transform. |
| Insufficient simulation time / the crate landed after the assertion | `physics_frames: 114`, `engine_tick: 115`, `step: 93` (~1.9 s of sim) — the crate is already asleep and settled long before the check. |
| The event was published but under a different type/label | The recorded stream contains exactly 2 items total (`event_count: 2`, `event_types: ["reset", "player_collision_start"]`) and the HUD shows `EVENTS: 2`. No crate event of any name exists. |
| The player is interfering with / occluding the crate | The player capsule is at z = 5.50; the crate is at x = 4.2, z = 2.5 — >3 m apart in z. The only player collision was with `/root/Main/Ground`. |
| The failing case is failing for a reason unrelated to the crate contact (e.g. the plate/gate/goal logic) | All other cases pass, including `observation-plate-opens-gate`, `observation-gate-passable-after-plate`, `observation-closed-gate-blocks`, and `observation-reset` (`crate_y=2.992` proves the reset path is intact). The single failing assertion is the contact one. |

**Conclusion:** the physics setup of the crate is correct and complete; the defect is in
*contact reporting* — the fixture's observation/subscription path for crate↔ground
contact is not producing an observable contact.

## Proposed correction

Smallest intended change: in `scripts/observation_world.gd`, make the crate↔ground contact
**observable by the fixture** by enabling contact monitoring on the crate `RigidBody3D`
so the engine reports the contact and the fixture's existing handler publishes it as an
event — a single property change on the crate node, e.g.

```gdscript
crate.contact_monitor = true          # + crate.max_contacts_reported = 1 if unset
```

Rationale for this being the smallest correct correction:

* It touches **one file and one line**, in the one file the task states differs from the
  pristine fixture.
* It changes **no** physics behaviour: the crate still falls, still lands at y = 0.35,
  still sleeps — the values the test already measures correctly (`crate_y`, `sleeping`)
  stay identical. It only makes the already-existing contact visible to the fixture.
* It adds **no** gameplay mechanic, does not weaken or delete a test, and does not
  hard-code an expected value (the contact is still produced by the physics engine, not
  faked).
* It is falsifiable: if the source shows contact monitoring is already enabled and the
  event merely is not published, the one-line correction moves to the publication path
  instead. Either way it stays a single line in `scripts/observation_world.gd`.

## Confidence

**High** on the diagnosis that the defect is in contact *reporting* rather than in the
crate's physics, geometry, collision layers or timing — the contradiction between the
physics-space query result (`/root/Main/Ground` **and** `/root/Main/Crate` both returned
at the crate's live resting transform) and `ground_collision=false` with `event_count: 2`
pins that down from the evidence alone.

**Medium** on the exact form of the one-line correction (contact-monitor enablement vs. a
missing/unpublished event emission), because the evidence shows the *absence* of the
contact event but not which of the two mechanisms is responsible. That distinction is
resolved by reading `scripts/observation_world.gd`, which was deliberately left unread
until this diagnosis was written.

Evidence that would raise confidence to certain: the source of the crate's contact
subscription (whether `contact_monitor`/`max_contacts_reported` are set and whether the
`body_entered` handler publishes to the event stream), and a re-run showing the crate
contact event present in the stream with `ground_collision=true`.
