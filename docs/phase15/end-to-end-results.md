# Phase 15 - end-to-end results

Date: 2026-10-22
Case: `crate-does-not-fall` (Phase 14 controlled defect)
Model: `opencode/deepseek-v4.1-flash-free`
OpenCode: `2.0.32`, private server per run (`--standalone`)
Godot: `4.7.2-stable (official)`

Four fresh, independent runs. Each run got its own sandbox, its own private
config root, its own private OpenCode server, a freshly injected defect and a
freshly collected evidence bundle. No run reused a session, a sandbox or an
output directory.

## Summary

| # | Run | Status | Diagnosis | Repair | Acceptance | Total |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `...-crate-does-not-fall-d1` | passed | accepted, 6847 B | `gravity_scale 0.0 -> 1.0`, byte-identical to pristine | 8/8 pass | 165.5 s |
| 2 | `...-crate-does-not-fall-d2` | passed | accepted, 7099 B | `gravity_scale 0.0 -> 1.0`, byte-identical to pristine | 8/8 pass | 176.5 s |
| 3 | `...-crate-does-not-fall-d3` | passed | accepted, 5340 B | `gravity_scale 0.0 -> 1.0`, byte-identical to pristine | 8/8 pass | 109.6 s |
| 4 | `...-crate-does-not-fall-d4-final` | passed | accepted | line deleted (relies on the engine default `1.0`), not byte-identical | 8/8 pass | 184.2 s |

4/4 passed. 3/4 repairs restored the exact pristine line
(`matches_pristine_file: true`); 1/4 removed the injected line instead, which is
behaviourally equivalent because `RigidBody3D.gravity_scale` defaults to `1.0`.
0 failures, 0 retries.

Run 4 was executed after the adapter gained task-text archiving, so the shipped
code path is covered by a run of its own. It is also the run that shows the
adapter does not conflate "passes acceptance" with "is the intended minimal
edit": `matches_pristine_file` is `false` and the diff records exactly what was
removed.

## Baseline per run

Preparation is identical for all three runs because it is the Phase 14
machinery:

- fixture: a fresh copy of `fixtures/observation` in a temp directory;
- injection: `crate.gravity_scale = 1.0` -> `crate.gravity_scale = 0.0` in
  `scripts/observation_world.gd` (`_build_crate`);
- acceptance script: `res://tests/run_observation.gd`;
- before the repair: `passed=7 failed=1`, failing case
  `observation-crate-falls`;
- evidence bundle: `test-output.txt`, `test-result.json`, `observation.json`,
  `physics-queries.json`, `state.json`, `before.png`.

The defect is real and observable: the crate stays at spawn height
`[4.2, 3.0, 2.5]` with zero velocity for the whole scenario while the rest of
the scene runs.

## Per-run timings

| Run | prepare | diagnosis | repair | verification | total |
| --- | --- | --- | --- | --- | --- |
| d1 | 31.1 s | 92.2 s | 31.2 s | 10.7 s | 165.5 s |
| d2 | 31.2 s | 94.6 s | 39.8 s | 10.7 s | 176.5 s |
| d3 | 31.0 s | 40.2 s | 27.5 s | 10.7 s | 109.6 s |
| d4 | 31.0 s | 100.1 s | 42.1 s | 10.7 s | 184.2 s |

Preparation and verification are dominated by Godot startup (about 31 s for the
windowed evidence capture, about 10.7 s for a headless acceptance run). The
agent phases are the variable part: 40-95 s for diagnosis and 27-40 s for
repair.

## Run 1 (`2026-10-22T15-57-15-267Z-crate-does-not-fall-d1`)

Diagnosis (`diagnosis.md`, sha256 `f249f1171d1da699...`):

- Failure: `FAIL observation-crate-falls crate_y=3.000 ground_collision=false
  sleeping=true`, plus the trace snapshot at tick 442 showing
  `crate_position=[4.19999980926514, 3.0, 2.5]` and zero velocity.
- Contradiction: an awake dynamic body 2.65 m above the ground cannot remain at
  spawn with zero velocity for 115 physics frames; the spawn-height physics
  query returns only the crate, the resting-height query returns the ground.
- Ruled out: already landed, hidden support, layer/mask mismatch, static/missing
  collider, physics not running, per-frame reset.
- Proposed correction: make the crate simulate - clear freeze/sleep, or restore
  `gravity_scale = 1.0`.
