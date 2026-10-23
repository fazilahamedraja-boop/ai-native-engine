# Phase 18 Controlled Defect Diagnosis

## Evidence (observed)

Both observation files describe the same seven captures and the same public state values. `healthy/observations.json` names run `phase18-visual-2026-10-23T13-49-21-600Z`; `defect/observations.json` names run `phase18-visual-2026-10-23T13-55-41-752Z`. In both, the HUD reads `PLAYER  HP 4/4  [####]`, `ENEMY   HP 5/5  [#####]`, `POSTURE 0/100`, `DODGE   READY`, and the same control legend during idle and all three windup captures. The active capture shows `PLAYER  HP 3/4  [###-]`, `STATE   INCOMING ATTACK - press K to deflect`, and the large `STRUCK` text. Player position, enemy position, and camera position are identical between builds for `idle`, `windup-early`, `windup-mid`, and `windup-late`; `enemy_feet_screen` is likewise identical for those captures.

The images show the same arena, camera, blue player character, red enemy character, HUD panel, floor disc, and background pillars in both builds. In `healthy/idle.png` and `defect/idle.png` the enemy is plain dark red with no warning marker on the floor. In `healthy/restart.png` and `defect/restart.png` the characters are farther apart and there is no warning marker. In `healthy/active.png` and `defect/active.png` the player flashes pink, `STRUCK` is displayed, and no warning marker is present.

During windup, `healthy/windup-early.png`, `healthy/windup-mid.png`, and `healthy/windup-late.png` show a pale orange warning disc on the floor beneath the enemy. It is visibly wider in `healthy/windup-mid.png` than in `healthy/windup-early.png`, and widest in `healthy/windup-late.png`. The enemy's upper body also appears lighter and more orange in all three healthy windup images than in the healthy idle or active images.

In `defect/windup-early.png`, `defect/windup-mid.png`, and `defect/windup-late.png`, an orange floor marker is present, but it is smaller and more saturated than its healthy counterpart, and its extent looks essentially unchanged across the three defect windup frames. The enemy's upper body stays close to the darker brick-red seen in idle and active.

As recorded in the observation files, the image hashes are identical across builds for `idle`, `active`, and `restart`; they differ for `windup-early`, `windup-mid`, `windup-late`, and `recovery`. The snapshot facts also show a small capture offset in the later frames: healthy `windup-late` is engine tick 27 with `enemy_phase_tick` 26, while defect `windup-late` is tick 28 with phase tick 27; healthy `recovery` is tick 41 with phase tick 1, while defect `recovery` is tick 42 with phase tick 2. Positions, health, and HUD text remain identical in those pairs.

## Comparison

**Observation.** `healthy/idle.png` versus `defect/idle.png`: byte-identical per the observed SHA-256 values, and visibly the same, with no warning disc.

**Observation.** `healthy/active.png` versus `defect/active.png`: byte-identical, with the same pink player flash, `STRUCK` text, health, enemy pose, and no warning disc.

**Observation.** `healthy/restart.png` versus `defect/restart.png`: byte-identical, with the same separated positions and no warning disc.

**Observation.** `healthy/windup-early.png` versus `defect/windup-early.png`: both are captured at engine tick 19 with `enemy_phase_tick` 18, the same positions, and the same camera. The healthy image has a broad, pale orange floor disc; the defect image has a smaller, deeper orange floor marker. The healthy enemy torso and head are lighter orange-red; the defect enemy is darker red.

**Observation.** `healthy/windup-mid.png` versus `defect/windup-mid.png`: both are at tick 23 with phase tick 22 and the same positions. The same difference is present: the healthy floor disc is wider and paler than the defect marker, and the healthy enemy still shows the lighter warning tint while the defect enemy does not.

**Observation.** `healthy/windup-late.png` versus `defect/windup-late.png`: the healthy floor disc is the widest of its three windup frames, while the defect marker is still about the size of its early frame. The defect frame is one engine tick later than the healthy frame, yet its marker is still not expanded, so the difference is not explained by the small capture offset.

**Observation.** `healthy/recovery.png` versus `defect/recovery.png`: the hashes differ, but both show `STRUCK`, `STATE   duel`, the same health, the same positions, and no warning disc. The only visible difference is a minor enemy pose/progress difference consistent with the one-tick capture offset recorded in the observation files (tick 41 versus 42, phase tick 1 versus 2).

**Interpretation.** The like-named pairs that isolate the regression are the three windup frames. Their shared, repeatable difference is that the healthy build's warning presentation escalates across the windup: the floor disc expands and the enemy carries a lighter orange warning tint. In the defect build the floor marker stays at a small, roughly constant size and the enemy stays at its base dark red. The idle, active, and restart frames being identical, together with unchanged positions and HUD, rules out a camera, layout, or text change. The recovery hash difference is consistent with the documented sampling offset and is not counted as evidence of the visual defect.

## Chosen visual defect

The windup warning cue is frozen instead of escalating. Across `windup-early`, `windup-mid`, and `windup-late`, the intended cue should visibly grow in scale and intensity as the strike approaches: in the healthy build the pale orange floor disc widens from the early frame through the late frame, and the enemy is visibly lit with a lighter orange-red warning tint. In the defect build the floor marker remains at nearly its early size and deeper orange colour, and the enemy stays at its plain dark red; the progression from early to late is effectively absent.

This matters because the windup cue is the player's visual timing signal for an incoming attack. HUD text and attack timing are unchanged, but the escalating "it is about to land" element is lost, leaving only a static early-looking warning. A player relying on the visual cue gets less usable warning time and may mistime a deflect or dodge.

What must remain unchanged: the enemy and player positions, the camera, all HUD text and health values, the windup/active/recovery timing, the active hit that reduces player health to 3/4, the `STRUCK` display, the player's pink hit flash, the absence of a warning marker in idle, active, recovery, and restart, and the byte-identical presentation of `idle`, `active`, and `restart`.

## Proposed repair evidence

An independent observer can verify a repair with a new run of the same frozen encounter, camera, scenario, input sequence, and capture names. The observer should:

1. Open the new `windup-early`, `windup-mid`, and `windup-late` captures side by side with the accepted `healthy/` captures. The replacement warning disc should be pale orange and visually wider in each successive frame, ending widest in the late frame, matching the healthy progression. The enemy should show the same lighter orange warning tint during windup.
2. Confirm, without relying on this diagnosis, that the new `idle`, `active`, and `restart` captures are visually identical to `healthy/idle.png`, `healthy/active.png`, and `healthy/restart.png`; their hashes matching the accepted build would be strong corroboration.
3. Confirm that the new `recovery` capture has no warning disc and shows the same HUD state, health, positions, and `STRUCK` text as the accepted recovery capture.
4. Confirm from the public snapshot fields that engine ticks, phase ticks, positions, player health, enemy health, and HUD text still match the accepted run (allowing for the same small screenshot-capture offset seen between the two original runs).

## Limitations

These are still images, so they cannot show the smoothness, frame rate, or exact timing curve of the escalation; they can only confirm its endpoints and intermediate sample. They cannot give exact colour, opacity, or scale values, nor prove how the cue looks from other camera angles or with other enemies. The capture-tick offset in `windup-late` and `recovery` means those pairs are not perfectly aligned samples, although the early and mid pairs are aligned and already show the difference. The images and public snapshots cannot prove gameplay timing, input handling, or whether the attack remains dodgeable; those must be checked in a real run. No fix has been run or verified here.
