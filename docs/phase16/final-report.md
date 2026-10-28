# Phase 16 — final report

## Bottom line

A complete, playable third-person sword duel now exists in the Phase 16
worktree. The player can move, attack, and deflect; one enemy telegraphs,
attacks, takes damage, staggers, and can be defeated; player defeat, victory,
and restart all work. It was verified in a real windowed session and in an
exported Windows build.

Phase 8–15 is untouched: the regression suite still passes 65/65, and this
branch has not been merged or pushed.

| Verification | Result |
| --- | --- |
| In-engine acceptance suite | **18/18 pass**, 14.3 s |
| Windowed playthrough | **11/11 checks**, 9 correlated frames |
| Agent repair (adapter-driven) | **1 injected failure → 18/18 pass**, oracle untouched |
| Export probe (packaged binary) | **6/6 pass** |
| Export clean launch | exit 0 headless, visible window rendered |
| Baseline regression (before) | **65/65 pass**, 94.4 s |
| Final regression (after) | **65/65 pass**, 94.6 s |

## Where it is

- Worktree: `C:\Users\<user>\ai-native-engine-phase16`
- Branch: `experiment/phase16-game`, based on Phase 15 `47e9127`
- Game: `experiments/godot-harness/game/`
- Acceptance suite: `game/tests/run_game_tests.gd`
- Windowed runner: `controller/game-verify.mjs`
- Agent-task runner: `controller/game-task.mjs`
- Export probe: `controller/export-verify.mjs`
- Reports and evidence: `docs/phase16/`

Run it:

```powershell
cd experiments/godot-harness
godot --headless --path game --import   # once per fresh checkout
godot --path game
```

`WASD` move, `J` or left mouse attack, `K` deflect, `R` restart.

The exported build is at
`experiments/godot-harness/game/build/DeflectArena.exe` (ignored by git,
109,127,680 bytes; `.pck` 70,348 bytes). It is reproduced with the documented
export command, not committed.

## What the game is

A 24 x 24 m walled arena, one player, one enemy, one encounter.

- **Player**: 4 HP, 4.4 m/s, 6/8/14/6-tick attack, 14-tick deflect window,
  8-tick deflect recovery.
- **Enemy**: 5 HP, 30/9/18/22-tick attack, 100 posture, +16 per sword hit,
  +55 per deflect, 0.35/tick decay, 70-tick stagger at full posture.
- **Camera**: fixed-angle follow with a shoulder offset, blended at 0.35/tick,
  ray pull-in with a minimum-boom fallback.
- **Combat**: explicit box queries on explicit layers, active ticks only,
  one-hit latch per swing, fully structured events. No damage shortcut in the
  test hooks.
- **Presentation**: placeholder rigid-limb fighter with procedural animation,
  primitive sword, emissive telegraph, HUD health/posture/state.

Full design and tuning: `game-design.md`. Execution record:
`implementation-plan.md`.

## Evidence

### Windowed playthrough

`docs/phase16/evidence/live/phase16-live-2026-10-22T17-21-27-965Z/`

Nine frames, each captured while paused at a known tick:

| Frame | Tick | State |
| --- | --- | --- |
| `01-spawn` | 0 | 4/5 HP, playing |
| `02-approach` | 24 | 2.18 m, enemy windup |
| `03-telegraph` | 47 | red telegraph visible |
| `04-parry-window` | 50 | parry active, 11 ticks left |
| `05-deflect` | 58 | success, HP 4, posture 53.6 |
| `06-victory` | 287 | enemy 0 HP, victory |
| `07-restart` | 0 | 4/5 HP, playing |
| `08-defeat` | 294 | player 0 HP, defeat |
| `09-final-restart` | 0 | 4/5 HP, playing |

Every frame has `engine_tick == simulation_step == state.step`. The two
restart frames are byte-identical; the spawn frame differs by one pixel with a
one-level channel difference (renderer noise, identical state). Full table and
narrative: `gameplay-verification.md`.

The first two windowed runs are preserved as superseded iterations (camera
distance and occlusion fixes). Only `17-21-27` is authoritative.

### In-engine suite

`docs/phase16/evidence/in-engine/run_game_tests.json`

