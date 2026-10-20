# Phase 8 - Stage D: reproducible repair experiment

Status: complete. No further phase was started.

## Objective

Demonstrate the harness's failure loop from a clean baseline with no manual
recreation of the defect:

```text
inject known defect -> failing test -> captured evidence -> diagnosis
-> one-line fix -> identical test rerun -> verified state
```

The clean baseline remains `fixtures/sentry`. The experiment uses a disposable
copy at `artifacts/repair-run/sentry` (ignored by Git).

## Defect

The committed injection is the exact string replacement in `repair/defect.mjs`:

```gdscript
# clean
var direction := Vector3(strafe, 0.0, -forward)

# injected defect
var direction := Vector3(strafe, 0.0, forward)
```

Forward input therefore moves toward `+Z` instead of the exit at `-Z`.

## Reproduce

From `experiments/godot-harness`:

```powershell
npm run test:repair
```

The runner deletes and recreates the working copy from `fixtures/sentry`, injects
the exact one-line defect, runs `tests/repair.test.mjs`, captures and diagnoses
the failure, restores only `scripts/player.gd`, and runs the same test again.

The test command before and after is identical:

```text
node --test tests/repair.test.mjs
```

with `HARNESS_PROJECT=artifacts/repair-run/sentry`.

## Failing result

Observed before repair:

- exit code **1**
- 1 test, 0 passed, 1 failed
- failing assertion:
  `forward input moved z to 5.99999666213989, expected approximately -6`
- diagnostic snapshot: `phase=active`, `z=+5.99999666213989`,
  `seen_by=[]`
- pure sentry logic suite still **passed**; the defect is confined to live
  movement, not the pure sentry state machine

Evidence:

- `docs/phase8/repair-before.txt`
- `docs/phase8/repair-evidence.json`

## Diagnosis

The first forward step moved from `z=0` toward `+Z` rather than `-Z`. The sentry
state machine was not involved because the player never entered a cone. The
only changed line was the direction construction in `player.gd`; strafe and
vertical motion were untouched. This localized the defect to the sign of the
forward component.

## Targeted fix

Only this line was restored:

```gdscript
var direction := Vector3(strafe, 0.0, -forward)
```

No other gameplay, sentry, bridge, or test file was changed by the repair step.

## Passing rerun

Observed after repair:

- same test, exit code **0**
- 1 test, 1 passed
- diagnostic snapshot: `z=-5.99999666213989`
- escape path returned `phase=won`
- pure sentry logic suite passed

Evidence:

- `docs/phase8/repair-after.txt`
- `docs/phase8/repair-evidence.json`

## Human intervention record

None was needed for the automated experiment. The operator's action is the single
command `npm run test:repair`; injection, diagnosis capture, the one-line
restoration, and the rerun are deterministic scripts. The clean fixture and the
Phase 7 evidence were not modified.

## Limitations

- The focused repair test covers forward movement and the escape route. The full
  gameplay suite remains the broader verification layer.
- The experiment proves the harness can detect and localize this injected
  movement defect; it does not claim autonomous repair of arbitrary bugs.
- The repair is a known one-line restoration, not a generated code change.
