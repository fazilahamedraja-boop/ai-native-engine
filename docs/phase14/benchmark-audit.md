# Phase 14 — Stage B: audit of the Phase 13 diagnosis benchmark

This is a read-only audit of what `experiments/godot-harness/controller/diagnosis-benchmark.mjs`
and `fixtures/phase13-defect` actually do, before Phase 14 changes anything. It exists because
the Phase 13 report said "the AI produced a diagnosis" without stating exactly who invoked the AI
and what the harness did on its own.

The audited code is the Phase 13 version at commit `c78619b` (the Phase 14 baseline).

## 1. How the controlled defect is prepared

| Step | What the code does | Where |
| --- | --- | --- |
| Source of the defect | The defect is a **literal string replacement** in the fixture source, written by hand in the Phase 13 session, not by a script. | `docs/phase12/CONTRACT.md` was written before the edit; the injection itself was done with an ad-hoc script that was deleted afterwards. |
| Where the defect lives | In a **checked-in fixture**, `fixtures/phase13-defect`, a copy of `fixtures/observation` with the defect present. | `fixtures/phase13-defect/scripts/observation_world.gd` |
| Re-injection | The runner gained `inject` / `repair` / `status` modes that patch the checked-in fixture in place, asserting exactly one occurrence of the target line. | `controller/diagnosis-benchmark.mjs` |
| Isolation | **None.** The defect is in the repository's working tree, not in a per-run copy. A second concurrent run would race on the same file. | — |

**Audit finding 1.** The defect is prepared reproducibly, but the *preparation* was not scripted in
the repository; only the re-injection was. And the defect lives in a shared, checked-in file rather
than an isolated per-run copy, so the benchmark was not safe to run twice concurrently and could
leave the repository in a broken state if a run was interrupted.

## 2. How the evidence bundle is produced

`diagnosis-benchmark.mjs prepare` does all of the following itself:

1. runs the acceptance suite on the defective fixture and writes the raw output to
   `evidence/test-output.txt`;
2. opens a **windowed** session, resets, advances the same fixed scenario, and captures a PNG
   (`evidence/frame-on-plate.png`);
3. reads the structured state with `observe()` (`evidence/observation.json`);
4. runs **two** physics-space queries — the plate volume and the gate volume
   (`evidence/physics-queries.json`);
5. writes the fixture snapshot (`evidence/state.json`);
6. writes `task.md` for the agent.

**Audit finding 2.** The bundle is complete and genuinely source-free: it contains the failing
test output, a fresh screenshot, the structured observation, the event stream, the physics-query
results, and the snapshot. There is no diff, no source, and no answer key in it.

**Audit finding 3.** The bundle is produced by the *same* runner that later produces the "after"
bundle. A bundle from a different capture path would be a stronger control, but there is only one
path.

## 3. How the repair location and answer key are hidden

| Protection | Present? | How |
| --- | --- | --- |
| No source in the bundle | yes | The bundle contains only the five evidence files and a PNG. |
| No diff in the bundle | yes | The injected line is not recorded anywhere in the bundle. |
| No answer key in the bundle | yes | The key was the Phase 13 session's own knowledge, not a file. |
| The agent is told the source is off-limits until it has written a diagnosis | yes | The task file states it, and the Phase 13 run recorded the ordering by file modification time. |
| The ordering is enforced by the harness | **no** | It was checked **after the fact** by comparing `diagnosis.md` and source modification times. Nothing stopped the agent from reading the source first. |
| The acceptance script is protected | yes | It was byte-identical before and after; verified by hashing. |

**Audit finding 4.** The "blind" property rested on an instruction plus a post-hoc timestamp check.
That is weaker than an enforced boundary, but it is not nothing: the ordering was independently
checkable and was checked.

**Audit finding 5.** In the Phase 13 layout the answer key was the orchestrator's own knowledge
rather than a file, so there was no key file to accidentally leak. In the Phase 14 layout the
cases are declarative, so the key **is** a file: `controller/blind-cases.mjs`. That is a new leak
risk that has to be named and handled by instruction, because the file lives in the repository the
agent can read.

## 4. How the AI is invoked

**Audit finding 6 — the important one. The Phase 13 benchmark did not invoke the AI at all.**

There is no agent-facing entry point in the harness. The Phase 13 flow was:

1. a human ran `diagnosis-benchmark.mjs prepare`;
2. a human handed the bundle to an external agent session, out of band;
3. that agent wrote `diagnosis.md`, read the source, applied the fix, and ran the test itself;
4. a human ran `diagnosis-benchmark.mjs verify` and recorded the comparison.

So the *diagnosis, the choice of correction, the edit and the test run* were the agent's, and the
*orchestration* was manual. The Phase 13 report did say the orchestration was manual, but it did
not say that no AI invocation existed in the harness at all — it said "the harness cannot spawn an
agent", which is the same fact stated less plainly. The precise statement is:

> The harness has **no** agent integration of any kind. Every step that involves an AI is a manual
> step performed by the orchestrating operator, who hands over a directory and reads back a file.

**Audit finding 7.** The Phase 13 benchmark ran **once**. There was no second run, no repeat, no
different defect, and no control condition. The Phase 13 report stated the single run's result
without a reliability claim, which was honest, but the benchmark had no way to produce one.

## 5. How the diagnosis and the source change are recorded

| Record | Present? | Notes |
| --- | --- | --- |
| The diagnosis text | yes | `diagnosis.md`, written by the agent. |
| The repair text | yes | `repair.md`, written by the agent: the line before and after, the justification, and the before/after test results. |
| The source change | **no** | Phase 13 recorded the repair *narratively*. The only mechanical proof was that `scripts/observation_world.gd` was byte-identical to the pristine observation fixture afterwards. There was no diff artifact and no measurement of how much the agent changed. |
| The ordering proof | yes | Modification times of `diagnosis.md` and the source file, quoted in the Phase 13 report. |
| Whether the diagnosis was *correct* | partially | The Phase 13 report quoted the agent's diagnosis and its confidence, and the acceptance suite proved the *repair* worked. Whether the stated diagnosis matched the actual defect class was not mechanically checked; it was read by a human. |

**Audit finding 8.** The Phase 13 benchmark measured "did the repair make the test pass", not "was
the diagnosis right". Those are different questions. A lucky fix would have looked identical.

## 6. How the acceptance and regression tests are run

| Check | Present? | Notes |
| --- | --- | --- |
| The same acceptance suite before the repair | yes | `runTests` on the defective fixture; the runner asserts it failed. |
| The same acceptance suite after the repair | yes | `runTests` again; the runner asserts it passed and that the failing count is zero. |
| Regression suites | **no** | The Phase 13 benchmark did not run the other fixture suites. `docs/phase13/test-results.json` records them, but they were run by `controller/safety-checks.mjs`, separately from the benchmark. |
| The acceptance script is unmodified | yes | Hash-compared before and after. |

**Audit finding 9.** The before/after comparison is sound, but the regression suites were a
separate step, not part of the benchmark, so a repair that broke another fixture would not have
been caught by the benchmark itself.

## 7. How output artifacts are protected

| Protection | Present? | Notes |
| --- | --- | --- |
| The runner writes to a fixed path | **no** | `controller/diagnosis-benchmark.mjs` wrote to `docs/phase11/stage-c/` — the *Phase 11* evidence directory. This is the exact hazard Phase 12B hit. |
| The output path is configurable | no | There was no `--out-dir`. |
| Protected directories are refused | no | `controller/evidence-output.mjs` did not exist yet; it was added at the end of Phase 13. |
| A copy is verified by hash | partly | The Phase 13 runner re-hashed the copied PNG. |

**Audit finding 10 — the most serious one.** The Phase 13 benchmark runner writes into
`docs/phase11/stage-c/`, which is **protected Phase 11 evidence**. Running it overwrites committed
Phase 11 evidence. The Phase 12B run had to revert exactly that damage with
`git checkout -- docs/phase11/`. The Phase 13 benchmark inherited the defect from the Phase 11
runner it was modelled on, and the Phase 13 report did not mention it.

## 8. Summary of the audit

| # | Finding | Severity | Addressed in Phase 14? |
| --- | --- | --- | --- |
| 1 | The defect lives in a shared checked-in fixture; no per-run isolation | medium | yes — each run gets its own temporary copy |
| 2 | The bundle is complete and source-free | — | kept |
| 3 | The same runner produces the before and after bundles | low | kept, and recorded as a limitation |
| 4 | The blind property is an instruction plus a post-hoc timestamp check, not an enforced boundary | medium | partially — the ordering is now measured automatically and the run is marked invalid if it was violated |
| 5 | The Phase 14 layout puts the answer key in a repository file | new risk | the key file is named explicitly in every task description as off-limits |
| 6 | **The harness has no agent integration at all; every AI step is manual** | high | **not addressed — documented as the boundary** |
| 7 | The benchmark ran once, with no repeat and no control | high | yes — four cases, two runs each |
| 8 | The source change is recorded narratively, not measured | medium | yes — the changed files are measured against the pristine fixture |
| 9 | Regression suites are not part of the benchmark | medium | yes — the benchmark runs them |
| 10 | **The runner writes into protected Phase 11 evidence** | high | yes — every run writes to a unique configurable directory and protected directories are refused |

## 9. What Phase 14 changes, in one line each

- The defect is prepared into an **isolated per-run copy**, never into the repository.
- The answer key is a **named file** that every task description explicitly forbids.
- The ordering (diagnosis before source) is **measured automatically** and a violation marks the run
  invalid.
- The **source change is measured** against the pristine fixture, so an over-broad repair is
  visible.
- The **regression suites run as part of the benchmark**.
- Every run writes to a **unique configurable directory**, and protected evidence directories are
  refused.
- The **agent invocation is still manual**, and is reported as such.
