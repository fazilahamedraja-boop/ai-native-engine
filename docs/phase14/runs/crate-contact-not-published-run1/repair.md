# Phase 14 repair record — crate-contact-not-published-run1

Fixture: `C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-2pqKfw\project`
File changed: `scripts/observation_world.gd` (the only file that differs from the pristine
observation fixture). No other file in the fixture was modified; the oracle
`res://tests/run_observation.gd` is byte-identical to the pristine one (its file
`LastWriteTime` is still the original `10/22/2026 7:08:31 PM`, while the repaired script
is `10/22/2026 7:48:14 PM`).

## The exact line changed

`scripts/observation_world.gd:650`, inside `_build_crate()`:

```gdscript
 # before
-	crate.contact_monitor = false
+	crate.contact_monitor = true
```

One line, one file, one boolean literal. The adjacent line
`crate.max_contacts_reported = 8` (line 651) was already correct and was left untouched.

## Why this is the smallest correct correction

In Godot 4 a `RigidBody3D` only emits `body_entered` / `body_exited` when **both**
`contact_monitor` is enabled **and** `max_contacts_reported > 0`. The fixture already had
the second half right (`max_contacts_reported = 8`) and already had the handlers wired:

```gdscript
crate.body_entered.connect(_on_crate_body_entered)   # line 672
crate.body_exited.connect(_on_crate_body_exited)      # line 673
```

and the handler already published the right event:

```gdscript
func _on_crate_body_entered(body: Node) -> void:
	...
	_record_event("crate_collision_start", {"body": body_path, ...})
```

With `contact_monitor = false` the physics engine never reported the crate↔ground
contact, so `_on_crate_body_entered` was never invoked and **no `crate_collision_start`
event was ever published** — even though the crate really was resting on the ground.
Flipping the single flag restores the intended path with no other change.

Why this is minimal and safe:

* **One line, one file.** No helper, no new signal wiring, no restructuring.
* **No physics behaviour is altered.** The crate still spawns at `CRATE_SPAWN`
  `(4.2, 3.0, 2.5)`, still falls, still settles at `y = 0.347`, still sleeps
  (`crate_sleeping: true`) — the values the test already measured correctly before the
  repair are **unchanged** (`crate_y=0.347`, `sleeping=true`).
* **No new gameplay mechanic and no faked value.** The event is still produced by the
  real physics engine's contact report; nothing is hard-coded and nothing about the
  expected values is asserted in the source.
* **No test was weakened or deleted.** `res://tests/run_observation.gd` was not touched.
* The fix is exactly the mechanism the diagnosis predicted: *"the defect is in contact
  reporting — the fixture's observation/subscription path for crate↔ground contact is
  not producing an observable contact."*

## Before / after test results

Same command both times:

```powershell
cd C:\Users\<user>\ai-native-engine-phase14\experiments\godot-harness
node controller/harness.mjs test --project "C:\Users\<user>\AppData\Local\Temp\phase14-blind-observation-2pqKfw\project" --script res://tests/run_observation.gd --json --allow-outside-root
```

### Before (from `evidence/test-output.txt`)

```
PASS observation-initial-state      plate=false gate=false collision=true beacon=red grounded=true position=[0.0, 0.85000002384186, 5.5]
PASS observation-plate-opens-gate    plate=true gate=true collision=false beacon=green events=["reset", "player_collision_start", "plate_entered", "gate_open"]
PASS observation-gate-passable-after-plate  goal=true z=-7.112 ...
PASS observation-closed-gate-blocks  plate=false gate=false z=-1.950 gate_collision_seen=true
PASS observation-event-stream        count=4 ordered=true fields_ok=true
PASS observation-reset               step=0 plate=false gate=false beacon=red crate_y=2.992 last_event=reset
PASS observation-humanoid-probe      mesh_count=22 bones=["root", "spine", "chest", "head"]
FAIL observation-crate-falls        crate_y=0.347 ground_collision=false sleeping=true
RESULT passed=7 failed=1
```

Exit code 1 (`run_observation.gd:54` → `quit(0 if failed == 0 else 1)`).

### After (same command, re-run)

```
PASS observation-initial-state      plate=false gate=false collision=true beacon=red grounded=true position=[0.0, 0.85000002384186, 5.5]
PASS observation-plate-opens-gate    plate=true gate=true collision=false beacon=green events=["reset", "player_collision_start", "crate_collision_start", "plate_entered", "gate_open"]
PASS observation-gate-passable-after-plate  goal=true z=-7.112 events=["reset", "player_collision_start", "crate_collision_start", "plate_entered", "gate_open", "plate_exited", "gate_close", "player_collision_start", "player_collision_end", "player_collision_start", "player_collision_end", "goal_reached"]
PASS observation-closed-gate-blocks  plate=false gate=false z=-1.950 gate_collision_seen=true
PASS observation-event-stream        count=5 ordered=true fields_ok=true
PASS observation-reset               step=0 plate=false gate=false beacon=red crate_y=2.992 last_event=reset
PASS observation-humanoid-probe      mesh_count=22 bones=["root", "spine", "chest", "head"]
PASS observation-crate-falls        crate_y=0.347 ground_collision=true sleeping=true
RESULT passed=8 failed=0
```

Harness JSON: `"exitCode": 0`, `"ok": true`, `"summary": {"passed": 8, "failed": 0}`,
`"reason": "tests passed"`, `"errors": []`, `"warnings": []`.

## Expected runtime change, verified

The crate↔ground contact is now reported and published:

```
{"body": "/root/Main/Ground",
 "crate_position": [4.19999933242798, 0.347229689359665, 2.50000166893005],
 "sequence": 3, "sim_time_seconds": 8.15, "simulation_step": 46,
 "tick": 489, "type": "crate_collision_start", "source": "fixture_recorded"}
```

* `trace.crate_falls.crate_ground_collision` flipped `false` → **`true`**.
* The `observation-crate-falls` detail is now `crate_y=0.347 ground_collision=true sleeping=true`
  — the **physics outcome is byte-for-byte the same as before** (`crate_y=0.347`,
  `sleeping=true`); only the previously missing *reporting* was added. That is the
  expected delta and confirms the fix touched observation, not simulation.
* Event counts grew by exactly the one new contact event: the crate case
  `events_count: 2 → 3`, the event-stream case `count=4 → 5`. `ordered=true` and
  `fields_ok=true` still hold, so the stream remains well-formed.
* `crate_position` in every trace snapshot is unchanged
  (`[4.20000…, 0.347224…, 2.50000…]`), and `crate_sleeping: true` — the crate still
  comes to rest at the same place, so no other behaviour moved.
