# Phase 14 — Startup failure diagnostics

## 1. The problem Phase 13 found

Phase 13 measured this and recorded it as the top remaining limitation:

> The session API surfaces the failure as a `HARNESS_READY` timeout. The underlying Godot parse
> error is present in the process logs but is not attached to the thrown error, so a caller must
> read `session.logTail()` to see it.

That is the same weakness that hid the Phase 12B root cause. A developer reading the error sees

```
Timed out waiting for HARNESS_READY after 20000 ms
```

and has to guess. The real cause was on stderr the whole time:

```
SCRIPT ERROR: Parse Error: Expected end of statement after expression, found ":" instead.
   at: GDScript::reload (res://harness/bridge.gd:389)
ERROR: Failed to load script "res://harness/bridge.gd" with error "Parse error".
ERROR: Failed to instantiate an autoload, script 'res://harness/bridge.gd' does not inherit from 'Node'.
```

**A timeout is not a diagnosis.** "The process never became ready" and "the process is ready but
the network is wrong" and "the script failed to compile" are three different bugs that all used to
look identical.

## 2. What changed

Two files changed.

### `controller/startup-diagnostics.mjs` (new)

A small module that classifies a startup failure and builds an actionable error.

```js
export const StartupFailure = {
  SPAWN_FAILED: 'spawn_failed',
  PROCESS_EXITED: 'process_exited',
  SCRIPT_ERROR: 'script_error',
  AUTOLOAD_ERROR: 'autoload_error',
  CONNECTION_FAILED: 'connection_failed',
  PROTOCOL_ERROR: 'protocol_error',
  GAME_NOT_READY: 'game_not_ready',
  SLOW_STARTUP: 'slow_startup',
}
```

`collectEngineErrors({stdout, stderr})` pulls the engine's own error lines out of the captured
output. Godot prints a bare `at: ...` line under an error, so an indented continuation line is
kept with the error above it.

`classifyStartupFailure(input)` decides what happened. The precedence is the important part:

1. a spawn error → `spawn_failed`;
2. a connection-phase failure → `connection_failed`;
3. a game-phase failure → `game_not_ready`;
4. a protocol-phase failure → `protocol_error`;
5. **the process exited** → `process_exited` (even if it also logged a script error, the exit is
   the more specific fact);
6. **the engine reported an autoload failure** → `autoload_error`;
7. **the engine reported a script or parse error** → `script_error`;
8. otherwise, the process is alive and reported nothing → `slow_startup`.

Rules 5–8 are what separate "already failed" from "genuinely slow". A live process with an
engine error is reported **by that error**, because it is far more actionable than a timeout. A
live process with no engine error is a genuinely slow start, and it stays distinguishable from a
startup that has already failed.

`startupError(input)` builds the `Error`. It carries a machine-readable `code`, a `diagnostics`
object with the structured facts, and a message that reads like this:

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
  stdout tail:
    Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org
  stderr tail:
    ...
```

### `controller/harness.mjs` (modified)

The failure paths now build that error instead of a bare message:

| Path | Before | After |
| --- | --- | --- |
| spawn error | the raw `Error` from `child.on('error')` | `startup_failed` with the cause |
| readiness timeout | `Timed out waiting for HARNESS_READY after N ms` | classified failure with the engine error, the process state and the log tails |
| process exits before readiness | `Godot exited before HARNESS_READY (code=…)` | `process_exited` with the exit code and signal |
| bridge PID mismatch | `Bridge PID … does not match controller PID …` | `protocol_error` with the same fact |
| socket connection | the raw socket error, or a bare connect timeout | `connection_failed`, distinguishable from a startup failure |
| game never ready | `Game scene did not become ready: {…}` | `game_not_ready` with the last ping and the log tails |

**The timeout was not increased and no error was suppressed.** The classification happens in the
same place the timeout did; only the message and the attached data changed.

## 3. Cleanup

A harness session that throws between `start()` and `stop()` leaves a Godot window running. That
is not hypothetical: it happened during Phase 13, and a windowed Godot that survived the kill
**held the parent's stdout and stderr pipes open**, so any shell reading them waited for an EOF
that never came. The run appeared to hang.

Three changes close that:

1. **Sessions register themselves.** `stopAllSessions()` is exported and stops every session that
   has been started and not yet stopped. It is the safety net for a caller that threw.
2. **`withSession(session, body)`** runs a body and always stops the session in a `finally`
   block, even when the body throws.
3. **`stop()` destroys the child's stdout and stderr pipes.** The child is the only writer to
   those streams, so they are destroyed rather than ended: a reader must still be able to consume
   whatever the engine already wrote. A windowed Godot that survived the kill can no longer hold
   the parent's pipes open.

## 4. The controlled failure scenarios

Four scenarios are built in isolated temporary projects. No protected fixture is modified: the
observation fixture is copied to a temporary directory and the copy is broken.

| # | Scenario | How it is built | Expected classification |
| --- | --- | --- | --- |
| 1 | **Invalid GDScript** | the observation bridge is copied and given `func broken( -> void:` | `script_error` (or `autoload_error` when the autoload message is the one that surfaces) |
| 2 | **Exits before readiness** | a minimal project whose bridge calls `get_tree().quit(3)` in `_ready` | `process_exited`, exit code 3 |
| 3 | **Starts but never signals readiness** | a minimal project whose bridge does nothing | `slow_startup` — alive, no engine error, no signal |
| 4 | **A valid project** | the observation fixture, unmodified | starts normally |

A fifth case proves that a genuinely slow start is still distinguishable from a failure:

> The real observation bridge is copied and delayed by three seconds before it publishes
> readiness. With a 1 200 ms limit the controller must report `slow_startup` with **no engine
> errors** and **no exit code** — the process was alive and simply had not got there. With a
> 20 000 ms limit the same project must start normally.

Six more unit-level checks cover the classification itself, the error collector's `at:`
continuation handling, and the two cleanup paths (`stopAllSessions` on a deliberately abandoned
session, and `withSession` on a body that throws). Each asserts that no Godot process is left
behind, by counting `godot.exe` before and after.

**14 new tests. 61 in total, all passing. No existing test was modified, weakened or removed.**

## 5. What this does not fix

- The readiness **timeout** is still the same value. A project that is genuinely slow to start
  still fails at the limit; it now says so explicitly instead of pretending.
- The diagnostics are attached to the **controller's** error, not to Godot's exit status. Godot
  still exits 0 in some failure cases (for example a bridge that parses but never listens), so
  the exit code alone is not a reliable failure signal. The classification compensates by reading
  the engine's output.
- The error text is for a human or an agent reading a log. It is not a machine-readable protocol
  extension: the `code` and `diagnostics` fields are the machine-readable part, and they are
  Node-level, not a change to the bridge's wire format.
- A bridge that starts and listens but never answers a command is still reported by the command
  timeout, not by the startup classifier. That is a different failure and belongs to a different
  layer.
