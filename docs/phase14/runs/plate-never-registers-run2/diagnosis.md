# Phase 14 blind diagnosis

Scope: derived only from the five evidence files in
`docs/phase14/runs/plate-never-registers-run2/evidence/` plus the rendered
`before.png`. No file under the isolated fixture
(`C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-FITHxd\project`)
was opened before this file was written.

## Failure

The acceptance suite reports `RESULT passed=6 failed=2`. The two failures are
the two cases that depend on the pressure plate:

```
FAIL observation-plate-opens-gate plate=false gate=false collision=true beacon=red
     events=["reset", "player_collision_start", "crate_collision_start"]
FAIL observation-gate-passable-after-plate goal=false z=-1.950
     events=["reset", "player_collision_start", "crate_collision_start",
             "player_collision_start", "player_collision_end"]
```

Every snapshot in the run carries `plate_pressed: false` and
`gate_open: false`, the HUD reads `"PLATE: CLEAR   GATE: CLOSED"`, the
`feedback` string reads `"PLATE CLEAR - GATE CLOSED"`, the prompt still reads
`"WALK ONTO THE PLATE"`, and `goal_reached` stays `false`.

No plate-related entry ever appears in the recorded event stream. The event
stream across the whole run only ever contains `reset`,
`player_collision_start`, `player_collision_end`, `crate_collision_start`,
and `gate_close`.

The gate half of the chain is demonstrably alive: the `initial` trace snapshot
shows `events_count: 6` with `last_event_type: "gate_close"`, and
`observation-closed-gate-blocks` passes with `gate_collision_seen=true`. So the
event recorder works and the gate subsystem works; only the *plate* signal
never fires.

## Contradiction

**Claim:** the plate never registers the player, even though every detection
input Godot needs is satisfied at the moment of observation.

The two conflicting observations:

1. **The player is physically inside the plate's collision volume.**
   `evidence/physics-queries.json`, query `plate_volume` — "box covering the
   pressure plate volume at (0, 0.10, -1.1), the place the player is expected
   to stand" — returns `"/root/Main/Player"` (`CharacterBody3D`,
   `shape_index: 0`) among its results. Independently, the `gate_passable`
   trace snapshot puts the player at `player_position:
   [0.0, 0.850000023841858, -1.9497377872467]` with
   `player_colliders: ["/root/Main/Gate"]`, i.e. the player walked from
   `z=5.5` all the way to the gate at `z=-2.5` and stopped against it. The
   Plate occupies `z ∈ [-2.2, 0.0]` (`Area3D` origin
   `[0, 0.100000001490116, -1.10000002384186]`, `BoxShape3D` size
   `[1.8, 0.2, 2.2]`), so `z = -1.9497` is *inside* the plate footprint, and
   `before.png` shows the blue capsule standing on the yellow plate with the
   HUD still reading `PLATE: CLEAR`.

2. **The plate's detection state is fully enabled and correctly layered.**
   From `evidence/observation.json`, `/root/Main/Plate`: `class: Area3D`,
   `collision_layer: 1`, `collision_mask: 1`, `monitoring: true`,
   `monitorable: true`, and its `/root/Main/Plate/Collision`
   `CollisionShape3D` has `disabled: false` with a valid `BoxShape3D`.
   `/root/Main/Player` has `collision_layer: 1`, `collision_mask: 1`
   (`CapsuleShape3D`, radius `0.4`, height `1.7`). Area→body detection requires
   `area.collision_mask & body.collision_layer`, and `1 & 1 = 1`, so the
   overlap is detectable and the player is a `PhysicsBody3D` descendant
   (a `CharacterBody3D`), which is exactly what `body_entered` reports.

So: overlap present, monitoring on, layers matching, shape enabled — yet
`plate_pressed` is `false`, `gate_open` is `false`, and no plate event is
recorded. The plate's *input conditions* are met; the plate's *detection
callback* never ran. Therefore the defect is in the fixture script's
plate-detection wiring/handling, not in the plate's geometry, not in the
player's transform, and not in the gate.

