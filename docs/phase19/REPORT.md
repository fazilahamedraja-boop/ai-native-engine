# Phase 19 report: playable 3D voxel sandbox

## Outcome

Phase 19 is complete in the isolated worktree
`C:\Users\hacke\ai-native-engine-phase19` on `experiment/phase19-voxel`, based
exactly on Phase 18 commit `1095fc43`. Nothing was merged, pushed, reset,
cleaned, or force-pushed. Phase 20 was not started.

The phase produced a small but genuinely playable first-person voxel sandbox:
a deterministic 32x16x32 world with grass, dirt, stone, logs and leaves, a
walking/jumping player with terrain collision, ray-targeted mining and adjacent
placement, a four-slot block hotbar, and JSON persistence stored under
`user://`. It is built on the existing Phase 8-18 harness rather than a parallel
workflow: the same `HarnessSession`, bridge protocol, sandbox adapter, evidence
writer, and window-capture approach, plus the Phase 18 agent-runner pattern.

Three independent things were verified, and they are deliberately reported
separately:

1. **Gameplay and persistence** - acceptance suites plus a windowed observation
   run that drives real physics ticks and captures real images.
2. **Autonomous repair** - a controlled defect on a disposable copy was
   detected, repaired by the external agent, and re-verified. This is a genuine
   agent repair (see the honest limits below).
3. **Packaging** - a native Windows export was driven through its own bridge and
   captured as a real window.

The result is **not** reported as one uninterrupted autonomous implementation
pass. The external implementation agent that was asked to author the data module
failed three times and then hit its provider quota. The canonical data module in
this worktree is the trusted reference implementation, not agent output. The
later controlled-defect repair *was* agent-authored and verified, but it ran on
a disposable copy and never touched canonical source.

## What is playable

| Requirement | Behaviour |
| --- | --- |
| World | 32 x 16 x 32 cells, seed `20261023`, procedural height 2-12, grass over dirt over stone, seeded trees (log column plus leaves) |
| Spawn | Feet on the highest solid block at the center column, two empty cells above, verified grounded |
| Boundaries | Player X/Z clamped inside the world; falling below the world resets the player with a `player_recovered` event |
| Look | Captured mouse look, yaw plus pitch clamped to +/-85 degrees |
| Movement | WASD at 5.2 m/s, ground/air acceleration, gravity 20 m/s^2, jump 6.9 m/s |
| Collision | Per-chunk triangle collision; the player lands on generated terrain and cannot walk through terrain walls |
| Targeting | Amanatides-Woo DDA raycast, 6 m reach, reports hit cell, previous cell, face normal, distance, block id |
| Mining | LMB removes the targeted block, adds one to inventory, rejects the protected y=0 bedrock layer |
| Placement | RMB places the selected block into the reported **previous** cell; rejects player overlap, out-of-world, bedrock layer, and empty inventory |
| Hotbar | Four slots (grass, dirt, stone, log) with number keys `1`-`4` and mouse wheel wrap; selection drives placement |
| Feedback | Crosshair target line, per-action HUD message, hotbar counts, change counter |
| Mouse capture | Explicit `mouse_captured` state, `Esc` releases, clicking the viewport recaptures |
| Persistence | `F5` save, `F9` load, `R` reset; JSON written under `user://` (outside the repository), invalid or missing saves handled without corrupting state |

## Architecture

All gameplay code lives in a new Godot project at
`experiments/godot-harness/voxel/`, not inside Deflect Arena.

| File | Lines | Responsibility |
| --- | --- | --- |
| `scripts/voxel_data.gd` | 317 | Pure data: block storage, deterministic generation, spawn, change tracking, save document validation, DDA raycast, content hash. No scene, input, or rendering dependency |
| `scripts/voxel_chunk_builder.gd` | 123 | Turns world data into one chunk mesh plus its triangle faces, emitting only exposed faces |
| `scripts/voxel_player.gd` | 110 | First-person `CharacterBody3D` controller: yaw/pitch, acceleration, gravity, jump, eye height |
| `scripts/voxel_save_store.gd` | 115 | `user://`-only JSON store with explicit error codes for missing, empty, and malformed files |
| `scripts/voxel_world.gd` | 1154 | Scene assembly, chunk nodes and collision bodies, targeting, mining/placement rules, hotbar, HUD, world events, save/load, `snapshot()`, `harness_*` surface |
| `harness/bridge.gd` | 1052 | Opt-in TCP bridge (`--harness-port=`), same protocol family as Phases 8-18 |