- Confidence: high that the body is not simulated; medium-high on the exact
  property, because `/root/Main/Crate` reports `properties: {}`.

Repair (`repair.diff`):

```
=== scripts/observation_world.gd ===
@@ line 646 @@
-	crate.gravity_scale = 0.0
+	crate.gravity_scale = 1.0
```

Verification: `ok: true`, `passed=8 failed=0`, previously failing case now
passing. Cleanup: sandbox removed, temp fixture removed, no orphan processes.

## Run 2 (`2026-10-22T16-00-35-926Z-crate-does-not-fall-d2`)

Diagnosis (`diagnosis.md`, sha256 `6e32085a4dd2020f...`):

- Same failure signature, independently re-derived from the evidence.
- Proposed correction: stop holding the crate out of the simulation; remove the
  freeze/forced sleep, "leaving `gravity_scale` at 1.0".
- Confidence: high (~0.85) that the crate is excluded from
  gravity/integration; moderate (~0.55) on the exact mechanism
  (freeze vs forced sleep vs `gravity_scale = 0`).

Repair: identical one-line change, byte-identical to the pristine fixture.

Verification: `ok: true`, `passed=8 failed=0`, no failing cases. Cleanup clean.

## Run 3 (`2026-10-22T16-03-32-610Z-crate-does-not-fall-d3`)

Diagnosis (`diagnosis.md`, sha256 `2a32bec1c8c9b51a...`):

- Proposed correction: clear the initial sleep state, ensure the body is not
  frozen and "confirm `gravity_scale = 1`"; unfreeze on reset if that is the
  mechanism.
- Confidence: high (~0.9) on exclusion from simulation; moderate (~0.6) on the
  exact property, explicitly listing `freeze`, `sleeping`, `can_sleep` and
  `gravity_scale` as observationally equivalent without source.

Repair: identical one-line change, byte-identical to the pristine fixture.

Verification: `ok: true`, `passed=8 failed=0`, no failing cases. Cleanup clean.

## Run 4 (`2026-10-22T16-14-45-082Z-crate-does-not-fall-d4-final`)

Diagnosis: accepted; all five required sections, all seven case keywords, six
values quoted from the evidence. It explicitly warned "do not zero
`gravity_scale`; the body must use normal gravity", and stated ~0.6 confidence
on the precise flag because `properties` is empty in the observation.

Repair (`repair.diff`):

```
=== scripts/observation_world.gd ===
@@ line 646 @@
-	crate.gravity_scale = 0.0
```

The line was deleted rather than restored to `crate.gravity_scale = 1.0`. That
passes acceptance because the engine default is `1.0`, so the observable
behaviour is identical - but it is not the literal pristine line, and the
manifest records `matches_pristine_file: false`. This is the run that
demonstrates the adapter distinguishes "passes the oracle" from "reproduces the
original source exactly".

Verification: `ok: true`, `passed=8 failed=0`, no failing cases. Cleanup clean;
task text archived as `task-diagnosis.md` and `task-repair.md`.

## What the runs demonstrate

- The adapter can hand a real agent an evidence bundle, get an evidence-grounded
  diagnosis, then grant source access and get a working repair - reliably, for
  this defect, with this model.
- The diagnosis step genuinely reasons from evidence: all four runs identified
  the physical contradiction and all four explicitly flagged that the exact
  property could not be distinguished without source. None of them claimed more
  certainty than the evidence allowed.
- The repair step is where the remaining ambiguity is resolved: every run found
  `crate.gravity_scale` at the injection site; three restored `1.0`, one removed
  the line so the engine default applies. All four pass the oracle.
- Isolation held: no run produced a `permission.rejected` event, which means no
  run even attempted an outside path. The boundary itself is verified
  separately in `isolation-design.md`.

## What the runs do not demonstrate

- Repeatability for other defect classes. Only `crate-does-not-fall` was run.
- Repeatability for other models. Only `opencode/deepseek-v4.1-flash-free` was
  run, at the caller's explicit choice.
- Generalization beyond a single-line, single-file defect with a clean
  acceptance oracle.
- That a passing repair is the *intended* minimal edit. One of four runs removed
  the line instead of restoring it; the oracle cannot tell the difference, and
  only `matches_pristine_file` records it.
- That the agent can *run* tests itself: it cannot execute anything by design;
  verification is adapter-side.
