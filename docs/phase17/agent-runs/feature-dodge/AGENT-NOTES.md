# Phase 17 dodge-roll notes

## What changed

- `game/scripts/game_world.gd`
  - Added the `dodge` input action on `Space` via the existing runtime
    `_ensure_input_actions()` path (the same mechanism the other controls use).
  - Added `dodge` to the harness input dictionary, the live input reader, edge
    consumption, `set_harness_input()` (flat key and `actions.dodge`), and
    `harness_reset()`.
  - Added a tick-based three-phase dodge (`idle` / `active` / `recovery`) with:
    - 18 active ticks, 10 recovery ticks, 45-tick cooldown from the start tick.
    - 9.0 m/s committed XZ movement; direction captured from movement input, or
      backwards from the player's facing when there is no input.
    - i-frames exactly on active ticks 3..13 (`dodge_tick >= 3 and < 14`).
    - validity checks for outcome, phase, cooldown, idle attack, and no active
      parry. Rejections emit `dodge_rejected` with a short `reason` and change
      nothing else.
  - Enemy damage now checks the dodge i-frame flag first. A hit during the
    window is ignored and emits `dodge_evaded`; the parry/deflect state is not
    read or modified. All other damage/parry rules are untouched.
  - Added snapshot fields `dodge_phase`, `dodge_tick`, `dodge_cooldown`,
    `dodge_invulnerable`, `dodge_direction`, `dodge_available`; dodge
    phase/tick/cooldown/invulnerability are also in `harness_hash()`.
  - HUD now has a `DODGE` status line (`READY` / `ACTIVE` / `RECOVERY` /
    `COOLDOWN n.nn s`), `SPACE dodge` in the controls line, and `DODGE`/`EVADE`
    feedback.
  - `reset_game()` clears all dodge state, so restart makes a dodge
    immediately available. `harness_setup()` intentionally leaves dodge state
    alone so a test can reposition bodies mid-dodge without cancelling it.

- `game/scripts/fighter_rig.gd`
  - Added a procedural `dodge` pose: a low tucked shoulder-roll during active,
    settling into a low crouch during recovery. It uses only the existing rigid
    limb nodes and primitive transforms.

- `game/README.md`
  - Added the Space dodge control.

## Tick semantics used

The tick on which a dodge starts is phase tick 0. Snapshots therefore expose
active ticks 0..17 and recovery ticks 0..9; `dodge_recovery` is recorded 18
ticks after `dodge_started`, and `dodge_finished` 10 ticks after that. Damage
overlap is tested after the player/enemy move in a tick, so an incoming hit on
active tick 3..13 is evaded.

## Uncertainty

- For a no-input dodge the direction is backwards from the current facing, and
  the rig then turns to face that dodge direction (the spec's "visibly face a
  directional dodge"). If a test expects the rig to keep its original facing
  for a backstep, the yaw would differ, but `dodge_direction` is still correct.
- Rejection reason strings are short tokens (`not_playing`, `busy`, `cooldown`,
  `attacking`, `parrying`); the spec does not prescribe exact text.
