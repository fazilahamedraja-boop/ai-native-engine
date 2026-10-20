# Phase 9 Stage F - locked door and key generalization

**Status:** pass. Phase 9 is complete after this stage.

- Branch: `experiment/phase9-generalization`.
- Stage E commit: `e2f8ff4` (`test: add real physics control and repeatability evidence`).
- Stage F fixture: `experiments/godot-harness/fixtures/door/`.
- The Phase 8 sentry fixture, its bridge, tests, and evidence are unchanged.
- No merge, push, reset, rebase, or tag change was performed.

## 1. What this stage tests

Stage F asks whether the harness can verify a second, self-contained mechanic
using only general-purpose operations:

- start a different Godot project;
- advance real fixed physics with generic input;
- approach a locked door and observe feedback;
- acquire a key;
- unlock and open the door;
- pass through the opened doorway;
- reset every surface;
- inspect the live scene tree and node properties;
- capture windowed screenshots;
- introduce a defect, see the same test fail, repair it, and rerun the same test.

The fixture is a small corridor with a hinged door, a key, a player capsule, and
real `CharacterBody3D` movement. It is not the sentry scene and does not reuse
sentry state.

## 2. General-purpose harness surface

No door-specific harness command was added. The live scenario uses:

| Operation | Use |
| --- | --- |
| `HarnessSession.startProject()` | start `fixtures/door` |
| `HarnessSession.advancePhysics({ frames, input })` | real fixed-tick movement and interaction |
| `HarnessSession.inspectState()` | snapshot, scene tree, bridge/process logs |
| `HarnessSession.property()` | inspect `Door.locked`, `Door.open`, `Collision.disabled`, and `Key.visible` |
| `HarnessSession.reset()` | reset player, door, key, prompts, and counters |
| `HarnessSession.screenshot()` | windowed locked/key/open frames |
| `HarnessSession.stopProject()` | owned-process shutdown |
| `runTests()` | generic headless suite and defect rerun |

### The one generic addition: input actions

The existing input contract had only `forward`, `strafe`, `jump`, and `restart`.
There was no general way for a project to receive an interaction/action button.
Stage F added one generic field:

```js
{ forward: 1, actions: { interact: true } }
```

The controller accepts `actions` as an object of boolean names matching
`[a-z][a-z0-9_]{0,31}`. Names are not door-specific: the door fixture happens to
consume `interact`; another project can consume a different name. The fixture
consumes the action once and clears it, making it edge-triggered.

This is a harness-level input surface, not a door command. The door's state,
range check, key requirement, opening angle, feedback text, and reset logic are
all in `fixtures/door/scripts/`. The bridge copy only implements the same
`advance_physics` operation used by Stage E.

## 3. Fixture design

| Element | Behavior |
| --- | --- |
| Player | `CharacterBody3D`, `move_and_slide()` in `_physics_process`, speed 4, 60 Hz |
| Ground | static box with collision |
| Corridor | left/right walls and a lintel, so the door is the route |
| Door | hinged `StaticBody3D`, 1.6 x 2.2 x 0.2, locked initially |
| Door interaction | within 2.2 m, `interact` tries the door |
| Missing key | feedback `LOCKED - KEY REQUIRED`, attempt count increments, door stays closed |
| Key | gold object at `(2.0, 0.9, 4.5)`, automatic pickup within 1.0 m |
| Key pickup | `KEY ACQUIRED`, key hidden, `player_has_key=true` |
| Unlock | only with the key; door opens to the configured 100 degrees |
| Opening | collision disabled, open count increments, prompt `DOOR OPEN - GO THROUGH` |
| Reset | player spawn, door closed/locked, key visible, counts zero, prompt/feedback initial |
| HUD | door state, key state, prompt, feedback, z, attempts, opens |

The door's collision is disabled with a deferred shape change, which is the safe
path from inside the physics callback. The live test proves the player can pass
through only after unlocking.

## 4. Automated suite

Command:

```powershell
npm run test:door
```

This runs the headless real-physics suite:

```text
res://tests/run_door.gd
fixtures/door
```

Results from two fresh processes:

