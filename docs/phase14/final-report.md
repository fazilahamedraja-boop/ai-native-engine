# Phase 14 — Final report

**Mission:** make harness failures diagnosable, then measure whether an AI can repeatedly identify
and repair controlled defects using evidence rather than guessing.

- Worktree: `C:\Users\hacke\ai-native-engine-phase14`
- Branch: `experiment/phase14-reliable-diagnosis`
- Baseline: `experiment/phase13-live-observation` at `c78619b` — **verified against the repository
  before starting** (all four reported Phase 13 commits present and in order)
- Godot: `4.7.2-stable (official)`
- No merge, push, reset, rebase, retag, or history rewrite was performed.

| Document | Content |
| --- | --- |
| [`startup-failure-diagnostics.md`](startup-failure-diagnostics.md) | Stage A — startup failures that explain themselves |
| [`benchmark-audit.md`](benchmark-audit.md) | Stage B — what the Phase 13 benchmark actually did, and its ten findings |
| [`benchmark-design.md`](benchmark-design.md) | Stage C — the four defect cases and the isolation model |
| [`blind-diagnosis-results.md`](blind-diagnosis-results.md) | Stage C/D — the eight runs and the measured rates |
| [`test-results.json`](test-results.json) | machine-readable results for every run |
| [`stage-e-safety.json`](stage-e-safety.json) | Stage E — regression, isolation and cleanup measurements |
| [`runs/`](runs/) | per-run manifests, diagnoses, repairs and evidence bundles |

---

## 1. Implemented functionality

### Stage A — startup failures that explain themselves

Two files changed.

**`controller/startup-diagnostics.mjs` (new)** classifies a startup failure and builds an
actionable error carrying a machine-readable `code`, the process state, the engine's own error
lines, and the tail of both output streams:

| Code | Meaning |
| --- | --- |
| `spawn_failed` | the process could not be spawned |
| `process_exited` | the process died before readiness (exit code and signal included) |
| `script_error` | the engine reported a script or parse error |
| `autoload_error` | the engine reported an autoload failure |
| `connection_failed` | the bridge published a port but the socket failed |
| `protocol_error` | the readiness payload was not a valid handshake |
| `game_not_ready` | the bridge answered but the scene never became ready |
| `slow_startup` | the process was alive, reported no error, and never signalled readiness |

The precedence is the point. A live process **with** an engine error is reported by that error, not
as a timeout. A live process with **no** engine error is a genuinely slow start, and stays
distinguishable from a startup that has already failed.

**`controller/harness.mjs` (modified)** uses that classifier at every failure path, so a broken
bridge now reports:

```
Godot startup failed: script_error
  phase: ready
  project: fixtures/observation
  pid: 23844
  process: still running
  elapsed: 20038 ms (readiness limit 20000 ms)
  engine error:
    SCRIPT ERROR: Parse Error: Expected end of statement after expression, found ":" instead.
       at: GDScript::reload (res://harness/bridge.gd:389)
    ERROR: Failed to load script "res://harness/bridge.gd" with error "Parse error".
    ERROR: Failed to instantiate an autoload, script 'res://harness/bridge.gd' does not inherit from 'Node'.
  stdout tail: ...
  stderr tail: ...
```

instead of `Timed out waiting for HARNESS_READY after 20000 ms`. **The timeout was not increased and
no error was suppressed.**

**Cleanup is now guaranteed.** Sessions register themselves so `stopAllSessions()` can clean up a
session whose caller threw; `withSession(session, body)` always stops in a `finally` block; and
`stop()` destroys the child's stdout and stderr pipes, so a windowed Godot that survived the kill
cannot hold the parent's pipes open and stall a shell that reads them.

### Stage B/C — a repeatable, isolated blind-diagnosis benchmark

`controller/blind-benchmark.mjs` with `prepare` / `verify` / `cleanup` / `status` / `list` modes,
`controller/blind-cases.mjs` holding the four controlled defects, and `controller/blind-results.mjs`
aggregating the runs.

The ten findings from the Phase 13 audit are addressed in `benchmark-audit.md` §9. The two that
mattered most:

- The Phase 13 runner wrote into the **protected** `docs/phase11/stage-c/` directory. Every Phase
  14 run writes to a unique configurable directory, and `controller/evidence-output.mjs` refuses a
  protected directory.
- The Phase 13 defect lived in a **shared checked-in fixture**, so runs could not be isolated.
  Every Phase 14 run gets its own temporary copy of the source fixture; the repository's fixtures
  are never modified.

## 2. Actually verified behaviour

### Stage A — 14 new tests, four controlled failure scenarios

| Scenario | Result |
| --- | --- |
| Invalid GDScript in an isolated copy | reported as `script_error` with the parse error and the `at: bridge.gd:389` line in the message |
| Project exits before readiness | reported as `process_exited`, exit code 3 |
| Process starts but never signals readiness | reported as `slow_startup` — alive, no engine error, no exit code |
| A valid project | starts normally |
| A genuinely slow project (bridge delayed 3 s) | with a 1 200 ms limit → `slow_startup` with no engine errors and no exit code; with a 20 000 ms limit → starts normally |
| Cleanup | `stopAllSessions()` cleans up an abandoned session; `withSession()` stops a session whose body throws; no `godot.exe` left behind in any case |

No protected fixture was modified: the observation fixture is copied to a temporary directory and
the copy is broken.

### Stage C/D — 8 runs, 4 defect cases, 2 repetitions each

| Metric | Count |
| --- | --- |
| Baseline failure reproduced as expected | 8 / 8 |
| Diagnosis matched the defect class | 8 / 8 |
| Diagnosis written before the source was opened | 8 / 8 |
| Acceptance suite failed before → passed after | 8 / 8 |
| Acceptance script byte-identical | 8 / 8 |
| Repair was exactly one line | 8 / 8 |
| Repair restored the file byte-for-byte to pristine | 8 / 8 |
| Unrelated source changes | 0 |
| Startup errors / timeouts | 0 / 0 |

**Eight trials is a count, not a reliability percentage.** Four defect classes, two repetitions
each, deliberately chosen cases, and no control condition. The report does not claim a
probability and does not claim statistical significance.

### Stage E — regression, isolation, cleanup

| Check | Result |
| --- | --- |
| `npm test` | **65 / 65**, exit 0 (47 at the baseline, +14 startup diagnostics, +4 benchmark contract) |
| `character-audit` | 4/4, exit 0 |
| `combat` | 3/3, exit 0 |
| `observation` | 8/8, exit 0 |
| `door` | 7/7, exit 0 |
| `physics` | 9/9, exit 0 |
| `sentry` | 7/7, exit 0 |
| `phase13-defect` | 8/8, exit 0 |
| Protected evidence (`docs/phase8` … `docs/phase13`) | `git status` clean; sha256 recorded |
| Repository fixtures | unmodified |
| Run output directories | 8/8 under `docs/phase14`, all unique |
| Isolated fixtures | 8/8 outside the repository, all distinct |
| Temporary fixture directories left behind | 0 |
| Godot processes left running | 0 |

No pre-existing test was weakened, skipped, or removed. The 61 tests that existed at the baseline
still pass, unchanged.

## 3. AI diagnosis results

The four cases, the contradictions the agents had to find, and the exact one-line repairs are in
[`blind-diagnosis-results.md`](blind-diagnosis-results.md) §4 and §5.

The single most important observation: **in all 8 runs the repaired file was byte-identical to the
pristine upstream fixture.** The agents did not find a different value that also passed — they
restored the original line. In the door case one agent noticed that `OPEN_ANGLE_DEGREES := 100.0`
was already declared and referenced nowhere, and repaired the line by reconnecting the existing
declaration rather than guessing a value.

## 4. Human-assisted steps

This is the most important limitation in the phase, so it is stated without softening:

> **The harness contains no agent integration of any kind.** There is no function that spawns an
> agent, hands it a bundle, and reads back a decision. Every step involving an AI was performed
> manually by the orchestrating operator: running `prepare`, invoking an external agent session
> with the bundle, and reading the agent's written output back.

What the agent did on its own: the diagnosis, the choice of correction, the edit, and the test run.

What the operator did: orchestration, bookkeeping, and the final verification.

