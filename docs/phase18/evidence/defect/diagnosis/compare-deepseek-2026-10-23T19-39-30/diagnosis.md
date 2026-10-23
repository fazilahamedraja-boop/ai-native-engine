# Phase 18 Controlled Defect Diagnosis

## Evidence (observed)

All comparisons below are between the accepted build (`healthy/`) and the disposable build (`defect/`). The public snapshots agree with the images: player position `[0, ~0.0005, 2.6]`, enemy position `[0, ~0.0005, 0.8]`, camera at roughly `[1.1, 2.70, 7.3]`, player HP 4/4 (3/4 after the hit), enemy HP 5/5, posture 0/100, and identical HUD text in the corresponding states.

- `healthy/idle.png` and `defect/idle.png`: byte-identical (both listed with SHA-256 `9feaf1dd...0390f`). Both show the blue player facing the red enemy at attack distance on the gray arena disc, with HUD `STATE duel`, `DODGE READY`, and no orange marking on the floor. The enemy's normal dark cast shadow is present.
- `healthy/windup-early.png` and `defect/windup-early.png`: both are at engine tick 19, simulation step 19, enemy phase `windup`, `enemy_phase_tick` 18, with identical player/enemy positions and camera, and the same HUD line `STATE INCOMING ATTACK - press K to deflect`. In `healthy/windup-early.png` the floor beneath the enemy is plain gray with only the normal shadow; I see no orange floor marking. In `defect/windup-early.png` there is a distinct soft orange elliptical patch on the floor directly beneath the enemy's feet, extending left and right of the legs and partly behind the player's white blade.
- `healthy/windup-late.png` and `defect/windup-late.png`: both show the same windup HUD, with the orange patch present in `defect/windup-late.png` and absent in `healthy/windup-late.png`. The public snapshots differ by one capture tick here (`healthy` tick 27, `enemy_phase_tick` 26; `defect` tick 28, `enemy_phase_tick` 27), so the enemy pose may be marginally different. The defect's orange patch looks essentially the same apparent size, softness, and brightness as in `defect/windup-early.png`; I do not see it grow or brighten between the two defect frames.
- `healthy/active.png` and `defect/active.png`: byte-identical (both `26229885...62aed5`). Both show the pink player hit flash, the `STRUCK` overlay, HP 3/4, and no orange floor patch under the enemy.
- `healthy/recovery.png` and `defect/recovery.png`: both show the enemy in recovery, `STATE duel`, HP 3/4, and no orange floor patch. No clear visible difference; the files have different hashes, and the snapshots differ by one tick (`healthy` tick 41 / `enemy_phase_tick` 1; `defect` tick 42 / `enemy_phase_tick` 2).
- `healthy/restart.png` and `defect/restart.png`: byte-identical (both `59b289ce...f9f36dd`). Both show the clean restart state (HP 4/4, `STATE duel`, player farther back) with no orange floor patch.
- Public snapshot facts for `windup-mid`: both observation files list a `windup-mid` capture at tick 23, `enemy_phase_tick` 22, with different image hashes (`healthy` `c5f5febc...f0404`, `defect` `5454189b...8d28b1`). However, there is no `windup-mid.png` in either `healthy/` or `defect/`; only six PNGs exist per directory. I therefore could not visually inspect the middle frame.

## Comparison

**Observation (time-matched early pair).** `healthy/windup-early.png` and `defect/windup-early.png` are the cleanest pair: same engine tick, same phase tick, same positions, same camera, same HUD and health. The visible difference is confined to the floor beneath the enemy: the defect frame has a soft orange ellipse there, the healthy frame does not. Everything else in those two frames — character poses, weapon, shadow, arena, HUD — appears the same.

**Interpretation.** Because the early pair is matched in simulation state, the orange floor ellipse is a rendering difference caused by the regression, not a pose, camera, or HUD difference.

**Observation (late pair).** `defect/windup-late.png` still shows the orange ellipse, and it looks the same as in `defect/windup-early.png`. `healthy/windup-late.png` still shows no ellipse. The late pair has a one-tick snapshot offset, so I cannot treat tiny pose differences as part of the defect.

**Interpretation.** The added orange marking persists through the windup and does not visibly change between the early and late samples. Whatever the accepted build's warning cue is, this added patch is not a graded/ramping cue in the defect build.