| Run | Exit | Cases | Duration | Log SHA-256 |
| --- | --- | --- | --- | --- |
| 1 | 0 | 7/7 | 24,544 ms | `FE3AC56A90AB1B5E7A7917F16D146E5A8DE1FB2C2B7FC7658BDD03DBF691548F` |
| 2 | 0 | 7/7 | 20,723 ms | `FE3AC56A90AB1B5E7A7917F16D146E5A8DE1FB2C2B7FC7658BDD03DBF691548F` |

The two logs are byte-identical. The wall-clock difference is measured startup
variance on this machine, not a performance claim.

### Case results

| Case | Observed | Result |
| --- | --- | --- |
| `door-initial-state` | locked `true`, open `false`, key available `true`, prompt `APPROACH THE DOOR`, 60 Hz | pass |
| `door-too-far-feedback` | feedback `TOO FAR`, attempts `0`, distance `5.500000` | pass |
| `door-locked-no-key` | feedback `LOCKED - KEY REQUIRED`, z `0.500116`, blocked z `0.500116`, attempts `1` | pass |
| `door-key-required-and-acquired` | key held, key unavailable/invisible, distance `0.050000`, feedback `KEY ACQUIRED` | pass |
| `door-unlock-open-pass` | prompt `PRESS E TO UNLOCK`, `UNLOCKED - DOOR OPEN`, open `true`, z `-3.499981`, opens `1` | pass |
| `door-reset` | immediate step `0`, all fields initial, settled hash equals baseline | pass |
| `door-same-process-outcome-repeatability` | exact hash match `true`, outcome match `true`, position delta `0.000000000` | pass |

The reset and repeatability hashes were:

```text
baseline/settled: 03a99e65f6ba53a8b571fff64003bdf91ec908c25023ec9fd37f44551f681cd5
outcome hash:     6cdff7cf8e61adf41e058e9aaedb150e9295249272ee3122256400e265313459
```

The exact hash matched in this fixture and run. That is a measured result, not a
general determinism claim. Stage E's `1.43e-6` same-process contact difference
remains the governing limitation.

## 5. Live harness verification and runtime inspection

Command:

```powershell
npm run test:door-control
```

Result: exit `0`, 1/1 test, 20,868 ms. The live test starts the project, pauses,
resets, and runs the same mechanic through the bridge. It checks:

- `inspectState()` returns the live snapshot and scene tree;
- the scene tree contains `Door`, `Key`, and `Player`;
- `Door.locked` is `true` and `Door.open` is `false` initially;
- after the locked attempt, `Door.locked` is still `true`;
- after pickup, `Key.visible` is `false`;
- after unlock, `Door.locked` is `false`, `Door.open` is `true`, and
  `/root/Main/Door/Collision:disabled` is `true`;
- after reset, `Collision.disabled` is `false`, `Key.visible` is `true`, and
  the settled hash equals the initial baseline.

The structured inspection record is `docs/phase9/stage-f-inspect.json`. It
contains full initial/locked/key/open/reset snapshots, the scene tree, and the
property values. The scene tree includes:

```text
/root/Main/Ground
/root/Main/LeftWall
/root/Main/RightWall
/root/Main/Lintel
/root/Main/BackWall
/root/Main/Door
/root/Main/Key
/root/Main/Player
/root/Main/Camera
/root/Main/HUD
```

## 6. Screenshots

Command:

```powershell
npm run test:door-screenshot
```

Result: exit `0`, 1/1 test, 21,135 ms. The windowed run captured three
1280x720 frames:

| File | Size | SHA-256 | Visible state |
| --- | --- | --- | --- |
| `stage-f-locked.png` | 49,708 bytes | `3AA83792A9CFE4D761C038E9698E1AA89605093546AB480ED25588CCA6331968` | closed door, red `LOCKED`, key visible, `LOCKED - KEY REQUIRED` |
| `stage-f-key.png` | 43,404 bytes | `4B6E38A8DBF8EAB0AA96E7A94146CB2B1BE50841CB28C3C744313E94F987D472` | key gone, HUD `KEY: HELD`, `KEY ACQUIRED` |
| `stage-f-open.png` | 45,370 bytes | `772B050C274F5C2D4B0403534224305158E4FCEDEAD716075C18D62476DCD3C2` | door swung open, green `OPEN`, `UNLOCKED - DOOR OPEN`, opens `1` |

