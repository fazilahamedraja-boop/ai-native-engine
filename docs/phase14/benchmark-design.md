# Phase 14 — Benchmark design

## 1. Goal

Measure whether an AI agent can **repeatedly** identify and repair controlled defects using
evidence rather than guessing, and make harness failures diagnosable enough that the evidence
can be trusted.

The Phase 13 benchmark answered "can it do this once?". Phase 14 asks "does it work, repeatedly,
across different defect classes, and can the harness be trusted to tell us the truth about it?".

## 2. What is reused

Nothing new is built for the observation layer. The Phase 14 benchmark is a composition of
existing pieces:

| Piece | Where it comes from |
| --- | --- |
| `HarnessSession` — windowed start, `advancePhysics`, `captureFrame`, `observe`, `physicsQuery`, `stop` | Phase 8–12 |
| The generic observation bridge with `observe` and `physics_query` | Phase 10 / Phase 12B |
| The observation fixture (player, plate, gate, beacon, crate, humanoid) | Phase 10 |
| The door fixture (player, key, locked door, `interact` action) | Phase 6 / Phase 8 |
| `runTests` and the fixture acceptance scripts | Phase 8–10 |
| `controller/evidence-output.mjs` — configurable, protected-directory-refusing output | Phase 13 |
| The defect-to-repair evidence shape | Phase 10 Stage D, Phase 11 Stage C, Phase 13 |

## 3. The four controlled defects

Each case is a **one-line** change to an isolated copy of an existing fixture. The four are in
different subsystems, in two different scenes, and produce different evidence signatures and
different failing acceptance cases. They are not three variations of one operator inversion.

| Case | Scene | Subsystem | Failing acceptance case(s) | The contradiction the agent must find |
| --- | --- | --- | --- | --- |
| `plate-never-registers` | observation | gameplay **state transition** — the plate's `body_entered` guard is inverted | `observation-plate-opens-gate`, `observation-gate-passable-after-plate` | the player physically occupies the plate volume (a physics query returns the player's own `CharacterBody3D`) and the plate is armed on the right layer, yet the plate reports clear and no plate event exists |
| `crate-does-not-fall` | observation | **physics configuration** — the crate's `gravity_scale` is 0 | `observation-crate-falls` | the crate is awake and stationary at exactly its spawn height after 90 ticks while the rest of the scene runs; two physics queries show it is up at the spawn height and absent from the resting height |
| `crate-contact-not-published` | observation | **event and signal handling** — the crate's `contact_monitor` is off | `observation-crate-falls` | the crate fell and came to rest on the ground, and a physics query at the resting height returns both the crate and the ground, so they are in real contact — yet the fixture published no contact event |
| `door-does-not-swing` | **door** (different scene, different mechanic) | **interaction response** — the door's open transition does not rotate the panel | `door-unlock-open-pass` | the state says the door is open and its collider is off, and a physics query finds no collider in the doorway, but the door panel never rotated and the doorway still looks closed |

The last case is worth a note: the door fixture keeps its own smaller bridge, so the benchmark
copies the **observation** bridge into the isolated copy — the same pattern the Phase 10
door-reuse test uses. The door scene and its scripts are untouched, and its acceptance script
`res://tests/run_door.gd` is byte-identical to the pristine one.

### How the cases were chosen

Ten candidate one-line defects were evaluated empirically against the unchanged acceptance suites
before any were selected. Four candidates produced **no** test failure and were rejected:

| Rejected candidate | Why it was rejected |
| --- | --- |
| gate collider never disabled | the gate also rises out of the way, so the player still passes — the suite stays green |
| door collider never disabled | the door panel rotates away, so the collider no longer blocks — the suite stays green |

That is a useful negative result: a defect that does not change the observable outcome is not a
defect, and the benchmark would have measured nothing.

## 4. The isolation model

Every run gets its own temporary copy of the source fixture. The repository's fixtures are never
modified.

