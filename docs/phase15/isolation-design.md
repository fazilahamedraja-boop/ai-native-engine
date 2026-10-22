# Phase 15 - isolation design

Date: 2026-10-22
Status: verified for OpenCode 2.0.32 on this machine

The agent must not be able to reach the answer key, the original repository, the
protected Phase 8-14 evidence, an alternate copy of the source, or the
defective fixture before it has produced a diagnosis. This document describes
the mechanism that enforces that, the experiments that verified it, and the
limits that remain.

## 1. What "isolated" means here

The agent is a normal operating-system process running as the same Windows user
as the harness. **There is no OS-level sandbox** (no container, no job object, no
restricted token, no separate account). The boundary is OpenCode's own
permission engine, configured so that no file tool can address a path outside
the per-run sandbox and no tool that can execute code is present at all.

That is a real access boundary in the sense that matters for this task: a
request for an outside path is refused by the tool runtime before any file
descriptor is opened, and the refusal is visible in the event stream. It is not
a defence against a compromised OpenCode binary, and it is not a claim that the
agent runs with reduced OS privileges. Section 5 states the limits explicitly.

## 2. Mechanism

Each run gets four things:

| Boundary | Implementation |
| --- | --- |
| Private server | `opencode run --standalone` - no shared background service |
| Private config root | `XDG_CONFIG_HOME=<run>/config`, containing exactly one file: `config/opencode/opencode.json` |
| Private filesystem root | `cwd = <run>/sandbox`, created with `mkdtemp` under `%TEMP%` |
| Private outputs | evidence copy under `<run>/sandbox/evidence`, logs under `docs/phase15/runs/<run>/logs` |

The committed config is
`experiments/godot-harness/controller/agent-sandbox/opencode.json`; its sha256
was verified identical to the file used in the experiments.

```json
{
  "permissions": [
    { "action": "external_directory", "resource": "*", "effect": "deny" },
    { "action": "shell",            "resource": "*", "effect": "deny" },
    { "action": "write", "resource": "*opencode.json*", "effect": "deny" },
    { "action": "edit",  "resource": "*opencode.json*", "effect": "deny" },
    { "action": "write", "resource": "*.opencode/*",     "effect": "deny" },
    { "action": "edit",  "resource": "*.opencode/*",     "effect": "deny" }
  ],
  "policies": [
    { "action": "tool.use", "resource": "*",      "effect": "deny" },
    { "action": "tool.use", "resource": "read*",  "effect": "allow" },
    { "action": "tool.use", "resource": "write*", "effect": "allow" },
    { "action": "tool.use", "resource": "edit*",  "effect": "allow" },
    { "action": "tool.use", "resource": "glob*",  "effect": "allow" },
    { "action": "tool.use", "resource": "grep*",  "effect": "allow" }
  ],
  "tools": {
    "webfetch": false, "websearch": false, "execute": false,
    "question": false, "skill": false, "subagent": false
  },
  "experimental": { "subagent_depth": 0 }
}
```

Why each part is load-bearing:

- **`external_directory`** is the path boundary. It is evaluated against the
  session working directory and covers `read`, `write`, `edit`, `glob` and
  `grep`.
- **`shell`** would be a complete bypass (any command, any path, any network
  access). Denying it removes the tool from the catalog entirely.
- **`tools.execute: false`** removes code mode. This matters: while code mode
  was enabled, `execute` was not governed by the `tool.use` policies and exposed
  `opencode.session_move`, `opencode.worktree_create/remove` and
  `opencode.read_mcp_resource`. With code mode off those tools are absent.
- **`tools.subagent: false`** removes delegation. A subagent is a second agent
  loop; even though the policy engine blocked it when asked, removing the tool
  avoids relying on a per-call check.
- **`tools.skill: false`** removes skill loading. The private config root has no
  skills anyway (verified: loading one returns "Unable to load skill").
- **`tools.webfetch/websearch: false`** removes the network surface.
- **The `*opencode.json*` write/edit deny** prevents self-escalation: the agent
  cannot write a looser project config and then trigger a config reload.
- **The private config root** removes the user's global MCP servers, plugins,
  skills, custom agents and global permission rules. Without it, the global
  config's `external_directory: ask` would be answered by `--auto`.

## 3. Verification matrix

Run with the committed config, `--standalone`, private `XDG_CONFIG_HOME`, and
`--auto`. Raw logs: `docs/phase15/isolation-experiments/01-standalone-baseline.jsonl`
and `02-escape-matrix.jsonl`.

