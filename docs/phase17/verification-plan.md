# Phase 17 verification plan

This phase adds one feature to the Phase 16 game and verifies it without
weakening the existing tests. The runner owns every verification decision; the
agent only edits the disposable game copy.

## Isolation

| Item | Value |
| --- | --- |
| Worktree | `C:\Users\hacke\ai-native-engine-phase17` |
| Branch | `experiment/phase17-dodge` |
| Base | Phase 16 `90fba1c` on `experiment/phase16-game` |
| Historical evidence | Phase 8-16 files are not edited |
| Sandbox | `%TEMP%\phase17-agent-*`; removed unless `--keep-sandbox` is set |

The Phase 15 adapter and its deny-by-default `opencode.json` are reused. The
agent has no shell, network, browser, subagent, skill, or question tool. It may
read and edit the copied game only.

## Test layers

| Layer | Owner | Command | What it proves |
| --- | --- | --- | --- |
| Existing acceptance | Runner | `npm run test:game` | Attack, deflect, posture, victory, defeat, restart still work (18 checks) |
| Dodge acceptance | Runner | `npm run test:game:dodge` | Dodge phases, timing, movement, input conflicts, i-frames, cooldown, restart, HUD, events (11 checks) |
| Full harness regression | Runner | `npm test` | Phase 8-16 controller/evidence tests (65 checks) |
| Windowed run | Runner | `npm run verify:dodge` | Six real window captures correlated with paused state and events |
| Controlled repair | Runner + agent | `node controller/phase17-agent.mjs --mode repair ...` | A disposable regression fails the suite, the agent repairs it, and the suite goes green without test edits |
| Windows export | Runner | `npm run probe:export:phase17` | The packaged binary starts, dodges, cools down, restarts, and lands one existing sword hit |

The hidden dodge suite is `game/tests/run_dodge_tests.gd`. It is copied into the
agent sandbox only while the runner executes it and is removed before the agent
starts. Test files are hashed before and after every agent attempt.

## Acceptance matrix

| Check | Positive path | Negative / boundary path |
| --- | --- | --- |
| Start | `Space`/`dodge` starts a visible active phase | Rejected while attacking, parrying, cooling down, or defeated |
| Movement | 9.0 m/s XZ burst, direction from movement input | Input during active/recovery does not steer |
| Phases | active -> recovery -> idle | Timers, i-frame flag, and direction reset correctly |
| I-frames | Damage during active ticks 3-13 is ignored and emits `dodge_evaded` | Damage at active ticks 0-2 and 14-17 lands normally |
| Cooldown | 45 ticks from start; available again at zero | A second dodge is rejected while cooling down |
| Restart | Restart clears every dodge field and a new dodge is available | Old movement/tick/cooldown cannot leak into the new encounter |
| HUD | `DODGE` status and `SPACE dodge` control are visible | — |
| Events | started, recovery, finished, rejected, evaded | Every invalid request leaves attack/parry/restart intact |
| Existing combat | Existing 18-check suite | Sword hit, deflect, posture, victory, defeat, restart unchanged |

## Windowed capture stages

The visible run must capture these states with the simulation tick and the
public snapshot/event stream at the same paused tick:

1. before the dodge (idle, cooldown 0, available);
2. initiation (active, tick 1, direction, cooldown started);
3. mid-dodge (active, invulnerable window);
4. recovery (no i-frames, control returning);
5. cooldown rejection (idle, cooldown > 0, `dodge_rejected`);
6. after restart (step 0, every dodge field cleared, rearmed).

## Controlled defect experiment

The repair experiment is run in a disposable copy. The defect is applied by the
runner, not by editing the canonical source. The runner reproduces at least one
expected failing check, gives the agent only failing test names/details and the
runtime tail (never the hidden test source), and allows at most two repair
attempts. The repair passes only when both the hidden dodge suite and the
existing 18 checks are green and no test was changed.

## Baseline before Phase 17

Measured in the isolated worktree at `90fba1c` after importing the Godot
project:

```text
npm run test:game       18/18 pass, 14.2 s
npm test                65/65 pass, 94,113 ms, NPM_TEST_EXIT=0
```

The hidden dodge suite was run before the feature and failed all 11 checks, which
confirms it exercises the missing behavior rather than passing vacuously.
