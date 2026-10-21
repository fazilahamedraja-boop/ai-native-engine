# Phase 13 diagnosis

Derived from the evidence bundle only:
`evidence/test-output.txt`, `evidence/observation.json`, `evidence/physics-queries.json`,
`evidence/state.json`, `evidence/frame-on-plate.png`.
No file under `experiments/godot-harness/fixtures/phase13-defect/` was opened before this
document was written.

## Failure

The acceptance suite fails 2 of 8 cases (`RESULT passed=6 failed=2`):

```
FAIL observation-plate-opens-gate plate=false gate=false collision=true beacon=red events=["reset", "player_collision_start", "crate_collision_start"]
FAIL observation-gate-passable-after-plate goal=false z=-1.950 events=["reset", "player_collision_start", "crate_collision_start", "player_collision_start", "player_collision_end"]
```

Both failures share one root symptom: **the pressure plate never registers**. Every captured
snapshot agrees — `plate_pressed: false`, `gate_open: false`, `goal_reached: false`,
`beacon_state: "red"`, `feedback: "PLATE CLEAR - GATE CLOSED"`,
`prompt: "WALK ONTO THE PLATE"` (`state.json`, `observation.json`, and every trace block in
`test-output.txt`). The HUD string in the trace says the same:
`"OBSERVATION FIXTURE\nPLATE: CLEAR   GATE: CLOSED\nBEACON: RED ..."`.

The player is still walking forward when the plate case ends, so it is not standing still:
`"player_velocity":[0.0,0.0,-4.0]`, `"player_motion":[0.0,0.0,-0.0666666626930237]`,
`"player_position":[0.0,0.850000023841858,-0.166664153337479]`, `"step":88`,
`"wall_contact":false`.

Because the plate never presses, the gate never opens, so in
`observation-gate-passable-after-plate` the player is stopped by the *closed* gate:
`"player_colliders":["/root/Main/Gate"]`, `"wall_contact":true`,
`"player_position":[0.0,0.850000023841858,-1.9497377872467]`, `"goal_reached":false`,
`"gate_open":false`. That blocked state is precisely what the *passing*
`observation-closed-gate-blocks` case asserts, which is why that case passes while the
"gate passable" case fails.

Causal chain (single defect): plate not pressed → gate stays closed and solid → player cannot
pass the gate → goal at `z <= -1.95` never reached.

## Contradiction

Two observations in the evidence cannot both be true:

1. **The player's body is inside the pressure plate's collision volume.**
   `evidence/physics-queries.json` → `plate_volume` ("box query covering the pressure plate
   volume at (0, 0.10, -1.1)") returns the player's own collider:
   `{"collider": "/root/Main/Player", "collider_type": "CharacterBody3D", "shape_index": 0}`
   next to `{"collider": "/root/Main/Ground", "collider_type": "StaticBody3D"}`.
   The player's capsule is 0.7 m wide with its bottom hemisphere at `y = 0.35` and its centre
   at `z = -0.166664153337479` (`observation.json` → `player_world_origin
   [0, 0.850000023841858, -0.166664153337479]`, `player_colliders: ["CapsuleShape3D"]`), so its
   footprint reaches `z ≈ -0.48` at the height of the plate volume — i.e. it overlaps the
   plate's volume. `frame-on-plate.png` shows the same moment (HUD `PLAYER z=-0.17`,
   `STEP: 88`, `TICK: 110`) with the cyan capsule standing on the yellow `PRESSURE PLATE`
   pad, while the HUD still reads `PLATE: CLEAR`.
2. **The plate's detector is live, on the right layer, watching the right body — and still
   never fires.** `evidence/observation.json` → `plate_collision`:
   `{"collision_layer": 1, "collision_mask": 1, "monitorable": true, "monitoring": true,
   "source": "measured"}`. The player is on layer 1: both harness shape queries run with
   `"collision_mask": 1` and the Player is returned by them, which can only happen if the
   player's own `collision_layer` intersects 1. A monitoring Area3D on layer/mask 1 that
   overlaps a layer-1 body must receive `body_entered`. Yet the recorded state is
   `plate_pressed: false` and the event stream contains only
   `["reset", "player_collision_start", "crate_collision_start"]` — no plate/gate-open event
   (the vocabulary does include gate events: the `initial` trace's
   `"last_event_type":"gate_close"`).

