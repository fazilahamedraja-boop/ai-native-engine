# Phase 13 repair record

Fixture: `experiments/godot-harness/fixtures/phase13-defect`
File changed: `experiments/godot-harness/fixtures/phase13-defect/scripts/observation_world.gd`
(line 288, function `_on_plate_body_entered`)

## The exact change (one line, one operator)

Before:

```gdscript
func _on_plate_body_entered(body: Node3D) -> void:
	if not is_instance_valid(player) or body == player or plate_pressed:
		return
	plate_pressed = true
```

After:

```gdscript
func _on_plate_body_entered(body: Node3D) -> void:
	if not is_instance_valid(player) or body != player or plate_pressed:
		return
	plate_pressed = true
```

`body == player` -> `body != player`. Nothing else in the repository was modified; the
acceptance script `res://tests/run_observation.gd` is byte-identical to the original
(unchanged mtime/hash), and no file outside `fixtures/phase13-defect/` was touched.

## Why this is the smallest correct correction

- The pressure plate is an `Area3D` at `PLATE_CENTER (0.0, 0.10, -1.1)` with
  `PLATE_SIZE (1.8, 0.2, 2.2)`, `monitoring = true`, `monitorable = true`,
  `collision_layer/mask = 1` (`observation_world.gd:14-15, 470-483`). Its
  `body_entered` signal was already connected (`observation_world.gd:504`), and its
  sibling handler `_on_plate_body_exited` already uses the opposite, correct polarity
  `body != player` (`observation_world.gd:297`). The entered-handler comparison was
  simply inverted: it discarded exactly the body the plate is meant to react to (the
  player) and would only ever have reacted to a foreign body. One operator restores the
  intended relation "only the player presses the plate".
- Geometry confirms the player really is inside the plate volume at the moment the test
  looks, so no geometry, timing, speed or test change is needed: the plate box spans
  `z in [-2.2, 0.0]`, `y in [0.0, 0.2]`; the player's capsule (`RADIUS 0.4`,
  `HEIGHT 1.7`, centre `y = 0.85`) at the end of the 85-frame approach sits at
  `z = -0.166664153337479` and reaches `z ~= -0.43` at the plate's top height, i.e. inside
  the area. The `body_entered` signal did fire; the handler threw the event away.
- The fix is confined to the defect site: the plate's layer/mask/monitoring flags, the
  gate logic (`_update_gate` / `_set_gate_open`), the player controller, the scene
  layout, the harness contract and the acceptance script are all untouched, so no
  gameplay rule was added and no expected value was hard-coded into the fixture.

## Before / after test results

Command (identical in both runs):

```powershell
cd C:\Users\<user>\ai-native-engine-phase13\experiments\godot-harness
node controller/harness.mjs test --project fixtures/phase13-defect --script res://tests/run_observation.gd --json
```

Before the repair (`evidence/test-output.txt`):

```
FAIL observation-plate-opens-gate plate=false gate=false collision=true beacon=red events=["reset", "player_collision_start", "crate_collision_start"]
FAIL observation-gate-passable-after-plate goal=false z=-1.950 events=["reset", "player_collision_start", "crate_collision_start", "player_collision_start", "player_collision_end"]
RESULT passed=6 failed=2
```

After the repair:

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

`exitCode: 0`, `summary: {"passed": 8, "failed": 0}`, `ok: true`, no errors or warnings.

## Verified runtime change

- `plate_entered` is now recorded with `"body": "/root/Main/Player"` at simulation step 82
  (physics frame 523), instead of never being recorded.
- `plate_opens_gate` snapshot: `plate_pressed true`, `gate_open true`,
  `gate_collision_enabled false`, `beacon_state "green"`, `feedback "PLATE PRESSED"`,
  HUD `PLATE: PRESSED   GATE: OPEN` / `BEACON: GREEN`, prompt `GATE OPEN - GO THROUGH`.
- `gate_passable` snapshot: the player leaves the plate (`plate_exited` -> `gate_close`,
  the event the oracle requires), passes the now-open gate and reaches the goal:
  `goal_reached true`, `player_position z = -7.18418073654175` (goal line `GOAL_Z = -4.6`),
  `feedback "GOAL REACHED"`.
- The off-plate case is unchanged: the player never touches the plate, so the gate stays
  solid and blocks it (`z = -1.9497377872467`, `gate_collision_seen=true`), which is what
  `observation-closed-gate-blocks` asserts.

## Post-hoc note: how the source compared to the evidence-only diagnosis

`diagnosis.md` was written at 2:11:21 and the fixture source was first opened afterwards
(`scripts/observation_world.gd` mtime 2:14:27), so the diagnosis stands on the evidence
alone. Opening the source confirmed the diagnosis' *defect class* - the fault is in the
plate's detection path, not in the gate, the observer, the player's layer or the scene
layout - but refined the *site*: the plate's collision shape is correct
(`PLATE_CENTER (0, 0.10, -1.1)` + `PLATE_SIZE (1.8, 0.2, 2.2)`, layer/mask 1,
`monitoring`/`monitorable` true, `body_entered` connected at `observation_world.gd:504`),
and the actual break was the **guard polarity inside the handler**: `body == player`
made the handler discard the only body it is supposed to act on. The sibling
`_on_plate_body_exited` already used `body != player`, which is what pinned the intended
relation before the fix. The one-operator correction below is therefore the smallest
possible repair of that site; no geometry, timing, layout or test change was required.
