# Phase 13 — Final report

**Mission:** extend the existing Godot AI harness so an agent can observe a running game,
correlate visual frames with structured runtime evidence, issue controlled gameplay actions,
inspect the results, and use that evidence to diagnose a reproducible defect.

- Worktree: `C:\Users\<user>\ai-native-engine-phase13`
- Branch: `experiment/phase13-live-observation`
- Baseline: `experiment/phase12-verify` at `5da4987` (Phase 12B verified) — **verified against the repository before starting**
- Godot: `4.7.2-stable (official)`, Vulkan 1.3.215
- No merge, push, reset, rebase, retag, or history rewrite was performed.

| Document | Content |
| --- | --- |
| [`capability-inventory.md`](capability-inventory.md) | what was reused, what was added, what is still missing |
| [`live-observation-report.md`](live-observation-report.md) | Stage A — fresh live observation |
| [`action-observation-results.md`](action-observation-results.md) | Stage B — controlled action verified by state |
| [`diagnosis-benchmark.md`](diagnosis-benchmark.md) | Stage C — evidence-driven diagnosis and repair |
| [`test-results.json`](test-results.json) | machine-readable results |
| [`manifest.json`](manifest.json) | frame → timestamp/tick → structured observation map, with artifact hashes |

---

## 1. Reused capabilities

Nothing new was built at the observation layer. Phase 13 composed the Phase 8–12 harness:

- **Windowed startup and owned-process shutdown** — `HarnessSession.startProject()` / `stop()`
- **Real running game time** — `advancePhysics({frames, input})`, which unpauses the tree, waits for
  real fixed physics ticks, and pauses again
- **Fresh frame capture** — `captureFrame()`, 1280×720 PNG with a byte-verified sha256
- **Structured observation and event history** — `observe()`
- **Bounded action input** — `setInput()` / `advancePhysics({input})`
- **Physics-space queries** — `physicsQuery()` from Phase 12B
- **Acceptance-suite execution** — `runTests()` / `harness.mjs test`
- **The defect-to-repair evidence shape** — first used in Phase 10's `defect-suite.mjs`

## 2. New implementation

| Addition | Why |
| --- | --- |
| `controller/evidence-output.mjs` + `tests/evidence-output.test.mjs` | Every Phase 8–12 runner writes to a hard-coded `docs/phaseN/` path. Re-running one of them **overwrites committed evidence** — that happened to Phase 11 during Phase 12B and had to be reverted with `git checkout`. Phase 13 runners take an explicit `--out-dir`, default to a unique `docs/phase13/artifacts/...` path, and refuse any protected directory, including by traversal. 12 test cases. |
| `controller/live-observe.mjs` | Stage A and B: live observation with explicit freshness checking, and controlled actions verified by their resulting state. |
| `controller/diagnosis-benchmark.mjs` | Stage C: produces a source-free evidence bundle plus a task description for an external agent, then re-verifies the same acceptance test after the repair. |
| `controller/safety-checks.mjs` | Stage D: measures startup, shutdown, timeout, stale-evidence, output-path and repeatability properties instead of assuming them. |
| `fixtures/phase13-defect/` | A dedicated copy of the observation fixture carrying one injected one-line defect, so the benchmark has a reproducible target and no Phase 8–12 fixture is touched. |

## 3. Verified behaviour

### Stage A — fresh live observation

A visible Godot window ran the observation fixture while the controller collected four
observations. Each observation paired a fresh PNG with the matching structured state, and every
one was traceable to its frame, wall-clock timestamp, engine tick, and fixture simulation step.

- **4 observations, 4 distinct screenshot hashes, 0 stale suspects**
- Ticks advanced 66 → 129 → 192 → 254; steps 45 → 90 → 135 → 180
- The sequence shows a real runtime change: the player travelled **9.35 m**, pressed the pressure
  plate, opened the gate, turned the beacon green, and walked through
- The bridge log shows `advance_physics start/done` per advance, so the game was **running** between
  captures; the tree was paused only for the frame read
