# Phase 17 feature request: dodge-roll

You are implementing a new combat mechanic in the existing Deflect Arena game.
This is a real Godot 4.7 project, not a mock. Keep the existing architecture and
combat rules.

## Context

- Project: `game/` inside the Godot harness.
- Game script: `game/scripts/game_world.gd`.
- Visual rig: `game/scripts/fighter_rig.gd`.
- Enemy state machine: `game/scripts/enemy_ai.gd`.
- The game is tick-based at 60 physics ticks per second.
- Existing controls: W/A/S/D movement, J/left mouse attack, K deflect, R restart.
- Existing acceptance tests must continue to pass. Do not edit test files.

## Goal

Add a dedicated, visible dodge-roll that is useful against the enemy's
telegraphed attack, without replacing or rewriting the combat system.

## Required controls

- Add a Godot input action named `dodge`, bound to **Space**.
- Add it to the harness input dictionary as the boolean key `dodge`.
- It must not conflict with movement, attack, deflect, or restart.

## Required behavior

Use these exact timing and movement values so the result is reproducible:

| Constant | Value |
| --- | --- |
| active duration | 18 physics ticks |
| recovery duration | 10 physics ticks |
| cooldown | 45 physics ticks, starting when the dodge starts |
| dodge speed | 9.0 metres/second on the XZ plane |
| invulnerability start | active tick 3 |
| invulnerability end | active tick 14 (exclusive) |

The dodge has three observable phases:

1. `active` - movement and the invulnerability window.
2. `recovery` - no dodge movement; the player is vulnerable.
3. `idle` - normal control has resumed.

The player must return to normal movement, attack, and deflect control after the
recovery phase.

### Direction

- At dodge start, choose the direction from the current movement input
  (`forward`/`strafe`).
- If there is no movement input, dodge backwards relative to the player's
  current facing.
- The player should visibly face a directional dodge.
- The dodge is a committed movement burst: input during active/recovery does
  not steer it.

### Validity and cooldown

A dodge may start only when all of these are true:

- the encounter outcome is `playing`;
- `dodge_phase` is `idle`;
- `dodge_cooldown` is zero;
- the player attack is idle;
- the player is not in an active parry window.

A rejected dodge request must not change the dodge state and must not cancel an
attack, parry, or restart. Record a `dodge_rejected` event with a short `reason`
field. Cooldown must prevent a second dodge immediately after the first one, and
the dodge must become available again when the cooldown expires.

### Interaction with enemy damage (invulnerability frames)

- `dodge_invulnerable` is true only while `dodge_phase == "active"` and
  `dodge_tick` is at least 3 and less than 14.
- If the enemy's damage hitbox overlaps the player during that window, the
  player takes **no** damage. Record a `dodge_evaded` event. Do not consume or
  trigger the deflect/parry state.
- Outside the window (active ticks 0-2, active ticks 14-17, and the whole
  recovery phase) existing damage rules apply exactly as before.
- This must not change the enemy state machine, attack timings, or the parry
  rules.

### Restart

`R` / harness `restart` must reset the dodge phase, tick, cooldown, direction,
invulnerability flag, and any one-shot dodge bookkeeping. A fresh dodge must be
available immediately after restart.

## Observable interface

Add these fields to the game `snapshot()` dictionary so the controller can
correlate screenshots with state:

- `dodge_phase`: `"idle"`, `"active"`, or `"recovery"`.
- `dodge_tick`: integer tick within the current active/recovery phase.
- `dodge_cooldown`: integer ticks remaining before another dodge is allowed.
- `dodge_invulnerable`: boolean, true only inside the explicit i-frame window.
- `dodge_direction`: three-number array `[x, y, z]`, normalized XZ direction
  (zero when idle).
- `dodge_available`: boolean convenience field for HUD/observers.

Emit these event-stream types at the corresponding transitions:

- `dodge_started` (include the chosen direction and current cooldown);
- `dodge_recovery` (active phase ended);
- `dodge_finished` (recovery ended, normal control restored);
- `dodge_rejected` (include `reason`);
- `dodge_evaded` (an enemy hit was ignored because of invulnerability).

Include the dodge phase/tick/cooldown/invulnerability in `harness_hash()` so
different dodge states have different hashes.

## HUD and visual feedback

- Add a `DODGE` line to the status panel showing `READY`, `ACTIVE`,
  `RECOVERY`, or a cooldown time.
- Add `SPACE dodge` to the controls line.
- Add a visible dodge pose/animation to the player rig during the active and
  recovery phases. It should look different from locomotion, attack, parry, and
  defeat. Keep it procedural; do not add an animation asset or a new framework.
- Use the existing feedback label for a short `DODGE`/`EVADE` message if useful.

## Constraints

- Reuse Godot's built-in `CharacterBody3D`, `InputMap`, physics, and scene graph.
- Do not add dependencies, a new engine, a second game mode, or a general
  dodge/combat framework.
- Do not edit anything under `game/tests/`.
- Do not modify the harness bridge protocol or the test runner.
- Keep existing movement, camera, attack, deflect, posture, victory, defeat,
  restart, and HUD behavior intact.
- Keep the change focused on the dodge mechanic and the small amount of HUD,
  snapshot, event, and rig code it needs.

## Verification

The runner, not the agent, will verify the result with the real Godot runtime.
It will run both the existing 18-check suite and an independent dodge acceptance
suite that is not present in your sandbox. Do not assume that editing tests or
hard-coding a snapshot can satisfy it.

When finished, leave a short `AGENT-NOTES.md` in the sandbox root describing
what you changed and any uncertainty. It is not part of the game build.
