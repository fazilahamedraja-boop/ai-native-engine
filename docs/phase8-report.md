# Phase 8 report: isolated Godot verification harness

Status: complete for the staged Phase 8 scope. Not merged. No further phase was
started.

- Branch: `experiment/phase8-godot-harness`, based on `master` at `2c28ee2`.
- Harness: `experiments/godot-harness/`.
- Usage guide: [`experiments/godot-harness/README.md`](../experiments/godot-harness/README.md).
- Evidence: [`docs/phase8/`](.).
- Phase 7 comparison branch remains `experiment/phase7-godot` at `ebbb21d`.
- `master` remains `2c28ee23dd2a6a7d14f598bdd2ff4acf4daf094e`; `spike/sentry-mode`
  remains `df973aafaa96847aa6f962337d8f1020f7e7d2b5`.

## Verdict

**All seven acceptance criteria passed for the selected sentry fixture, with
documented scope limits.** The central limit is explicit: this proves
repeatable requested-step behavior for the fixture's kinematic movement path; it
does not prove that arbitrary Godot physics is deterministic.

The harness is deliberately separate from engine source. `git diff master..HEAD`
contains no `src/` or `addons/` changes. The Phase 7 fixture was copied, not
edited, and no merge, reset, rebase, tag, or push was performed.

## What was delivered

| Area | Result |
| --- | --- |
| Headless logic | Existing sentry suite, 7/7, structured JSON and exit code |
| Live gameplay | 8 headless tests: movement, detection rise/decay, escape, failure, reset, jump, same-process and fresh-process repeatability |
| Lifecycle | Owned `start_project`, `run_tests`, `inspect_state`, `stop_project`; PID-matched bridge; only the owned child is stopped |
| Control | Pause/resume, persistent input, requested steps, reset, scene tree, property reads |
| State | Structured snapshots and SHA-256 hashes over selected fields only |
| Visual evidence | Two 1280x720 windowed screenshots, 54,319 and 47,863 bytes |
| Repair | Deterministic one-line defect; failing test exit 1; diagnosis; one-line fix; same test exit 0 |
| Clean copy | Full `npm test` 18/18 and logic 7/7 from a fresh copy under `%TEMP%` |
| Safety | Input, step/delta, path, project-root, and property validation; no false pass on missing/mismatched test results |

## Acceptance criteria

### 1. Isolation and preservation - PASS

- The worktree and branch are separate from the engine and Phase 7.
- `master`, `spike/sentry-mode`, and `experiment/phase7-godot` retain the hashes
  above.
- The Phase 7 worktree is clean; the sentry fixture was copied from Phase 7
  commit `ebbb21d`.
- The verified bundle still exists at
  `C:\Users\hacke\Backups\ai-native-engine\2026-10-20_155955\ai-native-engine.bundle`
  (1,242,757 bytes, timestamp unchanged).
- No engine source, addon, or new third-party dependency was introduced.

### 2. Four structured operations and lifecycle - PASS

The library exposes distinct operations:

| Operation | Result contract |
| --- | --- |
| `start_project` | `ok`, `pid`, `port`, project, duration, readiness, ping, log tail |
| `run_tests` | parsed cases, summary, `exitCode`, `signal`, `timedOut`, errors, stdout/stderr |
| `inspect_state` | paused snapshot, scene tree, bridge events, process log tail |
| `stop_project` | `exitCode`, signal, `killed`, log tail; idempotent when already stopped |

`startProject()` rejects a bridge whose reported PID differs from the spawned
child. It resolves the Windows `godot.cmd` shim to the real executable and spawns
without a shell. `stopProject()` sends `quit`, waits for that exact child, and
only calls `child.kill()` if the same child fails to exit. It never searches for
Godot by name.

The session isolation test starts two projects, stops one, and confirms the
other still answers. No harness-owned Godot process remained after the final
test run. The CLI exposes `test` and `inspect`; the four operations are available
through `HarnessSession` and `runTests()`.

### 3. Headless logic and live gameplay coverage - PASS

- Headless pure suite: **7/7**, exit 0, `ok: true`, no Godot errors or warnings.
- Headless gameplay suite: **8/8**, covering movement, detection rise/decay,
  escape/win, detection loss, reset, jump/land, and repeatability.
- Structured live scenario record: **9/9** checks.
- Screenshots are a separate windowed test, so the gameplay gate does not depend
  on rendering.

Observed values from `docs/phase8/stage-c-live.json`:

