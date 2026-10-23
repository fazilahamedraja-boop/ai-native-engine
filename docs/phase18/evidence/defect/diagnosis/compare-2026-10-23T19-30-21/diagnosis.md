# Phase 18 Controlled Defect Diagnosis

## Evidence (observed)

Concrete visible things in named images, plus public snapshot facts:

**Healthy build (`healthy/`):**
- `healthy/idle.png`: player rendered in normal blue; enemy behind; HUD `STATE duel`; no "STRUCK" text on screen.
- `healthy/active.png`: player rendered in pink hit-flash color; "STRUCK" text visible on screen; HUD `STATE INCOMING ATTACK - press K to deflect`; player_health 3/4.
- `healthy/windup-early.png`: player rendered in normal blue; HUD `STATE INCOMING ATTACK - press K to deflect`; **no** "STRUCK" text on screen; player_health 4/4.
- `healthy/windup-late.png`: player rendered in normal blue; HUD `STATE INCOMING ATTACK - press K to deflect`; **no** "STRUCK" text on screen; player_health 4/4.
- `healthy/recovery.png`: player rendered in normal blue; HUD `STATE duel`; no "STRUCK" text.
- `healthy/restart.png`: player rendered in normal blue; HUD `STATE duel`; no "STRUCK" text.

**Defect build (`defect/`):**
- `defect/idle.png`: player rendered in normal blue; HUD `STATE duel`; no "STRUCK" text. Image SHA-256 matches healthy/idle.png.
- `defect/active.png`: player rendered in pink hit-flash color; "STRUCK" text visible; HUD `STATE INCOMING ATTACK`; player_health 3/4. Image SHA-256 matches healthy/active.png.
- `defect/windup-early.png`: player rendered in **pink hit-flash color**; **"STRUCK" text visible** on screen; HUD `STATE INCOMING ATTACK - press K to deflect`; player_health 4/4. Image SHA-256 differs from healthy/windup-early.png.
- `defect/windup-late.png`: player rendered in **pink hit-flash color**; **"STRUCK" text visible** on screen; HUD `STATE INCOMING ATTACK - press K to deflect`; player_health 4/4. Image SHA-256 differs from healthy/windup-late.png.
- `defect/recovery.png`: player rendered in normal blue; HUD `STATE duel`; no "STRUCK" text. Visually indistinguishable from healthy/recovery.png in these stills; image SHA-256 differs.
- `defect/restart.png`: player rendered in normal blue; HUD `STATE duel`; no "STRUCK" text. Image SHA-256 matches healthy/restart.png.

**Public snapshot facts (from observations.json):**
- Both runs share the same scenario, camera, encounter, input sequence, and screenshot names.
- `windup-early` and `windup-late` captures have identical engine tick, positions, player_health (4/4), enemy_health (5/5), and HUD text in both builds; only the rendered image differs.
- `active` and `restart` captures are byte-identical between builds (matching image SHA-256).
- HUD text is public and identical between builds for every capture; the divergence is purely in what is rendered on top of/in the scene.

## Comparison

Like-named frame pairs that differ:

| Frame | Healthy (`healthy/`) | Defect (`defect/`) | Observation vs. interpretation |
|-------|----------------------|--------------------|--------------------------------|
| `idle.png` | Blue player, no STRUCK | Blue player, no STRUCK | No visual difference; matching SHA-256. |
| `active.png` | Pink player, STRUCK visible | Pink player, STRUCK visible | No visual difference; matching SHA-256. Correct hit state. |
| `windup-early.png` | Blue player, no STRUCK | **Pink player, STRUCK visible** | Observation: defect frame shows pink player and "STRUCK" overlay during windup; HUD STATE and player_health are identical to healthy. Interpretation: the hit state is being drawn during the windup warning window. |
| `windup-late.png` | Blue player, no STRUCK | **Pink player, STRUCK visible** | Observation: defect frame shows pink player and "STRUCK" overlay during windup; HUD STATE and player_health are identical to healthy. Interpretation: the hit state is being drawn during the windup warning window. |
| `recovery.png` | Blue player, no STRUCK | Blue player, no STRUCK | No confirmed visual difference in stills; SHA-256 differs but no visible change attributable to the regression. |
| `restart.png` | Blue player, no STRUCK | Blue player, no STRUCK | No visual difference; matching SHA-256. |

## Chosen visual defect

**During the enemy windup phase (`windup-early` and `windup-late`), the defect build incorrectly renders the player in pink hit-flash color and displays the "STRUCK" on-screen text, despite the HUD STATE being "INCOMING ATTACK" and player_health remaining 4/4.**

What changed visually: in the healthy build, windup frames show the player in normal blue with no "STRUCK" text — the windup is purely a warning cue. In the defect build, those same frames show the pink hit-flash player and "STRUCK" overlay, which are visuals that should belong only to the active/hit phase (as correctly shown in `active.png` in both builds).

Why it matters for the intended escalating windup cue: the windup windows are meant to escalate a warning so the player prepares to deflect. Falsely showing "STRUCK" and hit-flash during windup tells the player they have already been hit before the attack lands, breaking the escalating warning and potentially causing the player to stop responding correctly. It is a visual-only regression: gameplay, positions, timing, health, and HUD text are unchanged per the public snapshots.

What must remain unchanged: the `active.png` hit state (pink player + "STRUCK" is correct there), all idle/recovery/restart frames, all HUD text, health values, positions, and timing. Only the windup frames' erroneous hit visuals should be removed.

## Proposed repair evidence

An independent observer could verify the repair by capturing new screenshots from a fixed build using the same frozen encounter and comparing like-named frames:

1. `defect/windup-early.png` and `defect/windup-late.png` should show the player in normal blue with no "STRUCK" text, matching `healthy/windup-early.png` and `healthy/windup-late.png` visually.
2. `defect/active.png` should continue to show the pink player and "STRUCK" text unchanged.
3. `defect/idle.png`, `defect/recovery.png`, and `defect/restart.png` should remain unchanged.
4. Public snapshot fields (HUD text, player_health, enemy_phase, engine_tick) should remain identical between builds for the windup captures, confirming the fix is visual-only.

Verification is by image comparison of new screenshots, not by trusting source code or this diagnosis.

## Limitations

- These are still images; they cannot determine whether the "STRUCK" text or pink flash appears for a single frame or persists, nor the exact timing of when it appears/disappears within the windup window.
- The `recovery.png` SHA-256 differs between builds but no visual difference is confirmed in the stills; this cannot be explained from images alone and must be checked in a real run.
- The diagnosis does not claim to have run the game or verified a fix; it is based solely on reading the provided screenshots and public observation files.
- No code edit or file name is proposed, per the task constraints.