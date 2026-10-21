# Godot verification harness

A small, project-local control and verification layer around Godot. It exists to
give an agent or a CI job a set of distinct operations:

| Operation | Entry point | Result |
| --- | --- | --- |
| `start_project` | `HarnessSession.startProject()` | PID, bridge port, readiness, logs, duration |
| `run_tests` | `runTests()` or `node controller/harness.mjs test` | per-case pass/fail, summary, exit code, stdout/stderr |
| `inspect_state` | `HarnessSession.inspectState()` or the `inspect` CLI | snapshot, scene tree, bridge events, process logs |
| `advance_physics` | `HarnessSession.advancePhysics()` | N real fixed physics frames, final snapshot, paused state |
| `capture_frame` | `HarnessSession.captureFrame()` | one actual frame plus run id, tick, timing, hashes, paused state |
| `capture_sequence` | `HarnessSession.captureSequence()` | bounded actual frames sampled after real fixed physics ticks |
| `stop_project` | `HarnessSession.stopProject()` | exit code, signal, whether a kill was needed, log tail |

The controller also exposes pause/resume, persistent input, requested fixed
steps, reset, stable hashes, and windowed screenshots.

This is **not** a new MCP server or an engine fork. The bridge is a project
autoload in `fixtures/sentry/harness/bridge.gd`; it is inert unless the
controller passes `--harness-port=...` after Godot's `--` separator.

## Requirements

- Godot 4.7.2 on `PATH`, or set `GODOT_BIN` to the executable. On Windows the
  controller resolves the `godot.cmd` shim to the real executable so the spawned
  PID is the process that owns the bridge.
- Node.js 20 or newer. There are no npm dependencies.
- The checked-in fixture, or another project with the bridge autoload and game
  interface described below.
- A windowed Godot session for screenshots. `--headless` uses Godot's dummy
  renderer and intentionally returns `SCREENSHOT_UNAVAILABLE_HEADLESS`.

## Quick start

From `experiments/godot-harness`:

```powershell
npm test                 # parser, controller validation, lifecycle, live gameplay
npm run test:logic       # headless pure sentry suite, structured JSON
npm run test:gameplay    # live movement/detection/escape/failure/reset checks
npm run test:screenshot  # windowed screenshots copied into docs/phase8
npm run test:repair      # failing tests/repair.test.mjs -> one-line fix -> rerun
npm run evidence:live    # structured scenario record with hashes
npm run test:physics     # real fixed-tick physics suite, 9 cases
npm run test:physics-control      # live advance_physics bridge checks
npm run test:physics-screenshot   # windowed wall/air captures
npm run evidence:physics # five fresh-process physics repeatability record
npm run test:door        # locked-door/key real-physics suite, 7 cases
npm run test:door-control         # live bridge + inspect/property checks
npm run test:door-screenshot      # windowed locked/key/open captures
npm run test:door-repair          # failing defect -> repair -> same-test rerun
npm run evidence:visual           # windowed door captures + sampled approach sequence
npm run inspect          # start, inspect, stop one project, JSON result
```

`npm test` is the normal headless gate. `test:screenshot` is separate because it
needs a window; `test:repair` is separate because it intentionally runs a
failing test first. The physics and door commands use separate, self-contained
projects and do not change the sentry fixture.

## CLI

```text
node controller/harness.mjs test   --project fixtures/sentry [--json] [--out result.json]
node controller/harness.mjs inspect --project fixtures/sentry [--windowed] [--json]
```

Useful options:

```text
--project <path>          Project root relative to this directory
--script <res://...>      Test entry script (default res://tests/run_tests.gd)
--scene <res://...>       Explicit scene to launch
--windowed                Launch with a window instead of --headless
--allow-outside-root      Explicitly allow a project outside this harness
--timeout-ms <number>     Startup timeout
--out <path>              Write the full structured result to a file
```

Exit codes:

- `test`: `0` when the parsed suite passed and the process exited cleanly; `1`
  when a case failed, the summary mismatched, a `RESULT` line was missing, Godot
  emitted `ERROR`, or the process failed; `2` for CLI/validation errors.
- `inspect`: `0` only when start, state inspection, and owned-process stop all
  succeeded; `1` otherwise; `2` for CLI/validation errors.

`inspect` returns a wrapper `inspect_project` with `start`, `state`, `stop`, and
logs. The nested state operation is named `inspect_state`. The class API exposes
the four operations directly.

## Library API

```js
import { HarnessSession, runTests } from './controller/harness.mjs'

const pure = await runTests({ project: 'fixtures/sentry' })

const session = new HarnessSession({
  project: 'fixtures/sentry',
  headless: true,
})
try {
  const started = await session.startProject() // start_project
  await session.pause()
  await session.reset()

  const result = await session.step({
    steps: 80,
    delta: 1 / 60,
    input: { forward: 1, strafe: 0 },
    recordEvery: 20,
  })

  const state = await session.inspectState() // inspect_state
  console.log(pure.ok, started.pid, result.final.hash, state.snapshot.phase)
} finally {
  const stopped = await session.stopProject() // stop_project
  console.log(stopped.exitCode, stopped.killed)
}
```

