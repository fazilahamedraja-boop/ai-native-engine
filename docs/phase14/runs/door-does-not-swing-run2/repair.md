# Phase 14 repair record — door-does-not-swing-run2

Fixture: `C:\Users\hacke\AppData\Local\Temp\phase14-blind-door-i8HfAl\project`
Diagnosis: `docs/phase14/runs/door-does-not-swing-run2/diagnosis.md` (written
before any fixture source was opened — see "Ordering" below).

## The change

Exactly one line, in `scripts/door.gd` inside `_open()`:

**Before** (`scripts/door.gd:93`)

```gdscript
	collision_enabled = false
	_collision.set_deferred("disabled", true)
	rotation.y = deg_to_rad(0.0)
```

**After** (`scripts/door.gd:93`)

```gdscript
	collision_enabled = false
	_collision.set_deferred("disabled", true)
	rotation.y = deg_to_rad(OPEN_ANGLE_DEGREES)
```

Full file diff: one line, 1 insertion / 1 deletion. No other file in the
fixture was touched (`scripts/door.gd` 2735 → 2750 bytes; every other file
retains its original 7:08:31 PM mtime, including the oracle
`tests/run_door.gd`, 9960 bytes, unmodified).

## Why this is the smallest correct correction

- The defect is exactly the missing swing, and nothing else. The diagnosis
  proved the open transition was already correct in every other respect
  (unlock, key consumption, collider disable, feedback string, HUD, player
  passage) and that only the *rotation* was never applied.
- The rotation was not merely wrong in value — it was **supposed to use a
  constant that the file already declares**. `scripts/door.gd:14` declares
  `const OPEN_ANGLE_DEGREES := 100.0`, and before the fix that constant was
  **referenced nowhere** in the fixture (grep for `OPEN_ANGLE_DEGREES`
  matched only its own declaration). The mutated line had substituted a
  literal `0.0` for the constant, so the swing was silently turned off.
  Restoring the constant reference repairs the intent rather than
  introducing a new value.
- The value is the fixture's own, not an invented one: the oracle asserts
  `absf(float(opened["door_rotation_degrees"]) - 100.0) < 0.01`
  (`tests/run_door.gd:158`), and the snapshot exposes
  `door_rotation_degrees = rad_to_deg(door.rotation.y)`
  (`scripts/door_world.gd:197`). `OPEN_ANGLE_DEGREES = 100.0` satisfies that
  assertion; no expected value was hard-coded to make the test pass.
- Direction and hinge are unchanged. The node origin is the hinge and the
  panel/collider are offset to +X of it (`door.gd:5-8`, `door.gd:36`), so a
  +100° Y rotation swings the leaf clear of the opening, away from the
  approaching player, as the file's own doc comment intends.
- Reset behaviour is preserved: `reset_door()` still sets `rotation.y = 0.0`
  (`door.gd:103`), so the `door-reset` case still reports
  `door_rotation_degrees = 0.0` and `settled_hash == baseline_hash`.
- No test was weakened or deleted, no gameplay was added, and the oracle
  script is byte-identical to the pristine one.

## Before / after test results

Same command in both runs (from the task file):

```powershell
cd C:\Users\hacke\ai-native-engine-phase14\experiments\godot-harness
node controller/harness.mjs test --project "C:\Users\hacke\AppData\Local\Temp\phase14-blind-door-i8HfAl\project" --script res://tests/run_door.gd --json --allow-outside-root
```

**Before the repair** (`evidence/test-output.txt`):

```
FAIL door-unlock-open-pass feedback=UNLOCKED - DOOR OPEN locked=false open=true z=-3.499981 opens=1
RESULT passed=6 failed=1
```

**After the repair** (same command, re-run):

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

Harness JSON: `"summary": {"passed": 7, "failed": 0}`, `"exitCode": 0`,
`"ok": true`, `"errors": []`, `"warnings": []`, duration ~19.5 s.

## Verified runtime change

The expected runtime change is the door leaf's world rotation:

| snapshot field | before | after |
|---|---|---|
| `door_rotation_degrees` (unlock/open, `unlock_open.opened`) | `0` | `100.000000506024` |
| `door_rotation_degrees` (after passing through) | `0` | `100.000000506024` |
| `door_rotation_degrees` (after reset) | `0` | `0` (unchanged, as required) |

Other fields are unchanged by the repair: `door_locked=false`,
`door_open=true`, `door_collision_enabled=false`, `open_count=1`,
`feedback="UNLOCKED - DOOR OPEN"`, player `z=-3.499981`, and the reset
baseline hash `03a99e65f6ba53a8b571fff64003bdf91ec908c25023ec9fd37f44551f681cd5`
is identical to the pre-repair run — i.e. the swing did not perturb any
other deterministic behaviour.

## Ordering (proof the diagnosis preceded the source read)

```
diagnosis.md   LastWriteTime 2026-10-22 19:46:38
scripts/door.gd LastWriteTime 2026-10-22 19:46:55   (the one-line edit)
```

The diagnosis was written 17 s before the fixture source was opened and
before any edit. `experiments/godot-harness/controller/blind-cases.mjs` was
never opened by me (its mtime 19:34:57 is from task setup, unchanged).
