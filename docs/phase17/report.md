# Phase 17 - Dodge-roll

Status: **complete, runner-verified, not merged or pushed**

Branch: `experiment/phase17-dodge`\
Base commit: `90fba1c` (`docs: add phase 16 design, evidence, and final report`)\
Worktree: `C:\Users\<user>\ai-native-engine-phase17`\
Agent model: `opencode/deepseek-v4.1-flash-free`

## Outcome

A dodge-roll was added to the existing Deflect Arena game without replacing the
Phase 16 combat loop. The final implementation was produced by the Phase 15
adapter in an isolated sandbox, passed the runner-owned hidden acceptance suite,
and was then applied to the canonical worktree only after it was green.

The controlled repair experiment deliberately reduced `DODGE_SPEED` from `9.0`
to `1.0`. The hidden suite rejected that build with exactly one failure, the
agent repaired only the regression, and the repaired build passed again.

## What changed

| Area | Change |
| --- | --- |
| Input | `Space` -> `dodge`; added to the runtime `InputMap` alongside `W/A/S/D`, `J`, `K`, `R` |
| State | `idle`, `active`, `recovery`; active 18 ticks, recovery 10 ticks, cooldown 45 ticks from dodge start |
| Motion | 9.0 m/s in the committed direction; movement input chooses the direction, no input rolls backward relative to facing |
| Safety | Rejected while defeated, already dodging, cooling down, attacking, or parrying; rejection does not cancel the blocking action |
| Enemy interaction | I-frames during active ticks `3..13`; a blocked hit emits `dodge_evaded`; outside that window damage and parry behavior is unchanged |
| Observation | `dodge_phase`, `dodge_tick`, `dodge_cooldown`, `dodge_invulnerable`, `dodge_direction`, `dodge_available` |
| Events | `dodge_started`, `dodge_recovery`, `dodge_finished`, `dodge_rejected`, `dodge_evaded` |
| HUD | Dedicated `DODGE READY / ACTIVE / RECOVERY / COOLDOWN n.nn s` line and `SPACE dodge` control |
| Visuals | `fighter_rig.gd` has a full-body tuck-and-spin roll, distinct from attack, parry, walk, and defeat poses |
| Restart | Every dodge field is reset, including cooldown and i-frame state |

The dodge contract is in `docs/phase17/feature-spec.md`; the test matrix and
capture stages are in `docs/phase17/verification-plan.md`.

## Evidence summary

| Check | Result | Evidence |
| --- | --- | --- |
| Phase 16 baseline acceptance | 18/18, 14.2 s | baseline worktree / Phase 16 evidence |
| Phase 8-16 full regression | 65/65, 94,113 ms | baseline run, preserved |
| Feature agent run 2, red baseline | existing 18/18; hidden dodge 0/12 | `agent-runs/feature-dodge-run2/logs/baseline-*.txt` |
| Feature agent run 2, attempt 1 | dodge 12/12, existing 18/18, 476,362 ms | `agent-runs/feature-dodge-run2/manifest.json` |
| Canonical rerun after apply | game 18/18, 14,217 ms; dodge 12/12, 4,007 ms | `evidence/canonical/*-run2-source.json` |
| Windowed evidence | 9/9 checks, 6 captures, 0 engine errors | `evidence/live/windowed-dodge/` |
| Controlled defect, before repair | 11/12; expected failure `dodge-active-motion-and-phases`, `dx=0.30` | `agent-runs/repair-dodge-distance/logs/baseline-defect.txt` |
| Controlled repair | 12/12 dodge, 18/18 existing, 124,370 ms | `agent-runs/repair-dodge-distance/manifest.json` |
| Windows export probe | 9/9; dodge, i-frames, cooldown, restart, sword hit | `evidence/export/windows-deflect-arena/manifest.json` |
| Web build load | canvas 1440x900, title `deflect-arena`, no game errors | `evidence/web/web-verification.json` |
| Phase 8-16 regression after Phase 17 | 65/65, 98,000.5 ms, exit 0 | `evidence/regression/full-suite-after-phase17.log` |

