# Phase 14 repair record — `crate-does-not-fall-run2`

Fixture: `C:\Users\hacke\AppData\Local\Temp\phase14-blind-observation-CB8URR\project`
File changed: `scripts/observation_world.gd` (the only file that differs from the
pristine observation fixture, per the task file).
Oracle `res://tests/run_observation.gd`: **not modified** (mtime unchanged at
`2026-10-22 19:08:31`, byte-identical to the pristine copy).

## The exact line changed

`scripts/observation_world.gd`, inside `_build_crate()` — line 646:

```gdscript
 	crate = RigidBody3D.new()
 	crate.name = "Crate"
 	crate.position = CRATE_SPAWN
 	crate.mass = 1.0
-	crate.gravity_scale = 0.0
+	crate.gravity_scale = 1.0
 	crate.linear_damp = 0.15
 	crate.angular_damp = 0.15
 	crate.can_sleep = true
 	crate.contact_monitor = true
 	crate.max_contacts_reported = 8
```

One line, one token (`0.0` → `1.0`). Nothing else in the fixture was touched:
the other seven files under the fixture still carry their original mtimes
(`2026-10-22 19:08:31`); only `scripts/observation_world.gd` changed.

## Why this is the smallest correct correction

- **The evidence localises the fault to exactly one body property.** The crate
  was a fully-formed, registered `RigidBody3D` (enabled `BoxShape3D` 0.7³,
  `collision_layer/mask = 1`, matching the `Ground` `StaticBody3D` whose top
  face is exactly `y = 0`), yet after 113+ physics frames it was still at its
  spawn height with an exactly-zero velocity vector, `sleeping = true`, and
  the physics probe at the spawn height `(4.2, 3.00, 2.5)` still returned the
  crate while the probe at the resting height `(4.2, 0.35, 2.5)` returned only
  `Ground`. The crate was a valid rigid body that gravity was not acting on.
- **The mechanism is confirmed by the runtime trace.** In the *failing* run's
  `initial` trace the crate was `crate_sleeping: false` at `step=8` while
  `crate_linear_velocity` was `[0.0, 0.0, 0.0]` — the body was awake and yet
  never accelerated. That rules out "frozen"/"explicitly parked asleep"
  (`freeze`/`sleeping` would leave it asleep or frozen from frame 0) and
  isolates the fault to a neutralised gravity scale on that single body.
- **Restoring `gravity_scale = 1.0` (the Godot default) re-enables exactly the
  behaviour the fixture exists to demonstrate** — a crate that falls under
  gravity, lands on the ground, and reports a ground contact through the
  fixture's own `contact_monitor`/`body_entered` plumbing. It does not
  hard-code any expected value: the crate falls because gravity acts on it,
  and the test observes the fall on its own.
- **It removes the symptoms instead of masking them.** `crate_y = 3.000`,
  `ground_collision = false` and `sleeping = true` were all downstream of the
  suppressed gravity; restoring the default clears all three without touching
  the plate/gate/player/event code, and without weakening any test.

## Before / after test results

Same command both times (the one given in the task file):

```powershell
cd C:\Users\hacke\ai-native-engine-phase14\experiments\godot-harness
node controller/harness.mjs test --project "C:\Users\hacke\AppData\Local\Temp\phase14-blind-observation-CB8URR\project" --script res://tests/run_observation.gd --json --allow-outside-root
```

### Before the repair (baseline re-run by me, identical to `evidence/test-output.txt`)

```
FAIL observation-crate-falls crate_y=3.000 ground_collision=false sleeping=true
RESULT passed=7 failed=1
exit code 1
```

### After the repair

```
PASS observation-initial-state plate=false gate=false collision=true beacon=red grounded=true position=[0.0, 0.85000002384186, 5.5]
PASS observation-plate-opens-gate plate=true gate=true collision=false beacon=green events=["reset", "player_collision_start", "crate_collision_start", "plate_entered", "gate_open"]
PASS observation-gate-passable-after-plate goal=true z=-7.184 events=["reset", "player_collision_start", "crate_collision_start", "plate_entered", "gate_open", "plate_exited", "gate_close", "player_collision_start", "player_collision_end", "player_collision_start", "player_collision_end", "goal_reached"]
PASS observation-closed-gate-blocks plate=false gate=false z=-1.950 gate_collision_seen=true
PASS observation-event-stream count=5 ordered=true fields_ok=true
PASS observation-reset step=0 plate=false gate=false beacon=red crate_y=2.992 last_event=reset
PASS observation-humanoid-probe mesh_count=22 bones=["root", "spine", "chest", "head"]
PASS observation-crate-falls crate_y=0.347 ground_collision=true sleeping=true
RESULT passed=8 failed=0
exit code 0
```

**Counts: `passed=7 failed=1` (exit 1) → `passed=8 failed=0` (exit 0).**

## Expected runtime change — verified

| expectation | before | after |
|---|---|---|
| crate y after 93 physics frames | `3.000` (never moved) | `0.347` |
| crate ground contact (`crate_collision_start` with `/Ground`) | `false` | `true` |
| crate at rest on the ground (top face `y = 0`, 0.7 cube → centre `y = 0.35`) | n/a | `0.347` ✓ (predicted `0.35`) |
| crate velocity in flight | `[0,0,0]` | `[0, -0.969848334789276, 0]` (live `inspect` capture: awake, in free fall) |
| crate 3 frames after reset (test asserts `> 2.8`) | `3.000` | `2.992` ✓ (still falling, not teleported) |
| new `crate_collision_start` event appears in the event stream | absent | present (event count `4` → `5`) |

The `sleeping=true` in the final detail line is correct and expected: a crate
that has landed and come to rest legitimately sleeps on the floor. The oracle
asserts only `crate_y < 0.6` plus the presence of a `/Ground` contact event —
both now hold, without any change to the test.
