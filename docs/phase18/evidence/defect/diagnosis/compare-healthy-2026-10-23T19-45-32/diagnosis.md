# Phase 18 Controlled Defect Diagnosis

## Evidence (observed)

Both runs show the same arena, camera framing, blocky blue player, red enemy, dark
HUD panel in the upper-left, and the same six screenshots per run. All twelve PNGs
in `healthy/` and `defect/` were opened.

- `healthy/idle.png` and `defect/idle.png`: player stands just behind the red enemy,
  no orange marking on the floor, HUD reads `STATE duel`, `PLAYER HP 4/4`,
  `ENEMY HP 5/5`, `DODGE READY`. The two files have the same recorded
  `image_sha256` (`9feaf1dd...`).
- `healthy/windup-early.png` and `defect/windup-early.png`: a flat orange ellipse is
  now painted on the arena floor around the enemy's feet, partly hidden by the
  player's near leg. HUD reads `STATE INCOMING ATTACK - press K to deflect`.
- `healthy/windup-late.png`: the orange floor ellipse is large. It is visible to the
  left of the player's near leg and extends to the right past the enemy's feet, and
  it is visibly taller (front-to-back) than in `healthy/windup-early.png`.
- `defect/windup-late.png`: the orange floor ellipse is still compact. Its left edge
  stops at roughly the player's near leg and its right edge stops near the enemy, so
  it covers only the gap between the two figures and is visibly shorter
  front-to-back than the healthy late ellipse.
- `healthy/active.png` and `defect/active.png`: no orange floor ellipse. The player is
  tinted pink, the large text `STRUCK` appears, and HUD reads `PLAYER HP 3/4`
  with `STATE INCOMING ATTACK - press K to deflect`. These two files also share one
  `image_sha256` (`26229885...`).
- `healthy/recovery.png` and `defect/recovery.png`: no orange floor ellipse, player
  back to blue, `STRUCK` still on screen, HUD `STATE duel`. The two images look
  indistinguishable to the eye, although their hashes differ.
- `healthy/restart.png` and `defect/restart.png`: HUD `PLAYER HP 4/4`, `STATE duel`;
  both figures stand farther apart (the front circle of the arena is fully visible).
  These two files share one `image_sha256` (`59b289ce...`).

Public snapshot facts (`healthy/observations.json`, `defect/observations.json`):

- For windup-phase captures the `player_position`, `enemy_position`,
  `camera_position`, `player_health`, `enemy_health`, `enemy_feet_screen`, and HUD
  strings match between the two runs. Example: both `windup-early` captures report
  `enemy_feet_screen` `[674.71, 404.89]`, `enemy_phase_tick` 18, and camera
  `[1.1, 2.700552..., 7.3]`.
- `idle`, `active`, and `restart` have identical `image_sha256` values across runs;
  `windup-early`, `windup-mid`, `windup-late`, and `recovery` differ.
- The two runs are not frame-identical in time: `windup-late` is engine tick 27 in
  healthy and 28 in defect, and `recovery` is tick 41 versus 42.
- Both observation files list a capture named `windup-mid`, but no
  `windup-mid.png` exists in either `healthy/` or `defect/`, so that pair could not
  be viewed.

## Comparison

Observation only:

- The like-named pair that differs most is `windup-late.png`. In
  `healthy/windup-late.png` the orange floor ellipse is markedly wider and deeper
  than in `defect/windup-late.png`; the healthy ellipse reaches out to both sides of
  the two figures, the defect ellipse stays between their feet. The enemy's and
  player's bodies, their poses, the HUD text, and the camera framing are the same in
  both images.
- The `windup-early.png` pair looks very similar: both early ellipses are compact and
  partly occluded by the player's leg. The defect early ellipse may be marginally
  wider to the left, but the two are close and I cannot measure them from the
  images.
- The `idle`, `active`, `recovery`, and `restart` pairs show no visible defect: the
  orange warning is absent in all of them and the scene, tint, text, and HUD match.
  The bytes of `recovery.png` differ, but nothing visible distinguishes the pair.