The three hashes are distinct. The images show the state transitions, not just
a test pass.

## 7. Deliberate defect and repair

The repair experiment copies the fixture to the ignored
`artifacts/door-defect/` directory, changes one line in the copy, and runs the
same `res://tests/run_door.gd` suite. It does not modify the committed fixture.

Defect:

```gdscript
# original
if player_has_key:

# introduced in the copy
if true:
```

Command:

```powershell
npm run test:door-repair
```

Results:

| Phase | Exit | Cases | Failing case | Duration |
| --- | --- | --- | --- | --- |
| before | 1 | 6/7 | `door-locked-no-key` | 19,607 ms |
| after | 0 | 7/7 | none | 19,516 ms |

The failing detail was:

```text
FAIL door-locked-no-key feedback=UNLOCKED - DOOR OPEN z=0.500116 blocked_z=-1.499884 attempts=0
```

The repair restored `if player_has_key:` and reran the same suite. The after
log shows the locked case passing with `feedback=LOCKED - KEY REQUIRED`,
`blocked_z=0.500116`, and `attempts=1`. The full record is
`stage-f-repair.json`; the two logs are `stage-f-repair-before.log` and
`stage-f-repair-after.log`.

## 8. Regression checks

Run from `experiments/godot-harness`:

| Command | Result | Duration |
| --- | --- | --- |
| `npm test` | exit 0, 19/19 | 23,307 ms |
| `npm run test:logic` | exit 0, 7/7 | 3,518 ms |
| `npm run test:physics` | exit 0, 9/9 | 20,889 ms |
| `npm run test:physics-control` | exit 0, 2/2 | 21,092 ms |

Stage E's physics evidence is unchanged. The new `actions` validation has
negative controller tests; the valid action path is covered by the live door
test.

## 9. Limitations

Not established by Stage F:

- more than one door, key, or inventory item;
- real keyboard/controller bindings, UI focus, or input remapping;
- door animation curves, sound, or persistence;
- networking, multiple players, or save/load;
- general Godot physics determinism;
- performance, frame rate, or cost.

Additional specifics:

- Key pickup is automatic proximity, not an interact action. Only the door uses
  the new `interact` action.
- The screenshot test needs a window; headless runs cannot capture images.
- The repair defect is artificial and deliberately one-line. It proves
  detection/localization/rerun for this fixture, not a user-reported bug.
- The `actions` map is a harness control surface. It does not prove that a real
  keyboard event reaches the door in a packaged game.

## 10. Evidence paths

- `docs/phase9/stage-f-suite.log` and `stage-f-run-1.log`, `stage-f-run-2.log`.
- `docs/phase9/stage-f-control.log`.
- `docs/phase9/stage-f-inspect.json`.
- `docs/phase9/stage-f-screenshot.log`.
- `docs/phase9/stage-f-locked.png`, `stage-f-key.png`, `stage-f-open.png`.
- `docs/phase9/stage-f-repair.json`.
- `docs/phase9/stage-f-repair-before.log`, `stage-f-repair-after.log`,
  `stage-f-repair.log`.
- `docs/phase9/stage-f-regression-npm-test.log`,
  `stage-f-regression-logic.log`, `stage-f-regression-physics.log`,
  `stage-f-regression-physics-control.log`.

## 11. Human interventions and failed attempts

- No human code edits or manual test steps were required in Stage F. The user
  defined the stage scope and the gate.
- The first live control run failed at a strict reset-position assertion:
  Godot returned `0.850000023841858` for a requested `0.85`. The test was
  corrected to compare with a `0.001` tolerance; this was a test precision
  issue, not a product failure.
- The headless suite and the windowed capture passed on their first complete
  runs.
- The defect was intentionally introduced by the repair script and is not
  presented as an accidental bug.

## 12. Gate decision

The harness verifies a second self-contained mechanic through generic project,
physics, input, inspection, reset, and screenshot operations. The only harness
addition is the general `actions` input map. The locked behavior, feedback, key
acquisition, unlock/open, pass-through, reset, runtime inspection, screenshots,
and defect-repair loop are all evidenced.

**Stage F passes.** Phase 9 is complete. The work stops here without merging or
pushing. Stage F is committed separately from Stage E; the Phase 9 summary is a
docs-only follow-up.
