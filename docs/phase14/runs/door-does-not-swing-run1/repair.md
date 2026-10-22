# Phase 14 repair record - door-does-not-swing-run1

## The defect

`scripts/door.gd` opened the door by *removing* its collider but never swung
the panel. The `_open()` path set the hinge rotation to zero, so
`door_rotation_degrees` stayed `0.0` in every sampled state while
`door_open` reported `true` (see `diagnosis.md`).

## The exact line changed

File: `C:\Users\hacke\AppData\Local\Temp\phase14-blind-door-5DvxJk\project\scripts\door.gd`
Function: `_open()` - line 93.

Before:

```gdscript
	rotation.y = deg_to_rad(0.0)
```

After:

```gdscript
	rotation.y = deg_to_rad(OPEN_ANGLE_DEGREES)
```

That is the only edit. No other line, file, node, constant, test, or mechanic
was touched.

Context (unchanged lines around it):

```gdscript
func _open() -> void:
	if open:
		return
	open = true
	open_count += 1
	collision_enabled = false
	_collision.set_deferred("disabled", true)
	rotation.y = deg_to_rad(OPEN_ANGLE_DEGREES)   # <- was deg_to_rad(0.0)
```

## Why this is the smallest correct correction

1. **The open angle was already declared in the fixture.** `door.gd:14` defines
   `const OPEN_ANGLE_DEGREES := 100.0` and the file's own header comment says
   "The node origin is the hinge. The collision shape and visible panel are
   offset to the right of the hinge, so opening rotates the panel away from
   the player." Before the repair, `OPEN_ANGLE_DEGREES` was a **dead
   constant** - grep proves it was referenced nowhere in the file. The single
   defective line was the only place that should have consumed it. The repair
   therefore re-connects an existing declaration instead of introducing a new
   value, a new node, or a new code path.
2. **It restores the intended mechanism, not a test-specific value.** The
   hinge is the body's own origin (`door.position = DOOR_HINGE` =
   `Vector3(-0.8, 0, 0)`, `door_world.gd:16/306`) and the panel/collider sit
   at local `x = +0.8`, so rotating the body about its Y axis *is* the swing.
   Nothing else has to change for the door to swing physically.
3. **It is a one-line, single-token change** (`0.0` -> `OPEN_ANGLE_DEGREES`)
   inside one existing statement. No new gameplay, no new state, no new
   signal, no API change.
4. **It restores the pristine fixture byte-for-byte.** SHA-256 of the repaired
   `scripts/door.gd` is
   `fcd779c9305537c6c04e2a4d313d8d2d5e031c1faefec644cec8331e7fb907ec`,
   which is identical to the pristine `fixtures/door/scripts/door.gd` in this
   repo and to the `pristine_file_sha256` recorded for this blind case in
   `case-state.json:15` (the defective file hashed
   `075500cffb3e8854eb0737965d7cd54c8e98921efe60c6125ddd7aa5ca872874`).
5. **The oracle was not modified.** `res://tests/run_door.gd` still hashes
   `15c350f7a263161656b99e03b7c6941c1ce1ca3b5ee02d6976f1d7d4aaa941bb` and is
   byte-identical to the pristine `fixtures/door/tests/run_door.gd`; its
   mtime is unchanged (setup time). Only `scripts/door.gd` has a new mtime in
   the fixture tree. No test was weakened, deleted, or relaxed, and no
   expected value was hard-coded.

## Before / after test results

Same command both times, exactly as specified in `task.md`:

```powershell
cd C:\Users\hacke\ai-native-engine-phase14\experiments\godot-harness
node controller/harness.mjs test --project "C:\Users\hacke\AppData\Local\Temp\phase14-blind-door-5DvxJk\project" --script res://tests/run_door.gd --json --allow-outside-root
```

Before the repair (recorded evidence, `evidence/test-output.txt`):

```
FAIL door-unlock-open-pass feedback=UNLOCKED - DOOR OPEN locked=false open=true z=-3.499981 opens=1
RESULT passed=6 failed=1
```

exit code 1.

After the repair:

```
PASS door-initial-state locked=true open=false key_available=true prompt=APPROACH THE DOOR
PASS door-too-far-feedback feedback=TOO FAR locked_attempts=0 distance=5.500000
PASS door-locked-no-key feedback=LOCKED - KEY REQUIRED z=0.500116 blocked_z=0.500116 attempts=1
PASS door-key-required-and-acquired has_key=true key_available=false key_visible=false distance=0.050000
PASS door-unlock-open-pass feedback=UNLOCKED - DOOR OPEN locked=false open=true z=-3.499981 opens=1
PASS door-reset fields_ok=true hash_ok=true immediate_step=0 settled_hash=03a99e65f6ba53a8b571fff64003bdf91ec908c25023ec9fd37f44551f681cd5 baseline_hash=03a99e65f6ba53a8b571fff64003bdf91ec908c25023ec9fd37f44551f681cd5
PASS door-same-process-outcome-repeatability exact_hash_match=true outcome_hash_match=true position_delta=0.000000000 first_outcome=6cdff7cf8e61adf41e058e9aaedb150e9295249272ee3122256400e265313459 second_outcome=6cdff7cf8e61adf41e058e9aaedb150e9295249272ee3122256400e265313459
RESULT passed=7 failed=0
```

exit code 0 (`"ok": true`, `"reason": "tests passed"`, `"exitCode": 0`).
Re-verified twice after the edit (identical result both times).

## Expected runtime change verified

| Field | Before | After |
| --- | --- | --- |
| `door_rotation_degrees` (open state) | `0.0` | `100.000000506024` |
| `door_open` | `true` | `true` (unchanged) |
| `door_locked` | `false` | `false` (unchanged) |
| `door_collision_enabled` | `false` | `false` (unchanged) |
| `Door/Collision.disabled` (node property) | `true` | `true` (unchanged) |
| player `z` after passing through | `-3.49998068809509` | `-3.49998068809509` (unchanged) |
| `doorway_volume` physics query | `Lintel`, `Ground` | `Lintel`, `Ground` (unchanged - no door collider in the opening) |
| `door_rotation_degrees` after reset | `0.0` | `0.0` (unchanged - reset still closes the door) |
| `outcome_hash` | `6cdff7cf...` | `6cdff7cf...` (unchanged) |

The door now swings; the doorway stays physically clear; the reset path still
returns the door to `rotation.y = 0.0`; and the deterministic outcome hash is
unchanged.

Visual proof: `evidence/after.png` (regenerated by the case runner after the
repair) shows the doorway **empty** with the red panel swung open and seen
edge-on at the hinge, and the HUD reading `DOOR: OPEN | KEY: HELD`,
`PROMPT: DOOR OPEN - GO THROUGH`, `z=-3.500 attempts=0 opens=1`. The pre-repair
`evidence/before.png` shows the same HUD but the red panel still filling the
doorway flat - the exact contradiction described in `diagnosis.md`.

## Files touched

| File | Change |
| --- | --- |
| `...\phase14-blind-door-5DvxJk\project\scripts\door.gd` | 1 line (line 93) |
| `...\phase14-blind-door-5DvxJk\project\artifacts\phase14-blind-after.png` | new capture artifact (post-fix screenshot) |
| `docs\phase14\runs\door-does-not-swing-run1\diagnosis.md` | new (written before any source was read) |
| `docs\phase14\runs\door-does-not-swing-run1\repair.md` | new (this file) |

`res://tests/run_door.gd` (the oracle) and every other fixture file are
byte-identical to their pristine copies.
