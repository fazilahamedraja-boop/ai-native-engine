# Phase 14 blind diagnosis

Evidence-only analysis. No file under
`C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-e6DJQT\project`
was opened before this file was written.

## Failure

The acceptance suite reports `RESULT passed=6 failed=2`:

```
FAIL observation-plate-opens-gate plate=false gate=false collision=true beacon=red
     events=["reset", "player_collision_start", "crate_collision_start"]
FAIL observation-gate-passable-after-plate goal=false z=-1.950
     events=["reset", "player_collision_start", "crate_collision_start",
             "player_collision_start", "player_collision_end"]
```

Two assertions are broken, and both are downstream of the same flag:

* `observation-plate-opens-gate` — the plate never registers. `plate=false`, and
  because the plate never registers, `gate=false` and `beacon=red` follow.
* `observation-gate-passable-after-plate` — the goal is never reached
  (`goal=false`) because the gate stays shut; the player is parked at
  `z=-1.950`.

The fixture's own state at the captured moment
(`evidence/state.json`, `step 89`, `physics_frames 112`):

```json
"player_position": [0, 0.850000023841858, -0.166664153337479],
"player_velocity": [0, 0, -4],
"feedback": "PLATE CLEAR - GATE CLOSED",
"prompt": "WALK ONTO THE PLATE",
"plate_pressed": false,
"gate_open": false,
"gate_collision_enabled": true,
"beacon_state": "red",
"goal_reached": false
```

The HUD in `evidence/before.png` shows the same thing: `PLATE: CLEAR  GATE:
CLOSED`, `PLAYER z=-0.17  STEP: 89  TICK: 110`, `EVENTS: 3  FEEDBACK: PLATE
CLEAR - GATE CLOSED`, with the blue player capsule visually standing **on** the
yellow pressure plate.

The controlling node in `evidence/observation.json` (`/root/Main`) also reports
`"plate_pressed": false`, `"gate_open": false`, `"gate_collision_enabled":
true`, `"beacon_state": "red"`, `"goal_reached": false`,
`"feedback": "PLATE CLEAR - GATE CLOSED"`.

## Contradiction

**Claim (falsifiable): the Plate's area-overlap detection is never acted upon,
even though the Player is physically inside the Plate's area volume and the
Area3D's monitoring configuration is correct.**

Two observations conflict:

1. **The player is inside the plate volume.** `evidence/physics-queries.json`,
   query `plate_volume` ("box covering the pressure plate volume at
   (0, 0.10, -1.1)"), returns two colliders: `/root/Main/Ground` and
   **`/root/Main/Player`** (`collider_type: "CharacterBody3D"`). Independently,
   `state.json` puts the player at `z = -0.166664153337479`, and
   `observation.json` measures the identical Player origin
   `[0, 0.850000023841858, -0.166664153337479]`.

   Geometry from the measured node data: the Plate's `BoxShape3D` is
   `size [1.79999995231628, 0.200000002980232, 2.20000004768372]` centred at
   global `[0, 0.100000001490116, -1.10000002384186]`, i.e. the plate occupies
   x ∈ [-0.9, 0.9], y ∈ [0.0, 0.2], z ∈ [-2.2, 0.0]. The Player's
   `CapsuleShape3D` is `radius 0.400000005960464`, `height
   1.70000004768372`, centred at y = 0.85, so its bottom point is y = 0.0 and
   its horizontal footprint is x ∈ [-0.4, 0.4], z ∈ [-0.5667, 0.2333]. The two
   shapes genuinely overlap on all three axes.

2. **The area's configuration cannot be the cause.**
   `evidence/observation.json` measures `/root/Main/Plate` as `Area3D` with
   `collision: {collision_layer: 1, collision_mask: 1, monitorable: true,
   monitoring: true}` and its `CollisionShape3D` `disabled: false`. The Player
   is measured with `collision_layer: 1`. So `mask (1) & layer (1) = 1 ≠ 0`:
   Godot's physics server **must** have emitted `body_entered` on the Plate the
   first frame the Player's capsule entered that volume.

Yet the fixture reports `plate_pressed: false`, `feedback: "PLATE CLEAR -
GATE CLOSED"`, `prompt: "WALK ONTO THE PLATE"`, and the recorded event stream
contains only `["reset", "player_collision_start", "crate_collision_start"]` —
no plate event, at a moment when the player is standing in the plate.

**Therefore the defect is in the fixture's handling of the plate overlap (in
`scripts/observation_world.gd`), not in the node/physics configuration, not in
the player's motion, and not in the gate logic.**