The "blind" property is **procedural, not enforced**. The agent is instructed to write
`diagnosis.md` before opening the source, and the benchmark **checks** that by comparing file
modification times; a violating run would be marked invalid. All 8 runs respected it. A sandbox
that makes the source unreadable until the diagnosis exists would be stronger and is listed as the
next task.

The answer key is a **file** in the repository (`controller/blind-cases.mjs`), and every task
description names it as off-limits. That is a leak risk the Phase 13 layout did not have, handled
by instruction.

## 5. Failed or inconclusive experiments

- **No run failed.** The benchmark measured no failures, so it produced no failure-mode data.
- **Ten candidate defects were evaluated before three were chosen.** Two were rejected because they
  produced **no** test failure at all — the gate collider and the door collider both still let the
  player through, because the gate rises and the door swings away. A defect that does not change
  the observable outcome is not a defect, and the benchmark would have measured nothing. This is a
  useful negative result, and it is recorded in `benchmark-design.md` §3.
- **One measurement bug was found and fixed during the phase.** The first version of the repair
  measurement compared the repaired file against the *pristine* fixture. Because a correct
  one-line repair restores the file to pristine, that comparison reported "no change" for the
  strongest possible repair and marked all 8 runs as failures. The measurement was corrected to
  compare against the **defective** state the agent was given, plus a separate
  `repaired_to_pristine` flag. The verification was re-run and the results above are from the
  corrected measurement.
- **One cleanup gap was found and fixed during the phase.** The benchmark's own test created
  temporary fixtures and removed only the output directory, leaving two fixture copies in the
  system temp directory. The Stage E check detected it. The test now calls the benchmark's
  `cleanup` mode, and the Stage E check now reports zero.
- **There is no control condition.** The same cases were never run with the evidence withheld, so
  the contribution of the evidence itself is not measured. An agent that knew the fixture well
  enough might have found these defects without the bundle.
- **The defect classes were chosen by the operator**, who knows where the defects are. Nothing here
  measures how an agent finds a defect it was not told about.
- **The startup-diagnostics work was not exercised by the benchmark.** The benchmark ran without a
  single startup error, so that change is validated by its own test suite, not by the benchmark.
- **No general Godot determinism claim is made.** The benchmark used a fixed scripted scenario and
  fixed physics ticks on one machine and one Godot build.

## 6. Remaining limitations and the next justified task

### Remaining limitations

1. No agent integration (above).
2. The blind property is procedural, not sandboxed.
3. Eight trials is too small for a reliability claim.
4. The answer key is a repository file, protected only by instruction.
5. The benchmark measures the *repair* mechanically but the *diagnosis* only by keyword match. A
   diagnosis that matched the keywords but reasoned wrongly would score as a match.
6. The physics query still cannot report area overlap, so a defect that turned on area-vs-body
   contact would need a different query.

### The next justified task

> **Add a harness-level agent adapter, and sandbox the source until the diagnosis exists.**

Concretely: an `agent` mode on the benchmark runner that takes an agent command, hands it the
bundle, waits for `diagnosis.md` to appear, and only then makes the fixture source readable —
enforced by the filesystem, not by an instruction. That closes the two weakest parts of this phase
at once: the manual orchestration, and the procedural-only blind property.

It is a small, well-defined piece of work: the pieces (bundle, ordering check, verification) all
exist; only the glue and the sandboxing are missing. It is deliberately **not** a general agent
framework — one adapter, one mode, no new observation surface.

## 7. Commits and repository state

| Commit | Content |
| --- | --- |
| `7cc75c2` | `feat: make harness startup failures explain themselves` |
| `1f47ffd` | `feat: add repeatable blind-diagnosis benchmark with isolated fixtures` |
| (this commit) | `docs: add phase 14 evidence and final report` |

| Item | State |
| --- | --- |
| Phase 8–13 evidence | untouched; `git status` clean, sha256 recorded |
| Phase 8–13 fixtures | untouched |
| Phase 8–13 branches and commits | intact; no history rewritten |
| Tags | unchanged (`checkpoint-2026-10-20` only) |
| Merge / push | **none** |
| Phase 14 worktree | clean after the final commit |
