# Phase 18 Implementation

## Chosen approach

A ground-level warning ring at the enemy's feet, built only from existing engine
primitives (a flat emissive `CylinderMesh` with a `StandardMaterial3D`, same
red/orange color family as the existing blade telegraph) inside
`fighter_rig.gd`. It is created hidden at build time (`_build_warning_ring`,
sitting just above the floor at the fighter's origin, no shadow cast) and is
shown, scaled, and brightened each visual tick by `set_warning` /
`tick_visual` / `_update_warning_ring`.

The ring is enabled only while `enemy_ai.phase == "windup"`, and its scale
(0.45× → 1.25× of the 0.62 m base radius) and emission energy (0.5 → 2.0) are
driven by `enemy_ai.phase_progress()` (windup `phase_tick / WINDUP_TICKS`). So
it is visible early in windup, grows steadily more prominent as the attack
approaches, and is driven entirely by the existing windup phase/tick — no
separate timer, no gameplay interaction. Because it sits on the ground around
the enemy's feet, it remains readable in the normal camera framing even when
the player's body partly occludes the enemy's torso.

This matches the diagnosis: baseline early/late windup stills are
indistinguishable in-world and the HUD line was the only unambiguous warning, so
an escalating world-space foot-level cue directly addresses the static,
non-escalating telegraph without touching combat.

## Files changed

- `game/scripts/game_world.gd` (edited): fixed the engine parse error that
  prevented the game from loading. `var windup := enemy_ai.phase == "windup"`
  could not be typed because `enemy_ai` is untyped (`.phase` is a `Variant`),
  so Godot could not infer the variable's type; changed to an explicitly typed
  `var windup: bool = enemy_ai.phase == "windup"`. The seeded call
  `enemy_rig.set_warning(windup, enemy_ai.phase_progress())` is kept, so the
  warning is present exactly during windup and scaled by progress.
- `game/scripts/fighter_rig.gd` (already seeded into this copy; no further
  edit): `_build_warning_ring` builds the hidden ring, `set_warning` stores
  enabled/progress, `tick_visual`/`_update_warning_ring` show/hide it and
  apply scale and emission from progress, and `reset_pose()` clears it on
  reset so no warning lingers into restart/idle.

## Visual behavior

- Idle, restart, recovery: `enemy_ai.phase` is not `"windup"`, so
  `set_warning(false, 0.0)` hides the ring — no warning appears, as required.
- Early windup: the ring appears at the enemy's feet at small scale and dim
  emission — a subtle but visible "attack incoming" cue.
- Late windup (tick approaching 30): the ring is at maximum width (~1.25×)
  and brightness (emission up to 2.0) — clearly more imminent than early
  windup and readable from the scene alone.
- Active/recovery: warning hidden again (the pre-existing blade glow during
  active ticks 1–3 and the post-hit pink flash / `STRUCK` feedback are
  unchanged).

## Behavior preserved

The ring is a visual `MeshInstance3D` with no collision shape, no physics
layer, and nothing queries it; visuals run after combat resolution in
`_update_visuals` and only read enemy phase/tick — they never write simulation
state. Movement, hitboxes, damage, posture, parry/dodge, i-frames, win/loss,
restart/reset, camera, all combat timings (enemy 30/9/18/22), and all HUD
text are untouched.

## Limits

I could not execute the Godot engine in this environment, so I cannot confirm
that the real run loads cleanly, renders the ring, or passes the visual
acceptance checks; the independent runner applies this exact source to the
canonical worktree and captures real screenshots. Prominence under the existing
occlusion and the early/late ordering judgment were verified by source review
against the baseline captures, not by in-engine observation.
