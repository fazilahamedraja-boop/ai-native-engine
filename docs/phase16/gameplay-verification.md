# Phase 16 — gameplay verification

## 1. Method

Two independent layers, both against real Godot processes:

1. **In-engine acceptance suite** (`game/tests/run_game_tests.gd`) — 18 checks
   over the public harness surface, run headless by the Phase 8 harness.
2. **Windowed playthrough** (`controller/game-verify.mjs`) — a real windowed
   `HarnessSession` at 1280x720, paused, stepped one physics tick at a time,
   with a screenshot and a structured snapshot at each checkpoint.

The windowed run does not trust the agent or the game's own HUD. Its policy
reads only public snapshot fields (`player_position`, `enemy_phase`,
`parry_ticks`, health, outcome) and asserts outcomes. Each capture is:

```
pause → advance_physics(N, input) → pause → snapshot → screenshot → snapshot
```

`engine_tick` is compared with `simulation_step` and with the game's own
`state.step` at every capture.

Authoritative run:

```
docs/phase16/evidence/live/phase16-live-2026-10-22T17-21-27-965Z/
```

Earlier runs `17-13-11` and `17-18-57` used earlier camera values and are
superseded. They are preserved, not deleted.

## 2. Windowed checks

`RESULT passed=11 failed=0`, `no-engine-errors errors=0`.

| Check | Observed |
| --- | --- |
| `windowed-session` | `headless=false` |
| `spawn-state-clean` | `step=0 player_hp=4 enemy_hp=5`, outcome `playing` |
| `player-approaches-enemy` | moved from 3.6 m to 2.18 m in 23 frames |
| `enemy-telegraphs` | enemy phase `windup`, tick 1 of the encounter |
| `parry-window-open` | `parry_ticks=11 result=active` |
| `deflect-registered` | `result=success player_hp=4`, `parry_success` event present |
| `sword-damages-enemy` | enemy health 5 → 0 |
| `victory-reached` | `outcome=victory enemy_hp=0` |
| `restart-clean` | step 0, 4/5 HP, outcome `playing` |
| `defeat-reached` | `outcome=defeat player_hp=0` |
| `no-engine-errors` | 0 engine ERROR lines |

## 3. Frame-to-state correlation

Every row has `engine_tick == simulation_step == state.step`. Positions are
`[x, y, z]` in metres.

| Capture | Tick/step | Player z | Enemy z | HP P/E | Posture | Enemy phase | Parry | Outcome |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `01-spawn.png` | 0 | 4.40 | 0.80 | 4/5 | 0 | idle | none | playing |
| `02-approach.png` | 24 | 2.98 | 0.80 | 4/5 | 0 | windup | none | playing |
| `03-telegraph.png` | 47 | 2.64 | 0.80 | 4/5 | 0 | windup | none | playing |
| `04-parry-window.png` | 50 | 2.64 | 0.80 | 4/5 | 0 | windup | active, 11 | playing |
| `05-deflect.png` | 58 | 2.64 | 0.91 | 4/5 | 53.6 | active | success | playing |
| `06-victory.png` | 287 | 2.64 | 1.14 | 4/0 | 79.2 | defeated | success | victory |
| `07-restart.png` | 0 | 4.40 | 0.80 | 4/5 | 0 | idle | none | playing |
| `08-defeat.png` | 294 | 2.42 | 1.19 | 0/5 | 0 | active | none | defeat |
| `09-final-restart.png` | 0 | 4.40 | 0.80 | 4/5 | 0 | idle | none | playing |

What the frames show:

- **01** spawn: HUD readable, player (blue) south of the enemy (rust), camera
  behind the player's right shoulder.
- **02** approach: the enemy has entered `windup` while the player closes.
- **03** telegraph: the enemy blade is emissive and the HUD warns to deflect.
- **04** parry window: the player is in the deflect pose with 11 ticks left.
- **05** deflect: `DEFLECT` feedback, enemy posture 53.6, player untouched.
- **06** victory: enemy lies defeated, `VICTORY` and restart prompt, posture
  79.2.
- **07** restart: byte-identical composition to 01; positions and health reset.
- **08** defeat: four enemy blows landed, `DEFEAT` and restart prompt.
- **09** final restart: byte-identical composition to 01 and 07.

`01`, `07`, and `09` are all 64,913 bytes. `07` and `09` are byte-identical
(SHA-256 `244B807C…14A18`); `01` differs from them by exactly one pixel with a
one-level channel difference at `(716, 309)`. The three snapshots are identical
at step 0, so that pixel is renderer nondeterminism, not a state difference.
Identical reset composition is a stronger signal than a step counter alone.

## 4. In-engine acceptance suite

`18 passed, 0 failed`, 14,265 ms, exit 0.

