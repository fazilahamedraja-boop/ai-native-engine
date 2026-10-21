# Phase 13 — Live observation report (Stage A)

Runner: `experiments/godot-harness/controller/live-observe.mjs`
Fixture: `fixtures/observation` (reused unchanged)
Evidence: `docs/phase13/stage-a-live-observation/`

## 1. What was demonstrated

A visible Godot window ran the observation fixture while the controller collected fresh
screenshots and matching structured observations, four times, over one continuous session. The
player was driven forward between observations with the existing input contract, so the sequence
shows a real runtime change rather than four copies of the same frame.

```
node controller/live-observe.mjs --out-dir docs/phase13/stage-a-live-observation
```

```json
{
  "ok": true,
  "observations": 4,
  "unique_frames": 4,
  "stale_suspects": 0,
  "player_travelled_metres": 9.3509
}
```

## 2. The observation sequence

Each row is one observation. `tick` is the engine physics-frame counter at capture time, `step`
is the fixture's own simulation step, and `sha256` is the hash of the copied PNG. The full
mapping is in `stage-a-live-observation/manifest.json`.

| # | file | tick | step | physics frames | player z | plate | gate | beacon | events | sha256 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 0 | `frames/frame-000.png` | 66 | 45 | 66 → 78 | 5.500 | clear | closed | red | reset, player_collision_start | `7d2ec22c9dc0…` |
| 1 | `frames/frame-001.png` | 129 | 90 | 129 → 141 | 2.500 | clear | closed | red | + crate_collision_start | `0dd312e939d2…` |
| 2 | `frames/frame-002.png` | 192 | 135 | 192 → 203 | −0.500 | **pressed** | **open** | **green** | + plate_entered, gate_open | `cc1bb5542dd3…` |
| 3 | `frames/frame-003.png` | 254 | 180 | 254 → 266 | −3.851 | clear | closed | red | + plate_exited, gate_close, player_collision_end | `e6d9911108dc…` |

The sequence is a complete gameplay narrative, not four arbitrary frames: the player starts at
the spawn point, walks forward, presses the pressure plate, the gate opens and the beacon turns
green, then the player walks through the open gate and the plate is released.

**Visual correlation.** `frames/frame-000.png` shows the blue player capsule at the bottom of the
frame with the HUD reading `PLATE: CLEAR  GATE: CLOSED  BEACON: RED  PLAYER z=5.50  STEP: 45
TICK: 64`. `frames/frame-002.png` shows the same player standing on the now-green pressure plate
with the gate raised and the HUD reading `PLATE: PRESSED  GATE: OPEN  BEACON: GREEN  PLAYER
z=-0.17  STEP: 135  TICK: 190`. Every HUD number matches the structured state captured in the
same row of the manifest.

## 3. The game was running

The bridge log for the session records each advance:

```
225 advance_physics start frames=45 target=64
991 advance_physics done frames=45
1006 paused
1282 advance_physics start frames=45 target=127
2040 advance_physics done frames=45
2055 paused
…
```

`advance_physics` unpauses the SceneTree, waits for the requested number of real fixed physics
ticks, and pauses again. The `paused` entries between the advances are the capture windows: the
existing `captureFrame` contract requires a paused tree so the viewport is stable when the PNG is
read. The game therefore ran continuously between observations, and the tree was only frozen for
the fraction of a second it takes to read a frame.

## 4. How freshness is established

A stale screenshot or a cached response would silently invalidate a live-observation claim, so
freshness is measured rather than assumed. Every capture is checked on three axes:

| Axis | Rule | Measured |
| --- | --- | --- |
| Pixel identity | consecutive frames must not share a sha256 | 4 unique hashes across 4 frames, `all_frames_distinct: true` |
| Engine clock | the engine tick must strictly increase | 66 → 129 → 192 → 254 |
| Simulation clock | the fixture step must strictly increase | 45 → 90 → 135 → 180 |

Any violation is recorded in `freshness.stale_suspects` rather than being passed off as a new
observation. The measured count was **0**.

The copied PNG is also re-hashed on disk and compared with the hash the bridge reported
(`copyCaptureFile` in `controller/evidence-output.mjs`). A truncated or substituted file raises
instead of being recorded.

## 5. Traceability

Every observation carries, in one record:

- `index` — position in the sequence
- `captured_at` — wall-clock ISO-8601 timestamp from the capture
- `engine_tick` and `simulation_step` — the two clocks, kept separate
- `physics_frames_before` / `physics_frames_after` — the engine counter either side of the capture
- `screenshot.path` / `.sha256` / `.bytes` — the artifact on disk
- `state` — the full fixture snapshot
- `observation` — the structured `observe()` result, the observed player world origin, the
  observed main-node properties, and the event type list

`stage-a-live-observation/manifest.json` is the frame → timestamp/tick → structured-state map
required by the phase definition. `stage-a-live-observation/observations.json` holds the full
per-observation records including the complete `observe()` payloads.

## 6. Limitations

- The observation rate is bounded by the fixed physics advance between captures, not by a real-time
  timer. A frame every 45 ticks (≈0.75 s of game time) was used.
- The screenshot is a still frame. There is no continuous video, and the Phase 10 harness
  documentation already describes sampled-frame PNG sequences as the evidence model.
- The engine tick and the fixture step are different clocks and can drift; both are recorded
  rather than reconciled.
- The HUD in the screenshot and the structured state come from the same paused instant, but the
  screenshot is read through the viewport and the state through the bridge, so they are two
  views of one moment rather than a single atomic read.
