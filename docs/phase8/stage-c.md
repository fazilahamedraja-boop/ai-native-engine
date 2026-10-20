# Phase 8 - Stage C: scripted live gameplay, snapshots, and repeatability

Status: complete. Stage D has not been started yet.

## Scope

Stage C adds the operations needed to drive live gameplay without real-time key
input: pause, explicit fixed steps, deterministic input values, reset,
snapshots, stable hashes, and windowed screenshots. The headless gameplay checks
cover movement, detection rise/decay, escape, failure, reset, and jump.

Rendering is not required by the headless suite. Screenshots are a separate
windowed test because Godot's dummy headless renderer has no viewport texture.

## Manual simulation step

The first implementation called `CharacterBody3D.move_and_slide()` from the
bridge while the SceneTree was paused. It produced different distances for the
same 60-step sequence:

- first run: `z=-1.5` after 60 forward steps
- second run: `z=-3.9648` after the same 60 steps

`move_and_slide()` derives part of its motion from engine frame timing, and the
bridge was calling it outside `_physics_process`. That is not a valid fixed-step
contract.

The fixture's player now uses explicit motion:

```gdscript
move_and_collide(Vector3(velocity.x, 0, velocity.z) * delta)
move_and_collide(Vector3(0, velocity.y, 0) * delta)
```

Grounding is maintained by the collision result plus a short downward
`test_move` probe. The sentry scene is flat and has no wall colliders, so
separating horizontal and vertical motion is sufficient here. This is a
project-specific deterministic movement path, not a claim that arbitrary Godot
physics is deterministic.

`harness_step(delta)` executes one simulation step and returns a snapshot. Jump
and restart are edge inputs; the harness consumes them after the first step.
The bridge pauses the tree before a step loop and auto-pauses `reset`.

## Snapshot and hash

The snapshot includes:

```text
step, phase, detection, detection_percent, player_position xyz,
player_velocity xyz, grounded, seen_by, exit_distance, hash, input, hud, hint
```

The stable hash covers only explicitly selected simulation fields:

```text
step
phase
detection
player position xyz
player velocity xyz
grounded
seen guard ids
exit distance
```

Camera transform, HUD text, port, PID, uptime, and render-frame timing are
excluded. HUD and camera changes therefore cannot invalidate a gameplay hash.

## Results

### Headless gameplay suite

Command:

```powershell
cd experiments/godot-harness
npm run test:gameplay
```

Result: **8/8 passed**. Covered movement, detection rise/decay, escape/win,
terminal loss, reset, jump/land, same-process repeatability, and fresh-process
repeatability.

### Structured scenario record

Command:

```powershell
npm run evidence:live
```

Result: **9/9 checks passed**. Key observed values:

| Check | Result |
| --- | --- |
| forward movement | `z=-5.99999666213989` after 80 steps |
| detection rise | `0.677777777777777`, seen by `guard-a` |
| detection decay | `0.327777777777779`, outside cones |
| escape | `phase=won`, exit distance `0.00000763148971935209` |
| failure | `phase=lost`, detection `1` |
| reset | `phase=active`, detection `0`, step `0` |
| jump/land | takeoff y `0.93416`, air y `1.78416`, landed y `0.850238` |
| same-process repeat | hash `10b28fcb8890a0f8a7d4b1df880341a5ca417533c2a6beb8e2d9b1fee3bf974b` twice |
| fresh-process repeat | same hash in a new process |

Full record: `docs/phase8/stage-c-live.json`.

### Screenshots

Command:

```powershell
npm run test:screenshot
```

Result: **1/1 passed** in a windowed run.

- `docs/phase8/live-detection.png`: 1280x720, 54,319 bytes, SHA256
  `3905822D21E83B67E8BBBA3CDEB4C7479DE73DDF2B9AD2A7768A66C572CE12CC`
- `docs/phase8/live-win.png`: 1280x720, 47,863 bytes, SHA256
  `7573250398298B89005112030EB73F1C5C3F0E418B5B5C01A6135C6E43071921`

The screenshots show the detection state and the `ESCAPED` HUD state. They are
captured after a short render wait, not by advancing simulation time.

## Repeatability and limitations

Observed on this machine with Godot 4.7.2:

- The same reset -> step sequence produced the same selected-field hash in the
  same process and in a fresh process.
- The explicit `move_and_collide` path made step distance independent of bridge
  call timing.
- This does **not** establish determinism for arbitrary scenes, moving
  platforms, complex collision response, or `move_and_slide()`.
- Live `_physics_process` also uses explicit motion, but the delta is supplied
  by the engine and can vary with frame scheduling; the repeatability claim is
  for the paused, requested-step path.
- The horizontal/vertical split does not implement wall sliding. The fixture has
  no wall colliders, so that limitation is out of scope.
- Screenshots are unavailable in `--headless`; the bridge returns a structured
  `SCREENSHOT_UNAVAILABLE_HEADLESS` error rather than touching the dummy
  renderer.
- The bridge is a localhost control surface, not an authentication boundary.

## Next stage

Stage D: a committed reproducible defect fixture, a failing live test, captured
failure evidence, a targeted one-line repair, and the same test rerun.
