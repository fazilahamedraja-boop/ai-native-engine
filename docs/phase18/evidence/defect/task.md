# Phase 18 controlled visual repair

This is a **repair** stage, not a feature stage.

The disposable `game/` already contains the accepted ground-level enemy windup
warning. One controlled visual regression was introduced into that working
implementation. It still loads and it does not change gameplay, timing, input,
health, the HUD, the camera, or the scenes.

## Allowed workspace

- `game/` only. No tests, harness, docs, acceptance thresholds, or protected
  evidence are present.
- Only `.gd` files under `game/scripts/` may be changed.
- Do not add an asset or dependency. Do not edit scenes, `project.godot`, input
  maps, or the harness.

## Evidence

- `baseline/`: seven real screenshots and public snapshots from the **accepted
  healthy build**. This is the visual reference.
- `observed/`: seven real screenshots and public snapshots from the **defective
  disposable build**. Same frozen encounter, camera, input sequence, and capture
  names as `baseline/`.
- `diagnosis.md`: an independent image-only comparison diagnosis made before
  source access. It may be incomplete; check it against the images and the
  current source.
- `FAILURE.md`: the independent checker's observed failure and measurements.

Read `TASK.md`, `FAILURE.md`, `diagnosis.md`, every image in `baseline/` and
`observed/`, and the relevant source. Use the actual images, not assumptions.

## Repair goal

Find and remove the smallest cause of the regression so the existing
world-space enemy windup cue is restored:

1. visible around the enemy's feet early in windup;
2. clearly more prominent late in windup than early;
3. absent in idle and recovery;
4. driven by the existing enemy windup phase/tick;
5. rendered in the 3D scene, not only in the HUD.

Do not add a second warning system. Repair the existing implementation
minimally. Preserve all existing movement, attacks, deflect/posture, dodge,
enemy damage, victory/defeat, restart/reset, camera, and HUD behavior.

## Required note: `IMPLEMENTATION.md`

Write exactly these sections:

# Phase 18 Controlled Repair

## Diagnosis (from images and source)
What the healthy and observed images show, and the concrete cause you found in
the current source. Separate observation from interpretation.

## Change
The minimal change and why it restores escalation without altering gameplay.

## Verification
What you actually ran or read. Do not claim a test, capture, or build you did
not run. The independent runner will perform the real windowed capture, the
existing 18-check game suite, and the hidden 12-check dodge suite after you
finish.

## Risks and limitations
What could still be wrong and what remains unverified.

Do not edit acceptance evidence, tests, the harness, or protected phase
evidence. Do not claim autonomous success for a run that failed.
