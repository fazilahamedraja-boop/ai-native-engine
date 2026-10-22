# Phase 14 blind repair record

Fixture: `C:\Users\hacke\AppData\Local\Temp\phase14-blind-observation-e6DJQT\project`
File changed: `scripts/observation_world.gd` (the only file in the fixture that
differed from the pristine observation fixture).

## The exact line changed

`scripts/observation_world.gd`, line 288, inside `func _on_plate_body_entered(body: Node3D) -> void:`

**Before**

```gdscript
func _on_plate_body_entered(body: Node3D) -> void:
	if not is_instance_valid(player) or body == player or plate_pressed:
		return
	plate_pressed = true
```

**After**

```gdscript
func _on_plate_body_entered(body: Node3D) -> void:
	if not is_instance_valid(player) or body != player or plate_pressed:
		return
	plate_pressed = true
```

One operator, one line. File SHA-256 before
`A99A7F45EEFFD7C47C7CD4EDCFA2886FFEF51BEC01F8D4F2BA2857E18084DC60` → after
`669BB0B24C9A07914C951F971F575AE5AE46C2AF992B82BD5BB5B52897ABD7AB`.
No other file in the fixture was touched (`res://tests/run_observation.gd` keeps
its original mtime and is byte-identical).

## Why this is the smallest correct correction

The guard is inverted: it *rejected the one body that matters*. `body == player`
made the handler bail out exactly when the Player entered the plate, so
`plate_pressed` could never become `true` — the plate could never register.

The correct semantics are already written in the file, in the sibling handler
`scripts/observation_world.gd:297`:

```gdscript
func _on_plate_body_exited(body: Node3D) -> void:
	if not is_instance_valid(player) or body != player or not plate_pressed:
		return
```

`body != player` → ignore every body that is not the player. The entered
handler must be symmetric with it; it was the only place in the fixture with
the comparison reversed. Fixing it restores the intended rule — *the plate is
pressed by the player and by nothing else* — and nothing more.

Why no other change is needed or acceptable:

* The Plate `Area3D` configuration was already correct and was **not** touched:
  `monitoring = true`, `monitorable = true`, `collision_layer = 1`,
  `collision_mask = 1`, and the Player is on `collision_layer = 1`, so
  `mask & layer = 1 ≠ 0`. The physics server therefore *did* emit
  `body_entered` for the Player — the evidence shows the Player physically
  inside the plate volume (`physics-queries.json` → `plate_volume` returns
  `/root/Main/Player`; player `z = -0.166664153337479` vs the plate band
  z ∈ [-2.2, 0.0]). The signal was being discarded by the handler, not
  withheld by the engine.
* Nothing else in the world can enter the plate, so the corrected guard cannot
  produce a false press: the Ground's AABB (y ∈ [-0.5, 0.0]) only *touches* the
  plate's AABB (y ∈ [0.0, 0.2]) and Godot's `AABB::intersects` rejects
  face-to-face contact; the crate rests at x = 4.2, outside the plate's
  x ∈ [-0.9, 0.9]; the walls are far away.
* The gate logic (`_update_gate` / `_set_gate_open`), the player's movement,
  the scene, the physics layers, the oracle test and every other line were
  left byte-identical. No test was weakened, deleted, or modified, no gameplay
  mechanic was added, and no expected value was hard-coded: the fix restores a
  behavioural rule that the fixture already encoded everywhere else.

## Before / after test results

Same command, same oracle (`res://tests/run_observation.gd`):

```powershell
cd C:\Users\hacke\ai-native-engine-phase14\experiments\godot-harness
node controller/harness.mjs test --project "C:\Users\hacke\AppData\Local\Temp\phase14-blind-observation-e6DJQT\project" --script res://tests/run_observation.gd --json --allow-outside-root
```

| | Before | After |
|---|---|---|
| `RESULT` | `passed=6 failed=2` | **`passed=8 failed=0`** |
| exit code | 1 | **0** |
| `observation-initial-state` | PASS | PASS |
| `observation-plate-opens-gate` | **FAIL** `plate=false gate=false collision=true beacon=red` | **PASS** `plate=true gate=true collision=false beacon=green` |
| `observation-gate-passable-after-plate` | **FAIL** `goal=false z=-1.950` | **PASS** `goal=true z=-7.184` |
| `observation-closed-gate-blocks` | PASS | PASS |
| `observation-event-stream` | PASS `count=3` | PASS `count=5` |
| `observation-reset` | PASS | PASS |
| `observation-humanoid-probe` | PASS | PASS |
| `observation-crate-falls` | PASS | PASS |

Full after-run JSON: `after-test-result.json` (this directory). The run was
executed twice after the repair and reported `passed=8 failed=0` / exit code 0
both times.

## Expected runtime change (verified)

* New event stream for the plate approach:
  `["reset", "player_collision_start", "crate_collision_start", "plate_entered", "gate_open"]`
  — `plate_entered` carries `body: "/root/Main/Player"` at
  `simulation_step 82`, and `gate_open` carries `plate_pressed: true`,
  `collision_enabled: false`.
* Plate snapshot now reads `plate_pressed: true`, `gate_open: true`,
  `gate_collision_enabled: false`, `beacon_state: "green"`,
  `feedback: "PLATE PRESSED"`, `prompt: "GATE OPEN - GO THROUGH"`, HUD
  `PLATE: PRESSED   GATE: OPEN`.
* The player then passes the open gate, the plate releases, the gate closes
  again, and the goal is reached: `z = -7.184`, `goal_reached = true`,
  `feedback: "GOAL REACHED"`, events
  `[..., "plate_entered", "gate_open", "plate_exited", "gate_close", ..., "goal_reached"]`.
* The player's motion is unchanged by the fix: the failing snapshot and the
  repaired snapshot both report the player at
  `z = -0.166664153337479` after 85 forward frames — only the plate/gate state
  differs.
* The off-plate path is unchanged: `observation-closed-gate-blocks` still
  reports `plate=false gate=false z=-1.950 gate_collision_seen=true`, i.e.
  straying off the plate still leaves the gate shut and blocking.
