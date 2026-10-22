# Phase 17 evidence index

All paths are relative to `docs/phase17/`. `manifest.json` in this directory
contains the SHA-256 and byte size of every Phase 17 doc and evidence file.

## Contracts and plans

- `feature-spec.md` - dodge input, timings, state, events, HUD, restart contract.
- `verification-plan.md` - isolation rules, test layers, capture matrix, repair rules.
- `oracle-corrections.md` - audited corrections to the first-run test oracle.
- `report.md` - final result, commands, AI/runner/manual split, limits.

## Agent runs

- `agent-runs/feature-dodge/` - historical first feature run. Attempt 1 failed
  because the test queried `attack_phase` instead of `player_attack_phase`;
  attempt 2 was stopped. Retained, not used as final evidence.
- `agent-runs/feature-dodge-run2/manifest.json` - final feature run: green
  attempt 1, 476,362 ms, hidden test hash, changed files.
- `agent-runs/feature-dodge-run2/attempt-1.diff` - complete source diff.
- `agent-runs/feature-dodge-run2/AGENT-NOTES.md` - agent's own implementation notes.
- `agent-runs/feature-dodge-run2/logs/` - import, red baseline, existing 18/18,
  hidden dodge 12/12, and the raw OpenCode event stream.
- `agent-runs/repair-dodge-distance/manifest.json` - defect id, injected and
  pristine hashes, repair attempt, 124,370 ms, green result.
- `agent-runs/repair-dodge-distance/defect.json` - exact injected regression.
- `agent-runs/repair-dodge-distance/attempt-1.diff` - functional repair is one line.
- `agent-runs/repair-dodge-distance/logs/` - red 11/12 defect baseline, repaired
  12/12 dodge and 18/18 existing logs.

## Canonical verification

- `evidence/canonical/game-suite-run2-source.json` - 18/18, 14,217 ms.
- `evidence/canonical/dodge-suite-run2-source.json` - 12/12, 4,007 ms.
- `evidence/canonical/game-suite-after-apply.json` and
  `dodge-suite-after-apply.json` - earlier apply check with the first-run source.

## Windowed captures

- `evidence/live/windowed-dodge/manifest.json` - 9/9 checks, 6 captures, engine
  output, per-capture state.
- `evidence/live/windowed-dodge/states.json` and `events.json` - tick-correlated
  state and event streams.
- `01-before-dodge.png`, `02-initiation.png`, `03-mid-dodge.png`,
  `04-recovery.png`, `05-cooldown.png`, `06-after-restart.png`.
- `engine-stdout.log`, `engine-stderr.log`.

## Exported Windows build

- `evidence/export/windows-deflect-arena/manifest.json` - 9/9 checks, EXE path,
  109,127,680 bytes, SHA-256, probe details.
- `evidence/export/windows-deflect-arena/package-scan.json` - EXE/PCK scan:
  no `phase17` or capture-PNG paths packaged.
- `stdout.log`, `stderr.log` - probe process output.

## Web build

- `evidence/web/web-build-manifest.json` - web export source/file hashes, byte
  sizes, output path.
- `evidence/web/web-verification.json` - direct URL, dashboard URL, canvas size,
  six loaded captures, iframe canvas, console result, screenshot hashes, and
  the explicit keyboard caveat.
- `dashboard-final.png`, `dashboard-captures.png`, `dashboard-play17.png` - live
  dashboard after publication.
- `play17-loaded.png`, `play17-after-space.png`, `play17-after-j.png`,
  `play17-synthetic-space.png` - direct web build.

## Regression

- `evidence/regression/full-suite-after-phase17.log` - 65/65, 98,000.5 ms,
  `FULL_SUITE_EXIT=0`.

## Live dashboard

- Temporary live root: `C:\Users\hacke\AppData\Local\Temp\opencode\phase16-progress`.
  `phase17.html` polls `phase17/status.json` and serves the mirrored evidence.
- The repository evidence remains the source of truth. The dashboard is a
  convenience view and is not part of the commit.