18 checks covering the 12 required criteria plus camera wall clipping,
stagger safety, the event stream, and the HUD. 18 passed, 0 failed, 14,265 ms.

### Agent adapter

`docs/phase16/agent-runs/2026-10-22T17-30-08-599Z-parry-window-repair/`

The Phase 15 adapter's sandbox, OpenCode invocation, tree hashing, and diff
helpers were reused. A controlled regression (`PARRY_WINDOW_TICKS` 14 → 44) was
injected into a sandbox copy. The runner verified it reproduced exactly one
failure, then gave the agent the task. The agent used `glob`, `grep`, `read`,
and `edit` (8 tool calls, 22 events, OpenCode 2.0.32, model
`opencode/deepseek-v4.1-flash-free`) and changed one line back to 14. The
runner rejected oracle edits (none), ran the real Godot suite, and got 18/18.
The sandbox was removed, with zero orphan processes.

The first attempt failed before any agent turn on a `godot` PATH shim
(`ENOENT`); the fix was to use the harness's `GODOT_BIN` resolver. That failed
run is preserved as integration evidence.

This is a genuine repair exercise, not a scripted diagnosis: the agent was not
told where the bug was, the test oracle was independently hashed, and the pass
decision came from the adapter running Godot. It repaired a copy of the real
game, not the shipped file, because the shipped file was already correct; the
diff and verification are the evidence.

### Exported build

`docs/phase16/evidence/export/2026-10-22T17-37-47-216Z-probe/`
and `.../17-35-09Z/export-printwindow.png`

- `DeflectArena.exe --headless --quit` → exit 0, no errors.
- Visible launch → process alive, title `deflect-arena`.
- `PrintWindow` captured the actual game window (HUD, arena, both fighters).
- Bridge probe: clean initial state, movement to 2.18 m in 24 frames, sword hit
  with `player_hit_enemy`, restart to step 0, process alive. 6/6.

The export probe proves packaging, launch, rendering, input, hit resolution,
and restart. The full victory/defeat loop is proven by the windowed source run;
it was not replayed inside the packaged binary.

## Definition of done

| Requirement | Status |
| --- | --- |
| Playable third-person game in the Phase 16 worktree | done |
| Move, attack, defend | done and verified |
| One enemy attacks, takes damage, staggers, is defeated | done and verified |
| Victory, defeat, restart | done and verified |
| Visible-window verification | done, 9 frames |
| 12 gameplay acceptance checks | 18/18 pass |
| Phase 8–15 regression unchanged | 65/65 pass |
| Adapter used for implementation/repair | controlled repair, adapter-verified |
| Isolated, reproducible evidence | per-run directories, hashes, manifests |
| Small auditable commits | four focused commits |
| Clean worktree | yes at handoff |
| No merge, no push | yes |

## Limits

Placeholder art with no skeleton or animation clips; one enemy and one attack;
fixed camera with no orbit or lock-on; no audio, menus, save, or progression;
Windows-only export; synthetic input for evidence, not OS-level key injection;
one scripted playthrough. Details and evidence caveats:
`known-limitations.md`.

## Reproduction

From `experiments/godot-harness`:

```powershell
godot --headless --path game --import
node controller/harness.mjs test --project game --script res://tests/run_game_tests.gd --json
node controller/game-verify.mjs --out-dir ..\..\docs\phase16\evidence\live\<new-run-id>
node controller/game-task.mjs --task ..\..\docs\phase16\agent-tasks\parry-window-repair.md --defect ..\..\docs\phase16\agent-tasks\parry-window-repair.json
godot --headless --path game --export-release "Windows Desktop" <abs>\game\build\DeflectArena.exe
node controller/export-verify.mjs --exe game/build/DeflectArena.exe
npm test
```

`npm run test:game`, `npm run verify:game`, `npm run agent:game`, and
`npm run probe:export` are thin wrappers for the same commands. `npm test`
itself is unchanged.

## Commit sequence

1. `feat: add deflect arena game project and acceptance suite`
2. `test: add windowed gameplay verification and export probe`
3. `feat: add phase 16 agent task runner`
4. `docs: add phase 16 design, evidence, and final report`

No commit exists on `master` from this phase. The Phase 16 branch is local; the
Phase 15 branch and tag are untouched.
