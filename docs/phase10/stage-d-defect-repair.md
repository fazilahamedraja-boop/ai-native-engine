# Phase 10 - Stage D: controlled defect, diagnosis, and repair

Status: complete. Stage D used one scripted defect in a temporary copy of the
Stage C observation fixture. It did not change the observer, the accepted test,
or the Phase 9 fixtures.

## Experiment

The defect is a single inverted relation in the gate guard:

```gdscript
# correct fixture source
if plate_pressed == gate_open:
    return

# injected defect in the temporary copy
if plate_pressed != gate_open:
    return
```

The copy was made with `fs.cpSync` from `fixtures/observation` into a system
temporary directory. `artifacts/` and `.godot/` were excluded. The acceptance
test and all other source files were copied unchanged. The replacement occurred
exactly once.

The defect copy was not committed. The evidence records its source hash, defect
hash, and repaired hash; the test runner recreates it from the committed Stage C
fixture.

## Testable diagnosis

### Observation

At the same checkpoint after 85 forward physics frames, the structured state
and screenshot agreed:

- the pressure plate was pressed;
- the gate remained closed;
- gate collision remained enabled;
- the beacon remained red;
- the player's forward motion was blocked at the gate;
- the HUD showed `PLATE PRESSED`, `GATE CLOSED`, `BEACON: RED`, and
  `GATE STUCK - WAIT`;
- the event stream contained `plate_entered` but no `gate_open`.

The visual evidence is not a separate guess about the state: the screenshot and
the paused observation at the same simulation step were compared field by field
(`plate_pressed`, `gate_open`, `gate_collision_enabled`, `beacon_state`), and all
four matched in both the defect and repaired checkpoints.

### Hypothesis

The gate update guard skips the state change when the plate and gate differ. In
the correct fixture, equality means the gate already follows the plate and the
update can return; inequality means an update is needed. With the inverted
guard, inequality returns instead, so the gate can never follow the plate.

### Prediction

Reversing only that one relation should:

1. make the gate open while the plate is pressed;
2. disable the gate collision;
3. turn the beacon green;
4. let the player pass and reach the goal; and
5. make the unchanged `res://tests/run_observation.gd` suite pass.

### Repair

The temporary copy was restored by applying the inverse token replacement once.
No observer code, test code, node name, or expected value was changed.

```text
source_sha256:  97ca10f4673ea0a6b293207865f5c9506a430d25043c25e21c6ff32539331bdb
defect_sha256:  b8d33dcc8968d4b5be22f6950cd1cd149dd588da35855f0360afa1b0925c77ec
repaired_sha256: 97ca10f4673ea0a6b293207865f5c9506a430d25043c25e21c6ff32539331bdb
repaired_matches_source: true
```

The repair workflow does not read the failure and select a fix from it. It
records the failing run, then applies the inverse of the controlled one-line
injection. The observer remains generic; the test checks behavior, not a source
token.

## Before and after the same test

The identical script `res://tests/run_observation.gd` was run against the
temporary copy before and after the repair. Its SHA-256 was
`abf91c78a6444f7203845311dd08223acbd12ab8fdabbfff55b4ae207b09413d` in both runs.

| Run | Exit | Result | Failing cases |
| --- | ---: | --- | --- |
| Before repair | 1 | 6 passed, 2 failed | `observation-plate-opens-gate`, `observation-gate-passable-after-plate` |
| After repair | 0 | 8 passed, 0 failed | none |

Before-repair details:

```text
observation-plate-opens-gate:
  plate=true gate=false collision=true beacon=red
  events=[reset, player_collision_start, crate_collision_start, plate_entered]

observation-gate-passable-after-plate:
  goal=false z=-1.950
  events include a Gate player_collision_start
```

The other six cases still passed, which is why the defect is behavior-specific:
walking, falling, collisions with the ground, reset, the humanoid inspection, and
the crate did not regress.

Evidence files:

- `docs/phase10/stage-d/stage-d-test-before.json`
- `docs/phase10/stage-d/stage-d-test-after.json`

## Visual and structured correlation

All four captures are 1280x720 windowed PNGs. The captured state is compared
with a paused `observe` result; screenshot ticks are later than the state tick
because rendering advances engine physics frames while the fixture step remains
paused.