| Scenario | Observed |
| --- | --- |
| Forward movement, 80 steps | `z=-5.99999666213989` |
| Detection rise | `0.677777777777777`, seen by `guard-a` |
| Detection decay | `0.327777777777779`, outside cones |
| Escape | `phase=won`, exit distance `0.00000763148971935209` |
| Failure | `phase=lost`, detection `1` |
| Reset | `phase=active`, detection `0`, step `0` |
| Jump/land | takeoff y `0.93416`, air y `1.78416`, landed y `0.850238` |

### 4. Pause, requested steps, inputs, snapshots, hashes - PASS (fixture scope)

The harness supports pause, explicit `step({steps, delta, input})`, persistent
input, reset, `recordEvery` sampling, and snapshots. Jump and restart are
edge-triggered and consumed by the first step.

The first implementation called `CharacterBody3D.move_and_slide()` from the
paused bridge. That produced different distances for the same 60-step sequence:
`z=-1.5` in one run and `z=-3.9648` in another. This was a real engine limitation,
not a test failure to hide. The fixture now uses explicit
`move_and_collide(Vector3 * delta)` motion plus a short downward `test_move`
probe. The same 80-step sequence then produced exactly the repeatable result
above.

The hash covers only selected simulation fields:

```text
step, phase, detection, player position xyz, player velocity xyz,
grounded, seen guard ids, exit distance
```

Camera transform, HUD text, port, PID, uptime, and render timing are excluded.
The same sequence produced the same hash in the same process and a fresh process:

```text
10b28fcb8890a0f8a7d4b1df880341a5ca417533c2a6beb8e2d9b1fee3bf974b
```

This is **not** a claim that arbitrary Godot physics is deterministic. The
fixture is flat, has no wall colliders, and uses a split horizontal/vertical
kinematic path. Moving platforms, complex collision response, and
`move_and_slide()` behavior are outside the tested claim.

### 5. Reproducible defect and repair loop - PASS

The clean baseline is `fixtures/sentry`. `npm run test:repair` copies it to an
ignored working directory, injects one exact defect, runs the focused test,
captures the failure and a diagnostic snapshot, restores only the movement line,
and reruns the same test.

- Defect: forward movement uses `+forward` instead of `-forward`.
- Before: test exit **1**, `z=+5.99999666213989`, pure logic suite still passed.
- Diagnosis: the player moved away from the exit; the changed sign localizes the
  fault to `scripts/player.gd`.
- Fix: restore exactly
  `var direction := Vector3(strafe, 0.0, -forward)`.
- After: same test exit **0**, `z=-5.99999666213989`, escape path `won`, pure
  logic suite passed.

Human intervention: **none required for the automated experiment**. The
operator command is `npm run test:repair`; injection, capture, restoration, and
rerun are deterministic scripts. This demonstrates detection and targeted
localization for one known defect, not general autonomous repair.

### 6. Validation, project restriction, and evidence honesty - PASS

- The controller rejects projects outside the harness root unless
  `--allow-outside-root` is explicitly passed.
- It validates `res://.gd` test scripts, step counts, deltas, input keys and
  ranges, and screenshot paths.
- The bridge independently validates node paths, property existence, absolute
  screenshot location, and step ranges.
- The test parser fails on missing or mismatched `RESULT` counts and on Godot
  `ERROR`/`SCRIPT ERROR` lines, even when the process exits zero.
- `start_project`, `run_tests`, `inspect_state`, and `stop_project` return
  observed values; no success is reported from an unchecked exit code.
- The bridge is loopback-only and has no authentication. This is documented as a
  local verification surface, not a sandbox or remote service.

Validation regression coverage is in `tests/controller.test.mjs`: outside-root
rejection, invalid steps/delta/input, unknown input keys, and screenshot path
traversal are all rejected before a bridge call.

### 7. Deliverables, staging, and no merge - PASS

Stages A-D were completed and documented separately:

- Stage A: `feat: add phase 8 headless test runner`
- Stage B: `feat: add phase 8 control bridge and process lifecycle`
- Stage C: `feat: add phase 8 scripted gameplay and repeatability checks`
- Stage D: `test: add phase 8 reproducible repair experiment`
- Follow-ups: `docs: remove redundant repair patch artifact`, `test: cover harness
  validation boundaries`

Deliverables are the separate harness, its usage README, stage reports, result
JSON, screenshots, repair logs, clean-copy logs, and this report. Nothing was
merged or pushed. The only remote operation in this phase was the pre-existing
`origin` configuration; it was not used.

