# Phase 9 - generalization report

**Status:** complete. Stage E and Stage F both pass. Work stops here.

- Worktree: `C:\Users\hacke\ai-native-engine-phase9`
- Branch: `experiment/phase9-generalization`
- Base: Phase 8 `6667ecc8b0247a63c3b2ac7e2dcfd348343d35cd`
- Stage E commit: `e2f8ff4b72434c6dfe6d7a566ddf143383ef7178`
- Stage F commit: `0da94c9839f53dbf84d85fc5bc28e6d4d210f189`
- This summary is a docs-only follow-up commit.
- No merge, push, reset, rebase, or tag change was performed.

## 1. Starting point and protected state

Phase 9 started from the verified Phase 8 harness commit, not from the custom
engine branch. The sentry fixture and its evidence were treated as fixed.

Verified refs before the Phase 9 report commit:

| Ref | Commit |
| --- | --- |
| `master` | `2c28ee23dd2a6a7d14f598bdd2ff4acf4daf094e` |
| `spike/sentry-mode` | `df973aafaa96847aa6f962337d8f1020f7e7d2b5` |
| `experiment/phase7-godot` | `ebbb21d5edc3680dc6f0e06b55d9e0ca3767f265` |
| `experiment/phase8-godot-harness` | `6667ecc8b0247a63c3b2ac7e2dcfd348343d35cd` |
| `experiment/phase9-generalization` | `0da94c9839f53dbf84d85fc5bc28e6d4d210f189` |

The existing `checkpoint-2026-10-20` tag remains
`d30f19c98afd647f425b03ecd6be17a37d6e3ac4`. The verified backup remains at:

```text
C:\Users\hacke\Backups\ai-native-engine\2026-10-20_155955\ai-native-engine.bundle
```

The main worktree `C:\Users\hacke\ai-native-engine` remains on
`fix/camera-relative-strafe` at `583ec00` and was not modified.

## 2. What Phase 9 added

### Stage E - real physics and repeatability

A separate `fixtures/physics` project with:

- a real `CharacterBody3D` player using `move_and_slide()` in the normal
  `_physics_process` tick;
- a real `StaticBody3D` ground and wall;
- a generic `advancePhysics({ frames, input })` controller operation and an
  `advance_physics` bridge command that waits for actual physics frames;
- a 9-case headless suite covering floor contact, motion, wall collision,
  non-penetration, wall sliding, jump/landing, reset, same-process outcome
  repeatability, and a deliberately missing wall collision;
- five fresh-process evidence runs;
- windowed wall/air screenshots;
- a documented limitation distinguishing exact state, selected-field outcome,
  and general physics determinism.

### Stage F - second self-contained mechanic

A separate `fixtures/door` project with:

- a real-physics player and corridor;
- a hinged locked door with collision and visible feedback;
- a key pickup and key-required unlock path;
- reset of player, door, key, prompts, and counters;
- a generic `actions` input map (`{ interact: true }`) added to the controller,
  not a door-specific command;
- a 7-case headless suite;
- live bridge checks with scene-tree and property inspection;
- locked/key/open screenshots;
- a controlled defect/repair experiment: the same suite fails before the repair
  and passes after it.

No Godot source, main worktree, sentry fixture, dependency, editor, or unrelated
feature was changed.

## 3. Stage E results

Commands (from `experiments/godot-harness`):

| Command | Result | Duration |
| --- | --- | --- |
| `npm run test:physics` | exit 0, 9/9 | 20,212 ms |
| `npm run test:physics-control` | exit 0, 2/2 | 20.454 s in the final regression run |
| `npm run test:physics-screenshot` | exit 0, 1/1 | 24,262 ms |
| `npm run evidence:physics` | 5 fresh processes, 9/9 each | 95,888 ms |
| `npm test` | exit 0, 19/19 | 22,662 ms |
| `npm run test:logic` | exit 0, 7/7 | 1,264 ms |

Measured physics values:

- wall stop: `z=-3.33333277702332`, `wall_clearance=0.016667`,
  `wall_contact=true`;
- wall slide: `x=1.41421401500702`, `z=-3.349059`;
- jump air peak: `y=1.553605`;
- missing-wall pass-through: `z=-7.999995`.

Repeatability result:

- All five fresh processes produced identical exact hashes and zero positional
  deltas for the measured suite.
- A repeated same-process wall-contact sequence produced an exact-hash mismatch
  with position delta `0.00000143051147460938` (about `1.43e-6`).
