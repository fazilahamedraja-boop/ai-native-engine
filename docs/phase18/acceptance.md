# Phase 18 independent visual acceptance criteria

These criteria were written before any Phase 18 game-visual change. They are
checked by `experiments/godot-harness/controller/phase18_visual_acceptance.py`
using only captured PNGs and the public snapshots correlated with them.

## Target

During the enemy's windup, the 3D scene must provide a readable, world-space
warning around the enemy that becomes more prominent as the attack approaches.
A player must not have to read the HUD to notice the threat. The cue must be
present while the player partly occludes the enemy in the normal camera
framing.

## Capture contract

Run the real game windowed, pause it, and capture the same framed encounter at:

- `idle` — enemy idle, AI frozen
- `windup-early` — enemy windup, phase tick >= 18
- `windup-mid` — enemy windup, phase tick >= 22
- `windup-late` — enemy windup, phase tick >= 24
- `active` — enemy active, phase tick >= 1
- `recovery` — enemy recovery, phase tick >= 1
- `restart` — clean restart, step 0

Every capture must have `state_before.hash == state_after.hash`, 1280x720
dimensions, a readable correlated public snapshot, and a recorded input
sequence. Player/enemy/camera positions must match the baseline within 0.12
units. The enemy phase name, health, and phase ordering must match; the phase
tick may differ by at most two fixed ticks because the paused capture loop can
advance one extra tick before a screenshot. This tolerance does not apply to
the visual thresholds. Godot must report no script errors, and both character
models must be loaded.

## Visual checks

The independent checker projects the enemy's feet using only the public camera
and position fields. It measures warm warning-colored pixels in a fixed ground
band around those feet: 170 px left/right, 10 px above the feet, 85 px below.

The improved build must satisfy all of:

- late windup has a substantial warm cue in the ground band;
- early windup already has a smaller but visible warm cue;
- the late cue is larger than the early cue (escalation);
- the cue changes the ground band pixels compared with idle;
- idle and recovery have no warning-sized warm region;
- the late windup warm region is at least 250 pixels larger than the baseline;
- HUD text remains `INCOMING ATTACK - press K to deflect` during windup;
- camera and fighter positions match the baseline within 0.12 units.

The exact numeric thresholds live in the independent checker, not in the agent
sandbox. A static ring that is equally strong throughout windup is not accepted:
the diagnosis identified the static, non-escalating telegraph as the defect.

## Behavioral checks

The visual change must not alter gameplay. The existing 18-check game suite and
the hidden 12-check dodge suite must both stay green, and the full Phase 8-17
regression suite must stay green. Windowed gameplay capture and exported-build
verification must also still pass.

## Baseline controls

The six-image diagnosis baseline (`phase18-baseline-2026-10-22T21-18-07-537Z`)
measured:

| capture | enemy phase | tick | warm ground pixels |
|---|---|---:|---:|
| idle | idle | 0 | 59 |
| windup-early | windup | 18 | 31 |
| windup-late | windup | 26 | 53 |
| active | active | 1 | 2052 |
| recovery | recover | 1 | 73 |
| restart | idle | 0 | 131 |

The baseline has no ground cue; the active frame is larger only because the
sword/impact feedback is already in the scene. The original 38-check baseline
run fails the early, late, and change checks. Its late/early ratio happens to
pass the escalation ratio because the baseline ground band is tiny and noisy;
the controlled-defect build is the case that isolates and fails
`telegraph-cue-escalates`. Later acceptance runs use the 39-check checker with
a baseline reference, which adds `visual-cue-increased-vs-baseline`.