| # | Attempt | Observed result |
| --- | --- | --- |
| 1 | `read C:\Users\hacke\ph15-secret\secret.txt` | `Permission denied: external_directory` |
| 2 | `read ..\ph15-secret\secret.txt` | `Permission denied: external_directory` |
| 3 | `read ..\..\Users\hacke\ph15-secret\secret.txt` | `Permission denied: external_directory` |
| 4 | `glob **/*.txt` with `path: C:\Users\hacke\ph15-secret` | `Permission denied: external_directory` |
| 5 | `glob *` with `path: ..` | `Permission denied: external_directory` |
| 6 | `grep TOP-SECRET` with `path: C:\Users\hacke\ph15-secret` | `Permission denied: external_directory` |
| 7 | `write C:\Users\hacke\ph15-iso\pwned2.txt` | `Permission denied: edit` |
| 8 | `write opencode.json` inside the workspace | `Permission denied: edit` |
| 9 | `shell "echo hi"` | tool absent: "No shell/execute tool is exposed in this session" |
| 10 | code mode `tools.opencode.worktree_list()` | tool absent: no code-mode namespace |
| 11 | `subagent` agent `general` | tool absent |
| 12 | `skill accessibility-testing` | `Unable to load skill accessibility-testing` |
| 13 | `tools.opencode.list_mcp_resources()` | `{"resources": [], "templates": []}` - no MCP servers |
| 14 | `write diagnosis.md` inside the workspace | success |
| 15 | `edit evidence/state.json` inside the workspace | success |

Attempts 14-15 are the control: the sandbox is not read-only, and the agent can
do the work it is asked to do.

### The experiment that failed

Before `--standalone` was added, the same config **did not apply**, and the agent
read the secret file successfully. The cause was the shared background service:
`opencode run` attached to a server started earlier from a different directory
with the global config. `opencode debug config` from the sandbox listed the
global config as the only source, and `opencode mcp list` still showed 11
connected servers. This is recorded in `agent-integration-audit.md` section 5.
Any future change that drops `--standalone` invalidates every row above.

## 4. Diagnosis-before-source

Enforced structurally, not by instruction:

1. The sandbox is created with `evidence/` and `task-diagnosis.md` only. The
   defective fixture lives in `%TEMP%` outside the sandbox and is unreachable
   (`external_directory`).
2. The adapter validates `diagnosis.md`: exists, non-empty, has an H1 and the
   five required sections, names the failing acceptance case, matches at least
   two case keywords, and quotes at least one numeric value that actually occurs
   in the evidence.
3. Only after validation does the adapter copy the defective fixture into
   `sandbox/project/` and start the repair session.
4. The repair session cannot modify `project/tests/**`: the adapter hashes the
   oracle before and after and fails the run if any test file changed.

The answer key (`controller/blind-cases.mjs`) is never copied into any sandbox
and is outside the reachable path set. The keyword list and expected failing
cases used for validation stay in the adapter process, never in the sandbox.

## 5. Limits

These are real and must be repeated in any claim about this phase.

1. **Same-user process, no OS sandbox.** Any code-execution capability would
   bypass every rule above. The design removes the known execution tools
   (`shell`, code mode, subagent) rather than pretending to contain them.
2. **The boundary is OpenCode's permission engine.** It is verified for 2.0.32
   on this machine. A future OpenCode version could add a tool that is not
   covered by the `tool.use *` deny default, or change how
   `external_directory` is computed. The matrix must be re-run after any upgrade.
3. **Links are not handled.** The sandbox is built by copying a fixture; it
   contains no symlinks or junctions. If a future sandbox input contained one,
   `read` would follow it. The adapter does not create links and the fixture
   does not contain any.
4. **Network is removed from the agent, not from the machine.** `webfetch`,
   `websearch` and MCP are gone, but the model provider call itself is a network
   request by definition.
5. **The agent can still write inside the sandbox**, including overwriting
   `task-repair.md` or `diagnosis.md` after validation. That does not grant
   access; it only means the run's own artifacts must be trusted only as
   recorded evidence, which is why the adapter copies the diagnosis out
   immediately after validation and records its hash.
6. **A failed run is not retried.** If a run fails for any reason the adapter
   records the failure and stops. It never substitutes a different model or a
   scripted diagnosis.