For real physics, use the same session API with `.advancePhysics({ frames,
input })`; the selected project's bridge must implement `advance_physics` and
the game must consume `harness_input` in `_physics_process`. The physics and
door fixtures do this.

`startProject()` waits for `HARNESS_READY`, connects to the loopback bridge,
checks that the bridge PID equals the child PID, and waits for the game node.
`stopProject()` asks the bridge to quit, waits for the owned child, and only
falls back to `child.kill()` if that child does not exit. It is idempotent and
returns `alreadyStopped: true` when there is no child. It never scans for other
Godot processes and never kills a process it did not start.

## Step and input semantics

- The bridge pauses the SceneTree before a `step` loop; `reset` also leaves the
  tree paused.
- `input` fields are `forward`, `strafe`, `jump`, `restart`, and `actions`.
  `forward`/`strafe` are clamped to `[-1, 1]`; `jump`/`restart` are edges and
  are consumed by the first step.
- `actions` is a generic map of boolean action names, for example
  `{"interact": true}`. Names must match `[a-z][a-z0-9_]{0,31}`. The controller
  validates the map; each fixture decides which actions it consumes and whether
  an action is edge-triggered. The door fixture consumes `interact` once per
  press.
- Input persists between steps when a field is omitted. Set every field you care
  about, or use `setInput()` before a sequence.
- `steps` is an integer from `0` to `100000`; `delta` is from `0.0001` to
  `0.25` seconds. `steps: 0` returns the current snapshot.
- `recordEvery` samples intermediate snapshots every N steps and always includes
  the final snapshot.
- Manual stepping calls the fixture's `harness_step(delta)`. The fixture uses
  explicit `move_and_collide(motion)` calls rather than `move_and_slide()`
  because `move_and_slide()` read frame timing internally while called from the
  paused bridge and produced different distances for the same sequence.
- This is a project-specific deterministic movement path, not a promise that
  arbitrary Godot physics is deterministic. See
  `docs/phase8/stage-c.md` for the measured before/after behavior.

### Real physics advance

`HarnessSession.advancePhysics({ frames, input })` is the real-physics path.
It is separate from `step()`:

- it unpauses the tree and waits for `frames` normal engine physics ticks;
- it applies input through the fixture's `set_harness_input()` before unpausing;
- it waits for the following idle frame so the last tick has completed;
- it pauses the tree again and returns the final snapshot.

The fixture must implement the generic game interface and consume
`harness_input` in `_physics_process`. The physics and door fixtures'
`harness_step()` deliberately error because a paused manual step cannot
advance the physics server. The bridge command is `advance_physics`; the sentry
bridge does not implement it, and the sentry fixture is unchanged.

## Visual capture and sampled sequences

`captureFrame()` requires a windowed, connected session with a paused tree. It
reads the actual viewport through the existing `screenshot` bridge command,
then returns a manifest-ready record with:

- a caller-supplied run id (or a random UUID), scenario, and metadata;
- capture timestamps and elapsed wall time;
- the engine tick, fixture simulation step, physics-frame counters, paused
  state, viewport size, PNG bytes, and SHA-256;
- the snapshot before and after the capture.

It does not advance the fixture simulation. The bridge may still increment
Godot's physics-frame counter while the tree is paused, so the record keeps both
before/after counters and checks the fixture `step` for a simulation change.

`captureSequence()` captures frame 0 at the current paused state, then advances
real fixed physics ticks between frames. It is a bounded sampled frame sequence,
not a real-time video capture. An evidence runner may encode the PNGs offline
with ffmpeg; that artifact must be described as an offline sampled-frame
encoding, not live video understanding.

Windowed capture is separate from headless tests because Godot's headless
display has no readable viewport texture. `npm test` remains the headless gate;
`npm run evidence:visual` is the Phase 10 windowed capture experiment.

## Snapshot and hash contract

`snapshot()` returns:

```text
step, paused, phase, detection, detection_percent, player_position,
player_velocity, grounded, seen_by, exit_distance, hash, input, hud, hint,
game_ready, uptime_ms
```

The stable hash covers only:

```text
step
phase
detection
player position xyz
player velocity xyz
grounded
seen guard ids
exit distance
```

Camera transform, HUD text, bridge port, PID, uptime, and render-frame timing
are excluded. A camera or HUD change must not change a gameplay hash.

## Bridge protocol

The bridge is a newline-delimited JSON socket on `127.0.0.1` with an
ephemeral port selected by the controller. It is opt-in and does not listen
without `--harness-port`.

Request:

```json
{"id":"1","cmd":"step","args":{"steps":80,"delta":0.0166666667,"input":{"forward":1,"strafe":0}}}
```

