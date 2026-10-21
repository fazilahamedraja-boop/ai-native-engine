# Phase 13 — Capability inventory

Baseline: `experiment/phase12-verify` at `5da4987` (Phase 12B verified).
Worktree: `C:\Users\hacke\ai-native-engine-phase13`, branch `experiment/phase13-live-observation`.
Godot: `4.7.2-stable (official)`, Vulkan 1.3.215 renderer on this machine.

This document records which capabilities Phase 13 **reused**, which it **added**, and which
remain **missing**. Nothing here was assumed; each row was exercised during the phase.

## 1. Reused capabilities

Every capability below already existed in the Phase 8–12 harness. Phase 13 added no new
observation primitive, no new bridge command, and no new gameplay mechanic.

| Capability | Where it lives | Exercised in Phase 13 | Verified result |
| --- | --- | --- | --- |
| Windowed game startup / bridge readiness | `HarnessSession.startProject()` — `harness.mjs:279` | Stage A, B, C, D | 3/3 windowed start/stop cycles, exit code 0, no kill, no leaked process |
| Owned-process shutdown | `HarnessSession.stop()` — `harness.mjs:937` | Stage D | exit code 0, `killed: false`, `godot.exe` count 0 before and after |
| Real running game time | `advancePhysics({frames, input})` — `harness.mjs:540` | Stage A, B, C | 4 advances of 45 frames, 2.0–3.1 s wall each; the bridge log shows `advance_physics start/done` per advance |
| Fresh windowed frame capture | `captureFrame()` — `harness.mjs:572` | Stage A, B, C, D | 1280×720 PNG, byte-verified sha256, per-frame hash distinct |
| Structured runtime observation | `observe()` — `harness.mjs:707` | Stage A, B, C | node transforms, properties, collision shapes, layer/mask, event stream |
| Fixture event history | `observe()` → `events` (bridge `harness_events`) | Stage A, C | `plate_entered`, `gate_open`, `plate_exited`, `gate_close`, `goal_reached` observed |
| Bounded action input | `setInput()` / `advancePhysics({input})` — `harness.mjs:511` | Stage B | `forward: 1` and `actions.interact: true` both verified by resulting state |
| Physics-space query | `physicsQuery()` — Phase 12B, `harness.mjs:746` | Stage C | box query over the plate volume returns the player's own `CharacterBody3D` collider |
| Read-only observation contract | `observe` never mutates the scene | Stage D | `step`, `hash`, `outcome_hash`, transforms and collision blocks identical across queries |
| Collision layer/mask publication | Phase 12B `observe` → `collision` | Stage C | plate reported as `collision_layer 1, collision_mask 1, monitoring true, monitorable true` |
| Acceptance-suite runner | `runTests()` / `harness.mjs test` | Stage C, D | 7 fixture suites, all exit 0 |
| Defect-to-repair loop pattern | `controller/defect-suite.mjs` (Phase 10) | Stage C | reused the shape: failing suite → evidence bundle → repair → same suite |

## 2. New in Phase 13

Only four things were added, all of them in the harness's own tooling.

| Addition | Files | Why |
| --- | --- | --- |
| Configurable, guarded evidence output | `controller/evidence-output.mjs`, `tests/evidence-output.test.mjs` | Every Phase 8–12 runner writes to a hard-coded `docs/phaseN/` path. Re-running one of them overwrites committed evidence — this actually happened to Phase 11 during Phase 12B and had to be reverted. Phase 13 runners take an explicit `--out-dir` and refuse any protected directory. |
| Live observation runner | `controller/live-observe.mjs` | Collects fresh frames and matching structured state while a visible game window is running, with explicit freshness checking. |
| Diagnosis benchmark runner | `controller/diagnosis-benchmark.mjs` | Produces a source-free evidence bundle for an external agent, then re-verifies the same acceptance test after the repair. |
| Safety / lifecycle checks | `controller/safety-checks.mjs` | Measures startup, shutdown, timeout, stale-evidence, output-path and repeatability properties instead of assuming them. |
| Dedicated Phase 13 fixture | `fixtures/phase13-defect/` | A copy of the observation fixture carrying one injected one-line defect, so the diagnosis benchmark has a reproducible target that does not touch the Phase 10–12 fixtures. |