Design choices worth naming:

- **Chunk meshes, not block nodes.** The world is split into 8x8 columns, giving
  16 chunks for this size. Each chunk owns one `MeshInstance3D` and one
  `StaticBody3D` with a concave triangle shape. A 16384-cell world therefore
  creates 16 render nodes and 16 collision bodies instead of thousands.
- **Pure data layer.** `voxel_data.gd` is the only module the hidden suite loads,
  so it can be exercised headlessly with no scene tree.
- **Saves are changes, not snapshots.** The document stores the seed, dimensions,
  version, and the diff against generated terrain, so a save stays small
  (535 bytes for the observed world).
- **Errors are values.** Save, load, mine, and place all return or emit a coded
  status (`SAVED`, `MISSING`, `INVALID_JSON`, `INVALID_WORLD`, `bedrock`,
  `player_overlap`) rather than failing silently.

Accepted source hashes:

| File | SHA256 |
| --- | --- |
| `scripts/voxel_data.gd` | `338d3ee055fc605333271c1ed725237812cd2c8f5bffa56ad915583479ea0b27` |
| `scripts/voxel_world.gd` | `b1fb9beceb27dc10bdf0551dbc67aa441613d01f62a1d166491bd3facb672d2d` |
| `scripts/voxel_player.gd` | `66e8ed6d9eb12426ed2e3b729146bbf686f8f61a40ace5edc3619361ac00173c` |
| `scripts/voxel_chunk_builder.gd` | `65839169a8afd67b322c640dd1b9f9f5d9c9e2d39478f069dbd2bcf97c5fadbb` |
| `scripts/voxel_save_store.gd` | `36ef6533c2e247281d1f4fcf6a9c87375b6cdb043c864dc0718273342e60bd05` |
| `harness/bridge.gd` | `08b1cae562ee841d61f33f67bae117e1aad6dd9736235fa5ae1280ab7e314b5b` |
| `tests/run_voxel_tests.gd` | `ee57ec3e59642e1297c84574db771eaa268067d9441e513dd862b191ce9426fc` |
| `tests/run_voxel_data_tests.gd` | `22b636a6965eb0894cf9e91a34b223672fef36471aa3981b3962fca32a7d4348` |

## Defects found and fixed during the phase

The sandbox was not correct on the first run. Each of these was found by running
the game or a suite, not by inspection:

| Symptom | Cause | Fix |
| --- | --- | --- |
| Raycast missed diagonal targets | `signi()` truncates floats toward zero, so any component below 1 became 0 | `int(signf(value))` in the DDA step |
| Player fell through the world and never landed | Top chunk faces were wound the wrong way, so collision only worked from below | Corrected the per-face corner order |
| Targeting ignored camera pitch | `look_direction()` used the yaw basis only | Derive forward from the camera's global basis |
| Harness input leaked between scenarios | `set_harness_input()` only overwrote supplied keys | Omitted movement fields reset to neutral every call |
| Save/reload fingerprint never matched | `harness_hash()` included the harness tick counter and transient velocity | Hash only what persistence restores: position, yaw/pitch, selection, inventory, change count, world hash |
| Packaged window capture failed | The Phase 18 capture script filters window titles containing `deflect`; the child process was also spawned hidden | New `capture-window-phase19.ps1` with a `-TitleMatch` parameter, and a visible spawn for the GUI build |

`harness_hash()` deliberately excludes harness-only state. Including `step`
meant a save taken at tick 21 could never match a reload that restarts at tick
1, which turned a persistence check into a tick-count check.

## Verification matrix

| Suite | Command | Result |
| --- | --- | --- |
| Hidden data module | `godot --headless --path experiments/godot-harness/voxel -s res://tests/run_voxel_data_tests.gd` | **15/15** |
| Gameplay acceptance | `godot --headless --path experiments/godot-harness/voxel -s res://tests/run_voxel_tests.gd` | **36/36** |
| Windowed observation | `node controller/voxel-observe.mjs` | **12/12**, 9 captures |
| Measurements | `node controller/voxel-measure.mjs` | world/timing/FPS recorded |
| Packaged build | `node controller/voxel-export-verify.mjs --exe voxel/build/voxel-sandbox.exe` | **12/12**, window captured |

