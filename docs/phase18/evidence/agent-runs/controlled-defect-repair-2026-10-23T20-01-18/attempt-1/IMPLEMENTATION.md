# Phase 18 Controlled Repair

## Diagnosis (from images and source)

**Observation (images and snapshots).** The `idle`, `active`, and `restart`
pairs are byte-identical between `baseline/` and `observed/`; their snapshot
hashes, positions, health, HUD text, and camera values also match. The three
windup pairs are the only frames that isolate the regression. In `baseline/`
the pale-orange floor disc under the enemy is visibly wider and paler in
`windup-mid` than in `windup-early`, and widest in `windup-late`. In
`observed/` the marker is smaller, deeper orange, and essentially the same size
in all three windup frames. The `FAILURE.md` measurements agree: observed warm
pixels around the enemy's feet are 1080 / 1101 / 1126 (late ÷ early = 1.04),
while the accepted reference is 1705 / 2219 / 2609 (late ÷ early = 1.53). The
`recovery` hash differs only in the pair with the documented one-tick capture
offset, and neither recovery image shows the disc.

**Observation (source).** `game/scripts/game_world.gd` already drives the cue
correctly every tick: `_update_enemy_visual()` calls
`enemy_rig.set_warning(enemy_ai.phase == "windup", enemy_ai.phase_progress())`,
so the enabled flag and a live 0..1 windup progress are both supplied. The
existing `_update_warning_ring()` in `game/scripts/fighter_rig.gd` then maps
`_warning_progress` to a growing radius (`lerpf(0.45, 1.25, progress)`) and a
brightening emission (`lerpf(0.5, 2.0, progress)`), and hides the ring when the
flag is off. The defect was in `set_warning()`: it computed
`clampf(progress * 0.0 + 0.35, 0.0, 1.0)`, discarding the incoming progress and
pinning `_warning_progress` at a constant 0.35. The ring therefore rendered the
same small, saturated early-looking marker on every windup frame instead of
escalating. The surrounding comment explicitly labelled this as the controlled
reversible defect.

**Interpretation.** The geometry, material, scene node, visibility gating,
windup phase source, and reset behavior were all intact. Only the progress
value reaching the existing world-space cue was frozen, which accounts for the
static warm-pixel counts and for the observed floor disc staying at nearly its
early size. Since idle, active, restart, gameplay state, and the HUD are
unchanged, this is a presentation-only regression in the existing ring.

## Change

One expression in `game/scripts/fighter_rig.gd`:

```gdscript
func set_warning(enabled: bool, progress: float) -> void:
	_warning_enabled = enabled
	_warning_progress = clampf(progress, 0.0, 1.0)
```

The previous expression ignored `progress` and forced 0.35. Passing the real
windup progress restores the already-written escalation curve: the ring starts
at the early size, grows and brightens through mid windup, and reaches its
widest/strongest point late, then disappears as soon as the enemy leaves the
windup phase. No gameplay, timing, input, health, HUD, camera, scene, material,
or additional warning effect was changed; the same single ring is still driven
by the existing enemy windup phase/tick.

## Verification

I read `TASK.md`, `FAILURE.md`, `diagnosis.md`, both `captures.json` files, all
seven `baseline/` images, all seven `observed/` images, and the three game
scripts involved (`game_world.gd`, `enemy_ai.gd`, `fighter_rig.gd`). I confirmed
from the images and measurements that the disc escalates in the accepted build
and is flat in the defective build, and traced the supplied
`enemy_ai.phase_progress()` value through
`_update_enemy_visual()` → `set_warning()` → `_update_warning_ring()` to the
single discarded-progress expression. I edited only
`game/scripts/fighter_rig.gd` and re-read the surrounding functions to confirm
the visibility gating (`windup` only), reset path
(`_warning_enabled = false`), and scale/emission formulas are untouched. I did
not run Godot, a build, the test suites, or a new windowed capture; those are
performed by the independent runner.

## Risks and limitations

- I could not execute the game or re-capture images in this disposable copy, so
  the exact pixel counts, frame timing, and visual match remain unverified until
  the independent windowed run. The expected warm-pixel progression is based on
  the existing `0.45..1.25` scale curve that the accepted captures match.
- The `diagnosis.md` also mentions a lighter orange enemy body tint during
  healthy windup. In the current source, body emission is only driven by
  `flash()`, not by windup; the windup-driven elements are the floor ring and
  the blade telegraph. That tint was not separately altered, and the checker's
  single failing measurement concerns the feet ring. If the independent capture
  still shows a body-tint mismatch, it would be a separate issue outside the
  frozen-progress cause identified here.
- Still images cannot verify smooth interpolation between captures or behavior
  from other camera angles; only the three sampled windup frames, the absence
  outside windup, and the unchanged state/HUD can be checked against the
  evidence.
