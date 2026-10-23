# Phase 18 Implementation

## Chosen approach

I added a ground-level warning ring around the enemy's feet, drawn in the 3D world (not a screen-space overlay). It is a thin, flat `CylinderMesh` (`MeshInstance3D`) parented to the enemy's `FighterRig` node so it sits at the enemy's feet and moves with the enemy. It uses only existing engine primitives (`CylinderMesh`, `StandardMaterial3D`) — no new asset files or dependencies — with an emissive red material matching the existing windup highlight color (`#ff4b34`).

The ring is driven entirely by the existing enemy windup phase/tick: it is enabled only while `enemy_ai.phase == "windup"`, and its scale and emission intensity scale with `enemy_ai.phase_progress()` (`phase_tick / WINDUP_TICKS`). Early in the windup it is small and dim; as the windup approaches the attack it grows wider and brighter. It is hidden in idle, active, and recovery. Because it is a world-space decal on the floor around the feet, it remains at least partly visible in the normal camera framing even when the player's body partly occludes the enemy.

No movement, combat timing, collision, hitbox, posture, health, dodge, camera, restart/reset, or HUD behavior is touched — only two `.gd` files gain a few lines of purely visual logic.

## Files changed

- `game/scripts/fighter_rig.gd`
  - Added `warning_ring`, `_warning_enabled`, and `_warning_progress` fields.
  - Added `_build_warning_ring()`, which constructs a flat emissive red cylinder at the fighter's feet (just above the floor, no shadow, no collision) and adds it as a child of the rig. Initially hidden.
  - Added `set_warning(enabled, progress)` to drive the ring.
  - `reset_pose()` now resets warning state and hides the ring.
  - `tick_visual()` calls `_update_warning_ring()`, which shows/hides the ring and interpolates its scale (`0.45 -> 1.25`) and emission energy (`0.5 -> 2.0`) with progress.
- `game/scripts/game_world.gd`
  - `_update_enemy_visual()` now calls `enemy_rig.set_warning(enemy_ai.phase == "windup", enemy_ai.phase_progress())` each tick alongside the existing `set_telegraph`/`tick_visual` calls.

## Visual behavior

- **Idle / restart:** `enemy_ai.phase` is `idle`, so `set_warning(false, 0)` is called each tick and the ring is hidden. No warning appears in `idle.png` or `restart.png`.
- **Early windup:** `phase` is `windup` with a low `phase_tick` (e.g. tick 18 → progress 0.6), so the ring is already visible at the enemy's feet, small-to-medium brightness — readable at normal window size.
- **Late windup:** `phase_tick` is higher (e.g. tick 26 → progress ~0.87), so the same ring is wider and brighter, making the attack feel more imminent. This gives the blind ordering check a visible early-to-late progression rather than two indistinguishable frames.
- **Active / recovery:** `phase` is no longer `windup`, so the ring is hidden again; no warning remains in `active.png` or `recovery.png`. Post-hit feedback (pink player flash, `STRUCK`) is untouched.

## Behavior preserved

The ring is a non-colliding `MeshInstance3D` with shadow casting off, so it cannot affect physics, hitbox queries, movement, or damage. It is only enabled during the enemy windup and is driven by `enemy_ai.phase` / `phase_tick`, which are already read by the existing telegraph/blade logic; no new timer or state is introduced. `_update_hud`, combat resolution, dodge/parry, camera blending, reset/restart, and HUD text are unchanged. The only behavioral addition is a world-space visual around the enemy's feet during windup.

## Limits

I could not run the game or capture new screenshots in this environment, so I could not verify the ring's on-screen size, brightness under the baseline lighting, or how much of it stays visible around the player's occlusion at 1280x720. The exact scale/energy range (`0.45->1.25`, `0.5->2.0`) and ring radius (`0.62`) were chosen from the enemy's capsule radius (`0.38`) and the baseline framing (enemy feet near screen `(674, 405)`) but should be confirmed against real captures. The independent runner will apply this exact source to the canonical worktree and capture real screenshots at the baseline snapshot points.
