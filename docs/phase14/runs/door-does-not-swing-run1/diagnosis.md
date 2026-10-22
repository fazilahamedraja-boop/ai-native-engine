# Phase 14 blind diagnosis

Evidence-only diagnosis. No file under the isolated fixture
(`C:\Users\hacke\AppData\Local\Temp\phase14-blind-door-5DvxJk\project`) and no
`blind-cases.mjs` were opened before this file was written.

## Failure

The acceptance suite reports one failing case out of seven:

- `evidence/test-output.txt:7` -
  `FAIL door-unlock-open-pass feedback=UNLOCKED - DOOR OPEN locked=false open=true z=-3.499981 opens=1`
- `evidence/test-output.txt:11` - `RESULT passed=6 failed=1`

The six passing cases are `door-initial-state`, `door-too-far-feedback`,
`door-locked-no-key`, `door-key-required-and-acquired`, `door-reset` and
`door-same-process-outcome-repeatability`. Only the *pass-through* case fails,
and it fails **after** the door has already reported itself open: the detail
string carries `locked=false`, `open=true`, `opens=1`,
`feedback=UNLOCKED - DOOR OPEN`, and a player `z=-3.499981` (i.e. on the far
side of the doorway plane at `z=0`, 3.5 units beyond it).

So the failing case is not "the door would not open" and not "the player could
not get through". Something else that the open state is supposed to satisfy is
missing, and the only state field in the whole evidence set that is
simultaneously *unexpected for an open door* and *uniformly wrong* is the door's
rotation.

## Contradiction

**Falsifiable claim:** the door never swings. "Open" in this fixture is
implemented as *deleting the collider*, not as *rotating the door open*.

Two observations conflict:

1. **The door is open.** `evidence/state.json` reports
   `"door_open": true`, `"door_collision_enabled": false`,
   `"door_locked": false`, `"player_has_key": true`, and the player at
   `z=-3.49998068809509` with `player_velocity [0, 0, -4]`.
   `evidence/physics-queries.json` asks the `doorway_volume` box "to find out
   whether a door collider is still in the opening" and the only hits are
   `/root/Main/Lintel` and `/root/Main/Ground` - **no `/root/Main/Door`**.
   `evidence/observation.json` confirms the door's `Collision` child has
   `"disabled": true`. The opening is physically clear and the player walked
   through it.

2. **The door did not move.** Every single sampled state in the
   `DOOR_SUMMARY` trace reports `"door_rotation_degrees": 0.0` - in
   `initial_state`, `too_far`, `locked_no_key.before` / `.after_interact` /
   `.blocked`, `key_pickup`, `unlock_open.at_door` / `.opened` /
   `.passed_through`, `reset.*` and `repeatability.first` / `.second`.
   `evidence/observation.json` shows `/root/Main/Door` with
   `global_transform.quaternion [0, 0, 0, 1]` and `rotation_degrees
   [0, 0, 0]`, i.e. bit-for-bit unrotated. `evidence/before.png` shows the red
   door panel still flush in the wall plane while the HUD reads
   `DOOR: OPEN` / `PROMPT: DOOR OPEN - GO THROUGH`.

`open=true` + a clear doorway + a player standing on the far side (z=-3.5) is
only consistent with a door that *swung out of the way*. But the door's
measured rotation is exactly `0.0` at every sample and the panel is visibly
still in the wall. **A door that is open but has not rotated by a single degree
is the contradiction.**

The structural detail that makes the intended mechanism recoverable from the
evidence alone: in `evidence/observation.json` the `Door` body sits at
`global_transform.origin [-0.8, 0, 0]` while its `Collision` child is offset to
`origin [0.8, 1.1, 0]` with `size [1.6, 2.2, 0.2]`. The panel therefore spans
`x = -0.8 .. +0.8` and the body origin *is* the hinge edge. The door is built
to be swung by rotating the body about its Y axis at that hinge - and that
rotation is `0.0`.

## Hypotheses ruled out