| Case | What it asserts |
| --- | --- |
| `game-startup` | scene instantiates, step 0, playing |
| `game-player-moves-and-stays-grounded` | horizontal travel, `y` stays near ground |
| `game-camera-follows` | distance in range, moved with player, look dot ≈ 1 |
| `game-camera-avoids-wall-clipping` | boom collapses to ≥ 1 m instead of leaving the wall |
| `game-attack-windup-cannot-damage` | no damage before active ticks |
| `game-attack-hits-enemy-once` | one swing, exactly one damage event |
| `game-attack-no-damage-outside-window` | recovery/cooldown queries cannot damage |
| `game-attack-facing-away-misses` | local hitbox respects facing |
| `game-enemy-damages-player` | enemy active hit removes one player HP |
| `game-parry-success` | no damage, posture ≥ 54, one `parry_success` |
| `game-parry-mistimed-does-not-register` | early press expires, hit lands, no success event |
| `game-enemy-stagger-transition` | posture 100 → stagger, then recovery |
| `game-staggered-enemy-cannot-attack` | no enemy active hit while staggered |
| `game-enemy-defeat-victory` | enemy HP 0 → victory |
| `game-player-defeat` | player HP 0 → defeat |
| `game-restart-restores-initial-state` | full reset after victory/defeat |
| `game-event-stream` | required event types, monotonic ticks |
| `game-hud-reflects-state` | HUD text matches health/outcome |

The suite uses `harness_setup` for controlled positions and can freeze the
enemy AI to measure a hitbox. Damage still flows through the same
`_resolve_combat` path as live play. The claim is limited to these scenarios at
60 Hz, not general physics determinism.

## 5. Adapter repair verification

Separate from gameplay, but on the same game source:

- Injected defect: deflect window 44 instead of 14.
- Before: exactly `game-parry-mistimed-does-not-register` failed.
- Agent: 22 events, tools `edit`, `glob`, `grep`, `read`.
- Change: one line in `scripts/game_world.gd` (44 → 14).
- Oracle hash: unchanged.
- After: 18/18 pass, adapter-side, in Godot.
- Sandbox removed, 0 orphan processes.

Evidence: `docs/phase16/agent-runs/2026-10-22T17-30-08-599Z-parry-window-repair/`.

## 6. Exported build verification

| Check | Result |
| --- | --- |
| Export | exit 0; `DeflectArena.exe` + `DeflectArena.pck` |
| `--headless --quit` | exit 0, no errors |
| Visible launch | process alive, window title `deflect-arena` |
| Window content | `PrintWindow` capture shows HUD, arena, both fighters |
| Bridge probe | 6/6 (initial state, movement, sword hit + event, restart, alive) |

The exported probe drives the packaged PCK over the same JSON bridge:
`packaged-initial-state` 4/5 HP at step 0, `packaged-movement` 24 frames to
2.18 m, `packaged-sword-hit` enemy HP 5 → 4 with `player_hit_enemy`,
`packaged-restart` back to step 0, process alive. It does not re-drive the
whole victory/defeat loop inside the binary; that loop is proven by the
windowed source run, which uses the same game code and resources.

## 7. Visual / structured discrepancies

1. **Apparent mirrored HUD.** The first 1x screenshots looked like the HUD text
   had a mirrored ghost. A pixel-correlation check on the crop showed the faint
   mask matches the bright mask at a 2 px translation (score 209) and only
   weakly under horizontal flip (score 70). It is the font antialias/outline
   halo, not a duplicate or mirrored render. No code change.
2. **Enemy occlusion.** With the camera directly behind
   (`(0, 2.6, 4.9)`), the player hid the enemy at melee range. The shoulder
   offset `(1.1, 2.7, 4.7)` fixed it. Visible in the superseded
   `17-18-57/03-telegraph.png` versus the authoritative
   `17-21-27/03-telegraph.png`.
3. **Desktop capture of the export.** `CopyFromScreen` captured an unrelated
   full-screen application that covered the game window. The misleading frame
   was discarded. `PrintWindow` with `PW_RENDERFULLCONTENT` captured the actual
   game window and is the authoritative export frame.
4. **Synthetic input.** The windowed evidence drives the game through
   `set_harness_input` (the controller schema), not OS-level key events. The
   same `_step_simulation` consumes both that path and the `InputMap` path used
   in normal play; the physical bindings are registered in
   `_ensure_input_actions`. This is a limit of the evidence method, not a
   gameplay bug. See `known-limitations.md`.

## 8. What is not claimed

- No human playthrough. The encounter was driven by a deterministic policy.
- No claim that every possible camera angle is clip-free; the tested case is
  the player backing into the south wall.
- No claim of frame-perfect timing on other machines; all observations are at
  60 physics Hz and the scenarios are deterministic in that setting.
- No claim that the exported binary's full victory/defeat loop was replayed;
  see section 6.
