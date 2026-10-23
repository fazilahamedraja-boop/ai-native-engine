# Phase 18 implementation task: readable incoming-attack telegraph

You are the implementation stage of a controlled visual-repair experiment.
You have a disposable copy of the game source. The diagnosis stage ran before
you received source access and its report is `./diagnosis.md`.

## Evidence
- Baseline captures: `./baseline/*.png`
- Correlated public snapshots: `./baseline/captures.json`
- Source: `./game` (no tests, harness, docs, or acceptance thresholds)
- Baseline run: `phase18-baseline-2026-10-22T21-26-46-923Z`

Read `./TASK.md`, `./diagnosis.md`, the baseline images, and the relevant source.
Use the actual images, not assumptions.

## Visual requirement
The game currently announces an incoming attack mainly with HUD text and a
thin blade glow. Make the threat readable in the 3D scene itself.

Implement a bounded visual change that:
1. adds a ground-level warning around the enemy's feet, visible in the normal
   camera framing even when the player partly occludes the enemy;
2. is already visible early in windup;
3. becomes more prominent as windup approaches the attack;
4. is absent in idle and recovery;
5. is driven by the existing enemy windup phase/tick, not a separate timer;
6. leaves all movement, attacks, deflect/posture, dodge, enemy damage, victory/
   defeat, restart/reset, camera, and existing HUD behavior unchanged.

Use only existing game assets and code. Do not add an external asset or a new
dependency. Do not change tests, the harness, `project.godot`, scenes, input
maps, physics, combat timings, or HUD text. Do not add a screen-space overlay:
the warning must be in the 3D world around the enemy.

## Allowed changes
Only existing or new `.gd` files under `game/scripts/`. Keep the change small
and reviewable. If you add a helper, place it under `game/scripts/`.

## Required notes
Write `./IMPLEMENTATION.md` with these sections:

# Phase 18 Implementation

## Chosen approach
What visual mechanism you added and why it matches the diagnosis.

## Files changed
Exact relative paths and what changed.

## Visual behavior
How it appears early and late in windup, and why it does not appear in idle or
recovery.

## Behavior preserved
Why this cannot affect gameplay, timing, collisions, health, posture, dodge,
camera, restart, or HUD text.

## Limits
What you could not verify without running the game.

Do not claim the implementation passes a test or that you ran the game. The
independent runner will apply this exact source to the canonical worktree and
capture real screenshots.