Commands: `ping`, `snapshot`, `pause`, `resume`, `set_input`, `step`,
`advance_physics`, `reset`, `screenshot`, `scene_tree`, `property`, `logs`,
`quit`. `advance_physics` is implemented by the physics and door fixture bridge
copies; the sentry bridge remains the Phase 8 command set.

Responses are either:

```json
{"id":"1","ok":true,"data":{...}}
```

or:

```json
{"id":"1","ok":false,"error":{"code":"VALIDATION_ERROR","message":"..."}}
```

The line limit is 1 MiB. `property` requires an absolute `/root/...` node path
and a property that actually exists. `screenshot` requires a `res://...png`
path inside the selected project and is unavailable under the headless renderer.

The bridge is a local development/verification surface, not an authentication
boundary. Do not expose the port, and only run trusted project code.

## Project selection and validation

By default `resolveProject` only accepts a project below this harness directory
and requires `project.godot`. Passing `--allow-outside-root` or
`allowOutsideRoot: true` is an explicit opt-in used for clean-copy checks. The
controller validates step counts, deltas, input shapes, test `res://` paths, and
screenshot paths before sending them to Godot. The bridge validates node paths,
property existence, absolute screenshot location, and step ranges again.

For a new fixture, add a project-local autoload:

```ini
[autoload]
HarnessBridge="*res://harness/bridge.gd"
```

and expose a node in the `harness_game` group with:

```gdscript
func snapshot() -> Dictionary
func set_harness_input(values: Dictionary) -> Dictionary
func harness_reset() -> Dictionary
func harness_hash() -> String
```

The sentry fixture additionally implements:

```gdscript
func harness_step(delta: float) -> Dictionary
```

A real-physics fixture should not implement `harness_step()` and should use
`advance_physics` instead. Read-only commands work without the write methods;
only use this interface on projects you intend to control.

## Tests and evidence

| Layer | Command | Observed result |
| --- | --- | --- |
| Pure sentry logic | `npm run test:logic` | 7/7, exit 0 |
| Controller parser and validation | `npm test` | 9/9 controller tests |
| Lifecycle isolation | `npm test` | 2/2 session tests |
| Live gameplay | `npm run test:gameplay` | 8/8 |
| Structured live scenarios | `npm run evidence:live` | 9/9 checks |
| Windowed screenshots | `npm run test:screenshot` | 1/1, two PNGs |
| Defect repair | `npm run test:repair` | failing exit 1 -> fixed exit 0 |
| Real physics suite | `npm run test:physics` | 9/9, exit 0 |
| Real physics bridge control | `npm run test:physics-control` | 2/2, exit 0 |
| Real physics screenshots | `npm run test:physics-screenshot` | 1/1, two PNGs |
| Real physics repeatability | `npm run evidence:physics` | 5 fresh runs, 9/9 each |
| Locked-door suite | `npm run test:door` | 7/7, exit 0 |
| Door bridge control | `npm run test:door-control` | 1/1 live scenario |
| Door screenshots | `npm run test:door-screenshot` | 1/1, three PNGs |
| Door defect repair | `npm run test:door-repair` | failing 6/7 -> passing 7/7 |

Stage evidence is under `docs/phase8/` and `docs/phase9/`:

- `stage-a.md`, `stage-a-run.json`
- `stage-b.md`, `stage-b-inspect.json`
- `stage-c.md`, `stage-c-live.json`, `live-detection.png`, `live-win.png`
- `stage-d.md`, `repair-evidence.json`, `repair-before.txt`, `repair-after.txt`
- `phase8-report.md` for the acceptance review
- `stage-e-physics.md`, `stage-e-physics.json`, `stage-e-run-*.log`,
  `stage-e-failure.*`, `stage-e-wall.png`, and `stage-e-air.png` for Stage E
- `stage-f-generalization.md`, `stage-f-suite.log`, `stage-f-control.log`,
  `stage-f-inspect.json`, `stage-f-repair.*`, `stage-f-locked.png`,
  `stage-f-key.png`, and `stage-f-open.png` for Stage F

## Limitations

- The original sentry fixture is a small flat scene. Its explicit
  horizontal/vertical movement split does not slide along walls, and it is not
  a general physics determinism claim for arbitrary Godot content.
- The Stage E physics fixture fixes one capsule, one ground box, one wall box,
  and 60 Hz. It does not establish general determinism. Fresh-process runs were
  exact in the measured suite, but the same process after repeated contact
  differed by about `1.43e-6`; the test therefore claims outcome repeatability
  and millimetre-selected-field repeatability, not bitwise same-process state.
- The Stage F door fixture is one capsule, one rectangular door, one key, and
  60 Hz. It proves that the generic action map, real physics, inspection, and
  reset path can carry a second mechanic; it is not a general interaction or
  inventory framework.
- Screenshots require a display/windowed run and are not part of the headless
  gate.
- The bridge uses loopback and no authentication. It is suitable for a local
  development machine or isolated CI runner, not a shared host.
- The repair experiment proves detection/localization/rerun for one injected
  movement defect. It does not claim general autonomous repair.
- No engine source, addon, or new third-party dependency is required.
