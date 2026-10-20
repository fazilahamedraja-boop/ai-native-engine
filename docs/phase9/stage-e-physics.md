# Phase 9 Stage E - real physics control and repeatability

**Status:** pass with documented limits. Stage F may proceed.

- Starting state: Phase 8 commit `6667ecc8b0247a63c3b2ac7e2dcfd348343d35cd`.
- Worktree: `C:\Users\hacke\ai-native-engine-phase9`.
- Branch: `experiment/phase9-generalization`.
- New fixture: `experiments/godot-harness/fixtures/physics/`.
- The Phase 8 sentry fixture, its bridge, tests, and evidence were not changed.
- No merge, push, reset, rebase, or tag change was performed.

## 1. Question

Can the Phase 8 harness control and observe real Godot physics, rather than
only the paused manual `move_and_collide()` path used by the sentry fixture?
If it can, how repeatable are the gameplay outcomes, the selected state fields,
and the exact state hashes under repeated fresh-process runs?

## 2. Method

The Stage E fixture is separate from the sentry fixture and contains:

- a `StaticBody3D` ground with a box collision shape;
- a `StaticBody3D` wall at `z=-4.0` with a box collision shape;
- a `CharacterBody3D` player with a capsule collision shape;
- movement, gravity, jump, `move_and_slide()`, and collision response in the
  engine's normal `_physics_process`;
- an explicit `physics/common/physics_ticks_per_second=60` setting;
- a HUD and camera for windowed screenshots.

The tested movement path is:

```text
fixed harness input -> _physics_process(delta=1/60)
-> velocity update -> move_and_slide()
-> collision response from the Godot physics server
```

There is no hand-written position update or `move_and_collide()` substitution
in the tested movement path. The fixture's `harness_step()` intentionally
returns an error and says to use real physics advance; the Stage E tests do not
call it.

### Controlling real ticks

The project-local bridge copy adds one general-purpose command,
`advance_physics`. It:

1. applies the requested input through `set_harness_input()`;
2. unpauses the `SceneTree`;
3. waits for `N` real engine physics frames;
4. waits for the following idle frame so the last requested tick has completed;
5. pauses the tree again and returns the final snapshot.

The headless acceptance suite uses the same fixed engine ticks directly with
`await physics_frame`; it does not use a paused manual step. This is the
project-local adapter the Stage E requirements prefer.

The controller exposes `HarnessSession.advancePhysics({ frames, input })` and
validates frames (`0..100000`) and input before a bridge call. The generic
controller change was covered by a new unit test. Only the new physics
fixture's bridge copy contains the `advance_physics` command; the Phase 8
sentry bridge is unchanged.

### Observation contract

Each snapshot records the physics step, player position, velocity, actual
motion for the latest tick, grounded state, wall contact, wall clearance,
collision-enabled state, last delta, HUD text, and two hashes:

- `hash`: exact selected simulation fields at `%.9f` precision;
- `outcome_hash`: the same fields rounded to millimetres (`%.3f`), used for the
  outcome-repeatability claim.

The exact hash remains diagnostic evidence. It is not used as a general
determinism claim.

### Scenarios

| Scenario | Input and duration | Assertion |
| --- | --- | --- |
| floor contact | settle 3 ticks | grounded, y near spawn, vertical velocity near zero, 60 Hz |
| forward movement | 30 ticks forward | z moves forward, x stays centered, grounded |
| wall collision | 120 ticks forward | stops at the wall, wall contact, near-zero motion into the wall |
| no pass-through | 120 further ticks into the wall | z remains on the near side |
| wall slide | 120 ticks forward, then 30 ticks forward+strafe | x changes while z stays at the wall |
| jump and landing | 3 settle, 1 jump, 10 air, 80 settle | leaves floor, rises, lands grounded near spawn |
| reset | wall/slide sequence, reset, 3 settle | step 0 immediately; settled state matches the initial settled hash |
| same-process repeatability | wall/slide sequence twice | outcome hash matches and position delta <= 1 mm |
| missing collision detection | disable the wall collision shape, reset, 120 forward | player passes through the wall plane |

## 3. Baseline and regression checks

Before Stage E changes, the Phase 8 baseline was re-run from the Phase 8
worktree:

| Command | Result |
| --- | --- |
| `npm test` | exit 0, 18/18, 21.7 s |
| `npm run test:logic` | exit 0, 7/7, 1.1 s |

After the Stage E harness changes:

| Command | Result |
| --- | --- |
| `npm test` | exit 0, 19/19 (18 Phase 8 tests + 1 new `advancePhysics` validation test), 22.7 s |
| `npm run test:logic` | exit 0, 7/7, 1.3 s |
| `npm run test:physics` | exit 0, 9/9, 20.2 s |
| `npm run test:physics-control` | exit 0, 2/2, 20.9 s |
| `npm run test:physics-screenshot` | exit 0, 1/1, 24.3 s |
| `npm run evidence:physics` | exit 0, 5 fresh processes, 95.9 s total |

The regression logs are `stage-e-regression-npm-test.log` and
`stage-e-regression-logic.log`.

## 4. Scenario results

All values below are from the five-run evidence record. The same values were
observed in all five fresh processes.

| Check | Observed | Result |
| --- | --- | --- |
| floor contact | y `0.850000`, vy `0.000000`, 60 Hz | pass |
| forward movement | z `-2.000001`, x `0.000000`, grounded | pass |
| wall collision | z `-3.333333`, wall clearance `0.016667`, motion z `0.000000`, contact | pass |
| no pass-through | z `-3.333333` after 120 more ticks | pass |
| wall slide | x `1.414214`, z `-3.349059`, motion x `0.047140`, contact | pass |
| jump/landing | takeoff y `0.934160`, air y `1.553605`, land y `0.850238`, grounded | pass |
| reset | immediate step `0`, immediate spawn/zero velocity, settled hash equals baseline `ef7e5862...` | pass |
| missing collision detection | disabled wall, z `-7.999995`, clearance `-4.649995` | pass |

The wall stops at `z=-3.333333`, not the geometric prediction `-3.35`; the
remaining `0.016667` is one quarter of a tick of movement and is inside the
documented `0.06` tolerance. The test does not treat that as a collision miss
because `is_on_wall()` is true, actual motion into the wall is zero, and the
player remains on the near side.

## 5. Repeatability

### Fresh processes

Five separate Godot processes ran the complete suite:

| Run | Exit | Cases | Duration |
| --- | --- | --- | --- |
| 1 | 0 | 9/9 | 19,018 ms |
| 2 | 0 | 9/9 | 19,024 ms |
| 3 | 0 | 9/9 | 19,024 ms |
| 4 | 0 | 9/9 | 19,014 ms |
| 5 | 0 | 9/9 | 19,024 ms |

Across those five fresh processes:

- every gameplay outcome was identical;
- every outcome hash was identical;
- every exact diagnostic hash was identical;
- the maximum position delta for wall z, slide x, jump air y, and missing-wall z
  was `0`.

Representative exact hashes from run 1:

| State | Exact hash |
| --- | --- |
| wall | `342ce8d00e2ef9d6e2b6e22b292f16c6f4be4cc7ea3244dfe3b33a8dcab1381a` |
| no pass-through | `7a6f046e199ad08deaf8a4bca4370359729788d8ef00f7577561606e5a94ff92` |
| slide | `ddb6ecd3c18fb1b113f2d07ec0c0de6d596bfac5d64ce7d03c9a842c73511b46` |
| jump landing | `9414516e64fb10f11f0c0d3eac58f6226be4e3a95e41496e593a66a2156b63b7` |
| reset settled | `ef7e5862fab219bbf4cc8226d08c0ed9f6bc6f677f9381e2b0dd2fe478264fd1` |
| missing collision | `e4e7d11934d5643dd4a531c567e8d2b193dc3f0c2ba763235871e273c96202dd` |

### Same process after contact

The same wall/slide sequence run twice in one process did **not** produce the
same exact hash. The final y position differed by `0.00000143051147460938`
(about `1.43e-6`). The quantized outcome hash matched, and the position delta
was below the 1 mm claim. The reset-to-settled baseline itself matched exactly,
so the difference appears when the second sequence re-enters contact, not when
the player is simply reset.

This is the main Stage E limitation:

- **Gameplay outcomes:** repeatable in this fixture.
- **Selected state fields at millimetre precision:** repeatable.
- **Exact same-process state after repeated contact:** not bitwise repeatable.
- **Fresh-process exact state:** identical in these five runs.
- **General Godot physics determinism:** not claimed.

The same-process repeatability test is therefore named
`physics-same-process-outcome-repeatability`; it asserts the outcome hash and
the 1 mm tolerance, and records `exact_hash_match=false` as evidence rather
than hiding it.

## 6. Failure information and missing-collision sensitivity

A temporary negative copy of the fixture was created under the ignored
`artifacts/physics-no-wall/` directory. Its wall collision shape was added but
disabled at startup, so the control path and scene organization stayed the
same.

Command:

