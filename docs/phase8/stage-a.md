# Phase 8 - Stage A: headless tests and structured results

Status: complete. Stage B has not been started yet.

## Scope

Stage A exercises the existing Godot sentry project through the command line and
turns its text output into a structured result. It does not add live control,
snapshots, or repair behaviour yet.

The fixture is a clean copy of the Phase 7 project at
`experiment/phase7-godot` commit `ebbb21d`:

- `experiments/godot-harness/fixtures/sentry/`
- Godot `4.7.2.stable.official.ed1daf0bf`
- no `addons/`, no `.godot/`, and no game changes

## Existing capability review

The existing Godot MCP bridge was inspected before adding anything.

It already provides:

- `play_scene`, `stop_scene`, `is_playing`
- simulated keys/actions/mouse and input sequences
- game screenshot capture
- game output and scene-tree reads
- one-shot property reads and property monitors

The bridge is editor-session based. Its runtime probe answers through
`EngineDebugger`, so it requires an editor play session and does not provide a
headless CLI lifecycle or a project-local manual step operation. That is the
documented gap Stage B addresses. No new MCP server or editor is being built.

Testing frameworks investigated: GUT and GdUnit4 are established open-source
Godot test frameworks. Neither was added. The existing `SceneTree` runner already
produces per-case `PASS`/`FAIL` lines and an exit code, so a dependency would not
remove any work at this scope. The harness uses Godot's documented CLI directly:

- <https://docs.godotengine.org/en/stable/tutorials/editor/command_line_tutorial.html>

## Implementation

- `controller/harness.mjs`: runs `godot --headless --path <project> -s <script>`
  without a shell, captures stdout/stderr, enforces a timeout, parses per-case
  results, checks the summary counts against the individual cases, records Godot
  `ERROR` lines, and returns a structured JSON result.
- `tests/controller.test.mjs`: Node built-in tests for parsing a pass, a failure,
  a count mismatch, a missing summary, and a Godot `ERROR` line.
- `package.json`: `npm run test` and `npm run test:logic`.

The controller only accepts `res://*.gd` test entry scripts and refuses projects
outside the harness root unless `--allow-outside-root` is explicitly passed.

## Results

Command:

```powershell
cd experiments/godot-harness
npm run test:logic
```

Result:

- 7 cases passed, 0 failed
- Godot exit code 0
- `ok: true`
- duration: 1.192 s
- no Godot `ERROR` or `WARNING` lines

Covered cases: initial state, detection rise, detection decay, loss precedence,
exit win, reset determinism, and outside-cone safety.

The full structured record is `docs/phase8/stage-a-run.json`.

## Limitations

- These are pure gameplay-logic tests. They do not execute `CharacterBody3D`
  movement or scene wiring; those are Stage C work.
- The parser treats any Godot `ERROR:` or `SCRIPT ERROR:` line as a failed run,
  even when the exit code is zero.
- No test has been run from a clean copy yet; that check belongs to the final
  acceptance pass.

## Next stage

Stage B: a minimal project-local control bridge and distinct `start_project`,
`run_tests`, `stop_project`, and `inspect_state` operations.