```
prepare --case <id> --out-dir <dir>
  1. copy the source fixture to a fresh temporary directory
  2. copy the observation bridge in, if the case needs the generic surface
  3. apply the one-line defect, asserting exactly one occurrence is replaced
  4. run the unchanged acceptance suite -> must FAIL; record the failing cases
  5. open a windowed session, run the case's fixed scenario, and collect
     the screenshot, the structured observation, the event stream, and the
     physics-query results
  6. write the evidence bundle and task.md, and record the case state
```

```
verify --case <id> --out-dir <dir>
  1. re-run the same acceptance suite on the same isolated fixture
  2. re-run the same live scenario and collect the after evidence
  3. measure the source change against the pristine fixture
  4. check the acceptance script is byte-identical
  5. check the diagnosis was written before the source was first modified
  6. check the stated diagnosis matches the defect class
  7. run the Phase 8-13 regression suites
  8. write result.json
```

```
cleanup --case <id> --out-dir <dir>
  remove the temporary fixture
```

## 5. What the agent may see

The agent receives a **read allow-list** in `task.md`:

- `evidence/test-output.txt` — the failing acceptance output
- `evidence/observation.json` — structured state, node transforms, collision shapes, layer/mask, events
- `evidence/physics-queries.json` — the physics-space query results
- `evidence/state.json` — the fixture snapshot
- `evidence/<label>.png` — a fresh screenshot

The bundle contains **no source, no diff, and no answer key**. The answer key lives in
`controller/blind-cases.mjs`, which every task description names explicitly as off-limits.

The agent is told to write its diagnosis to `diagnosis.md` **before** opening the fixture source.
The benchmark then checks, automatically, that `diagnosis.md`'s modification time is not later than
the source file's. A run that violates the ordering is marked `ordering_respected: false` and
does not count as a success.

The agent is also told which file it is expected to change, and that the acceptance script is the
oracle and must not be modified. The benchmark verifies both.

## 6. What the benchmark measures

| Metric | Definition |
| --- | --- |
| `diagnosis_matched_defect_class` | the diagnosis text contains at least one keyword for the case's defect class |
| `ordering_respected` | `diagnosis.md` was written no later than the first source modification |
| `oracle_intact` | the acceptance script is byte-identical to the pristine one |
| `agent_changed_files` | the files the agent changed, measured against the pristine fixture |
| `minimal_repair` | exactly one file changed, and it is the file that carried the defect |
| `test_before` / `test_after` | the acceptance summary and the failing case names |
| `runtime_change` | the before and after snapshots side by side |

## 7. Repeatability

Each case is run **twice**, in two independently prepared isolated fixtures with two separate
output directories. Nothing is shared between the two runs of a case.

**The sample is deliberately small.** Four cases × two runs is eight trials. That is enough to
expose a case that is systematically hard or systematically easy, and to tell a stable result from
a lucky one. It is **not** enough to claim a reliability percentage, and the report does not.

## 8. The human/AI boundary

This is stated plainly because it is the most important limitation:

> **The harness contains no agent integration.** There is no function that spawns an agent, hands
> it a bundle, and reads back a decision. Every step that involves an AI is performed manually by
> the orchestrating operator: preparing the bundle, invoking an external agent session with the
> bundle, and reading the agent's written output back.

What the agent decides on its own: the diagnosis, the choice of correction, the edit, and the test
run. What the operator does: orchestration and bookkeeping.

The ordering guarantee is therefore procedural, but it is **checkable**: the benchmark measures
the file modification times and marks a run invalid if the diagnosis came after the source was
read. That is a weaker guarantee than an enforced sandbox, and the report says so.

## 9. What would make this stronger

- A harness-level agent adapter, so the whole loop — prepare, diagnose, repair, verify — runs
  without an operator in the middle.
- A sandbox that makes the fixture source unreadable until the diagnosis file exists, rather than
  relying on an instruction plus a timestamp check.
- More defect classes, and more than two runs per class.
- A control condition: the same cases with the evidence withheld, to measure how much the
  evidence actually contributes.