Supporting contradiction (the trajectory): the player spawns at
`z = 5.5` (`PASS observation-initial-state ... position=[0.0,
0.85000002384186, 5.5]`) and drives at `player_velocity = [0, 0, -4]`. In the
`closed_gate_blocks` trace it ends at `z = -1.950`, which is exactly the
resting position of a radius-0.4 capsule against the closed gate (gate centre
`z = -2.5`, box depth `0.300000011920929` → front face `z = -2.35`;
`-2.35 + 0.4 = -1.95`). The player therefore traversed the **entire** plate
footprint z ∈ [-2.2, 0.0] and still ended with `plate=false`.

## Hypotheses ruled out

| # | Hypothesis | Evidence that excludes it |
|---|-----------|------------------------------|
| 1 | The player never reached the plate | `state.json` `player_position` z = `-0.166664153337479` (inside z ∈ [-2.2, 0.0]); `physics-queries.json` `plate_volume` returns `/root/Main/Player`; `before.png` shows the capsule on the plate; the closed-gate trace ends at `z = -1.950`, past the plate's far edge at -2.2. |
| 2 | The Area3D is not monitoring | `observation.json` measures `/root/Main/Plate` with `monitoring: true`, `monitorable: true`. |
| 3 | Layer/mask mismatch prevents detection | Plate `collision_mask: 1`; Player `collision_layer: 1`; `1 & 1 ≠ 0`. |
| 4 | The plate's shape is disabled or displaced so overlap is impossible | Plate `CollisionShape3D` `disabled: false`, `BoxShape3D` size `[1.8, 0.2, 2.2]` at global `[0, 0.1, -1.1]`; the player's capsule bottom is at y = 0.0 and overlaps the plate band y ∈ [0.0, 0.2]. |
| 5 | The player fell / was not grounded | `grounded: true`; y constant at `0.850000023841858`; `player_collision_start` with `collider: "/root/Main/Ground"`, `normal: [0, 1, 0]`. |
| 6 | The gate-open logic is the bug (the gate should open) | `plate_pressed` itself is `false` — the gate staying shut is a correct consequence of it, and `gate_collision_enabled: true` with `PASS observation-closed-gate-blocks ... gate_collision_seen=true` shows the gate behaves. |
| 7 | The crate is the intended trigger and it simply missed the plate | The crate is a sleeping RigidBody3D resting at `[4.2, 0.347, 2.5]` — outside the plate AABB on both x (plate x ∈ [-0.9, 0.9]) and z (plate z ∈ [-2.2, 0.0]) — with ~0 linear velocity; `crate_collision_start` reports `body: "/root/Main/Ground"`; the HUD prompt is `WALK ONTO THE PLATE`. |
| 8 | The latch was set and then cleared by a late reset | `reset` is event sequence **1** at `simulation_step 0`, i.e. before the player moves; `PASS observation-reset ... step=0 ... last_event=reset`. |
| 9 | The player is not a `PhysicsBody3D`, so an area can never see it | `observation.json` measures `/root/Main/Player` as `class: "CharacterBody3D"` with `collision_layer: 1` — a body, fully visible to a monitoring Area3D. |

## Proposed correction

Change **one line** in
`C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-e6DJQT\project\scripts\observation_world.gd`
so the already-correctly-configured Plate `Area3D` actually latches
`plate_pressed = true` when the Player's body enters it.

No scene file, no collision layer/mask, no shape, no player movement and no
test change is warranted: the measured node configuration already satisfies
Godot's area/body detection contract, and the fault has been narrowed to the
script's plate-detection path (the `body_entered` connection and/or the
`plate_pressed = true` assignment inside its handler). The exact line will be
identified from the source and left otherwise untouched.

## Confidence

**High (~90%)** that the defect lies in the fixture script's plate-detection
path, and **high (~95%)** that the physics/node configuration is innocent
(monitoring, mask, layer, shape bounds, and the player's actual position are
all independently measured and mutually consistent with a real overlap that
Godot must have reported).

**Medium (~60%)** on the exact defective line until the source is read — the
evidence cannot distinguish between a mis-wired signal (e.g. connecting
`area_entered` instead of `body_entered`, or connecting the wrong node) and a
handler that bails on a wrong body test.

Extra evidence that would raise confidence to certainty:

1. Godot's stderr/engine log for the run — a missing/invalid `connect()` call
   would surface there as a script error.
2. A direct probe of `plate.get_overlapping_bodies()` at the snapshot moment.
   If it returns the Player, the physics server registered the overlap and the
   fault is conclusively in the script's callback; if it returns empty, the
   fault would instead be in the area's runtime configuration.
3. Enabling `print`/signal tracing on the Plate's `body_entered` to observe
   whether the signal fires at all.
