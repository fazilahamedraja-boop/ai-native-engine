# Phase 15 - agent adapter contract

Implementation: `experiments/godot-harness/controller/agent-adapter.mjs`
Sandbox config: `experiments/godot-harness/controller/agent-sandbox/opencode.json`

The adapter is the first integration between the Godot AI-native harness and a
real coding agent. It takes a controlled defect plus its evidence bundle,
drives an OpenCode session through diagnosis and repair, and returns a
structured result. It is deliberately small: the observation, test and
verification machinery from Phases 8-14 is reused unchanged.

## 1. Command line

```
node controller/agent-adapter.mjs run \
  --case <case-id> \
  --model <provider/model[#variant]> \
  [--label <name>] \
  [--out-dir <docs/phase15/runs/...>] \
  [--timeout-ms <n>]

node controller/agent-adapter.mjs list
```

- `--case` is one of the four Phase 14 controlled defects
  (`plate-never-registers`, `crate-does-not-fall`,
  `crate-contact-not-published`, `door-does-not-swing`). `list` prints them.
- `--model` is required and is passed to `opencode run --model` verbatim. The
  adapter has no default model and never substitutes one.
- `--label` names the run (default `run`) and appears in the output directory.
- `--out-dir` must resolve inside `docs/phase15/runs`; anything else is refused,
  including every protected Phase 8-14 evidence directory.
- `--timeout-ms` bounds each agent phase independently (default 300000 ms).
  On timeout the whole process tree is killed with `taskkill /T /F`.
- `OPENCODE_BIN` overrides binary discovery; otherwise `%APPDATA%\npm\...\opencode.exe`
  is used, then `where opencode`.

Exit code is `0` when the run passed and `1` when it failed. The single-line
JSON printed to stdout is a summary; the authoritative record is
`manifest.json`.

## 2. Phases and ordering

The manifest records the exact order that ran:

```
prepare
sandbox-evidence
diagnosis-run
source-grant
repair-run
change-validation
verification
cleanup
```

1. **prepare** - invokes `controller/blind-benchmark.mjs prepare`, which copies
   the source fixture to a temp directory, injects the one-line defect, runs the
   acceptance script (asserting it fails), collects structured state, events,
   physics queries and a screenshot, and writes `case-state.json`.
2. **sandbox-evidence** - creates the per-run sandbox and copies only
   `prepared/evidence/*` into it, plus `task-diagnosis.md`.
3. **diagnosis-run** - one OpenCode session, evidence only. Must write
   `diagnosis.md`.
4. **source-grant** - validates the diagnosis, copies the diagnosis out of the
   sandbox, then copies the defective fixture into `sandbox/project/` (minus
   `.godot` and `artifacts`) and writes `task-repair.md`.
5. **repair-run** - a *separate* OpenCode session in the same sandbox, now with
   source available. Must change `project/`.
6. **change-validation** - hashes the oracle (`project/tests/**`), diffs every
   project file against the state the agent was given, extracts the patch and
   checks the change touches the injected file.
7. **verification** - runs the real acceptance script with the Godot harness
   against the agent's project copy.
8. **cleanup** - removes the sandbox, removes the prepared temp fixture, checks
   that every spawned OpenCode process is gone.

## 3. Diagnosis validation

`diagnosis.md` is rejected unless all of the following hold:

- file exists and is at least 200 characters;
- contains an H1 and the sections `Failure`, `Contradiction`,
  `Hypotheses ruled out`, `Proposed correction`, `Confidence`;
- names one of the case's expected failing acceptance cases;
- matches at least two of the case's diagnosis keywords;
- quotes at least one decimal number that actually occurs in
  `evidence/test-output.txt`.

The last two checks are the plausibility gate. They are computed in the adapter
process from `blind-cases.mjs`; the sandbox never contains them. The gate
cannot prove reasoning quality - it proves the artifact is specific, grounded
and about the right failure. The three successful runs show what a passing
diagnosis looks like.

## 4. Verification

Verification is performed by the adapter, outside the sandbox, with
`runTests({ project, script: caseDef.testScript })`. The agent cannot run Godot
itself: there is no shell and no code mode in the sandbox. This is a deliberate
trade-off - giving the agent command execution would destroy the isolation
boundary, and the acceptance result is more trustworthy when produced by the
untouched harness.

A run passes only when:

- the diagnosis was accepted;
- at least one project file changed;
- the changed file is the injected file;
- no file under `project/tests/**` changed;
- no project file was deleted;
- the acceptance script exits 0 with `ok: true` and zero failing cases.

## 5. Artifacts per run

Everything under `docs/phase15/runs/<stamp>-<case>-<label>/`:

| Path | Content |
| --- | --- |
| `manifest.json` | authoritative record: status, failure reason, ordering, timings, hashes, validation, changed files, acceptance, cleanup |
| `diagnosis.md` | the accepted diagnosis, copied before the repair phase |
| `repair.diff` | human-readable diff of every changed file |
| `repair.md` | the agent's own repair note, when it wrote one |
| `verification-test-output.txt` | raw Godot output of the post-repair acceptance run |
| `logs/diagnosis.jsonl` | raw OpenCode event stream, diagnosis phase |
| `logs/repair.jsonl` | raw OpenCode event stream, repair phase |
| `logs/*.stderr.txt` | raw stderr for each phase |
| `prepared/` | the Phase 14 preparation record (evidence, case state, task) |

## 6. Failure model

The adapter fails closed. Recorded failure reasons include:

| Condition | Reason recorded |
| --- | --- |
| diagnosis phase nonzero exit | `diagnosis run exited with code N` |
| diagnosis phase timeout | `diagnosis run timed out after N ms` |
| no diagnosis written | `the agent did not write diagnosis.md` |
| diagnosis implausible | `diagnosis rejected: <specific problems>` |
| repair phase nonzero exit / timeout | analogous messages |
| no change | `the agent made no change to the project` |
| deleted file | `the agent deleted a project file` |
| oracle modified | `the agent modified the test oracle: ...` |
| acceptance fails | `verification failed (exit N); still failing: ...` |

There is no retry, no fallback model and no synthetic diagnosis. A failed run
leaves its manifest, logs and whatever the agent produced, then exits 1.

## 7. Guarantees and non-guarantees

Guaranteed by the adapter:

- unique output directory per run;
- provenance of every artifact (sha256 in the manifest);
- bounded wall-clock time per phase;
- no write outside `docs/phase15/runs` and the per-run temp sandbox;
- the answer key and the original repository are never mounted;
- the oracle cannot change without failing the run;
- the sandbox and temp fixture are removed even on failure;
- the model is whatever the caller specified.

Not guaranteed:

- that a diagnosis is correct, only that it is grounded and specific;
- that the repair is the minimal one - only that it touches the injected file
  and passes the acceptance suite (`matches_pristine_file` records whether it
  happens to be byte-identical to the pristine fixture);
- OS-level containment (see `isolation-design.md` section 5);
- repeatability across models or across cases. The three runs in
  `end-to-end-results.md` demonstrate repeatability for one case and one model
  only.
