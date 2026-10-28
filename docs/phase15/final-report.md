# Phase 15 - final report: connecting a real coding agent to the harness

Date: 2026-10-22
Worktree: `C:\Users\<user>\ai-native-engine-phase15`
Branch: `experiment/phase15-agent-adapter`
Baseline: `c867288` (Phase 14 complete)

## What this phase set out to do

Connect a real OpenCode coding agent to the existing Godot AI-native harness so
that it autonomously receives evidence, diagnoses a defect, repairs it in an
isolated workspace, and has that repair verified. Smallest reliable
implementation - no new observation primitives.

## What was built

1. **`controller/agent-adapter.mjs`** - a runner that prepares a controlled
   defect, gives the agent an evidence-only sandbox, validates its diagnosis,
   then grants a *copy* of the defective source, collects the repair and runs
   the real acceptance suite. Fails closed; no retries, no fallback model.
2. **`controller/agent-sandbox/opencode.json`** - the isolation policy: private
   config root, no MCP, no shell, no code mode, no subagent, no network tools,
   path access confined to the sandbox, and a deny on writing project config.
3. **Four end-to-end runs** - `docs/phase15/runs/`, 76 artifacts, 1.65 MB,
   including raw JSONL event streams, diagnoses, diffs, manifests and Godot
   verification output.
4. **Documentation** - interface audit, adapter contract, isolation design with
   the verified escape matrix, and the results record.

## Results

- **4/4 end-to-end runs passed** on `crate-does-not-fall` with
  `opencode/deepseek-v4.1-flash-free`.
- Every run produced a grounded, evidence-specific diagnosis before source
  access. All four identified that the crate was excluded from simulation and
  explicitly flagged that the exact property was not observable in the evidence.
- Three runs restored `crate.gravity_scale = 1.0` byte-identically to the
  pristine fixture. One run (the fourth) deleted the injected line instead,
  relying on the engine default of `1.0`: same behaviour, same `8/8`
  acceptance, recorded as `matches_pristine_file: false`. The harness reports
  that distinction rather than hiding it.
- Acceptance went from `7/8` to `8/8` in every run.
- Wall-clock per run: 110-184 s, of which about 42 s is Godot startup and
  capture; the agent itself used 67-142 s.
- Cleanup succeeded in every run: sandbox removed, temp fixture removed, no
  orphaned agent processes.

## Isolation: what was proven

Verified by direct experiment against the committed config, not by prompt text
(`docs/phase15/isolation-design.md`):

- absolute, relative and parent-directory reads -> `Permission denied: external_directory`;
- `glob`/`grep` outside the sandbox -> denied;
- writes outside the sandbox -> denied;
- writing a project `opencode.json` -> denied (self-escalation blocked);
- `shell` -> tool absent;
- code mode -> tool absent (this was a real hole while enabled: it exposed
  `session_move`, `worktree_*` and MCP resource reads outside the `tool.use`
  policies);
- `subagent` -> tool absent;
- `skill` -> none available;
- MCP -> zero servers, zero resources;
- the answer key and the original repository are never mounted.

The decisive finding of the audit: **`--standalone` is mandatory**. Without it,
`opencode run` attaches to a shared background service that was started
elsewhere with the global config, and the sandbox policy is silently ignored -
the first experiment read a file outside the sandbox. With `--standalone` plus a
private `XDG_CONFIG_HOME`, every attempt in the matrix was denied. That shared
service (`opencode` PID 9600, started 2026-10-18) is still running on this
machine; the adapter never touches it.

## Regression status (unchanged)

| Check | Result |
| --- | --- |
| `npm test` (9 suites) | 65/65 pass, 0 fail, 0 skipped, 0 todo |
| `character-audit` | 4/4 |
| `combat` | 3/3 |
| `door` | 7/7 |
| `observation` | 8/8 |
| `phase13-defect` | 8/8 |
| `physics` | 9/9 |
| `sentry` | 7/7 |

All counts are identical to the Phase 14 baseline. No test file was modified:
`git status` shows only the new adapter, sandbox config, `package.json` script
entries and `docs/phase15/`. `git diff` over `docs/phase8` through `docs/phase14`
is empty. The Phase 8-14 fixtures are untouched.

## Limits

- This is **not an OS sandbox**. The agent runs as the same user; containment is
  OpenCode's permission engine plus the absence of every code-execution tool.
  Re-verify the matrix after any OpenCode upgrade.
- Repeatability is demonstrated for **one case and one model**: four runs of
  `crate-does-not-fall` with `deepseek-v4.1-flash-free`. Nothing here shows the
  same reliability for the other three Phase 14 defects or other models.
- **A passing repair is not necessarily the intended minimal edit.** One of four
  runs deleted the defective line instead of restoring it; the acceptance oracle
  cannot distinguish the two. Only `matches_pristine_file` records the
  difference, and the adapter does not fail a run for it.
- The task is a single-line, single-file defect with a clean oracle. The adapter
  has not been exercised on multi-file changes, ambiguous failures, or cases
  where the evidence does not identify the defect.
- The agent cannot run tests. Verification is adapter-side by design; if a
  future phase needs agent-side iteration, that requires a different isolation
  design (a real sandbox with an allowlisted command runner), not a permission
  tweak.
- No failure path was triggered by the agent in these three runs. Failure
  handling is implemented and unit-checked by inspection only; it has not yet
  been observed against a genuinely failing agent, other than one adapter bug
  found and fixed during development.

## Recommendation for the next phase

Take the adapter to the other three Phase 14 defects, one run each, before
scaling anything. That is the cheapest test of whether the loop generalizes
across defect classes (state transition, event path, interaction response) or
whether the current result is specific to an obviously inert physics body.

Only after that should the engine work resume toward the playable 3D action
game. No game implementation was started in this phase.
