# Phase 16 — known limitations

## Art and animation

- The fighters are the repository's `placeholder-character.glb`: 6 meshes, no
  skeleton, no animation clips. Limbs are rotated procedurally; there is no
  skinning, IK, foot planting, or ragdoll.
- The sword is three `BoxMesh` primitives. The arena is boxes, cylinders, and a
  plane. No textures beyond flat materials.
- No audio, particles, trails, or post-processing beyond the environment glow
  and tonemap.
- Placeholder art was chosen deliberately to spend the phase on a working,
  verified loop instead of an art pipeline.

## Gameplay scope

- One enemy, one arena, one enemy attack. No combos, feints, unblockables,
  multiple attack types, or phase changes.
- No lock-on and no camera orbit. The camera is a fixed-angle follow with a
  shoulder offset.
- Posture only gates stagger. There is no deathblow, posture break animation,
  or execution.
- No progression, inventory, save files, menus, settings, key rebinding, or
  pause. `R` is the only recovery action.
- Player attack has a single swing; holding the key does not chain attacks.
- The enemy steers directly at the player with no navigation mesh. A player who
  circles a pillar can put it between themselves and the enemy; the enemy may
  press into the pillar instead of pathing around it. This was not tested.
- Outcomes freeze combat input except restart.

## Camera

- The camera follows position only; walking sideways does not swing it behind
  the player. This is intentional for a fixed-arena duel, not a general
  third-person camera. Movement uses world axes (`W` = −Z); the shoulder offset
  yaws the view about 13°, so `W` is not exactly screen-up.
- The wall pull-in was tested against the south wall while backing up. Other
  corners and the pillars were not exhaustively tested. The minimum-boom
  fallback raises the camera instead of clipping, but a very tight corner can
  still produce an awkward close view.

## Evidence method

- The windowed run drives `set_harness_input` through the harness bridge. It
  does not inject OS-level keyboard events. Normal play reads the same
  simulation through `_read_live_input` and `InputMap` actions registered in
  `_ensure_input_actions`; the bindings are simple and share the same
  `_step_simulation`, but a physical-key test was not performed because another
  full-screen application covered the desktop during the run.
- One scripted playthrough policy, one victory path, one defeat path. No human
  playtest and no fuzzing of input sequences.
- All timings assume 60 physics ticks per second. The suite does not claim
  general physics determinism; it claims these controlled scenarios resolve as
  asserted at 60 Hz.
- Renderer nondeterminism exists at the single-pixel level: the spawn frame and
  the restart frame differ by one pixel with a one-level channel difference,
  while their snapshots are identical. The two restart frames are byte-identical.
- The superseded live runs (`17-13-11`, `17-18-57`) are retained for audit but
  used earlier camera values. Only `17-21-27` is authoritative.

## Exported build

- Windows x86_64 only, exported with the installed `4.7.2.stable` templates.
- `DeflectArena.exe` is 109,127,680 bytes and `DeflectArena.pck` is 70,348
  bytes. The build directory is ignored by git; the binary is not committed.
  Reproduce it with the documented export command.
- No custom icon, company metadata, or code signing. Windows SmartScreen may
  warn on first launch.
- The harness bridge is included in the PCK. It only listens when
  `--harness-port=` is passed after `--`; normal launches open no socket. It is
  still an extra local surface in the shipped build and could be excluded in a
  future export preset.
- The exported probe verifies clean load, rendering, the bridge, movement, one
  sword hit, and restart. It does not replay the full victory/defeat loop inside
  the exported binary; that loop is verified in the windowed source run.
- The desktop screenshot of the exported window was unreliable because an
  unrelated full-screen application was in front. `PrintWindow` captured the
  game window itself and is the authoritative export frame.

## Harness and test hooks

- `harness_setup` can teleport bodies, set health/posture, freeze enemy AI, and
  set player rotation. It is test-only and cannot deal damage directly; every
  damage event still runs through the live combat path.
- `harness_reset` and `harness_setup` are callable from the bridge in any build
  that includes the bridge. They are not exposed in normal play because the
  bridge is opt-in.
- A fresh checkout must run `godot --headless --path game --import` once before
  the GLB loads. The `.import` file is committed, but the imported binary cache
  under `.godot/` is not.
- The acceptance suite takes about 14 s; the full Phase 8–15 suite about 95 s.
  Neither is a performance benchmark for the game.

## Deliberately out of scope

No new engine, renderer, physics engine, observation framework, or general
gameplay framework was built. No Phase 8–15 history was merged, pushed, reset,
rebased, retagged, or rewritten. No external art, audio, or fonts were added.
