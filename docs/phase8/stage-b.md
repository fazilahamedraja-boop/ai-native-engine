# Phase 8 - Stage B: control bridge and process lifecycle

Status: complete. Stage C has not been started yet.

## Scope

Stage B adds the minimum project-local bridge needed for a coding agent to
start a Godot project, pause it, inspect the running scene, read a property,
resume it, and stop it. It does not add scripted inputs, manual simulation
steps, screenshots, or repair variants yet.

## Capability decision

The existing Godot MCP bridge was inspected again for this stage. It is rich but
editor-bound:

| Needed operation | MCP | Stage B choice |
| --- | --- | --- |
| start/stop scene | `play_scene`, `stop_scene` via editor | controller-owned process |
| inputs | keys/actions/sequences in a live editor session | deferred to Stage C |
| logs | game output ring through the debugger | controller stdout/stderr |
| screenshots | live game frame capture | deferred to Stage C |
| scene tree | runtime probe through debugger | loopback bridge |
| property reads | runtime probe through debugger | loopback bridge |
| pause/step | no manual simulation step | bridge pause; step deferred |
| headless CLI operation | not provided | bridge + Node controller |

The MCP path needs an editor play session and `EngineDebugger`. A headless CLI
cannot use it. The smallest useful missing piece is therefore a project-local
autoload and a Node controller, not another MCP server. No engine source was
modified and no new dependency was added.

## Operations

The controller exposes four distinct operations:

- `HarnessSession.startProject()` -> `start_project`
- `runTests()` -> `run_tests`
- `HarnessSession.stopProject()` -> `stop_project`
- `HarnessSession.inspectState()` -> `inspect_state`

`startProject` is the only operation that creates a process. It records the
PID, waits for a `HARNESS_READY` line, connects to the bridge, and waits until
the game scene is ready. `stopProject` sends `quit`, waits for that exact child
to exit, and only falls back to `child.kill()` when the same child does not
exit. It never searches for Godot by name and never signals a process it did not
start.

The Node tests start two sessions, stop one, and verify the other still answers.

## Bridge

`fixtures/sentry/harness/bridge.gd` is an autoload. It is inert unless the
project is launched with `--harness-port=<port>` after Godot's `--` separator.
When enabled it:

- binds only to `127.0.0.1` on a controller-selected ephemeral port;
- uses newline-delimited JSON with one request ID per command;
- supports `ping`, `snapshot`, `pause`, `resume`, `scene_tree`, `property`,
  `logs`, and `quit`;
- enforces a line-size limit, `/root/...` node paths, and known properties;
- keeps running while the SceneTree is paused via
  `PROCESS_MODE_ALWAYS`.

The controller resolves the installed Godot `.cmd` shim to the real engine
executable before spawning, so the PID reported by the bridge is the PID the
controller owns. Arguments are passed directly to `spawn`, not through a shell.

`main.gd` only adds the `harness_game` group so the bridge can find the game
node. Gameplay behaviour is unchanged in this stage.

## Results

Commands:

```powershell
cd experiments/godot-harness
npm test
node controller/harness.mjs inspect --project fixtures/sentry --json `
  --out ../../docs/phase8/stage-b-inspect.json
```

Observed:

- Node tests: **7/7 passed**
  - controller parser tests: 5
  - live session tests: 2
- `inspect` start: PID 10464, port 65024, project-ready in 1.14 s
- paused snapshot: `phase=active`, `detection=0`, `player_position=[0, 0.85, 0]`
- scene tree contains `/root/Main/Player` (`CharacterBody3D`), both guards,
  exit, camera, HUD, and the bridge node
- property read: `/root/Main/Player.global_position` returned a 3-component
  vector
- invalid property returned `PROPERTY_NOT_FOUND`
- stop: exit code 0, `killed=false`
- no `stderr` and no Godot `ERROR`/`WARNING` lines

The full start/inspect/stop record is `docs/phase8/stage-b-inspect.json`.

## Limitations

- No deterministic input or simulation step yet.
- No screenshot support yet.
- The bridge trusts a local caller on loopback; it is not an authentication
  boundary. Start only projects you intend to control.
- `stop_project` handles normal quit and a hung controller-owned child. It does
  not attempt to discover or clean up processes that escaped after a host crash.
- A caller can inspect any node under `/root`, including the bridge. This is
  read-only at this stage.

## Next stage

Stage C: pause plus deterministic scripted inputs, manual stepping, snapshots,
stable hashes, screenshot evidence, and repeatability measurements.