| Hypothesis | Evidence that excludes it |
| --- | --- |
| The door never opened (interact missed, key missing) | `opens=1`, `locked=false`, `open=true`, `feedback=UNLOCKED - DOOR OPEN`; `player_has_key=true`, `key_available=false`, `key_visible=false`; `door-key-required-and-acquired` passes with `has_key=true` |
| The player was blocked and never passed through | `player_position.z` moved `+0.500018775463104 -> -3.49998068809509`; `player_motion -0.0666666030883789`/frame at `velocity -4.0` over 60 frames = exactly 4.0 units of continuous travel; `wall_contact=false` at `passed_through` |
| The doorway is still obstructed by the door collider | `physics-queries.json` `doorway_volume` returns only `Lintel` and `Ground`; `observation.json` shows `Door/Collision` `"disabled": true`; `door_collision_enabled=false` |
| The door swung but the swing was too small to clear the opening | `door_rotation_degrees` is exactly `0.0` in all 11 sampled states - there was no swing at all; and the opening is already clear, so "too small" cannot apply |
| The player was teleported past the door instead of walking | travel distance (`4.0`) equals `velocity * elapsed` exactly and `player_motion` is a continuous per-frame delta, not a jump |
| The run is non-deterministic / the harness is broken | `door-same-process-outcome-repeatability` passes with `exact_hash_match=true`, `position_delta=0.000000000`; `door-reset` passes with `settled_hash == baseline_hash == 03a99e65...`; 6 of 7 cases pass |
| The failure is in the reset/repeatability path rather than the open path | both of those cases pass; only `door-unlock-open-pass` fails, and it fails at the point where `door_open` is already `true` |
| The fixture never had a swing (the spec never asked for one) | the fixture's own oracle asks for it: the case is named `door-unlock-open-pass` and every other door state it checks (`locked`, `open`, `feedback`, `opens`, `z`) is already correct in the FAIL detail - the only remaining open-state dimension it tracks is the door's rotation, which is `0.0` everywhere |

## Proposed correction

**Smallest change:** in `scripts/door.gd`, make the *open* path actually swing
the door, i.e. apply the door's open rotation to the hinged `Door` body
(rotation about the body's own Y axis at its hinge origin `x = -0.8`), instead
of the current behaviour of only disabling the collider and leaving the door at
`0.0`.

Formally: the open path must end with the door's rotation set to the fixture's
open angle (a single rotation assignment, or a single open-angle constant that
that assignment reads), so that `door_rotation_degrees` becomes non-zero and
the panel clears the doorway physically, exactly as `door_open=true` claims.

What I will **not** do: touch `res://tests/run_door.gd` (the oracle, stays
byte-identical), weaken or delete any case, add gameplay, or hard-code a
value so the case passes. The rotation target will be taken from the fixture's
own declared open angle / the oracle's own expectation, not invented to match
the observed numbers.

Everything else in the open path (collider disable so the doorway stays
physically clear, `feedback`, `prompt`, `opens`, `locked`) is already correct
per the evidence and must be left alone.

## Confidence

**Medium-high (~70%)** on the *diagnosis* ("the door is opened by disabling its
collider instead of swinging it"), because it is the only property in the
entire evidence set that is simultaneously wrong-for-an-open-door and uniform
across all samples, and it is corroborated independently by three sources
(numeric trace, physics query, rendered screenshot).

**Lower (~40%)** on the *exact source line*, which I have deliberately not
looked at yet. Three source-level shapes are still open and I will confirm
which applies by reading `scripts/door.gd`:

1. the open path sets `rotation_degrees` to `0`/a closed angle instead of the
   open angle;
2. an open-angle constant was changed to `0`;
3. the swing exists but is overwritten each frame (e.g. reset to a zero
   rotation in `_process`).

What would raise confidence to high:

- reading `scripts/door.gd` and finding exactly one assignment that explains
  `door_rotation_degrees == 0.0` while `door_open == true`;
- re-running the **unchanged** oracle and getting `RESULT passed=7 failed=0`
  with exit code 0;
- confirming in the post-fix run that `door_rotation_degrees` is non-zero at
  `unlock_open.opened` and `unlock_open.passed_through` and that
  `door_collision_enabled` is still `false` and the `doorway_volume` query still
  reports no `Door` collider in the opening (the swinging door must not
  reintroduce a blocker).