So the plate's **volume** and the plate's **detection** disagree: the player is inside the
plate's volume and the detector is armed, but the fixture reports the plate as clear. The
fault is therefore in how the plate's detection volume is defined (or in the wiring from that
volume to the fixture's state) — not in the plate's layer/mask/monitoring flags, and not in
the gate, the crate, the probe, or the observer.

## Hypotheses ruled out

- **"The plate area is disabled or mis-layered."** Ruled out by measurement:
  `plate_collision` is `collision_layer 1`, `collision_mask 1`, `monitoring true`,
  `monitorable true`, `"source": "measured"`. The area is live and watching layer 1.
- **"The player is not on layer 1."** Ruled out: the harness shape queries use
  `collision_mask: 1` and both return `/root/Main/Player`; a shape query only hits colliders
  whose layer intersects the query mask.
- **"The player never reached the plate"** (a movement/speed problem). Ruled out by the
  plate-volume query returning the Player, and by the event stream: the player's body was
  already colliding with the world two ticks after the reset (`player_collision_start`,
  `collider: /root/Main/Ground`, `tick 22` after `reset` at `tick 20`). The player is inside
  the plate's volume at the end of the case.
- **"The gate is the broken component."** Ruled out: `observation-closed-gate-blocks` PASSES
  with `gate_collision_seen=true` and the player resting against `/root/Main/Gate`;
  `gate_open` is a consequence of `plate_pressed`, and `gate_collision_enabled: true` is
  reported correctly in every snapshot.
- **"The observer/harness is misreporting."** Ruled out: the same observer returns correct
  values for everything else (`crate_y=0.347`, `ground_collision=true`, `sleeping=true`,
  `mesh_count=22`, `beacon_state`, `gate_collision_enabled`), and the passing
  `observation-reset` case shows the plate state correctly reset to `false`.
- **"The crate or the humanoid probe regressed."** Ruled out: `observation-crate-falls` and
  `observation-humanoid-probe` PASS.
- **"The plate's expected position is wrong."** Not ruled out, but it does not explain the
  failure by itself: the pad the player stands on is drawn at the plate position
  (`(0, 0.10, -1.1)` is the volume the harness queries and the plate is rendered there in
  `frame-on-plate.png`), so the *volume* is right; what is missing is the registration.

## Proposed correction

One line, inside `experiments/godot-harness/fixtures/phase13-defect/`, in the plate setup:
make the plate's detection volume actually cover the pad the player stands on, so the
overlapping player body is delivered to the fixture's plate handler.

The evidence isolates the fault to the plate's detection shape/wiring, not to the area's
flags (already correct) and not to the gate (correct). Concretely, the plate's
`CollisionShape3D` must span the plate pad at the plate position (`0, 0.10, -1.1`) — today
that volume holds only `Ground` and the `Player` in the harness shape query, i.e. nothing
belonging to the plate itself — and its `body_entered` must reach the handler that sets
`plate_pressed`.

Nothing else changes: no test is touched, no expected value is hard-coded, no gameplay rule
is added. Expected consequence: `plate_pressed` becomes true, the fixture opens the gate and
disables the gate collider, the beacon turns green, the player walks through to the goal at
`z <= -1.95`, and `observation-plate-opens-gate` + `observation-gate-passable-after-plate`
flip to PASS (`passed=8 failed=0`).

## Confidence

- **High** for the causal chain and for the defect *class* (the plate's detection volume/
  wiring, not the gate, not the observer, not the player's layer). Every snapshot in all four
  evidence files agrees, and the same fixture passes the six cases that do not depend on the
  plate.
- **Medium** for the exact defect site. The evidence proves the *symptom* (armed detector,
  overlapping body, no event) and therefore that the plate's detection geometry or its signal
  wiring is broken, but the evidence alone cannot distinguish (a) a collision shape that is
  disabled/degenerate/mis-sized/mis-positioned relative to the pad from (b) a
  `body_entered` connection that is missing or wired to the wrong node. Reading the fixture
  source is required to name the single line; the correction must stay one line.
- **Evidence that would raise confidence to certain:** the fixture source showing the plate
  node tree with its `CollisionShape3D` transform and the `body_entered` connection, plus a
  re-run of the same acceptance command reporting `RESULT passed=8 failed=0`.