- The quantized `outcome_hash` matched, and the reset-to-settled baseline itself
  matched exactly.
- Therefore the claim is gameplay/outcome repeatability and selected-field
  repeatability, not general bitwise physics determinism.

Failure evidence:

- The negative fixture was a copy with the wall collision shape present but
  disabled.
- The suite exited 1 with 6 passed and 3 failed, `reason: "test cases failed"`,
  and no Godot `ERROR` lines.
- The first negative fixture attempt omitted the collision shape entirely and
  produced a RID leak error; it was replaced with the disabled-shape fixture so
  the recorded failure is about assertions rather than engine resource errors.

The Stage E gate was documented in `docs/phase9/stage-e-physics.md` before Stage
F began. The gate passed with the exact-hash limitation recorded.

## 4. Stage F results

### Headless suite

Command:

```powershell
npm run test:door
```

| Run | Exit | Cases | Duration | Log SHA-256 |
| --- | --- | --- | --- | --- |
| 1 | 0 | 7/7 | 24,544 ms | `FE3AC56A90AB1B5E7A7917F16D146E5A8DE1FB2C2B7FC7658BDD03DBF691548F` |
| 2 | 0 | 7/7 | 20,723 ms | `FE3AC56A90AB1B5E7A7917F16D146E5A8DE1FB2C2B7FC7658BDD03DBF691548F` |

The logs are byte-identical. The elapsed-time difference is measured startup
variance on this machine, not a performance claim.

Key values:

- Initial: door locked, open false, key available, prompt `APPROACH THE DOOR`.
- Too far: feedback `TOO FAR`, locked attempts 0, distance `5.500000`.
- Locked/no key: feedback `LOCKED - KEY REQUIRED`, z `0.500116`, blocked z
  `0.500116`, attempts 1.
- Key: held, unavailable, invisible, distance `0.050000`, feedback
  `KEY ACQUIRED`.
- Unlock/open: `UNLOCKED - DOOR OPEN`, open true, z `-3.499981`, opens 1,
  rotation reached the configured 100-degree angle within the test tolerance.
- Reset: immediate step 0, all initial fields restored, settled hash equals the
  baseline:
  `03a99e65f6ba53a8b571fff64003bdf91ec908c25023ec9fd37f44551f681cd5`.
- Same-process repeatability: exact hash match true, outcome match true,
  position delta `0.000000000`; outcome hash
  `6cdff7cf8e61adf41e058e9aaedb150e9295249272ee3122256400e265313459`.

The exact hash matched in this fixture and run. That is a measured result, not a
general determinism claim. Stage E's `1.43e-6` counterexample remains the
governing limitation.

### Live control and runtime inspection

Command:

```powershell
npm run test:door-control
```

Result: exit 0, 1/1, 20,868 ms.

The live test verified through the generic bridge:

- `inspectState()` scene tree contains `Door`, `Key`, and `Player`;
- initial `Door.locked=true` and `Door.open=false`;
- after a locked attempt, `Door.locked` is still true;
- after pickup, `Key.visible=false`;
- after unlock, `Door.locked=false`, `Door.open=true`, and
  `/root/Main/Door/Collision:disabled=true`;
- after reset, `Collision.disabled=false`, `Key.visible=true`, and the settled
  hash equals the initial baseline.

The structured record is `docs/phase9/stage-f-inspect.json`.

### Screenshots

Command:

```powershell
npm run test:door-screenshot
```

Result: exit 0, 1/1, 21,135 ms. Three 1280x720 PNGs:

| File | Size | SHA-256 |
| --- | --- | --- |
| `stage-f-locked.png` | 49,708 bytes | `3AA83792A9CFE4D761C038E9698E1AA89605093546AB480ED25588CCA6331968` |
| `stage-f-key.png` | 43,404 bytes | `4B6E38A8DBF8EAB0AA96E7A94146CB2B1BE50841CB28C3C744313E94F987D472` |
| `stage-f-open.png` | 45,370 bytes | `772B050C274F5C2D4B0403534224305158E4FCEDEAD716075C18D62476DCD3C2` |

They show the closed/locked state, the key-held state, and the opened doorway.

### Defect and repair

Command:

```powershell
npm run test:door-repair
```

The runner copied the fixture to the ignored `artifacts/door-defect/` path,
replaced the key check with an unconditional true branch, ran the same
`res://tests/run_door.gd` suite, repaired the line, and reran the same suite.