### Source hashes

| File | SHA-256 |
| --- | --- |
| `game/scripts/game_world.gd` | `9d435ebd21013939c17cfa28fde37a791783ecf8b20d843916686bf8318cbf91` |
| `game/scripts/fighter_rig.gd` | `87f2ed8b36359e9b8f51c8bd5b0a29fe5fd64742c6059608feafb229e86ba7e8` |
| `game/README.md` | `b290a1c7869f100f4f3c5d4bb08f7bcce9fae218b4fc6a5bae302cadfb3bc8e4` |
| `game/tests/run_dodge_tests.gd` | `78b9ae15a00c2d220dd916449243469cfd96640c511602d87786e33e56fb20e7` |
| `controller/phase17-agent.mjs` | `82a5ef50d708e62246674fc659adf52130007df45cb71d0e9c1f26f9d98e892b` |
| `controller/dodge-verify.mjs` | `3d98cd1ba5bbec589d660d186adda5184eb8f11ff5b90ad219fb1dc9f9c9d5bd` |
| `controller/phase17-export-verify.mjs` | `d17fa14e1d2b4fb506f078533ae9787e07035566b99db7c02af72387731a96e4` |
| `controller/web-export.mjs` | `5c613f67cd2627ff1515dbe9781bb7a7ffd39d3cd2e1913733b2c79b8718de69` |

The feature and repair manifests record the same hidden-test hash,
`78b9ae15...e7`, before and after the agent ran. The runner rejects a run if the
test oracle or `harness/` changed.

### Exported Windows build

`game/build/DeflectArena.exe`

- bytes: `109,127,680`
- SHA-256: `cd2526cc93bc164d9d8f011761c2348973dfe06654824498767096fa58568212`
- probe: `npm run probe:export:phase17 -- --exe game/build/DeflectArena.exe`
- result: 9/9 passed

The packaged probe observed `dodge_phase=active` with cooldown, invulnerability,
a `1.20` m XZ displacement while moving, recovery without i-frames, cooldown
rejection, a clean restart (`dodge=idle`, cooldown 0), and a sword hit that
reduced enemy HP from 5 to 4. The process stayed alive.

The packaged EXE and PCK were also scanned for `phase17` paths and capture PNG
names; neither contains any (`evidence/export/windows-deflect-arena/package-scan.json`).
The duplicate `game/artifacts/phase17-*.png` files are ignored runtime artifacts;
the committed captures are the ones under `docs/phase17/evidence/live/`.

### Windowed captures

The real window was started with `headless=false`; the engine was paused at each
stage, one frame was captured, and the snapshot for that same tick was recorded.

| Capture | Tick | Observed dodge state |
| --- | --- | --- |
| `01-before-dodge.png` | 0 | idle, cooldown 0, available |
| `02-initiation.png` | 1 | active, tick 0, cooldown 45, direction +X |
| `03-mid-dodge.png` | 5 | active, tick 4, invulnerable |
| `04-recovery.png` | 19 | recovery, tick 0, not invulnerable |
| `05-cooldown.png` | 30 | idle, cooldown 16, rejected |
| `06-after-restart.png` | 0 | idle, cooldown 0, available |

`states.json`, `events.json`, and `manifest.json` pair each image with its
structured state. The captures are also mirrored under the live dashboard at
`phase17/evidence/`.

## AI / runner / manual split

**AI agent (feature).** The final `game_world.gd`, `fighter_rig.gd`, and
`game/README.md` changes came from the feature run. The sandbox contained only
`game/`; the hidden dodge suite was removed before the agent started. The agent
did not see the test oracle. Its final note is preserved at
`agent-runs/feature-dodge-run2/AGENT-NOTES.md`.