The gameplay suite asserts behaviour, not file existence. Covered checks include
`startup-spawn-safe`, `startup-block-types`, `startup-hotbar-and-inventory`,
`movement-forward`, `movement-strafe`, `movement-jump-and-land`,
`collision-terrain-wall`, `targeting-raycast-state`,
`targeting-highlight-and-hud`, `targeting-no-target`,
`mining-removes-block`, `mining-rejects-bedrock`, `mining-feedback`,
`placement-adjacent-cell`, `placement-rejects-player-overlap`,
`placement-rejects-outside-world`, `placement-rejects-empty-inventory`,
`placement-rejects-bedrock-layer`, `placement-feedback`,
`hotbar-number-key`, `hotbar-mouse-wheel-wraps`,
`hotbar-selected-matches-placement-tool`, `mouse-release-and-recapture`,
`player-boundary-clamp`, `player-fall-recovery`,
`save-writes-outside-repository`, `load-restores-world-and-player`,
`load-restores-harness-hash`, `load-missing-save-safe`,
`load-invalid-json-safe`, `load-invalid-world-atomic`,
`load-feedback-and-hud`.

The data suite is the hidden half of the external-agent contract. It asserts
determinism, required block types, height variation, spawn safety, boundaries,
set/get, change tracking, save round trip, atomic rejection of invalid saves,
three raycast cases, and hash tracking. The agent never receives this file.

## Windowed observation evidence

`docs/phase19/evidence/runtime/2026-10-25T05-55-04-354Z/`:

`observation checks passed: 12/12`

| Scenario | Check | Image SHA256 (prefix) |
| --- | --- | --- |
| spawn | grounded, world shape, block types | `c9900db02d25` |
| movement | forward displacement | `31f9f82d5f8e` |
| jump | airborne with positive vertical velocity | `5424acc38999` |
| targeting | ray hit plus HUD target line | `7719094ba1cb` |
| mining | `block_mined` event and inventory +1 | `eee586739b83` |
| placement | `block_placed` at the previous cell | `4c83439976ec` |
| hotbar | slot 3 selected, matches placement tool | `19a0841a9c57` |
| save | `world_saved`, 535 bytes, path under `user://` | `0a2cf834d877` |
| reload | `world_loaded`, identical state hash | `d06d5de1e456` |

All nine images are real 1280x720 windowed captures. They are **paused frames**,
taken with the tree paused via the harness `captureFrame` path, not video. The
save state hash `82c8c004af33...` equals the reload state hash, which is the
persistence-equivalence claim in this phase.

Earlier observation runs are preserved rather than deleted, because they show
the failures that shaped the fixes: `05-50-50-624Z` (setup returned an envelope,
not a snapshot), `05-51-52-107Z` (state omitted the `save` block), and
`05-52-29-297Z` (11/12, `reload-event` mismatched on the pre-fix hash).

## Controlled-defect repair experiment

Runner: `experiments/godot-harness/controller/voxel-defect.mjs`. The trusted
runner copies the healthy project, injects one defect, proves the hidden suite
fails, launches one time-boxed external agent against a disposable copy, verifies
the candidate in a separate copy, and records every stage. It never edits the
canonical worktree.

Accepted run: `docs/phase19/evidence/repair/2026-10-25T06-02-23-740Z/`

| Stage | Result |
| --- | --- |
| Defect injected | Raycast returns the hit cell as `previous`, so placement targets the block it points at |
| Hidden suite on defect | **14/15**, failing check `data-raycast-down` |
| Agent model | `opencode/deepseek-v4.1-flash-free` |
| Agent duration | 60.4 s, exit 0, no timeout |
| Files changed by agent | `project/scripts/voxel_data.gd` only |
| Hidden suite on candidate | **15/15** |
| Candidate SHA256 | `338d3ee0...` - byte-identical to the healthy module |
| Canonical module before/after | `338d3ee0...` / `338d3ee0...`, unchanged |

The agent's `IMPLEMENTATION.md` correctly identified the faulty `previous` field
and the `_try_place()` consumer. The sandbox configuration denied shell,
external directories, webfetch, websearch, execute, question, skill, and
subagent, so the fix had to come from the supplied source and test failure.

Two earlier runs of the *experiment design* are preserved with `FAILURE.md`:
`05-59-10-201Z` refused to inject because the literal match assumed LF while the
checkout uses CRLF, and `05-59-48-987Z` injected a flat-terrain defect the hidden
suite could not see, because seed-dependent trees still produced height variation
and different world hashes. No agent ran in either case.