- The screenshots and the structured state agree frame by frame (`PLATE: CLEAR → PLATE: PRESSED`,
  `PLAYER z=5.50 → z=-0.50`, `GATE: CLOSED → GATE: OPEN`)

### Stage B — controlled action

| Action | Verification | Result |
|---|---|---|
| Move forward, 45 frames | expected distance 3.000 m (from the fixture's own `SPEED`), direction, and floor contact | **3.000 m actual, ratio 1.0000, verified** |
| `interact` | the fixture's own counter | 0 → 1, **verified** |

An action is never credited because an input was sent. The movement check pins direction,
distance band, and floor contact, so a player that fell through the floor while "moving" would
fail it.

### Stage C — evidence-driven diagnosis

A dedicated fixture carried one injected one-line defect (an inverted body comparison in the
pressure plate's `body_entered` handler). The evidence bundle contained **no source, no diff, and
no answer key** — only the failing test output, a fresh screenshot, the structured state, the
event stream, and two physics-space queries.

The decisive fact was a contradiction: the physics query over the plate volume returned
`/root/Main/Player`, and the plate was armed on the right layer, yet the fixture reported
`plate_pressed: false` with no plate event at all.

An external agent session received only the bundle and the task description. It:

1. wrote a **falsifiable diagnosis** to `diagnosis.md`, quoting the conflicting values, ruling out
   six alternative hypotheses with evidence, and **explicitly declining to name the exact defect
   site** because the evidence alone could not distinguish a bad collision shape from a bad signal
   connection;
2. then read the source, found the one-operator inversion, and applied the fix;
3. re-ran the **same** acceptance test.

| | Before | After |
|---|---|---|
| Acceptance suite | 6/8, exit 1 | **8/8, exit 0** |
| `plate_pressed` / `gate_open` | false / false | **true / true** |
| Event stream | `reset, player_collision_start, crate_collision_start` | `…, plate_entered, gate_open` |
| Plate-volume physics query | Ground + **Player** | Ground + **Player** (unchanged) |

The last row matters: the physics did not change. The player occupied the plate volume before
and after. What changed is that the fixture now reacts to a fact that was already true — which
is exactly the distinction the Phase 12 physics query was added to make.

**Ordering was verified from the filesystem:** `diagnosis.md` was written at 02:11:21, the fixture
source was first modified at 02:14:27. The evidence files' hashes are unchanged, so the agent did
not edit its own evidence.

**Scope was audited after the repair:** every file in `fixtures/phase13-defect` is byte-identical
to the pristine `fixtures/observation` except `project.godot` (fixture name) and generated
artifacts. The acceptance script is byte-identical — the oracle was not weakened.

### Stage D — safety, lifecycle, regression

| Check | Result |
|---|---|
| Windowed startup/shutdown reliability | 3/3 cycles started and exited 0, no kill, `godot.exe` count 0 before and after |
| Failed startup is detected and bounded | rejected in 25 038 ms, bounded; the real cause (GDScript parse error) is in `session.logTail()` |
| Bounded observation timeout | unknown command rejected in 401 ms |
| A failed capture never returns stale evidence | rejected with `captureFrame requires a paused tree`; before/after hashes distinct |
| Repeated observations reproduce | identical `hash`, `outcome_hash`, and position across two runs |
| Output directories cannot overwrite Phase 8–12 evidence | 12 unit cases, all pass |
| Phase 8–13 fixture suites | 7/7 suites pass, expected counts met |
| Harness node tests | 35 → **47** (12 new cases; no existing test modified) |

## 4. Failed or inconclusive checks

Nothing is claimed as passing that did not pass. The following are the real limitations.

1. **A failed startup is reported as a timeout, not as its cause.** A broken bridge surfaces as
   `Timed out waiting for HARNESS_READY after 20000 ms`. The underlying GDScript parse error *is*
   present in `session.logTail()`, and the safety check confirms it, but it is not attached to the
   thrown error. This is the same weakness that made Phase 12B's root cause hard to find, and it
   is **not fixed** in this phase. It is a real, small, well-defined piece of work.
2. **The diagnosis benchmark ran once.** It shows the loop works; it does not show it is reliable,
   and there is no no-evidence control condition.
3. **The agent integration is manual.** See §6.
4. **The physics query does not expose area overlap.** `collide_with_areas` is not available, so a
   query cannot report the `Area3D` plate itself. The benchmark worked around this by querying the
   plate *volume* and looking for the player's body, which happened to be the fact the diagnosis
   needed. A defect that turned on area-vs-body overlap would need a different query.
5. **Determinism claim scope.** The repeatability result covers this fixture, this fixed input
   sequence, this machine, and this Godot build. It is **not** a general Godot physics determinism
   claim, and the phase brief explicitly forbids making one.
6. **Two bugs in my own Stage D runner, both found and fixed during the phase.** The first version
   of the failed-capture check left the tree resumed, so the follow-up capture threw; and a check
   that threw before `session.stop()` left a windowed Godot process alive, which held the parent's
   stdout pipe open and stalled any shell reading it. Both are fixed with `try/finally` around
   every session, and the final run leaks no process. The second one is a genuine operational
   lesson: **a harness session that throws before `stop()` leaves a Godot window running**.

## 5. Manual steps still required

| Step | Why it is still manual |
|---|---|
| Handing the bundle to the agent | The harness has no agent-facing entry point. The bundle, the task description, and the acceptance test are machine-readable, so this is automatable, but the automation does not exist. |
| Reading the agent's diagnosis back | Same reason. The agent wrote `diagnosis.md`; a runner would have to poll for it. |
| Verifying the diagnosis precedes the source read | Currently done by comparing file modification times by hand. A runner could assert this automatically. |
| Selecting the defect to inject | The injection script is explicit and reproducible, but choosing *which* defect to inject is a human decision. |

## 6. Did the AI genuinely choose, or follow a script?

**The diagnosis was genuinely chosen.** The harness supplied no answer key, the bundle contained
no source or diff, and the diagnosis file was written more than three minutes before the source
was first opened. The agent reasoned from the contradiction, ruled out six alternatives with
evidence, and **declined to over-claim** — it stated that the evidence could not distinguish two
remaining candidate sites and that the source was required to name the line. The repair was then
its own.

**The orchestration was manual.** The harness cannot spawn an agent, hand it a bundle, and read
back a decision. The bundle was handed over by hand and the output read back by hand. This is
recorded as a missing integration in
[`capability-inventory.md`](capability-inventory.md) §3 rather than being presented as automation.

**The sequence was not scripted end to end.** The "walk forward until the plate is reached" part
*is* scripted — that is the scenario, and it is the same in both the before and after runs, which
is what makes the comparison valid. Everything the agent was asked to do — the diagnosis, the
choice of correction, the edit, and the test run — was the agent's.

## 7. State of the repository

| Item | State |
|---|---|
| Phase 8–12 evidence | **untouched**; `git status --porcelain docs/phase8 docs/phase9 docs/phase10 docs/phase11 docs/phase12` is empty |
| Phase 8–12 fixtures | **untouched**; the Phase 13 fixture is a new, separate copy |
| Phase 8–13 branches and commits | intact; no history rewritten |
| Tags | unchanged (`checkpoint-2026-10-20` only) |
| Merge / push | **none** |
| Phase 13 worktree | clean after the final commit |

## 8. The smallest justified next task

**Attach the startup-failure cause to the thrown error.** `HarnessSession.start()` currently
collapses every startup failure into `Timed out waiting for HARNESS_READY after 20000 ms`, and
the real Godot error is only reachable through `session.logTail()`. This is a small, bounded
change to the controller: capture the child's stderr at startup and include the first matching
engine error in the rejection message. It is worth doing because it is the exact failure mode
that hid Phase 12B's root cause and it would hide the next one too.

The second candidate, if the first is done, is the agent-integration step: a runner that writes
the evidence bundle, hands it to an agent, waits for `diagnosis.md`, and asserts the ordering.
The pieces already exist; only the glue is missing.
