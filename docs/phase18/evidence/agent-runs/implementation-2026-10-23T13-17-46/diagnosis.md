# Phase 18 Baseline Diagnosis

## Evidence (observed)

All six PNGs were opened and were legible; no image was unreadable. The statements below are limited to what is visible in those images and to the public fields in `observations.json`.

The top-left HUD is present in every frame. In `idle.png` it reads `DEFLECT ARENA`, `PLAYER  HP 4/4  [####]`, `ENEMY   HP 5/5  [#####]`, `POSTURE 0/100  [..............]`, `STATE   duel`, `DODGE   READY`, and the controls line. The frames differ mainly in the `STATE` line and the player HP bar.

- **`idle.png`**: HUD `STATE   duel`; PLAYER 4/4, ENEMY 5/5. In the 3D scene, the blue player stands in the foreground with its back to the camera; the red enemy is close behind it, so the two silhouettes overlap substantially. The public snapshot gives player z=2.6 and enemy z=0.8, distance 1.8, and enemy feet screen at `(674.68, 404.45)`. No ground ring, warning decal, glow, beam, or attack text is visible in the arena.
- **`windup-early.png`**: HUD changes to `STATE   INCOMING ATTACK - press K to deflect`; HP is still 4/4 and 5/5. Scene: the enemy's stance, screen position, and spacing look essentially unchanged from `idle.png` (enemy feet screen `(674.71, 404.89)`, less than half a pixel from idle). The only in-world candidate for a warning is a narrow salmon/orange band near the top of the enemy's head/upper chest. It is small, and I cannot tell from the still whether it is an authored warning light or a lit model edge. I do not see a ground marker, a weapon arc, or a direction indicator in the arena.
- **`windup-late.png`**: HUD is identical to `windup-early.png`. The public snapshot reports enemy phase tick 26 (against 18 in the early frame) and the exact same enemy feet screen point `(674.71, 404.89)`. Visually, the 3D scene is indistinguishable from `windup-early.png`: same enemy pose, same spacing, same salmon band, no visible growth, brightening, pulsing, countdown, or new geometry. The next public snapshot, `active.png`, is only five engine ticks later (tick 32 versus 27), and the hit has already landed there.
- **`active.png`**: HUD still says `STATE   INCOMING ATTACK - press K to deflect`, while `PLAYER  HP 3/4  [###-]` shows the hit has already been taken. In the 3D scene, the player model is tinted pink/salmon instead of blue, the enemy is slightly closer and lower (enemy z=0.8433, feet screen `(674.07, 406.22)`), and a large pale-cyan `STRUCK` label appears outside the HUD panel near the upper middle-right. I cannot distinguish a separate weapon arc or ground impact marker in this still; the strongest readable hit feedback is the player's color flash plus `STRUCK`.
- **`recovery.png`**: HUD `STATE   duel` again, `PLAYER  HP 3/4`; the player is blue again and the enemy is upright at z=0.915. The large `STRUCK` label is still visible even though the HUD state is no longer an attack state and the snapshot phase is `recover`. No warning-style world cue is apparent in the arena; the scene otherwise resembles the idle stance.
- **`restart.png`**: HUD `STATE   duel`, PLAYER 4/4, ENEMY 5/5. The camera is pulled back (camera z=9.1 versus 7.3; player z=4.4), so both figures are smaller and farther apart on screen. `STRUCK` is gone. No warning cue is visible in the 3D scene, and the state reads as clean.

## Hypotheses

- **H1:** The windup presentation may be a binary state change: the HUD line is swapped at windup entry, and any in-world highlight is switched on at the start and left unchanged until the attack. If so, the 3D scene has no visible representation of remaining time.
- **H2:** The salmon band may be an authored warning highlight, or it may simply be a lit edge/top face of the low-poly model. The stills do not let me decide, but in either case it does not visibly change between the early and late windup frames.
- **H3:** The apparent absence of escalation could partly be a sampling artifact. The two windup stills are eight ticks apart in a windup that runs from tick 1 to about tick 31, so a short pulse or animation could have occurred between the captures. This is a hypothesis, not a claim that such animation exists.
- **H4:** The player's body sits between the camera and the enemy, so a body/weapon telegraph could be partly occluded. The warning might read differently from another camera angle or player position; the baseline only shows this framing.
- **H5:** The player's pink flash is likely a damage reaction, not an anticipation cue. It appears in `active.png` at the moment the HP drops, which is after the warning window.
- **H6:** The `STRUCK` label lingering in `recovery.png` may be an intentional hit confirmation that outlives the attack phase, or it may be a stale overlay. The stills and public fields cannot establish which.

