# Phase 18 Baseline Diagnosis

## Evidence (observed)

- In `idle.png` (state `duel`, enemy phase `idle`) the HUD reads "STATE duel" and the 3D scene shows the blue player and red enemy standing apart on the dark arena floor with no attack-related text in the world.
- In `windup-early.png` and `windup-late.png` (enemy phase `windup`, enemy_phase_tick 18 and 27) the HUD reads "STATE INCOMING ATTACK - press K to deflect". In the 3D scene the enemy stands on a faint orange foot ring, but there is no world-space attack warning text or other salient in-scene cue announcing the incoming attack.
- In `active.png` (enemy phase `active`, player HP 4→3, event `enemy_hit_player` at tick 32) the HUD still reads "STATE INCOMING ATTACK - press K to deflect" and, additionally, the large world-space text "STRUCK" appears in the scene — only after the player has already been hit.
- In `recovery.png` (enemy phase `recover`, HUD "STATE duel") the world-space text "STRUCK" is still visible in the 3D scene even though the HUD has returned to `duel`, so the in-scene cue is stale and contradicts the HUD.
- In `restart.png` (clean state, `STATE duel`) no "STRUCK" text is present, confirming it is an impact artifact rather than a permanent scene element.

The HUD cue ("STATE INCOMING ATTACK - press K to deflect") appears in `windup-early.png`, `windup-late.png`, and `active.png`. The world-space cues actually visible are only the subtle orange foot ring under the enemy during windup and the post-impact "STRUCK" text in `active.png` and `recovery.png`.

## Hypotheses

- The attack telegraph is implemented as HUD text only, with no corresponding world-space warning during the windup window, so a player looking at the 3D scene (rather than the HUD overlay) receives no clear incoming-attack signal.
- The "STRUCK" world text is triggered on impact rather than before it, so it functions as damage feedback, not as an attack warning, and it lingers into recovery where it conflicts with the HUD state.
- Because the only reliable warning lives in the HUD, players who glance away from the text overlay may not realize an attack is incoming until they are hit.

## Chosen visual problem

The incoming enemy attack is communicated to the player exclusively through HUD text ("STATE INCOMING ATTACK - press K to deflect"); the 3D scene contains no clear, sustained world-space warning during the windup window. This is genuine from the evidence: `windup-early.png` and `windup-late.png` show the HUD warning while the scene shows only the enemy's idle pose and a faint orange foot ring, and `active.png` shows the salient world text "STRUCK" appearing only after the hit has landed (player HP drops 4→3). It is worth fixing because the goal is for the game to communicate an incoming attack clearly in the 3D scene, not only as HUD text. What must remain unchanged: the HUD text and layout, enemy positions and timing, the windup/active/recovery phase sequence, the orange foot ring if present, and the post-impact "STRUCK" feedback — the problem concerns adding or strengthening a pre-impact world-space warning, not altering existing simulation behavior.

## Proposed acceptance evidence

An independent observer should capture new screenshots of the same windup scenario (enemy phase `windup`) and verify that a clear world-space attack cue — for example, text or a visual marker in the 3D scene near the enemy, distinct from the HUD overlay — is visible during windup in `windup-early.png`-style and `windup-late.png`-style frames, is absent during `idle.png`-style and `recovery.png`-style frames, and does not rely on reading the HUD "STATE" line. Comparison should be image-based: side-by-side stills of the baseline windup frames versus the new windup frames, checking for the presence of an in-scene warning where none currently exists.

## Limitations

These are still images, so motion, timing, audio cues, and cue duration cannot be determined from them. Whether a new world-space cue is actually noticeable, readable, and correctly synchronized with the windup window must be verified by a later real run. I cannot determine what implementation change would produce the cue, nor have I run the game or verified any fix. No image was unreadable; all six screenshots and `observations.json` were read successfully.