**Honest limit.** The agent's accepted change is a one-line revert to the value
the reference implementation already used, and the resulting file is
byte-identical to the healthy module. That is a real, independently verified
detect-repair-verify loop, but it is not evidence that the model derived a novel
algorithm. The canonical data module was written as a trusted reference, and the
implementation agent never produced an accepted module: attempt 3 ended with a
HTTP 429 `FreeUsageLimitError` from the provider.

## Measurements

`docs/phase19/evidence/measurements/2026-10-25T06-05-56-931Z/`, seed `20261023`.
Machine: Intel Core i7-10610U, Intel UHD Graphics, 16 GB RAM, Godot
`4.7.2-stable`, gl_compatibility renderer, 1280x720.

| Metric | Value | Method |
| --- | --- | --- |
| World dimensions | 32 x 16 x 32 = 16384 cells | data module |
| Solid blocks | 6181 (air 10203) | `counts()` |
| Block mix | grass 1024, dirt 2048, stone 3033, log 12, leaves 64 | `counts()` |
| Chunks | 16 (8 x 8 columns, 8 blocks per side) | chunk loop |
| Geometry | 3608 visible faces, 21648 vertices, 7216 triangles | chunk builder output |
| Generation | median **2.503 ms**, mean 2.531, min 2.229, max 3.304 (n=10) | `Time.get_ticks_usec()` around `generate()` |
| All-chunk mesh build | median **65.533 ms**, mean 66.490, min 64.652, max 71.428 (n=5) | `Time.get_ticks_usec()` around all 16 builds |
| Launch | **794 ms** spawn-to-first-game-ready-ping (engine uptime 197 ms) | windowed `HarnessSession.start()` |
| FPS | 60, 60, 59 | `Performance.get_monitor` samples, 1 s apart |
| Draw calls | 91, 89, 89 | engine monitor |
| Rendered primitives | 21152, 20936, 20936 | engine monitor |
| Static memory | ~41.9 MB | engine monitor |

Faces are emitted only where a neighbour is air or outside the world, which is
why 6181 solid blocks produce 3608 visible faces instead of 37086.

These are single-machine measurements, not a benchmark: three FPS samples on an
integrated GPU, and CPU timings that exclude physics body creation, material
setup, and rendering. The lower FPS values visible inside the observation
`run.json` (41-55) come from pausing and resuming the tree for each capture and
are not steady-state numbers.

## Native Windows export

`experiments/godot-harness/voxel/export_presets.cfg` exports a release build with
an embedded PCK. Export command:

```powershell
godot --headless --path experiments/godot-harness/voxel --export-release "Windows Desktop" experiments/godot-harness/voxel/build/voxel-sandbox.exe
```

| Property | Value |
| --- | --- |
| File | `build/voxel-sandbox.exe` |
| Bytes | 109,235,296 |
| SHA256 | `1ade5406fb14049b6c077f751cf4eba1bf8237014030fcbc05c7d7f77ba652bb` |
| PE header | valid (`MZ` + `PE\0\0`) |
| Verification | **12/12** checks |

`docs/phase19/evidence/export/2026-10-25T06-11-40-680Z/` drives the shipped
binary through its own opt-in bridge and confirms bridge reachability, a
non-headless window, world shape, spawn, movement, jump, targeting, mining,
adjacent placement, hotbar selection, save/reload, and a real window capture
(`packaged-window.png`, 1280x720, SHA256 `35cf3d6e...`). The captured frame shows
the terrain, HUD, hotbar, save feedback, and the two restored changes.

Earlier export runs are preserved: `06-08-43-608Z` (wrong bridge command name,
2/2 before the failure), `06-09-03-921Z` and `06-10-38-770Z` (11/12, window
capture only, first for the `deflect` title filter and then for the hidden
window).

## Safety and isolation

- All Phase 19 work is in `C:\Users\hacke\ai-native-engine-phase19` on
  `experiment/phase19-voxel`; working branch HEAD is based on `1095fc43`.
- `docs/phase8` through `docs/phase18` are byte-unchanged (`git diff` and
  `git status` show no modifications or additions).
- The agent sandbox is deny-by-default: `shell`, `external_directory`,
  `webfetch`, `websearch`, `execute`, `question`, `skill`, and `subagent` are
  denied; only read/write/edit/glob/grep are allowed, and the sandbox config
  itself is write-protected.
- The defect experiment operated only on temporary copies. The canonical data
  module hash was equal before and after the run.
