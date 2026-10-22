# Phase 14 repair record — `crate-contact-not-published-run2`

## The defect

`scripts/observation_world.gd` built the falling crate with **contact monitoring
switched off**, so the fixture's own ground-contact report was structurally blind even
though the physics was correct.

`_build_crate()` created a `RigidBody3D` and connected its contact signals:

```gdscript
crate.body_entered.connect(_on_crate_body_entered)
crate.body_exited.connect(_on_crate_body_exited)
```

but the `RigidBody3D` had `contact_monitor = false`. In Godot 4 a `RigidBody3D` only
emits `body_entered` / `body_exited` when `contact_monitor` is enabled, so
`_on_crate_body_entered()` was never invoked, no `crate_collision_start` event was ever
recorded, and the acceptance case — which passes only if a `crate_collision_start` event
carries a body path containing `/Ground` — could never succeed. The adjacent
`crate.max_contacts_reported = 8` was dead configuration: it is the per-body cap that
only matters when monitoring is on.

The physics itself was never broken: the crate still fell (`crate_y` 2.992 → 0.347),
still came to rest exactly on the ground (box half-height 0.35 on a ground whose top face
is `y = -0.25 + 0.25 = 0.0`), and still slept. Only the *reporting* of that contact was
missing — exactly the contradiction recorded in `diagnosis.md`.

## The exact line changed

File: `C:\Users\hacke\AppData\Local\Temp\phase14-blind-observation-r7O6Jl\project\scripts\observation_world.gd`

Line 650, in `_build_crate()`:

```diff
-	crate.contact_monitor = false
+	crate.contact_monitor = true
 	crate.max_contacts_reported = 8
```

One line. One boolean literal. Nothing else in the fixture was touched.

## Why this is the smallest correct correction

- It restores the *intended* behaviour rather than simulating it: the fixture already
  contains the handler `_on_crate_body_entered()` (line 337) that records
  `crate_collision_start` with the colliding body's path, and the signal is already
  connected (line 672). Only the monitor switch that enables that signal was off.
- No geometry, layer, mask, spawn height, mass, damping or plate/gate/beacon/player logic
  was touched, so the crate still lands on the same spot: before and after the fix the
  trace reports the identical `crate_position [4.20000743865967, 0.347223967313766,
  2.50000476837158]`, identical `crate_linear_velocity [2.68e-06, -1.05e-05, -8.35e-06]`
  and `crate_sleeping=true`. Only the *report* changed, which is the diagnosis's
  prediction.
- No test was weakened, deleted or modified: `res://tests/run_observation.gd` is
  untouched (SHA-256 `00E00681334691A94E54CD699390CA4D79BFFD47649E66CD75D741128BECA8D5`,
  `LastWriteTime 2026-10-22 19:08:31`, i.e. before the repair edit at 19:47:56). No
  expected value is hard-coded: the crate's landing height is still whatever the physics
  produces, and the event is still produced by the real contact signal.
- The alternative "fixes" were rejected as larger and less correct: raising
  `max_contacts_reported` (already 8), re-adding a shape query / ray cast, or adding a
  synthetic `crate_collision_start` event would all replace a real physical signal with
  a simulated one, and the last one would be exactly the "hard-code the expected value"
  the brief forbids.

## Expected runtime change, verified

The `crate_collision_start` event now appears in the recorded stream with the ground's
real path, emitted by the physics contact at the moment of landing:

```json
{"body": "/root/Main/Ground", "crate_position": [4.19999933242798, 0.347229689359665, 2.50000166893005],
 "sequence": 3, "simulation_step": 46, "tick": 488, "type": "crate_collision_start", "source": "fixture_recorded"}
```

The `crate_falls` trace flipped from `"crate_ground_collision": false` to `true` with
every other field byte-identical.

## Before / after test results

Same command both times:

```powershell
cd C:\Users\hacke\ai-native-engine-phase14\experiments\godot-harness
node controller/harness.mjs test --project "C:\Users\hacke\AppData\Local\Temp\phase14-blind-observation-r7O6Jl\project" --script res://tests/run_observation.gd --json --allow-outside-root
```

**Before**

```
FAIL observation-crate-falls crate_y=0.347 ground_collision=false sleeping=true
RESULT passed=7 failed=1
```

exit code 1 (harness `exitCode: 1`, `ok: false`).

**After**

```
PASS observation-crate-falls crate_y=0.347 ground_collision=true sleeping=true
RESULT passed=8 failed=0
```

exit code 0 (harness `exitCode: 0`, `ok: true`, `reason: "tests passed"`, `errors: []`,
`warnings: []`).

All eight cases now pass:

| case | before | after |
|---|---|---|
| observation-initial-state | PASS | PASS |
| observation-plate-opens-gate | PASS | PASS |
| observation-gate-passable-after-plate | PASS | PASS |
| observation-closed-gate-blocks | PASS | PASS |
| observation-event-stream | PASS (`count=4`) | PASS (`count=5`, `ordered=true`, `fields_ok=true`) |
| observation-reset | PASS | PASS |
| observation-humanoid-probe | PASS | PASS |
| observation-crate-falls | **FAIL** (`ground_collision=false`) | **PASS** (`ground_collision=true`) |

The only observable side effect of the repair is the additional legitimate
`crate_collision_start` event in the stream (`count` 4 → 5); the event-stream case only
asserts `events.size() > 0 and ordered and fields_ok`, all of which still hold.