Interpretation (separate from the above): the healthy build's warning ellipse grows
noticeably between the early and late windup screenshots, i.e. it escalates with the
windup. The defect build's ellipse does not do that - it looks close to its early
size in the late screenshot. Since camera, actor positions, and phase are the same,
the size difference is not explained by framing or movement; it is a change in the
warning indicator itself. The single-tick offset at `windup-late` (defect one tick
further along) would, if anything, make a growing indicator slightly larger, not
smaller, so it does not account for the gap.

## Chosen visual defect

The gain or scale of the orange ground warning ellipse stops escalating during the
enemy windup, so the late-windup cue stays at roughly its early-windup footprint
instead of expanding to the large late footprint seen in `healthy/windup-late.png`.

What changed visually: in `defect/windup-late.png` the orange marker under the enemy
is small, thin, and confined between the player's near foot and the enemy, whereas
`healthy/windup-late.png` shows a much larger, deeper marker that spreads past both
figures. In the early windup the two builds look close, so the regression is
specifically the loss of the late enlargement rather than the disappearance of the
marker.

Why it matters for the escalating windup cue: the expanding floor ellipse is the
readable "the attack is about to land" signal. If the marker looks the same at the
start and end of the windup, the player loses the sense of the attack closing in and
must rely on phase timing instead of the visual telegraph, which weakens the
intended warning ramp.

What must remain unchanged: the marker must still appear for the whole windup,
stay centered on the enemy's feet, keep its early-windup size at the early tick,
grow smoothly through the middle and late windup (healthy late is clearly the
largest), and vanish at the active and recovery phases. The actor positions, poses,
camera, HUD text, health values, `STRUCK` feedback, and restart layout must all stay
as they are; only the late-windup scaling of the orange marker is in question.

## Proposed repair evidence

An independent observer can re-run the same frozen encounter with the same capture
names and compare new screenshots without trusting this diagnosis:

1. Capture `windup-early`, `windup-mid`, and `windup-late` at the recorded phase
   ticks (18, 22, 26) and measure the orange ellipse's pixel width and
   front-to-back height in each image.
2. Confirm the width and height increase monotonically from early to mid to late,
   and that the late width/height is in the same range as
   `healthy/windup-late.png` - notably reaching out past both figures rather than
   sitting between their feet.
3. Confirm the early ellipse still matches `healthy/windup-early.png` in size, so the
   fix did not inflate the first warning frame.
4. Confirm `active`, `recovery`, and `restart` still show no orange ellipse, and that
   `idle`/`active`/`restart` remain pixel-identical to the healthy captures (same
   hashes), with identical HUD text and `enemy_feet_screen` coordinates.
5. Confirm the marker disappears at the recorded active tick and does not reappear
   during recovery.

A reviewer can do this by eye for the growth trend and by a simple pixel measurement
of the orange region for the size claim; no source access is needed.

## Limitations

- The images cannot show the growth curve or easing between frames, only the sampled
  sizes at early and late. There is no `windup-mid.png` in either directory, even
  though both observation files list one, so the middle of the escalation cannot be
  compared and "does not grow" versus "grows too little" versus "shrinks late"
  cannot be separated from stills alone.
- `windup-late` and `recovery` were captured one engine tick apart between runs, so
  sub-frame timing differences exist; the large late-windup size gap is far greater
  than one tick should produce, but the exact per-tick behavior is unverified.
- `recovery.png` hashes differ while the images look the same to me, so a difference
  too small to see (sub-pixel pose, shading, or opacity) cannot be ruled out.
- Exact world-space radius, opacity, colour, and any pulse/flash of the marker
  cannot be determined from stills; the ellipse is partly occluded by the player, so
  its hidden extent is inferred, not seen.
- Only one camera angle and one encounter are available. The images cannot prove
  this is the only regression in the defect build, only that it is the visible
  difference in the supplied frames. A real run is needed to confirm the cue reads
  correctly in motion, that the timing of appearance and disappearance is unchanged,
  and that no other phase uses the same marker unexpectedly.
- No fix was applied or verified here; the repair evidence above describes a future
  check only.