- Save files are written under `user://`
  (`%APPDATA%\Godot\app_userdata\voxel-sandbox\`), never inside the repository or
  the exported PCK. A test asserts the absolute path is outside the worktree.
- Evidence writers reject output paths outside `docs/phase19`.
- No secrets, tokens, or credentials were written. Nothing was pushed.

## Limits and honest gaps

- **Canonical module authorship.** The data module is the trusted reference, not
  external-agent output. The implementation agent failed three attempts and was
  quota-blocked; this is recorded in
  `evidence/agent-runs/implementation-2026-10-23T17-06-43-470Z/`.
- **Agent repair is a one-line revert.** The controlled-defect success is real
  but narrow; it does not demonstrate synthesising the DDA algorithm from
  scratch.
- **No textures.** Blocks are lit, per-face coloured meshes with slight per-cell
  variation. There is no texture atlas, ambient occlusion, or water.
- **Fixed world, no streaming.** 32x16x32 with no infinite terrain, LOD, or
  chunk loading. A 16-chunk mesh rebuild takes ~65 ms, which is noticeable as a
  hitch when a block changes if the frame budget is tight; only one chunk column
  is rebuilt per edit, so the observed in-game cost is lower, but that path was
  not separately benchmarked.
- **Mouse capture is state-verified, not OS-verified.** Headless Godot does not
  retain `MOUSE_CAPTURED`, so capture is modelled as explicit game state and
  tested through that state and its feedback. A human-visible test of the OS
  cursor grabbing was not automated.
- **Paused-frame imagery.** Screen captures are paused 1280x720 frames, not
  video, and no claim is made about motion smoothness beyond the FPS samples.
- **Single machine.** Performance and the exported binary were verified only on
  this Windows host, not on a clean VM or another GPU.
- **No CI wiring.** The suites and runners are reproducible commands, but they
  are not wired into a CI pipeline.

## Reproduction

From `C:\Users\hacke\ai-native-engine-phase19\experiments\godot-harness`:

```powershell
# Refresh the global class cache after adding class_name scripts.
godot --headless --editor --path voxel --quit

# Hidden data suite (15 checks)
godot --headless --path voxel -s res://tests/run_voxel_data_tests.gd

# Gameplay acceptance suite (36 checks)
godot --headless --path voxel -s res://tests/run_voxel_tests.gd

# Windowed observation with screenshots (12 checks)
node controller/voxel-observe.mjs --out-dir ../../docs/phase19/evidence/runtime/<run>

# Measurements (CPU timings + windowed monitors)
node controller/voxel-measure.mjs

# Controlled-defect repair experiment (one bounded agent attempt)
node controller/voxel-defect.mjs --timeout-ms 600000

# Export and verify the native Windows build
godot --headless --path voxel --export-release "Windows Desktop" voxel/build/voxel-sandbox.exe
node controller/voxel-export-verify.mjs --exe voxel/build/voxel-sandbox.exe
```

The project can also be run interactively:

```powershell
godot --path experiments/godot-harness/voxel
```

In-game controls: WASD move, Space jump, mouse look, LMB mine, RMB place,
`1`-`4` or wheel to select, `F5` save, `F9` load, `R` reset, `Esc` release mouse.

## Evidence index

| Directory | Result |
| --- | --- |
| `evidence/runtime/2026-10-25T05-55-04-354Z/` | Accepted 12/12 observation, 9 captures |
| `evidence/repair/2026-10-25T06-02-23-740Z/` | Accepted agent repair, 15/15 |
| `evidence/repair/2026-10-25T05-59-10-201Z/` | Preserved pre-flight failure (CRLF match) |
| `evidence/repair/2026-10-25T05-59-48-987Z/` | Preserved design failure (masked defect) |
| `evidence/measurements/2026-10-25T06-05-56-931Z/` | Accepted measurements |
| `evidence/export/2026-10-25T06-11-40-680Z/` | Accepted 12/12 packaged verification plus window |
| `evidence/runtime/2026-10-25T05-50-50-624Z/`, `05-51-52-107Z/`, `05-52-29-297Z/` | Preserved observation failures |
| `evidence/export/2026-10-25T06-08-43-608Z/`, `06-09-03-921Z/`, `06-10-38-770Z/` | Preserved export-run failures |
| `evidence/agent-runs/implementation-2026-10-23T17-06-43-470Z/` | Preserved failed implementation agent run (quota) |

## Next phase

Phase 20 was not started. The next session should treat `experiment/phase19-voxel`
as a local-only branch pending review, and should not assume the implementation
agent can author this kind of module until the provider quota issue is resolved.