| Phase | Exit | Cases | Failing case | Duration |
| --- | --- | --- | --- | --- |
| before | 1 | 6/7 | `door-locked-no-key` | 19,607 ms |
| after | 0 | 7/7 | none | 19,516 ms |

Failing detail:

```text
FAIL door-locked-no-key feedback=UNLOCKED - DOOR OPEN z=0.500116 blocked_z=-1.499884 attempts=0
```

After repair the same case reported `LOCKED - KEY REQUIRED`,
`blocked_z=0.500116`, and `attempts=1`. The record is
`docs/phase9/stage-f-repair.json`.

## 5. Regression summary

Run from `experiments/godot-harness` after the Stage F changes:

| Command | Result | Duration |
| --- | --- | --- |
| `npm test` | exit 0, 19/19 | 23,307 ms |
| `npm run test:logic` | exit 0, 7/7 | 3,518 ms |
| `npm run test:physics` | exit 0, 9/9 | 20,889 ms |
| `npm run test:physics-control` | exit 0, 2/2 | 21,092 ms |
| `npm run test:door` | exit 0, 7/7 | 20,723-24,544 ms (two runs) |
| `npm run test:door-control` | exit 0, 1/1 | 20,868 ms |
| `npm run test:door-screenshot` | exit 0, 1/1 | 21,135 ms |
| `npm run test:door-repair` | before 6/7 exit 1; after 7/7 exit 0 | 39,977 ms total |

The sentry fixture and its tests were not changed. The new input validation has
negative controller tests; the valid action path is covered by the live door
test.

## 6. Human interventions, failed attempts, and limits

Human interventions:

- The user defined the Phase 9 stages, the real-physics requirement, the
  Stage E gate, the separate-fixture requirement, and the defect/repair loop.
- No human code edits or manual test steps were required for Stage E or Stage F.
- No autonomy beyond the requested scope is claimed.

Failed attempts:

- Stage E's first negative fixture omitted the collision shape and produced a
  RID leak; it was replaced with a disabled-shape fixture so the failure evidence
  is about the acceptance assertions.
- Stage F's first live control run failed a strict reset-position assertion
  because Godot returned `0.850000023841858` for a requested `0.85`. The test
  now compares with a `0.001` tolerance. This was a test precision issue, not a
  product failure.
- The Stage F defect was intentionally introduced by the repair script and is
  not presented as an accidental bug.

Limits:

- The physics fixture is one capsule, one ground box, one wall box, and 60 Hz.
- The door fixture is one door, one key, one corridor, and 60 Hz.
- There is no general interaction, inventory, save/load, animation, audio,
  networking, or keyboard-binding proof.
- The `actions` map is a harness control surface, not a real keyboard event.
- Screenshots require a window; headless runs cannot capture images.
- Exact physics determinism is not established. Stage E's measured same-process
  difference and the outcome-only fallback remain the correct claim.
- No cost, performance, frame-rate, or general engine-robustness claim was made.
  Durations are wall-clock measurements on this machine.

## 7. Evidence index

Stage E:

- `docs/phase9/stage-e-physics.md`
- `docs/phase9/stage-e-physics.json`
- `docs/phase9/stage-e-run-*.log`
- `docs/phase9/stage-e-failure.*`
- `docs/phase9/stage-e-wall.png`
- `docs/phase9/stage-e-air.png`

Stage F:

- `docs/phase9/stage-f-generalization.md`
- `docs/phase9/stage-f-suite.log`
- `docs/phase9/stage-f-run-1.log`
- `docs/phase9/stage-f-run-2.log`
- `docs/phase9/stage-f-control.log`
- `docs/phase9/stage-f-inspect.json`
- `docs/phase9/stage-f-screenshot.log`
- `docs/phase9/stage-f-locked.png`
- `docs/phase9/stage-f-key.png`
- `docs/phase9/stage-f-open.png`
- `docs/phase9/stage-f-repair.json`
- `docs/phase9/stage-f-repair-before.log`
- `docs/phase9/stage-f-repair-after.log`
- `docs/phase9/stage-f-repair.log`
- `docs/phase9/stage-f-regression-*.log`

## 8. Final state and stop

Phase 9 demonstrates that the harness can carry a second, self-contained
mechanic through generic project, physics, input, inspection, reset, and
screenshot operations. The only harness-level addition needed was the generic
`actions` map; the door and key behavior stayed in the fixture.

The branch is not merged or pushed. The protected refs and backup are intact.
The work stops here for review.
