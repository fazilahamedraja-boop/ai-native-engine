# Phase 15 - OpenCode agent-integration audit

Date: 2026-10-22
Installed interface: OpenCode `2.0.32`

This document records what the installed OpenCode CLI actually does, verified by
running it. Nothing here is inferred from documentation. The point of the audit
was to find the smallest reliable way to drive a real coding session from the
Godot harness - not to build an observation framework.

## 1. Installation and entry points

| Item | Value |
| --- | --- |
| PowerShell shim | `C:\Users\<user>\AppData\Roaming\npm\opencode.ps1` |
| Real binary | `...\npm\node_modules\@opencode\cli\bin\opencode.exe` (213 MB, self-contained) |
| Version | `opencode 2.0.32` |
| Config root (default) | `C:\Users\<user>\.config\opencode` |
| Data root (default) | `C:\Users\<user>\.local\share\opencode` (sessions in `opencode.db`) |
| Config schema | `https://opencode.ai/config.json` |

`opencode debug paths` prints every resolved path (home, data, cache, config,
state, tmp, bin, log, repos, db), which made it possible to confirm that a
private `XDG_CONFIG_HOME` really moves the config root.

## 2. Noninteractive interface

`opencode run` is the documented noninteractive subcommand. Verified flags:

```
opencode run [message] [directory]
  --format json|default     JSONL event stream (json) or plain text
  --model provider/model[#variant]
  --agent <name>
  --auto                    auto-approve permissions that are not explicitly denied
  --standalone              run with a private server instead of the background service
  --server <url>
  --session/-s <id>         continue, or create with that id
  --continue/-c
  --fork
  --file/-f <path>
  --title <text>
  --thinking
  --print-logs
```

Global: `--log-level <all|trace|debug|info|warn|warning|error|fatal|none>`,
`--print-logs`, `--help`, `--version`.

`opencode models` lists every reachable `provider/model` pair, so the adapter
does not hardcode a model: the caller passes `--model`, and the value is used
verbatim. Models observed in this environment include
`opencode/deepseek-v4.1-flash-free` and `opencode/minimax-m3.1-flash-free`.

Other useful subcommands: `opencode mcp list`, `opencode debug config`
(list of configuration sources), `opencode debug paths`, `opencode debug agents`.

## 3. JSONL event stream

Every line is one event:

```json
{ "type": "tool_use", "timestamp": 1792683217513, "sessionID": "ses_...", "part": { ... } }
```

Observed event types and payloads:

| `type` | `part.type` | Payload used by the adapter |
| --- | --- | --- |
| `step_start` | `step-start` | step boundary |
| `tool_use` | `tool` | `part.tool`, `part.state.status`, `part.state.input`, `part.state.output`, `part.state.error` |
| `step_finish` | `step-finish` | `part.reason`, `part.cost`, `part.tokens` |
| `text` | `text` | `part.text` - the final assistant answer |

`part.state.status` is `completed` or `error`. A permission denial surfaces as a
`tool_use` with `status: "error"` and
`error.message: "Permission denied: external_directory"`, which is exactly what
the isolation matrix checks.

## 4. Configuration surface

The schema exposes four relevant mechanisms:

1. `permissions` - ordered ruleset of `{ action, resource, effect }`, where
   `action` is free-form (`external_directory`, `shell`, `read`, `write`,
   `edit`, `glob`, `grep`, `webfetch`, `websearch`, ...). Matching is a
   case-insensitive glob anchored at both ends; `*` becomes `.*`, `?` becomes
   `.`, and backslashes are normalised to `/`.
2. `policies` - ordered rules of
   `{ action: provider.use | tool.use | integration.use, resource, effect }`.
   `integration.use` with `mcp:<name>`, `skill:<id>` or `plugin:<id>` **removes**
   that integration. `tool.use` resources are matched against
   `<permission-action>:<resource>`.
3. `mcp.servers.<name>` - server definitions with a `disabled` flag (the legacy
   top-level `mcp.<name>: {enabled:false}` shape is deprecated).
4. `tools` - deprecated map of `tool -> boolean`; still effective for
   `webfetch`, `websearch`, `execute` (code mode), `question`, `skill`,
   `subagent`.

Two details matter for isolation:

- Rules are evaluated **last match wins**. A project rule can therefore loosen a
  global rule, which is why the adapter removes the global config root entirely
  instead of trying to override it.
- Permission denials are enforced by the running session, not by prompt text.
  With `permissions` denying `shell`, the `shell` tool is not merely blocked at
  call time - it is absent from the tool catalog.

## 5. The background-service trap (most important finding)

The first isolation experiment **failed**:

- Sandbox: `C:\Users\<user>\ph15-sandbox`, containing only `evidence/state.json`
  and an `opencode.json` that denied `external_directory` and `shell`.
- Command: `opencode run --format json --model ... --auto "read the secret"`.
- Result: the agent read `C:\Users\<user>\ph15-secret\secret.txt` successfully.

Root cause: a default `opencode run` attaches to the **shared background
service**, which was started earlier, from `C:\Users\<user>`, with the global
config. A session created there does not adopt the invoking process's working
directory or its project `opencode.json`. Confirmed with:

- `opencode debug config` executed from the sandbox still listed only
  `C:\Users\<user>\.config\opencode\opencode.json` as a configuration source;
- `opencode mcp list` still reported 11 connected MCP servers even after
  `XDG_CONFIG_HOME` pointed at an otherwise empty config directory.

Consequence: **`--standalone` is mandatory** for this integration. It forces a
private server per invocation, so the sandbox working directory, the private
config root and the permission rules are actually the ones in effect.

This was re-tested after adding `--standalone` and a private `XDG_CONFIG_HOME`,
and every escape attempt was denied. See `isolation-design.md` for the matrix.

## 6. What was deliberately not used

- No `--session` reuse between phases: diagnosis and repair run in separate
  sessions with separate sandboxes, so the repair session cannot inherit
  pre-diagnosis state and the diagnosis session never sees source.
- No `--agent` overrides: the default agent plus an explicit tool allowlist is
  simpler and auditable.
- No `opencode serve` API: the CLI JSONL stream already carries tool calls,
  results and the final text, and avoids a second protocol surface.
- No MCP server in the sandbox: the private config root defines none, and
  `tools.opencode.list_mcp_resources` returns `{"resources": [], "templates": []}`.

## 7. Adapter surface derived from the audit

- Command: `opencode run --standalone --format json --model <spec> --auto --title <...> "<short instruction>"`
- Working directory: per-run sandbox.
- Environment: inherited, with `XDG_CONFIG_HOME` pointed at a per-run config
  root containing exactly one file: the sandbox `opencode.json`.
- Task text lives in the sandbox (`task-diagnosis.md`, `task-repair.md`) so the
  argv stays short and the prompt is auditable after the run.
- Logs: stdout JSONL captured verbatim, stderr captured separately.
- Time bound: per-phase wall clock, with the whole process tree killed on
  timeout.
