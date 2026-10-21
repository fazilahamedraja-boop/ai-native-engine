# Phase 10 - Stage B: visual observation

Status: complete. Stage C has not been started yet.

## Scope

Stage B adds reproducible visual evidence around the existing Phase 9 door
fixture. It does not add a new game scenario, change the door fixture, or add an
observation bridge. The purpose is to prove that actual windowed frames can be
captured with enough metadata for later correlation.

The Godot runtime is `4.7.2.stable.official.ed1daf0bf`. The captures use the
normal viewport and the Phase 9 door's real fixed-tick movement.

## Implementation

- `controller/harness.mjs`
  - `captureFrame()`: one actual viewport capture plus run id, scenario,
    metadata, capture timestamps, wall duration, tick, simulation step,
    physics-frame counters, paused state, screenshot hash/bytes/dimensions, and
    the snapshot before and after the capture.
  - `captureSequence()`: frame 0 at the current paused state, then real
    `advancePhysics()` chunks between later frames. Frame count and interval are
    bounded.
- `tests/capture.test.mjs`: validation tests for unsafe paths, run ids,
  scenarios, metadata, windowed/connected/paused requirements, frame bounds,
  intervals, prefixes, and input.
- `controller/visual-suite.mjs`: windowed door scenario; three state captures
  plus a seven-frame approach sequence; optional offline ffmpeg encoding.
- `package.json`: `npm test` now includes the capture validation tests;
  `npm run evidence:visual` runs the windowed evidence suite.
- `README.md`: capture operation and sampled-sequence documentation.

No change was made to `fixtures/door`, its tests, or `docs/phase9/`.

## Commands and results

From `experiments/godot-harness`:

```powershell
node --test tests/capture.test.mjs
npm run evidence:visual
```

Observed:

- capture validation: **3/3 passed**, exit 0, 243 ms test duration.
- windowed visual suite: exit 0, **20.919 s** wall time including process start,
  screenshots, sequence, ffmpeg, and stop.
- Godot PID 26160; bridge port and start metadata are in the manifest.
- stopped with exit code 0 and `killed=false`.

The suite asserted:

- locked attempt: `feedback=LOCKED - KEY REQUIRED`, `door_locked=true`,
  `door_open=false`;
- key pickup: `player_has_key=true`, `key_visible=false`;
- open: `feedback=UNLOCKED - DOOR OPEN`, `door_open=true`, `door_locked=false`;
- every screenshot is 1280x720, non-empty, and copied hash matches the bridge
  hash.

## Evidence

Primary manifest: `docs/phase10/stage-b-captures.json`.

Run id: `stage-b-7ed07076-2cbd-492a-940c-d904ca476ef5`.

| Capture | Tick / step | State | PNG | Bytes | SHA-256 |
| --- | --- | --- | --- | ---: | --- |
| locked | 120 / 101 | locked attempt | `stage-b-locked.png` | 49,708 | `3aa83792a9cfe4d761c038e9698e1aa89605093546ab480ed25588cca6331968` |
| key | 181 / 45 | key held | `stage-b-key.png` | 43,404 | `4b6e38a8dbf8eab0aa96e7a94146cb2b1be50841cb28c3c744313e94f987d472` |
| open | 330 / 176 | door open | `stage-b-open.png` | 45,370 | `772b050c274f5c2d4b0403534224305158e4fcedead716075c18d62476dcd3c2` |

The manifest's `scenario.steps` records the exact sequence of `reset` and
`advance_physics` operations, including each input object and the resulting
step/tick. The locked state was reached with 100 forward ticks and one interact
tick; the key state with 30 strafe-right ticks and 15 forward ticks; the open
state with 30 strafe-left ticks, 100 forward ticks, and one interact tick.

The approach sequence is `stage-b-frames/stage-b-approach-000.png` through
`006.png`, sampled every 20 real physics ticks. The first frame is at
`(0, 0.85, 5.5)`, step 0. Frame 3 is at `z=1.500003`, and frames 4-6 are at
`z=0.500116` with identical hashes because the locked door blocks further
movement. That repeated final state is collision evidence, not a claim that the
frames are unique.

The sequence was encoded offline at 5 fps to
`docs/phase10/stage-b-approach.mp4` (34,008 bytes, SHA-256
`bc3db4b4f2b301c3fd887f38f0dfa52462feaca7e6bf01c67858e0bf64482324`). This is
an offline encoding of sampled PNGs. It is not a real-time recording, and no
live-video-understanding claim is made.

## What worked

- Actual windowed frames were captured from the running game, not a fabricated
  representation.
- The run id, scenario, input, tick, simulation step, capture time, and hashes
  are in one machine-readable manifest.
- The existing door fixture was reused without changing it.
- The sequence shows real approach movement and a real blocked state.
- The sampled frames and mp4 are small and easy to inspect.

## Limitations

- Windowed capture needs a display; headless mode has no readable viewport.
- Each capture waits 120 ms for rendering; the suite is not a performance
  benchmark.
- The sequence is sampled every 20 physics ticks (0.333 s of simulation), not
  every frame. The mp4 is an offline sample encoding, not real-time video.
- The observer did not read the HUD with OCR; the HUD text is visible in pixels
  only and structured state comes from snapshots.
- No audio, camera interpolation, or animation evidence is included in this
  stage.
- The captured PNG hashes happen to match the Phase 9 evidence because the same
  deterministic fixture states were captured; this does not establish general
  physics determinism.

## Next stage

Stage C: add the generic structured observation contract, a new observation
fixture with player/plate/gate/beacon/crate/rig, game and collision event
timelines, and humanoid/rig inspection.