| Checkpoint | Defect | Repaired |
| --- | --- | --- |
| Plate pressed | step 89, state tick 110, screenshot tick 118 | step 88, state tick 108, screenshot tick 116 |
| Gate | closed, collision enabled | open, collision disabled |
| Beacon | red | green |
| HUD | `PLATE PRESSED`, `GATE CLOSED`, `GATE STUCK - WAIT` | `PLATE PRESSED`, `GATE OPEN`, `GO THROUGH` |
| Player | z=-0.1667, on plate, forward 4 m/s | z=-0.1667, on plate, forward 4 m/s |
| After 100 more forward frames | z=-1.9497, velocity 0, goal false | z=-7.1842, goal true, gate closed behind |
| Gate collision event | `player_collision_start` on `/root/Main/Gate` at simulation step 116 | gate opened at step 82; closed at step 125 after the player passed |

Capture evidence:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `stage-d-defect-plate.png` | 61,144 | `42d0f40a0389818f6eb21832f37d658b10db0658f345ef8287c8feaa5a0f6def` |
| `stage-d-defect-exit.png` | 65,365 | `ac00d0cc4af3c94c38125bbf2fb335c5a45fd652db4c89f9651861dfc00a4c91` |
| `stage-d-repaired-plate.png` | 64,133 | `82fb0d4959739a10737864097a1dc2d0fe6a5fc6b9b79300d8ab323c28bf75f1` |
| `stage-d-repaired-exit.png` | 57,051 | `b909d4df7f111b0d646b067544f2062c28e832c2d6e4cfa860ad3d49dba52a33` |

The screenshots were inspected directly:

- the defect plate capture shows the player on the glowing plate, the gate
  visibly closed, the red beacon, and the closed-gate HUD;
- the defect exit capture shows the player stopped against the gate;
- the repaired plate capture shows the gate raised, the open passage, the green
  beacon, and the open-gate HUD;
- the repaired exit capture shows `GOAL REACHED` beyond the gate.

The full observations are stored beside the PNGs as
`stage-d-<variant>-<checkpoint>-observation.json`. State matching was true for
all four semantic fields at every checkpoint. Engine-tick deltas at plate
sampling were 15 for the defect and 13 for the repaired run; these are paused
sampling/render overhead, not simulation-step changes.

`stage-d-observations.json` is the run manifest, containing the run ID, Godot
version, process IDs, stop results, patch hashes, test summaries, state
comparison, and the diagnosis record.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| Use one small fixture with a reproducible defect | Pass: one fixture copy, one occurrence replaced, scripted reproduction |
| Correlate visual and structured evidence | Pass: four windowed captures matched four observed fields at the same paused steps |
| Form a testable diagnosis | Pass: visual + state + event evidence led to an inversion hypothesis and a prediction |
| Make a minimal repair | Pass: one token restored; repaired source hash equals the source hash |
| Rerun the same test | Pass: identical script hash, 6/8 before, 8/8 after |
| Keep diagnosis out of the observer | Pass: the generic `observe` contract was reused without defect-specific branches |
| Keep diagnosis out of the acceptance test | Pass: the test checks plate/gate/beacon behavior, not source tokens |
| Preserve Stage C and Phase 9 artifacts | Pass: Stage C fixture and Phase 9 files are unchanged; only the temporary copy was modified |

## Commands and results

```powershell
node --check controller/defect-suite.mjs
npm run evidence:defect
```

`node --check` exited 0. `npm run evidence:defect` exited 0 and wrote the
Stage D manifest and four captures under `docs/phase10/stage-d/`. The test runs
inside that command used the same acceptance script before and after repair; the
before run exited 1 with 6/8, and the after run exited 0 with 8/8.

The full headless gate was run after the Stage D documentation and README
updates; its result is in the Phase 10 final report.

## Limits

- This is a controlled injected defect, not a naturally reported bug. It proves
  the observation/diagnosis/repair loop on one known failure, not general
  diagnosis accuracy.
- The defective copy is temporary. Reproducibility comes from the committed
  Stage C fixture and the scripted one-line replacement, not from a committed
  duplicate project.
- Screenshots are paused viewport captures, not live video understanding.
- Rendering can advance engine ticks. The evidence keeps state ticks, screenshot
  ticks, and simulation steps separate.
- The test suite is small and behavior-level. It does not prove that every
  gameplay defect is observable through the current contract.
- The Stage C limits still apply: direct-child collision/animation/skeleton
  discovery, fixture-defined events, a rigid humanoid without a skin, and no
  general physics determinism claim.

Stage D stops here. The Phase 10 final report summarizes the phase; no merge or
push is part of this stage.
