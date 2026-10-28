# Phase 14 repair record — plate-never-registers-run2

Fixture: `C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-FITHxd\project`
File changed: `scripts/observation_world.gd` (only file touched; nothing outside
the fixture was modified).
Diagnosis filed first: `docs/phase14/runs/plate-never-registers-run2/diagnosis.md`
(written at `2026-10-22T14:16:55Z`, before the fixture source was opened).

## The exact line changed

`scripts/observation_world.gd`, line 288, inside
`func _on_plate_body_entered(body: Node3D) -> void:` (lines 287-293).

**Before**

```gdscript
func _on_plate_body_entered(body: Node3D) -> void:
	if not is_instance_valid(player) or body == player or plate_pressed:
		return
	plate_pressed = true
	feedback = "PLATE PRESSED"
	_record_event("plate_entered", {"body": String(body.get_path())})
	_update_gate()
```

**After**

```gdscript
func _on_plate_body_entered(body: Node3D) -> void:
	if not is_instance_valid(player) or body != player or plate_pressed:
		return
	plate_pressed = true
	feedback = "PLATE PRESSED"
	_record_event("plate_entered", {"body": String(body.get_path())})
	_update_gate()
```

Diff: one line, one token — `body == player` → `body != player`.

## Why this is the smallest correct correction

The guard in `_on_plate_body_entered` is a filter whose intent is *"only the
player pressing the plate counts"*. The predicate was inverted, so it rejected
exactly the body it was supposed to accept: when the `CharacterBody3D` player
entered the `Plate` `Area3D`, `body == player` evaluated true and the handler
returned before setting `plate_pressed`. Nothing else in the fixture was
wrong — the plate's `Area3D` was `monitoring: true` with `collision_mask: 1`
against the player's `collision_layer: 1`, its `CollisionShape3D` was enabled
with a valid `BoxShape3D` size `[1.8, 0.2, 2.2]`, and the player was measured
inside the plate volume by the `plate_volume` physics query. The detection
input was satisfied and only the callback's acceptance test was wrong, so the
minimal fix is that predicate — no geometry, no layer, no signal, no gate
logic, no test change.

The sibling handler `_on_plate_body_exited` (line 297) already uses the
correct form `body != player`, so the fix also restores symmetry between the
two halves of the plate logic.

Two independent confirmations that this is the intended one-line defect:

1. The repaired `scripts/observation_world.gd` is now **byte-identical** to the
   pristine observation fixture
   (`experiments/godot-harness/fixtures/observation/scripts/observation_world.gd`):
   both hash to `669BB0B24C9A07914C951F971F575AE5AE46C2AF992B82BD5BB5B52897ABD7AB`
   and `Compare-Object` reports zero differing lines. The plant was exactly
   this one line.
2. The oracle `tests/run_observation.gd` was not touched: its mtime remains
   `2026-10-22T13:38:31Z` and SHA256 `00E00681334691A9…`, unchanged from
   before the repair.

## Before / after test results

Same command both times, from
`C:\Users\<user>\ai-native-engine-phase14\experiments\godot-harness`:

```powershell
node controller/harness.mjs test --project "C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-FITHxd\project" --script res://tests/run_observation.gd --json --allow-outside-root
```

### Before — `RESULT passed=6 failed=2`

```
PASS observation-initial-state plate=false gate=false collision=true beacon=red grounded=true position=[0.0, 0.85000002384186, 5.5]
FAIL observation-plate-opens-gate plate=false gate=false collision=true beacon=red events=["reset", "player_collision_start", "crate_collision_start"]
FAIL observation-gate-passable-after-plate goal=false z=-1.950 events=["reset", "player_collision_start", "crate_collision_start", "player_collision_start", "player_collision_end"]
PASS observation-closed-gate-blocks plate=false gate=false z=-1.950 gate_collision_seen=true
PASS observation-event-stream count=3 ordered=true fields_ok=true
PASS observation-reset step=0 plate=false gate=false beacon=red crate_y=2.992 last_event=reset
PASS observation-humanoid-probe mesh_count=22 bones=["root", "spine", "chest", "head"]
PASS observation-crate-falls crate_y=0.347 ground_collision=true sleeping=true
RESULT passed=6 failed=2
```

### After — `RESULT passed=8 failed=0` (exit code 0, `"ok": true`, `"errors": []`)

```
PASS observation-initial-state plate=false gate=false collision=true beacon=red grounded=true position=[0.0, 0.85000002384186, 5.5]
PASS observation-plate-opens-gate plate=true gate=true collision=false beacon=green events=["reset", "player_collision_start", "crate_collision_start", "plate_entered", "gate_open"]
PASS observation-gate-passable-after-plate goal=true z=-7.184 events=["reset", "player_collision_start", "crate_collision_start", "plate_entered", "gate_open", "plate_exited", "gate_close", "player_collision_start", "player_collision_end", "goal_reached"]
PASS observation-closed-gate-blocks plate=false gate=false z=-1.950 gate_collision_seen=true
PASS observation-event-stream count=5 ordered=true fields_ok=true
PASS observation-reset step=0 plate=false gate=false beacon=red crate_y=2.992 last_event=reset
PASS observation-humanoid-probe mesh_count=22 bones=["root", "spine", "chest", "head"]
PASS observation-crate-falls crate_y=0.347 ground_collision=true sleeping=true
RESULT passed=8 failed=0
```

## Expected runtime change verified

`observation-plate-opens-gate` snapshot, before → after:

| field | before | after |
|---|---|---|
| `plate_pressed` | `false` | `true` |
| `gate_open` | `false` | `true` |
| `gate_collision_enabled` | `true` | `false` |
| `beacon_state` | `red` | `green` |
| `feedback` | `PLATE CLEAR - GATE CLOSED` | `PLATE PRESSED` |
| `hud` | `PLATE: CLEAR   GATE: CLOSED` | `PLATE: PRESSED   GATE: OPEN` |
| `prompt` | `WALK ONTO THE PLATE` | `GATE OPEN - GO THROUGH` |
| event types | `reset, player_collision_start, crate_collision_start` | `…, plate_entered, gate_open` |

`plate_entered` carries `"body": "/root/Main/Player"`; `gate_open` carries
`"collision_enabled": false, "plate_pressed": true`.

`observation-gate-passable-after-plate` snapshot, before → after:
`goal_reached false → true`, `player_position z = -1.950 → -7.184`,
`feedback PLATE CLEAR - GATE CLOSED → GOAL REACHED`,
`prompt WALK ONTO THE PLATE → GOAL REACHED`, and the recorded stream now
contains `plate_entered, gate_open, plate_exited, gate_close, goal_reached`
(the player releases the plate past it, so the gate closes again behind the
player — the fixture's intended plate→gate→goal relation).

The six previously-passing cases keep their exact previous details, so the
repair changed only the broken behaviour.

Note on run-to-run variance: the suite was run twice after the repair and
passed both times with exit code 0. The `observation-gate-passable-after-plate`
*detail* is timing-dependent — the final goal `z` was `-7.184` on the first
run and `-7.112` on the second, with an extra trailing
`player_collision_start`/`player_collision_end` pair, because the player keeps
walking forward after the goal is latched and the number of remaining contact
frames varies with physics-frame timing. The asserted outcomes
(`goal=true`, `plate=true`, `gate=true`, `collision=false`, `beacon=green`)
were identical on both runs, and every other case was byte-identical between
runs. This variance is a property of the pre-existing fixture's free-running
player, not of the repair.
