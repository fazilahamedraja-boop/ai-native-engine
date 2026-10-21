# Phase 12B — Timeout Diagnosis

**Verdict: the four timeouts are a CODE DEFECT in the Phase 12 implementation, not an
environmental problem.** The previous Phase 12 report attributed them to "environment timeouts
unrelated to code changes". That attribution was wrong and is corrected here.

## 1. Summary

The Phase 12 implementation added a `physics_query` command to
`experiments/godot-harness/fixtures/observation/harness/bridge.gd`. That edit introduced a
**GDScript parse error**. Because `bridge.gd` is registered as a Godot **autoload**, the parse
failure prevents the autoload from instantiating, so the bridge never starts, never binds a
socket, and never prints `HARNESS_READY`. The controller waits 20 s for that line and then fails
the session with `Timed out waiting for HARNESS_READY after 20000 ms`.

Exactly four tests fail, and they are exactly the four that boot `fixtures/observation` (or a
copy of it). Every other fixture keeps its own unmodified `bridge.gd` and starts normally.

## 2. Evidence

### 2.1 The parse error (direct, reproducible)

```powershell
godot --headless --path experiments/godot-harness/fixtures/observation --quit-after 5
```

```
Godot Engine v4.7.2.stable.official.ed1daf0bf - https://godotengine.org

SCRIPT ERROR: Parse Error: Expected end of statement after expression, found ":" instead.
   at: GDScript::reload (res://harness/bridge.gd:389)
ERROR: Failed to load script "res://harness/bridge.gd" with error "Parse error".
   at: load (modules/gdscript/gdscript_resource_manager.cpp:46)
ERROR: Failed to instantiate an autoload, script 'res://harness/bridge.gd' does not inherit from 'Node'.
   at: start (main/main.cpp:4539)
```

Saved verbatim: `logs/prefix-godot-observation-fixture.txt`.

The same command against `fixtures/sentry` — whose `bridge.gd` was **not** touched by Phase 12 —
produces **no parse error at all**. That single difference isolates the defect to the Phase 12
edit.

### 2.2 The bridge never becomes ready

```powershell
godot --headless --path experiments/godot-harness/fixtures/observation -- --harness-port=0
```

```
=== HARNESS_READY present? ===
False
```

The controller's readiness contract is `HARNESS_READY <json>` on stdout
(`controller/harness.mjs:319-333`). No line is ever printed, so
`HarnessSession.start()` rejects at `harness.mjs:361` with
`Timed out waiting for HARNESS_READY after 20000 ms`.

### 2.3 The failing set is exactly the `fixtures/observation` set

| Test | Boots | Result |
| --- | --- | --- |
| `observe reports measured runtime, character, collision, animation, and event data` | `fixtures/observation` | **timeout** |
| `observe inspects the humanoid model and skeleton with explicit transform spaces` | `fixtures/observation` | **timeout** |
| `observeTimeline samples fixed physics advances and de-duplicates events` | `fixtures/observation` | **timeout** |
| `observe reuses an unmodified door scene through the generic observation bridge` | temp copy of `fixtures/door` **with `fixtures/observation/harness/bridge.gd` copied in** | **timeout** |
| 23 other tests | `fixtures/sentry`, `fixtures/physics`, `fixtures/door` (own bridges) | pass |

The fourth case is the decisive one. That test copies the **observation** bridge into a temporary
door project (`tests/observation.test.mjs:285-288`), so it inherits the broken script and times
out — even though the door scene itself is untouched. This rules out "the door scene is broken"
and confirms "the bridge script is broken".

### 2.4 Why only these fixtures are affected

Phase 12 edited exactly one file: `fixtures/observation/harness/bridge.gd`. Each fixture carries
its own bridge copy, so the other three were unaffected:

| Fixture | Bridge sha256 (first 16) | Contains `physics_query`? | Boots? |
| --- | --- | --- | --- |
| `fixtures/observation` | `018CD44346E81247` | yes | **no — parse error** |
| `fixtures/door` | `D2411AFC473A5573` | no | yes |
| `fixtures/physics` | `7AEEEB7E31D4688E` | no | yes |
| `fixtures/sentry` | `2FB828428729108B` | no | yes |

### 2.5 The exact defect

`bridge.gd` line 389 and 7 further lines use `:=` where GDScript requires `=`:

```gdscript
query.collision_mask := 1     # line 389 — PARSE ERROR
```

`:=` is GDScript's **typed declaration** operator. It is only valid on a `var` declaration. On an
**existing property** it is a syntax error. The affected lines:

| Line | Statement |
| --- | --- |
| 389 | `query.collision_mask := 1` |
| 407 | `query.collision_mask := 1` |
| 426 | `query.collision_mask := 1` |
| 441 | `query.shape := null` |
| 442 | `query.transform := Transform3D(Basis(), from)` |
| 443 | `query.to := to` |
| 444 | `query.collision_mask := 1` |

Line 389 is the first one the parser reaches, which is why the error is reported there.

### 2.6 Why the error was not caught earlier

The Phase 12 report stated the failures were "environment timeouts". They were not: they were the
parse error surfacing through a timeout. The error message was on the Godot process's stderr, but
`HarnessSession.start()` converts *any* startup failure into the single timeout message, so the
underlying parse error was never surfaced to the test output. **This is the real diagnostic
defect**: startup failures are collapsed into a timeout, hiding the cause.

## 3. Conclusion

| Question | Answer |
| --- | --- |
| Did the Godot process start? | Yes — the engine launched and the scene loaded. |
| Was the correct project loaded? | Yes — `fixtures/observation`. |
| Was the correct bridge script loaded? | **No.** It failed to parse. |
| Did the bridge listen on the expected port? | **No.** The autoload never instantiated, so no socket was bound. |
| Did the controller connect to the right endpoint? | It never got an endpoint; no `HARNESS_READY` was printed. |
| Did the test wait for a response that never arrived? | Yes — it waited 20 s for `HARNESS_READY`. |
| Were errors swallowed into timeouts? | **Yes.** The parse error was on stderr but the session API reported only a timeout. |
| Did `physics_query` reach `_physics_query_reply`? | **No.** The function was never loaded, so the command was never registered. |
| Was the operation executed against a valid physics space? | **No.** It never executed. |
| Was the cause the implementation or the environment? | **The implementation.** The environment is proven healthy: the same engine, the same machine, and three sibling fixtures boot correctly. |

## 4. Fix

The smallest responsible change: replace the seven invalid `:=` property assignments with `=`.
No test is weakened, no timeout is increased, no behaviour is mocked, and the query contract is
unchanged.

The fix is applied and verified in the isolated worktree
`C:\Users\hacke\ai-native-engine-phase12-verify` (branch `experiment/phase12-verify`).