## Chosen visual problem

**The windup's in-world telegraph is static and non-escalating, so the 3D scene does not communicate how imminent the attack is; the HUD line is the only unambiguous warning.**

This is supported by the fact that `windup-early.png` (phase tick 18) and `windup-late.png` (phase tick 26) look the same in the scene region: the enemy pose, spacing, silhouette, and reported feet screen point are effectively identical, and the only candidate in-world highlight is the same small salmon band in both. Yet the attack lands only five ticks after the late frame (`active.png`, tick 32, with the hit already applied). The strongest attack-related visuals in the baseline are reactive: the player turns pink and `STRUCK` appears after the HP loss. A player watching the scene rather than the HUD therefore gets little advance signal and no sense of urgency before impact.

Fixing this is worthwhile because the stated goal is anticipation in the 3D scene, not merely a HUD label. This is bounded to the visual presentation of the windup; it does not require changing the enemy's timing, positions, damage, inputs, or the HUD. It matters especially because the enemy is partly behind the player, so a subtle, unchanging cue competes poorly with the HUD and with the dramatic post-hit feedback.

What must remain unchanged:

- The HUD text and layout, including `INCOMING ATTACK - press K to deflect`, HP, posture, dodge, and controls.
- The phase timing and outcomes visible in the public snapshots: windup begins at tick 1, active at tick 31, the hit at tick 32, and recovery around tick 41, with only one HP lost.
- The player/enemy positions and 1.8-unit spacing, the camera framing, the arena geometry, and the blue/red character identities.
- Clean states: no warning in `idle.png` or `restart.png`, and no warning remaining in `recovery.png`.
- Existing post-hit feedback, such as the pink player flash and `STRUCK`, is outside this chosen problem and need not change.

## Proposed acceptance evidence

1. Re-run the same six public states and capture new stills at the same snapshot points: idle before any windup, early windup near phase tick 18, late windup near phase tick 26, active at phase tick 1, recovery at phase tick 1, and restart at tick 0. Include at least one additional windup sample between the early and late points so a progression can be judged rather than inferred from two endpoints.
2. Produce full-resolution 3D-scene crops with the HUD panel masked or cropped out, so the observer must use only the world-space presentation. Keep the same camera and character framing as the baseline.
3. Run a blind ordering check on the windup crops. Show the early and late crops unlabeled in randomized order and ask an independent observer, who has not seen the implementation, which one is later or closer to impact. On the baseline, the two should be effectively indistinguishable; on an improved build, the later frame should be identifiable from the scene alone at normal window size.
4. Run a warning-presence check on the masked crops: idle and restart should read as "no warning"; recovery should read as "no warning"; early windup should read as "warning"; late windup should read as "more imminent" than early. The observer may use the public tick labels as ground truth for ordering, but not source code.
5. Verify visibility under the existing occlusion: the improved cue should still be visible in the baseline camera framing while the enemy is partly behind the player. If the only way to see the cue is to move the camera or read the HUD, the acceptance test fails.
6. Verify the unchanged invariants from the new images: the HUD strings and positions match the baseline, active still shows `PLAYER HP 3/4`, positions remain about 1.8 units apart, and no additional HP is lost. The improvement should be attributable to the 3D-scene warning, not to added HUD text or altered gameplay.
7. A useful control is to run the same blind ordering test on the old early/late crops: if observers cannot reliably order the old pair but can order the new pair, that is image-based evidence of improvement.

## Limitations

- These are still images. They cannot show motion, a pulse, particles, audio, or whether a cue is readable in real time. A purely temporal warning could exist yet be absent from both sampled frames.
- The windup is sampled sparsely: two frames at phase ticks 18 and 26 out of a roughly 30-tick windup, with no frame near windup start and none between the two. Any change confined to the unsampled interval would be missed.
- I did not perform pixel-level color or image-difference measurements. Judgments about identical appearance and the salmon band are visual, and compression or anti-aliasing could hide small differences.
- I cannot determine whether the salmon band is a deliberate warning, a lighting artifact, or a model detail, nor whether the `STRUCK` label's persistence into recovery is intentional.
- The fixed camera and the player's position in front of the enemy limit what can be inferred about occlusion at other angles or player positions. The restart frame uses a different camera distance, so it is not a direct like-for-like comparison for scene detail.
- Only one attack cycle is shown. The images do not establish how the presentation behaves across repeated attacks or other enemy states.
- I cannot verify that any proposed improvement works. That requires a later real run with new screenshots captured at the same public snapshots and a genuinely independent observer.
- Input responsiveness, deflect behavior, audio cues, frame rate, and actual gameplay difficulty cannot be assessed from these stills.
