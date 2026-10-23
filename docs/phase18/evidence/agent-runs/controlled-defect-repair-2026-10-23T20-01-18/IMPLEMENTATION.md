# Phase 18 Controlled Repair

## Diagnosis (from images and source)

**Observation (images and snapshots).** The `idle`, `active`, and `restart`
pairs have identical SHA-256 hashes and identical public snapshots. In both
builds they show the same arena, camera, player, enemy, HUD, health, and no
warning marker. The `recovery` pair differs slightly because the captured tick
is one later in the defective run (tick 42 / phase tick 2 versus tick 41 / phase
tick 1), but both images show `STRUCK`, the same state and health, and no
warning marker.

The three windup pairs are the ones that isolate the regression. In
`baseline/`, the pale-orange disc under the enemy is visibly wider and brighter
in `windup-mid` than in `windup-early`, and widest/brightest in `windup-late`.
In `observed/`, the marker is smaller, more saturated orange, and almost the
same size in all three windup frames. The snapshot metadata shows why: the
captures are at enemy phase ticks 18, 22, and 26-27 out of a 30-tick windup,
so the accepted cue should be at roughly 60%, 73%, and 87-90% progress across
those three frames.

**Observation (source).** `game/scripts/game_world.gd` already supplies the
live windup state on every visual tick:

```gdscript
var windup: bool = enemy_ai.phase == "windup"
enemy_rig.set_warning(windup, enemy_ai.phase_progress())
```

`enemy_ai.phase_progress()` returns `phase_tick / WINDUP_TICKS` during windup.
`game/scripts/fighter_rig.gd` already contains the rest of the cue: it creates
one `WarningRing` mesh at the fighter's feet, hides it unless warning is enabled
and progress is positive, scales it from 0.45 to 1.25 with progress, and raises
its emission energy from 0.5 to 2.0 with progress. `reset_pose()` disables both
the warning and the ring. The regression was in `set_warning()`: the defective
build computed `clampf(progress * 0.0 + 0.35, 0.0, 1.0)`, discarding the
incoming windup progress and pinning `_warning_progress` at a constant 0.35. The
copy now contains `clampf(progress, 0.0, 1.0)`, so the existing escalation curve
receives the real value again.

**Interpretation.** Geometry, material, visibility gating, the windup phase
source, reset behavior, gameplay state, and the HUD were all intact. Freezing
only the progress value reaching the existing world-space ring explains the
small, saturated, nearly constant marker in the observed windup frames and why
idle, active, recovery, and restart were unaffected. This is a presentation
regression in the single existing ring, not a missing warning system.

## Chosen approach

Repair the one existing world-space cue rather than add a new effect. The
smallest correct change is to pass the real enemy windup progress through
`set_warning()` to the already-written ring scale/emission curve. Nothing in the
enemy state machine, combat resolution, input, camera, HUD, or scene graph needs
to change.

## Change

The repair is confined to one expression in
`game/scripts/fighter_rig.gd`:

```gdscript
func set_warning(enabled: bool, progress: float) -> void:
	_warning_enabled = enabled
	_warning_progress = clampf(progress, 0.0, 1.0)
```

The defective expression ignored `progress` and forced 0.35. With the real
value restored, the existing code maps the sampled windup frames to increasing
ring sizes and emission strengths: about 0.93 / 1.04 / 1.17 scale and
1.40 / 1.60 / 1.85 energy at 60% / 73% / 90% progress. The same ring is hidden
as soon as `enemy_ai.phase` leaves `windup`.

## Files changed

- `game/scripts/fighter_rig.gd` only: the progress assignment in
  `set_warning()`.

No scene, asset, project setting, input map, harness, test, or other script was
changed.

## Visual behavior

- During windup, the single ground-level ring is visible around the enemy's
  feet and grows wider and brighter with windup progress.
- It is small and dim early, clearly larger and brighter in mid windup, and
  largest and brightest late in windup.
- It is absent in idle, active, recovery, stagger, defeat, and restart, because
  `game_world.gd` enables it only for `phase == "windup"` and
  `reset_pose()` clears it.
- The effect remains a 3D scene mesh under the enemy, not a HUD element.

## Behavior preserved

The change touches only the visual progress consumed by the existing ring. It
does not alter movement, attacks, deflect/posture, dodge timing or i-frames,
enemy damage, health, victory/defeat, restart/reset, camera, scene contents,
materials, or HUD text. The public snapshots for idle, active, and restart
remain byte-identical in the supplied evidence, and the source paths that
produce those values are unchanged.

## Verification

I read `TASK.md`, `FAILURE.md`, `diagnosis.md`, both `captures.json` files, all
seven `baseline/` images, all seven `observed/` images, and the three game
scripts (`game_world.gd`, `enemy_ai.gd`, `fighter_rig.gd`). From the captures I
confirmed the windup phase ticks and progress values, and from the images I
confirmed that the accepted disc escalates while the observed marker stays
small and saturated and disappears outside windup. I traced the value from
`enemy_ai.phase_progress()` through `_update_enemy_visual()` and `set_warning()`
to `_update_warning_ring()`, and confirmed the current source passes the real
progress, keeps the `windup`-only gate, and clears the ring on reset. I did not
run Godot, a build, a test suite, or a new windowed capture; the independent
runner performs those.

## Risks and limitations

- I could not execute the game or capture new frames in this disposable copy,
  so exact pixel counts, frame timing, and visual equality with the accepted
  build remain unverified until the independent windowed run.
- The healthy and defective `windup-late`/`recovery` captures have a one-tick
  offset. The repair restores the intended curve, but the new late frame may
  sample a slightly different progress than the accepted late frame; it should
  still be larger and brighter than early and mid.
- Still images cannot confirm smooth interpolation, other camera angles, or
  whether a different enemy would read the cue the same way. Only the three
  sampled windup frames and the absence outside windup can be checked here.
- `diagnosis.md` also reports that the healthy enemy torso looks lighter during
  windup. The source has no separate windup-driven body tint; its windup visual
  paths are the feet ring and the existing blade telegraph, so that appearance
  is most likely pose/lighting variation. If the independent capture still
  shows a distinct body-material mismatch, that would be a separate issue from
  the frozen ring progress repaired here.

## Limits

No gameplay or capture tooling was available in this disposable copy, so the
repair was validated by source tracing and the supplied images rather than by a
local run. The independent runner's windowed capture and the 18-check game suite
plus the hidden 12-check dodge suite remain the authoritative verification.
