# Phase 17 dodge-roll - agent notes

## What changed

### `game/scripts/game_world.gd`
- Added a `dodge` input action bound to **Space** in `_ensure_input_actions()`,
  and wired it through `_read_live_input()`, `_consume_edges()`,
  `set_harness_input()` (flat key and `actions.dodge`), `harness_reset()`, and
  the default `harness_input` dictionary.
- Added dodge state (`dodge_phase`, `dodge_tick`, `dodge_cooldown`,
  `dodge_direction`, `dodge_invulnerable`, plus a one-shot evade latch) with
  constants matching the spec exactly:
  active 18, recovery 10, cooldown 45, speed 9.0 m/s, i-frames active ticks
  3..13 (tick 14 exclusive).
- `_advance_dodge_state()` runs at the start of each playing tick so the
  snapshot for a tick reflects the state used by that tick's combat resolution.
  The start tick is active tick 0; ticks 0..17 are active, then 10 recovery
  ticks (0..9), then idle. Cooldown is set to 45 on the start tick and is not
  decremented on that tick, so it reads 45 immediately after the dodge starts
  and reaches 0 exactly 45 ticks later.
- `_start_dodge()` validates in the spec order (outcome -> not idle ->
  cooldown -> attacking -> parrying) and records `dodge_rejected` with a short
  `reason` without mutating any state on rejection. Direction comes from the
  current `forward`/`strafe` input vector; with no input it is the player's
  backward facing vector. The rig facing snaps to the chosen direction.
- Active movement sets XZ velocity directly to `direction * 9.0` (committed,
  unsteerable). Recovery zeroes XZ velocity. Attack/deflect requests are
  ignored while a dodge is committed, and `_start_attack`/`_start_parry` also
  refuse while `dodge_phase != "idle"`.
- `_resolve_combat()` checks `dodge_invulnerable` before parry/deflect: an
  overlapping enemy hit is ignored, records `dodge_evaded`, and does not touch
  parry state or enemy posture. Outside the i-frame window the original damage
  and parry rules are unchanged.
- Events: `dodge_started` (direction + cooldown), `dodge_recovery`,
  `dodge_finished`, `dodge_rejected` (reason), `dodge_evaded`.
- `reset_game()` and `harness_setup()` clear all dodge state; a fresh dodge is
  available immediately after restart.
- Snapshot adds `dodge_phase`, `dodge_tick`, `dodge_cooldown`,
  `dodge_invulnerable`, `dodge_direction`, `dodge_available`.
- `harness_hash()` now includes phase/tick/cooldown/invulnerable.
- HUD adds a `DODGE` line (`READY` / `ACTIVE` / `RECOVERY` / `COOLDOWN n.nn s`)
  and `SPACE dodge` to the controls line.
- A dodge request when the encounter is not `playing` records
  `dodge_rejected` with reason `not_playing` without touching state.

### `game/scripts/fighter_rig.gd`
- Added a `dodge` animation mode and `_pose_dodge()`: a low procedural shoulder
  roll (full body tuck + X-axis turn + tucked limbs). It is intentionally
  distinct from locomotion, attack, parry, stagger, and defeat.

## Uncertainty / notes
- `dodge_tick` is the tick within the current phase, starting at 0 on the tick
  the phase begins (matching "active tick 3" / "tick 14 exclusive"). A test
  that assumed the start snapshot reads tick 1 would disagree; nothing in the
  spec fixes that off-by-one, and tick 0 is the natural reading.
- Rejection reason strings are short and descriptive
  (`not_playing`, `dodge_not_idle`, `cooldown`, `attacking`, `parrying`); the
  spec does not pin exact values.
- `dodge_evaded` is latched once per dodge so a single enemy swing cannot emit
  duplicates. The enemy damage window is one tick, so this only matters if the
  enemy machine is changed (which it was not).
- No test files, bridge protocol, enemy state machine, or existing combat
  timings were modified.