**AI agent (repair).** The repair run received the feature build with exactly one
injected defect and a failure report that did not name the defect. It changed
`DODGE_SPEED` back to `9.0`. The reviewed diff is functionally one line; the
runner also recorded a Godot-generated `.import` metadata change.

**Runner.** The runner created the isolated copies, proved the existing suite
green and the hidden dodge suite red before each attempt, hashed the test tree,
ran the hidden suite after each attempt, and wrote the attempt diff and logs. It
also ran the windowed capture verifier, the exported-build probe, and the defect
injection. It did not edit game code.

**Manual.** A human/agent operator created the branch and docs, launched the
bounded runs, applied the verified source to the canonical tree, patched the
live dashboard paths, and wrote this report. No manual gameplay code was written
to make the tests pass.

## Historical note: first feature run

The first feature run (`agent-runs/feature-dodge/`) is retained as history. Its
attempt 1 reported 11/12 because the test queried `attack_phase`; the snapshot
field is `player_attack_phase`. The implementation was not at fault. The oracle
corrections are documented in `docs/phase17/oracle-corrections.md`. The first
run's attempt 2 was deliberately stopped after the oracle issue was understood.
The final evidence run is `feature-dodge-run2`, using the corrected suite.

## Web build

The final web build is published separately from the Phase 16 build:

`http://127.0.0.1:8788/play17/index.html`

The dashboard page is `http://127.0.0.1:8788/phase17.html`; it polls
`phase17/status.json`. The Phase 16 `/play` build was not overwritten.

The web build loaded in Chromium with a 1440x900 canvas; the only console error
was a missing `favicon.ico`. The dashboard itself loaded the poster and all six
windowed captures, and the Play button embedded `play17/index.html` in an iframe
with a 1146x645 canvas. Automated trusted-key injection did not register a dodge
or attack in the browser session, so keyboard gameplay in the web build is
**not** claimed as verified. The native Windows export probe is the gameplay
proof for dodge, restart, and sword combat.

Web build source/file hashes are in `evidence/web/web-build-manifest.json`; the
load result is in `evidence/web/web-verification.json`. Screenshots include the
dashboard (`dashboard-final.png`, `dashboard-captures.png`,
`dashboard-play17.png`) and the direct build (`play17-loaded.png`,
`play17-after-space.png`, `play17-after-j.png`, `play17-synthetic-space.png`).

## Reproduction

From `experiments/godot-harness`:

```powershell
npm run test:game
npm run test:game:dodge
npm run verify:dodge
npm run probe:export:phase17 -- --exe game/build/DeflectArena.exe
npm test
```

The feature and repair runs were invoked with the bounded adapter:

```powershell
$env:PHASE17_AGENT_MODEL = 'opencode/deepseek-v4.1-flash-free'
node controller/phase17-agent.mjs --mode feature `
  --out-dir ../../docs/phase17/agent-runs/feature-dodge-run2 `
  --task ../../docs/phase17/feature-spec.md `
  --timeout-ms 900000 --max-attempts 2

node controller/phase17-agent.mjs --mode repair `
  --out-dir ../../docs/phase17/agent-runs/repair-dodge-distance `
  --task ../../docs/phase17/agent-tasks/dodge-distance-repair.md `
  --defect ../../docs/phase17/agent-tasks/dodge-distance-defect.json `
  --timeout-ms 900000 --max-attempts 2
```

## Remaining limits

- The web export was verified for load and rendering, not for keyboard gameplay
  through automated trusted keys.
- The Windows build is unsigned, as in Phase 16.
- The repair diff includes a Godot-generated `.import` metadata file; the
  functional repair is the single `DODGE_SPEED` line.
- No merge, push, reset, or history rewrite was performed. Phase 8-16 evidence
  and the Phase 16 `/play` build remain untouched.

## Evidence index

See `docs/phase17/evidence/index.md` for the complete file list.