## 3. Genuinely missing

| Missing | Status | Note |
| --- | --- | --- |
| Automatic "AI in the loop" harness integration | **Not present.** | The harness has no agent-facing entry point: it can observe, act, and test, but it cannot spawn an AI, hand it a bundle, and read back a decision. Phase 13 drove the diagnosis step **manually** by handing the bundle to an external agent session and reading its written output. The bundle, the task description, and the acceptance test are all machine-readable, so wiring this into the controller is a small, well-defined piece of work — but it does not exist yet and is not claimed. |
| Physics-query parameters beyond shape/mask | Not present | `collide_with_areas`, `collide_with_bodies`, `exclude` and `margin` are not exposed. The Phase 13 benchmark worked around this by querying the plate *volume* and looking for the player's **body**, which is the fact the diagnosis needed. |
| A "what changed" diff between two observations | Not present | The agent compares values itself. There is no structural diff helper. |
| Engine-level event bus | Not present | Event history is still fixture-recorded via `harness_events(since_tick)`. |
| `intersect_point` | Not present | The Phase 12 contract covers shape and ray queries only. |
| Automatic stale-frame detection inside `captureFrame` | Not present | `captureFrame` returns a hash but does not compare it with the previous capture. Phase 13 added the comparison in the runner and in `copyCaptureFile`. |
| Startup-failure diagnostics attached to the thrown error | Not present | A broken bridge surfaces as `Timed out waiting for HARNESS_READY after 20000 ms`. The real cause is in `session.logTail()`, but it is not attached to the error. See the Stage D note below. |

## 4. Baseline regression (Stage 0)

Measured in the Phase 13 worktree before any change, from
`experiments/godot-harness`:

| Suite | Command | Exit | Passed | Failed |
| --- | --- | --- | --- | --- |
| Harness node tests | `npm test` | 0 | 35 | 0 |
| `character-audit` | `node controller/harness.mjs test --project fixtures/character-audit --script res://tests/run_character_audit.gd --json` | 0 | 4 | 0 |
| `combat` | `… --project fixtures/combat --script res://tests/run_combat.gd --json` | 0 | 3 | 0 |
| `observation` | `… --project fixtures/observation --script res://tests/run_observation.gd --json` | 0 | 8 | 0 |
| `door` | `… --project fixtures/door --script res://tests/run_door.gd --json` | 0 | 7 | 0 |
| `physics` | `… --project fixtures/physics --script res://tests/run_physics.gd --json` | 0 | 9 | 0 |
| `sentry` | `… --project fixtures/sentry --script res://tests/run_tests.gd --json` | 0 | 7 | 0 |

A windowed `inspect` of `fixtures/observation` also succeeded: Vulkan renderer active, bridge
ready on an ephemeral port, clean exit 0.

## 5. Final regression (Stage D)

After all Phase 13 changes, from the same worktree:

| Suite | Exit | Passed | Failed |
| --- | --- | --- | --- |
| Harness node tests (`npm test`) | 0 | 47 | 0 |
| `character-audit` | 0 | 4 | 0 |
| `combat` | 0 | 3 | 0 |
| `observation` | 0 | 8 | 0 |
| `door` | 0 | 7 | 0 |
| `physics` | 0 | 9 | 0 |
| `sentry` | 0 | 7 | 0 |
| `phase13-defect` | 0 | 8 | 0 |

The harness node-test count rose from 35 to 47 because Phase 13 added
`tests/evidence-output.test.mjs` (12 cases). No existing test was modified or removed.
