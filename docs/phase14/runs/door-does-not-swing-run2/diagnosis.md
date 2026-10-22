# Phase 14 blind diagnosis

Fixture: `door` (Godot 4.7.2-stable, physics 60 Hz). Failing acceptance case:
`door-unlock-open-pass`. Test run before repair: `RESULT passed=6 failed=1`.

## Failure

The unlock/open/pass sequence completes its **state** half but never its
**motion** half.

- `evidence/test-output.txt:7`
  `FAIL door-unlock-open-pass feedback=UNLOCKED - DOOR OPEN locked=false open=true z=-3.499981 opens=1`
  Every logical field of the open transition is correct: `locked=false`,
  `open=true`, `opens=1`, and the player did travel through the doorway to
  `z=-3.499981` (door plane is `z=0`, player starts at `z=5.5`).
- `evidence/state.json:18-21`
  `"door_locked": false, "door_open": true, "door_collision_enabled": false,
  "door_rotation_degrees": 0`
  The door is *reported* open and its collider is off, yet the door's rotation
  is exactly `0`.
- `evidence/observation.json:43-69` — `/root/Main/Door` (`StaticBody3D`) is
  `source: "measured"`, `rotation_degrees: [0, 0, 0]`,
  `global_transform.origin: [-0.8, 0, 0]`. Its child `Collision`
  (`CollisionShape3D`, `BoxShape3D` size `[1.6, 2.2, 0.2]`) sits at the
  **closed-door** pose: local origin `[0.8, 1.1, 0]` (world `x ∈ [-0.8, 0.8]`,
  i.e. still filling the opening) with `disabled: true`.
- `evidence/before.png` — the HUD reads `DOOR: OPEN | KEY: HELD`,
  `PROMPT: DOOR OPEN - GO THROUGH`, `FEEDBACK: UNLOCKED - DOOR OPEN`,
  `z=-3.500 attempts=0 opens=1`, a green `OPEN` label floats over the doorway —
  and the red door leaf is still **standing flat in the wall**, filling the
  opening, with its handle knob facing the camera. The player capsule is
  already past the door on the far side.

So: the door is open *in state and in the HUD*, but the leaf itself has not
moved by a single degree. The player passed through a door that is still
visually shut — the collider was disabled, the leaf was never swung.

## Contradiction

**Falsifiable claim:** a door whose state is `open = true` and whose feedback
string is `UNLOCKED - DOOR OPEN` must have a non-zero world Y rotation by the
time the player has walked through it.

**The conflicting observations:**

| | says |
|---|---|
| `state.json` / `test-output.txt` / `before.png` (state + HUD + screenshot) | the door is **open**: `door_open=true`, `opens=1`, `door_collision_enabled=false`, HUD `DOOR: OPEN`, feedback `UNLOCKED - DOOR OPEN`, player through at `z=-3.499981` |
| `observation.json` (measured world transform of `/root/Main/Door`) | the door leaf is **still shut**: `rotation_degrees: [0, 0, 0]`, collider box still spanning the doorway (`x ∈ [-0.8, 0.8]` at `z = 0`), `disabled: true` |

A swung-open door cannot have zero rotation. The only way these two
observations coexist is if the open transition disables the collider and
updates state/HUD but **never applies a rotation to the door node**. That is
the defect: the *swing* half of "open the door" is missing.

Two independent measurements agree on the zero rotation (`state.json`
`door_rotation_degrees: 0` and the harness-measured
`/root/Main/Door.rotation_degrees: [0,0,0]`), so this is a real
transform state, not a stale/incorrectly-scoped read.

## Hypotheses ruled out

1. **"The door never unlocked / the key flow is broken."** Excluded by
   `door_locked=false`, `opens=1`, `feedback=UNLOCKED - DOOR OPEN`,
   `player_has_key=true`, `key_available=false`, `key_visible=false`
   (`state.json:14-23`), and by the passing case
   `door-key-required-and-acquired ... has_key=true key_available=false`.
2. **"The player is blocked and never got through."** Excluded by
   `z=-3.499981` and `player_velocity [0,0,-4]` in `state.json` — the player
   is 3.5 m *past* the `z=0` door plane, and the screenshot shows the capsule
   beyond the doorway.
3. **"The doorway is still physically blocked by the door collider."**
   Excluded by `physics-queries.json`: the `doorway_volume` box query over the
   opening returns only `/root/Main/Lintel` and `/root/Main/Ground`; no door
   collider is present (its shape is `disabled: true`).
4. **"The transform reading is stale or taken in the wrong space."** Excluded:
   `observation.json` reports `source: "measured"`, `space: "world"` for the
   Door, and its `Collision` child's *global* origin is
   `[0, 1.1, 0]` — the closed-door geometry, matching `rotation_degrees:
   [0,0,0]` and the screenshot.
5. **"The whole fixture/scene is broken (crash, missing nodes, dead input)."**
   Excluded: `engine_tick: 259`, `node_count: 4`, the HUD live and updating
   (`z=5.500 attempts=0 opens=1` at the initial trace), 6 of 7 cases passing
   including the reset/hash and repeatability cases, and the player moving
   under input.
6. **"The door swung and then snapped back to 0°."** Excluded: the failing
   detail shows `opens=1` with the door still open at `z=-3.499981`, and both
   the measured transform and `door_rotation_degrees` read `0` at that same
   moment — no nonzero value is observable anywhere in the evidence.
7. **"The swing is applied to a different node (e.g. a visual child) that the
   harness does not sample."** Excluded as the *primary* cause: the collider
   child — which is rigidly attached to the door leaf — is still in the
   closed-door pose (`global origin [0, 1.1, 0]`), and the screenshot shows
   the leaf itself unrotated. No rotation was applied to the door subtree.

## Proposed correction

**Smallest change:** in `scripts/door.gd`, make the *open* transition rotate
the door leaf about its hinge instead of only flipping state — i.e. on the
same transition that currently sets `open = true` / `feedback = "UNLOCKED -
DOOR OPEN"` and disables the collider, also drive the door node's Y rotation
to the swing angle so that the measured `door_rotation_degrees` becomes
non-zero and the leaf visibly swings out of the doorway.

Everything else stays as-is: the collider stays disabled while open, the
feedback/HUD strings stay unchanged, no gameplay is added, and the pristine
reset/hash behaviour must be preserved (the door must return to rotation `0`
on reset, so the `door-reset` baseline hash still matches).

I will read `scripts/door.gd` only after this file exists, to find the exact
line where the rotation update is dropped and to apply the minimal edit
(most likely a single missing/incorrect assignment on the door node's
rotation).

## Confidence

**Medium-high** on the diagnosis, **low** on the exact one-line fix until the
source is read.

Supporting: three independent evidence channels (measured transform,
fixture state snapshot, and the rendered screenshot) all show a door that is
open in state but unrotated in the world, while every other aspect of the
open sequence (unlock, key consumption, collider disable, feedback, player
passage) behaves correctly. The contradiction is unambiguous.

What would raise confidence:

- The measured `door_rotation_degrees` after the fix (should become the
  intended swing angle rather than `0`), and the case flipping to `PASS`.
- A re-run of `physics-queries.json`'s `doorway_volume` query plus a
  post-fix screenshot showing the leaf rotated clear of the opening.
- The pristine fixture's door-open pose, to confirm the intended swing angle
  and direction (hinge at the `Door` node origin `x = -0.8`, leaf spanning
  `x ∈ [-0.8, 0.8]` when closed).