**Observation (non-windup states).** `idle`, `active`, and `restart` are byte-identical between builds, and all three show no orange floor patch. `recovery` shows no orange patch in either build, although its hashes differ along with the one-tick snapshot offset.

**Interpretation.** The regression is scoped to the windup presentation. The defect does not leave the orange marking on during idle, the active hit, recovery, or restart.

**Observation vs interpretation boundary.** I directly observe the orange ellipse only in the two defect windup images that exist. I do not observe it in the healthy windup images. I cannot observe `windup-mid` at all. I have not measured the ellipse's exact radius or opacity over time; the "same appearance" statement is a visual comparison of the two defect windup frames, not a numeric measurement.

## Chosen visual defect

**The defect: the windup tell has become a persistent, uniform orange ground ellipse beneath the attacker.** In `defect/windup-early.png` and `defect/windup-late.png`, a soft orange elliptical patch is painted on the floor under the enemy's feet. The like-named `healthy/windup-early.png` and `healthy/windup-late.png` contain no such patch; they show only the gray floor and the enemy's normal shadow.

**Why it matters for the intended escalating windup cue.** The turn's warning is supposed to escalate as the active hit approaches, so the player can read "soon" versus "now" from the presentation. This patch is effectively binary and already fully formed in the earliest sampled windup frame (tick 19), and it looks the same in the latest sampled windup frame (tick 27/28). It therefore carries no escalation information: the floor under the enemy looks the same early and late, so it cannot communicate increasing urgency. It is also an extra element that is absent from the accepted build's windup frames, so it is not the accepted graded cue; it instead adds a static, full-strength floor tell where the accepted presentation has none.

**What must remain unchanged.** The player and enemy positions, facing, poses (other than any deliberate cue change), camera, arena geometry, shadows, player health, enemy health, posture, HUD text, `STRUCK` overlay, and hit-flash colors must stay as they are. The corrected behavior must also remain scoped: no windup marking during idle, the active hit, recovery, or restart; the warning must still disappear once the windup ends. The early-to-late timing of the warning must stay tied to the same windup phase.

## Proposed repair evidence

An independent observer can verify a repair from new screenshots without source code or trusting this diagnosis:

1. Run the same frozen encounter, camera, scenario, input sequence, and screenshot names, and capture at the same engine ticks/phase ticks as the baseline.
2. In the windup frames (`windup-early`, `windup-mid`, `windup-late`), the floor beneath the attacker must not show the solid orange ellipse seen in the defect. If the accepted build's cue is a graded warning, the three windup frames must show a visible early-to-late progression rather than three identical floor patches.
3. Compare each new windup frame with the corresponding `healthy/` frame. If the fix restores the accepted rendering at matched ticks, the frames should be visually indistinguishable (and, given that `idle`, `active`, and `restart` were byte-identical, ideally hash-identical at matched capture ticks).
4. Confirm `idle`, `active`, and `restart` remain pixel-identical (or reproduce the known baseline hashes `9feaf1dd...`, `26229885...`, `59b289ce...`), and confirm `recovery` shows no windup marking.
5. In every frame, confirm the player/enemy positions, camera, health, posture, and HUD text match the baseline snapshots; any cue change must not move characters or alter game state.

## Limitations

- Only two windup frames with images exist (`windup-early` and `windup-late`). The `windup-mid` image is listed in both observation files but is missing from both directories, so I could not visually confirm the middle frame or verify that the patch is unchanged across three points.
- Still images cannot show whether the cue pulses, blinks, or ramps in real time; the "non-escalating" conclusion rests on the visual similarity of the early and late stills. A real-time run or frame sequence is needed to judge perceived escalation and readability.
- I cannot determine from stills whether the orange patch is a solid mesh, a sprite, a projected glow, or a light, nor its exact size, alpha, or growth curve. I also cannot tell whether it is world-anchored or screen-anchored.
- The `recovery` stills have different hashes but no visible difference; the snapshots differ by one tick/phase tick. I cannot tell from stills whether this is capture jitter, a tiny pose difference, or something related to the defect. Timing must be verified in a real run.
- One fixed camera angle is shown. The stills cannot show whether the cue is occluded at other angles, whether it tracks the enemy correctly, or how it reads against different backgrounds.
- I did not run the game and did not verify any fix; all statements above are from the provided images and public snapshot files only.