## Hypotheses ruled out

- **Plate geometry / placement is wrong (plate or player out of position).**
  Ruled out by `physics-queries.json` → `plate_volume` returning
  `/root/Main/Player`, and by `before.png`, which shows the capsule on the
  plate. The measured transforms are self-consistent: plate box
  `y ∈ [0.0, 0.2]`, capsule bottom at `y = 0.85 - 0.85 = 0.0`, so the lower
  hemisphere is inside the plate box for both observed player positions
  (`z=-0.166664153337479` and `z=-1.9497377872467`).
- **Layer / mask mismatch (area cannot see the player).** Ruled out: area
  `collision_mask: 1` vs player `collision_layer: 1`.
- **Area is not monitoring / shape disabled.** Ruled out by the measured
  `monitoring: true`, `monitorable: true`, `disabled: false`.
- **The player never reaches the plate (test-driving failure).** Ruled out:
  `gate_passable` shows the player at `z=-1.9497377872467` colliding with
  `/root/Main/Gate`, which is *past* the plate's near edge, and
  `before.png` (step 88) shows the capsule on the plate.
- **The gate-opening logic is broken.** Ruled out: the gate records
  `gate_close` events, `gate_collision_enabled: true` is reported, and the
  `observation-closed-gate-blocks` case passes. The gate is downstream of the
  failure — it never sees `plate_pressed == true`.
- **The oracle/test is at fault.** Ruled out: the same oracle passes six
  cases (initial state, closed-gate-blocks, event stream ordering/fields,
  reset, humanoid probe, crate fall), and the failures are exactly the two
  cases that require the plate→gate chain.
- **Physics stepping/stall (player frozen short of the plate).** Ruled out:
  `player_velocity: [0.0, 0.0, -4.0]` and `player_motion:
  [0.0, 0.0, -0.0666666626930237]` in the `plate_opens_gate` snapshot show
  the player actively advancing toward the plate.

## Proposed correction

Repair the **single wiring line in
`C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-FITHxd\project\scripts\observation_world.gd`**
that connects the `Plate` `Area3D`'s overlap notification to the handler that
sets `plate_pressed = true` and records the plate event.

The evidence narrows the change to that one connection/handler line: the
signal that should be delivered for a `CharacterBody3D` entering an `Area3D`
is `body_entered`; if that line instead subscribes to a signal that a
`PhysicsBody3D` never emits (`area_entered`), or to the exit rather than the
enter edge, the handler is never invoked and every downstream symptom in the
evidence follows exactly (no plate event, `plate_pressed` stays `false`,
gate stays closed, goal never reached) while every other subsystem keeps
working.

Expected runtime change after the fix: stepping the player onto the plate
must flip `plate_pressed` to `true`, emit a plate event into the recorded
stream, drive `gate_open` to `true` and `gate_collision_enabled` to `false`,
change the HUD/feedback away from `"PLATE CLEAR - GATE CLOSED"`, and let the
player pass the gate to `goal_reached: true`.

## Confidence

**Medium-high** for the diagnosis class ("the plate's Area3D→script detection
link never delivers `body_entered` for the player; the plate's collision
configuration and the player's transform are correct"), because the
contradiction is directly measured: overlap present in the physics query, all
Area3D detection flags correct in the measured node dump, yet no plate event
and a permanently `false` `plate_pressed`.

**Lower** for the exact form of the defect (wrong signal name vs. wrong
signal target vs. a handler-side filter that rejects the player), because
that is not distinguishable from the evidence alone — all three produce
byte-identical observations.

Evidence that would raise confidence to high: the source of
`scripts/observation_world.gd` (which line connects the plate signal) and
any Godot stderr from the run (a bad `connect()` target would print
`Invalid signal` / argument-count errors). Both are available after this
diagnosis is filed, and the source read will confirm or refute the
"one wiring line" hypothesis immediately.
