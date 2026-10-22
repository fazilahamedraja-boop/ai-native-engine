# Phase 14 — Blind diagnosis results

Machine-readable results: [`test-results.json`](test-results.json). Per-run evidence:
[`runs/`](runs/).

## 1. What was run

Four controlled defect cases, each in its own isolated copy of an existing fixture, each run
**twice** in two independently prepared fixtures with two separate output directories. Eight trials
in total.

Every run followed the same protocol:

1. **prepare** — copy the source fixture to a fresh temporary directory, inject the one-line
   defect, run the **unchanged** acceptance suite and record the failure, then collect a fresh
   windowed screenshot, the structured observation, the event stream and the physics-query
   results into a bundle containing no source, no diff and no answer key;
2. **agent** — write an evidence-only diagnosis, then read the source, apply the smallest repair,
   and re-run the same acceptance test;
3. **verify** — re-run the same suite and the same live scenario, measure the source change
   against the pristine fixture, check the oracle is byte-identical, check the diagnosis was
   written before the source was first modified, and check the stated diagnosis against the
   defect class.

## 2. Headline counts

| Metric | Count |
| --- | --- |
| Runs | 8 |
| Baseline failure reproduced as expected | **8 / 8** |
| Diagnosis matched the defect class | **8 / 8** |
| Diagnosis written before the source was opened | **8 / 8** |
| Acceptance suite failed before the repair | **8 / 8** |
| Acceptance suite passed after the repair | **8 / 8** |
| Acceptance script byte-identical (not weakened) | **8 / 8** |
| Repair was exactly one line | **8 / 8** |
| Repair restored the file byte-for-byte to pristine | **8 / 8** |
| Unrelated source changes | **0 / 8** |
| Full success (all of the above) | **8 / 8** |
| Incorrect diagnoses | **0** |
| Startup errors | **0** |
| Timeouts | **0** |

**This is a count, not a reliability percentage.** Eight trials across four deliberately chosen
defect classes is far too small to claim a probability. What it does support is the weaker and more
useful statement: *the loop worked on every case that was tried, on both repetitions, with no
over-broad repairs and no weakened oracles.*

## 3. Per case

| Case | Scene | Defect class | Runs | Baseline failed | Diagnosis matched | Suite passes after | One-line repair | Restored to pristine |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `plate-never-registers` | observation | gameplay **state transition** | 2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `crate-does-not-fall` | observation | **physics configuration** | 2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `crate-contact-not-published` | observation | **event and signal handling** | 2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |
| `door-does-not-swing` | **door** | **interaction response** | 2 | 2/2 | 2/2 | 2/2 | 2/2 | 2/2 |

The baseline failures also matched the *expected* failing acceptance cases in all 8 runs
(`baseline_failures_matched_expectation: 2/2` for every case), so each agent was looking at the
intended failure and not a different one.

## 4. The repairs, measured

Every repair was measured by diffing the file the agent was given against the file it left, and
against the pristine upstream fixture.

| Case | File | Line | Before | After |
| --- | --- | --- | --- | --- |
| `plate-never-registers` | `scripts/observation_world.gd` | 288 | `if not is_instance_valid(player) or body == player or plate_pressed:` | `if not is_instance_valid(player) or body != player or plate_pressed:` |
| `crate-does-not-fall` | `scripts/observation_world.gd` | 646 | `crate.gravity_scale = 0.0` | `crate.gravity_scale = 1.0` |
| `crate-contact-not-published` | `scripts/observation_world.gd` | 650 | `crate.contact_monitor = false` | `crate.contact_monitor = true` |
| `door-does-not-swing` | `scripts/door.gd` | 93 | `rotation.y = deg_to_rad(0.0)` | `rotation.y = deg_to_rad(OPEN_ANGLE_DEGREES)` |

In all 8 runs the repaired file was **byte-identical to the pristine upstream fixture** — the
agent restored the original line exactly, rather than inventing a different value that also
passed. No run touched any file other than the one that carried the defect.

One detail worth recording: the door case's agent noticed that `OPEN_ANGLE_DEGREES := 100.0` was
already declared in the file and referenced nowhere — a dead constant — and repaired the line by
reconnecting the existing declaration. That is a stronger repair than guessing `100.0`.

## 5. The contradictions the agents had to find

These are the specific falsifiable claims each agent had to support. They are the reason the
Phase 12 physics query exists.

### `plate-never-registers`

> The player physically occupies the plate volume — a physics query over the plate volume at
> `(0, 0.10, −1.1)` returns the player's own `CharacterBody3D` — and the plate is armed
> (`monitoring: true`, `collision_layer 1`, `collision_mask 1`, shape not disabled), yet
> `plate_pressed` is false and the event stream contains no plate event at all.

The agent had to notice that the detection **inputs** were all satisfied and the **detection
callback** was where the fault lay. The plate's `collision` block, published by the Phase 12B
change to `observe`, is what ruled out "the area is disabled" and "the layer is wrong".