```powershell
node controller/harness.mjs test --project artifacts/physics-no-wall --script res://tests/run_physics.gd --json --out C:\Users\hacke\ai-native-engine-phase9\docs\phase9\stage-e-failure.json
```

Result: exit `1`, 6 passed, 3 failed, `reason: "test cases failed"`, no Godot
`ERROR` lines. The failures were exactly the wall-dependent checks:

```text
FAIL physics-wall-collision z=-7.999995 motion_z=-0.066667 wall_clearance=-4.649995 contact=false
FAIL physics-no-pass-through z=-16.003092 wall_clearance=-12.653092
FAIL physics-wall-slide x=1.414214 z=-9.414199 motion_x=0.047140 contact=false
PASS physics-missing-wall-collision-detected wall_enabled=false z=-7.999995 wall_clearance=-4.649995
RESULT passed=6 failed=3
```

The first negative fixture attempt omitted the collision shape node entirely.
That produced a Godot RID leak error and a less clean failure record; it was
discarded. The committed fixture keeps the shape and the missing-collision test
disables it through the generic `set_wall_collision()` control. The failure
record is `stage-e-failure.json` / `stage-e-failure.log`.

## 7. Screenshots

| File | Size | SHA-256 |
| --- | --- | --- |
| `stage-e-wall.png` | 35,718 bytes | `B88101231FBD0AE1B970D78900603877E080398A8A31A1B4B07BBB1C16CA3608` |
| `stage-e-air.png` | 38,751 bytes | `4C793672B605D7D65B9C48EA8CADD562C1F23F73C33868E761EE93665C6AEAE7` |

Both are 1280x720 windowed captures. The wall image shows `ON FLOOR | WALL
CONTACT`, `z=-3.333`, and the player against the wall. The air image shows
`AIRBORNE | NO WALL CONTACT` and the player above the floor.

## 8. What changed in the harness

- `controller/harness.mjs`: `HarnessSession.advancePhysics({ frames, input })`.
- `tests/controller.test.mjs`: validation test for frames and input.
- `fixtures/physics/harness/bridge.gd`: project-local copy with
  `advance_physics`. The sentry bridge is untouched.
- `fixtures/physics/`: the real-physics fixture, player, scene, and tests.
- `controller/physics-suite.mjs`: five fresh-process evidence runner.
- `tests/physics.test.mjs`: live bridge-control checks.
- `tests/physics-screenshot.test.mjs`: windowed wall and air captures.
- `package.json`: physics commands.
- No new npm dependency, addon, engine source change, or MCP server.

## 9. Limitations and gate decision

Not established by Stage E:

- general Godot physics determinism;
- other collision shapes, meshes, moving bodies, joints, or platforms;
- tick rates other than 60 Hz;
- arbitrary scene sizes or long-running simulation;
- bitwise repeatability of the same process after repeated contacts;
- performance, frame rate, or cost.

The bridge remains loopback-only and unauthenticated. The fixture is a
verification surface, not a security sandbox.

**Gate decision:** the harness can control and observe real Godot physics well
enough to test a small mechanic, and it detects a missing collision shape. The
Stage E result is a pass with the exact-hash limitation documented above.
Stage F may proceed, but it must not inherit a general determinism claim.

## 10. Evidence paths

- `docs/phase9/stage-e-physics.json` - five-run machine-readable record.
- `docs/phase9/stage-e-run-1.log` ... `stage-e-run-5.log` - full per-run logs.
- `docs/phase9/stage-e-failure.json`, `stage-e-failure.log` - negative fixture.
- `docs/phase9/stage-e-regression-npm-test.log` - 19/19 regression.
- `docs/phase9/stage-e-regression-logic.log` - 7/7 logic regression.
- `docs/phase9/stage-e-control.log` - live bridge-control test.
- `docs/phase9/stage-e-screenshot.log` - windowed capture test.
- `docs/phase9/stage-e-wall.png`, `stage-e-air.png` - screenshots.

## 11. Human interventions and failed attempts

- No human code edits or manual test steps were required in Stage E. The user
  set the stage requirements and gate.
- The first direct suite run failed to parse because GDScript could not infer
  the type of several `ok` variables; explicit `bool` annotations fixed it.
- The first windowed run logged `Node not inside tree` from `look_at()` before
  the camera was added; adding the camera first fixed it.
- The first same-process repeatability assertion used the exact hash and
  exposed the `1.43e-6` difference. The test was changed to the documented
  outcome/1 mm claim, and the exact mismatch remains visible in every log.
- The first negative fixture omitted the collision-shape node and produced a
  RID leak error. It was replaced with a disabled-shape fixture so the failure
  record is about the assertions, not cleanup noise.