## Verification log

Run from `experiments/godot-harness` unless noted.

| Command | Observed |
| --- | --- |
| `npm test` | **18/18 passed**, exit 0, 26.4 s |
| `npm run test:logic` | **7/7 passed**, exit 0, 1.458 s, `ok: true` |
| `npm run test:gameplay` | **8/8 passed** |
| `npm run evidence:live` | **9/9 checks passed**, `ok: true` |
| `npm run test:screenshot` | **1/1 passed**, two 1280x720 PNGs |
| `npm run test:repair` | before exit **1**, after exit **0**, `ok: true` |
| clean-copy `npm test` | **18/18 passed**, exit 0 |
| clean-copy `npm run test:logic` | **7/7 passed**, exit 0 |

The clean copy was created under
`C:\Users\hacke\AppData\Local\Temp\opencode\phase8-clean-copy`, excluding Git
metadata, `.godot`, `node_modules`, and generated artifacts. This verifies the
harness does not depend on the Phase 8 worktree's generated state.

## Captured evidence

| Evidence | Purpose |
| --- | --- |
| `docs/phase8/stage-a-run.json` | Structured pure-suite result |
| `docs/phase8/stage-b-inspect.json` | Start/inspect/stop lifecycle record |
| `docs/phase8/stage-c-live.json` | 9/9 live scenario checks and hashes |
| `docs/phase8/live-detection.png` | Detection frame, SHA256 `3905822D21E83B67E8BBBA3CDEB4C7479DE73DDF2B9AD2A7768A66C572CE12CC` |
| `docs/phase8/live-win.png` | Win frame, SHA256 `7573250398298B89005112030EB73F1C5C3F0E418B5B5C01A6135C6E43071921` |
| `docs/phase8/repair-evidence.json` | Before/after repair record |
| `docs/phase8/repair-before.txt` / `repair-after.txt` | Exact failing and passing test output |
| `docs/phase8/final-npm-test.txt` | Final 18/18 run |
| `docs/phase8/final-logic.txt` | Final 7/7 logic run |
| `docs/phase8/clean-copy-test.txt` / `clean-copy-logic.txt` | Clean-copy reproduction |

## Open-source and MCP review

GUT and GdUnit4 were investigated as established open-source Godot test
frameworks. Neither was added: the existing `SceneTree` runner already emits
per-case `PASS`/`FAIL` and a summary, and adding a framework would not remove work
at this scope. No engine source or external implementation was copied.

The existing Godot MCP was reviewed and used as capability evidence. It is
editor/runtime-probe based and does not provide a headless CLI lifecycle or a
manual simulation step, which is the documented gap. No new MCP server or editor
was built.

## Limitations and risks

1. **Physics scope.** The repeatability result is for the fixture's explicit
   kinematic path. It is not a general Godot physics determinism guarantee.
2. **No wall sliding.** Horizontal and vertical motion are split. The selected
   scene is flat and has no wall colliders.
3. **Screenshot scope.** Screenshots require a windowed run; the headless bridge
   returns `SCREENSHOT_UNAVAILABLE_HEADLESS` and never touches the dummy renderer.
4. **Bridge trust.** The bridge is loopback-only but unauthenticated. Path and
   input validation are not a security sandbox; only run trusted projects.
5. **Repair scope.** The experiment proves a known one-line movement defect can be
   detected, diagnosed, fixed, and rerun. It is not a general autonomous repair
   system.
6. **CI.** The harness is a local gate today. It has not been added to a remote
   CI workflow or a release pipeline.
7. **CLI shape.** `start_project` and `stop_project` are library operations; the
   CLI exposes `test` and a bundled `inspect` start/state/stop. A long-lived
   standalone process daemon was deliberately not added.

## Recommendation

Review `experiment/phase8-godot-harness` and decide whether to adopt it. If
adopted, the next focused follow-up should be **CI integration plus one real
physics scenario** to decide whether the explicit kinematic step is sufficient
or whether a true fixed-step Godot physics bridge is needed. That follow-up is
not part of this phase and was not started.

Do not merge this branch into `master` or delete the Phase 7 evidence without a
new, explicit decision.

## Stop state

- Phase 8 stops here.
- No next phase or scope expansion has been started.
- The verified worktree is on `experiment/phase8-godot-harness`; the final
  documentation commit is the only remaining change after this report.
- `master`, `spike/sentry-mode`, `experiment/phase7-godot`, the Phase 7 fixture,
  and the verified backup remain preserved.