### `crate-does-not-fall`

> The crate is awake (`sleeping: false`), stationary with zero velocity, and still exactly at its
> spawn height after 90+ physics ticks, while a physics query at the spawn height finds it and a
> query at the resting height finds only the ground.

The agent had to rule out "the whole scene is frozen" — the player, the plate and the gate behave
normally in the same run — and conclude that this one body's simulation was disabled.

### `crate-contact-not-published`

> The crate fell and came to rest on the ground exactly as it should (`crate_y = 0.347`,
> `sleeping = true`), and a physics query at the resting height returns **both** the ground and
> the crate, so they are in real contact — yet the fixture published **no** contact event.

This is the case where the physics query is the whole diagnosis: the physical contact is proven,
and only the reporting is missing.

### `door-does-not-swing`

> The door reports `door_open: true` and `door_collision_enabled: false`, the player walked
> through, and a physics query at the doorway finds no door collider — but the door's world
> transform never rotated (`door_rotation_degrees: 0`) and the screenshot shows the panel still
> flat in the wall.

Three sources — the state, the physics, and the visual — disagreed, and the agent had to find
which one was lying.

## 6. Human and AI boundary — stated plainly

> **The harness contains no agent integration of any kind.** There is no function that spawns an
> agent, hands it a bundle, and reads back a decision. Every step involving an AI was performed
> manually by the orchestrating operator: running `prepare`, invoking an external agent session
> with the bundle, and reading the agent's written output back.

What the agent decided on its own: the diagnosis, the choice of correction, the edit, and the
test run.

What the operator did: orchestration, bookkeeping, and the final verification.

The ordering guarantee is **procedural, not enforced**. The agent was instructed to write
`diagnosis.md` before opening the source, and the benchmark **checked** that instruction was
followed by comparing the two modification times. A run that violated it would be marked
`ordering_respected: false` and would not count as a success. All 8 runs respected it — the
diagnosis was written 24–60 seconds before the source was first modified in every case.

A sandbox that makes the source unreadable until the diagnosis file exists would be stronger.
That is listed as the next task, not claimed as done.

## 7. What the evidence bundle contained, and what it did not

Per run, the agent-visible bundle was:

| File | Content |
| --- | --- |
| `evidence/test-output.txt` | the raw failing acceptance output |
| `evidence/observation.json` | structured node observations: world transforms, properties, collision shapes, layer/mask, the full event stream |
| `evidence/physics-queries.json` | the physics-space query results for that case |
| `evidence/state.json` | the fixture snapshot at that moment |
| `evidence/before.png` | a fresh windowed screenshot of the running game |
| `task.md` | the task description and the read allow-list |

It contained **no source, no diff, and no answer key**. The benchmark's own test asserts this: it
scans every evidence file for the injected line, for the enclosing function name, and for the
answer-key markers, and fails if any appear.

The answer key itself lives in `experiments/godot-harness/controller/blind-cases.mjs`, and every
task description names that file explicitly as off-limits. That is a new leak risk that the Phase
13 layout did not have — in Phase 13 the key was the orchestrator's own knowledge rather than a
file — and it is handled by instruction, not by sandboxing.

## 8. Failure and inconclusive observations

- **No run failed.** Every run went failing → passing with a one-line repair.
- **No startup errors and no timeouts** occurred during the 8 runs. The Phase 14 startup
  diagnostics were in place, but they were not exercised by the benchmark itself; the scenario
  that exercises them is the `startup-diagnostics` test suite.
- **The sample is small.** Eight trials, four cases, two repetitions each. A case that is hard but
  not impossible could still pass twice; a case that is easy could pass twice for the wrong
  reason. There is no control condition — the same cases were not run with the evidence withheld
  — so the contribution of the evidence itself is not measured.
- **The defect classes were chosen by the operator**, who knows where the defects are. Nothing
  here measures how an agent finds a defect in code it was not told about.
- **The scenarios are scripted.** The walk-to-the-plate, the walk-to-the-key, the settle time:
  those are the experiment's setup, identical in the before and after runs, which is what makes
  the comparison valid. Only the diagnosis and the repair were the agent's.

## 9. Reproduction

```powershell
cd C:\Users\hacke\ai-native-engine-phase14\experiments\godot-harness

node controller/blind-benchmark.mjs list
node controller/blind-benchmark.mjs prepare --case <case> --out-dir <dir>
#   ... the agent reads <dir>/task.md, writes <dir>/diagnosis.md, repairs the fixture ...
node controller/blind-benchmark.mjs verify  --case <case> --out-dir <dir>
node controller/blind-benchmark.mjs cleanup --case <case> --out-dir <dir>
node controller/blind-results.mjs
```

The eight runs in this report are under `docs/phase14/runs/`, each with its own `case-state.json`,
`task.md`, `diagnosis.md`, `repair.md`, `result.json` and `evidence/` bundle.
