# Phase 10 - Stage A: observation design and baseline

Status: design complete. No observation implementation has been started yet.

## 1. Preflight

- Worktree: `C:\Users\hacke\ai-native-engine-phase10`
- Branch: `experiment/phase10-observation`
- Base: Phase 9 `edff0effec5fe8c082c88e853a43dfe9bcbc96ee`
- Main worktree: `C:\Users\hacke\ai-native-engine`
  - branch `fix/camera-relative-strafe`
  - HEAD `583ec00533909ecb1dddddfbb57211fb7b175f0c`
  - not modified
- Phase 7 worktree: clean at `ebbb21d5edc3680dc6f0e06b55d9e0ca3767f265`
- Phase 8 worktree: clean at `6667ecc8b0247a63c3b2ac7e2dcfd348343d35cd`
- Phase 9 worktree: clean at `edff0effec5fe8c082c88e853a43dfe9bcbc96ee`
- Protected refs were re-read and matched the Phase 9 report:
  - `master` `2c28ee23dd2a6a7d14f598bdd2ff4acf4daf094e`
  - `spike/sentry-mode` `df973aafaa96847aa6f962337d8f1020f7e7d2b5`
  - Phase 7 `ebbb21d5edc3680dc6f0e06b55d9e0ca3767f265`
  - Phase 8 `6667ecc8b0247a63c3b2ac7e2dcfd348343d35cd`
- The Phase 9 report is present at `edff0ef` and reports Stage E and Stage F
  complete with no merge or push.

### Phase 8 baseline verification

Phase 8 acceptance was re-run from a clean copy outside all phase worktrees so
its fixtures and evidence were not touched:

`%TEMP%\opencode\phase10-phase8-baseline`

The six documented commands all passed:

| Command | Exit | Result | Wall time |
| --- | ---: | --- | ---: |
| `npm test` | 0 | 18/18 tests | 22.182 s |
| `npm run test:logic` | 0 | 7/7 cases | 1.573 s |
| `npm run test:gameplay` | 0 | 8/8 tests | 22.072 s |
| `npm run evidence:live` | 0 | 9/9 checks | 21.359 s |
| `npm run test:screenshot` | 0 | 1/1 windowed test | 20.763 s |
| `npm run test:repair` | 0 | before live exit 1, after live exit 0 | 62.288 s |

The logs are preserved under `docs/phase10/preflight/phase8-logs/`. No file in
the Phase 8 worktree or its evidence directory was modified.

## 2. What the harness can already observe

The Phase 9 harness is a project-local bridge plus a Node controller. It already
supports:

- controller-owned `start_project`, `stop_project`, `run_tests`, and
  `inspect_state` lifecycle;
- pause/resume, persistent input, manual steps, and real fixed-tick
  `advance_physics`;
- complete snapshots, scene trees, one-property reads, reset, stable hashes, and
  windowed screenshots;
- controller stdout/stderr and a bounded bridge event log;
- a generic boolean `actions` input map used by the door fixture.

The Godot MCP server is editor-session based and exposes scene playback,
simulated input, screenshots, scene-tree reads, and property monitors through
`EngineDebugger`. It has no headless CLI lifecycle or project-local fixed-tick
control. It is not exposed as a tool in this Phase 10 session, so Phase 10 does
not depend on it. The Phase 8 capability review remains the reference:
<../phase8/stage-a.md> and <../phase8/stage-b.md>.

## 3. What is missing

The current evidence is mostly fixture-specific final snapshots:

- screenshots have no scenario/run identifier, input record, tick, simulation
  time, or capture timestamp in one manifest;
- no short frame sequence or recording workflow;
- no generic targeted observation of standard scene data (type, world
  transform, velocity, grounded/collision state, animation state, collision
  shapes, skeleton bones);
- `advance_physics` returns only a final snapshot, not a bounded timeline;
- bridge events are controller events, not gameplay or collision events;
- collision events cannot be reconstructed from a later snapshot, so they must
  be recorded at occurrence;
- there is no single artifact that lets an agent correlate a visual symptom with
  the runtime state and event timeline.

## 4. Design

### Reuse first

The implementation will extend the existing controller and bridge protocol. It
will not add an MCP server, engine fork, editor, second harness, or custom
physics stepping path.

Reused operations:

- `HarnessSession` lifecycle and owned-process stop;
- `pause`, `resume`, `reset`, `advancePhysics`, input, `snapshot`, `sceneTree`,
  `property`, `inspectState`, and `screenshot`;
- the existing newline-delimited JSON request/response protocol;
- normal Godot fixed-tick execution for all physics and animation evidence.

New general-purpose controller operations:

- `captureFrame({ path, scenario, runId, metadata })`: one actual windowed
  screenshot plus a manifest-ready record containing run id, scenario, input,
  tick, simulation time, capture timestamps, screenshot hash/bytes/size, and
  the snapshot around the capture.
- `captureSequence({ scenario, prefix, frameCount, everyFrames, input })`:
  a bounded sequence of actual frames sampled after real physics advances. It
  is a frame sequence, not a real-time video claim. A caller may encode it
  offline; any encoding is identified as a sampled-frame artifact.
- `observe({ targets, properties, descendants, sinceTick })`: targeted,
  validated runtime observation. It returns runtime metadata, selected nodes,
  optional requested properties, and gameplay events. It does not dump the
  entire scene every frame.
- `observeTimeline({ frames, everyFrames, input, targets, properties,
  descendants, sinceTick })`: bounded samples produced by advancing real
  physics in chunks and calling `observe` between chunks. Events are recorded
  at occurrence by the fixture and returned with their tick and simulation
  time.

The bridge gains `observe` and screenshot timing metadata. The fixture gains an
optional `harness_events(since_tick)` interface. Neither is fixture-specific:
any project that implements the same optional event method can use it.

### Observation contract

Runtime metadata:

- `tick`, `physics_frames`, `physics_ticks_per_second`, `sim_time`,
  `captured_at`, `uptime_ms`, `paused`, `godot`, and coordinate-space labels.

Per target node:

- identity: absolute path, name, class, process mode, visibility;
- local and global transforms, with local space labelled parent-relative and
  global space labelled world;
- velocity where the body exposes it (`velocity`, `linear_velocity`,
  `angular_velocity`);
- character state where available (`is_on_floor`, `is_on_wall`,
  `is_on_ceiling`, floor/wall normals, slide-collision count);
- collision-shape children: shape class, enabled state, local transform, and
  common dimensions such as box size, sphere radius, and capsule radius/height;
- animation state where available (`AnimationPlayer.current_animation`,
  position, playing, speed);
- skeleton state where available: bone count, names, parents, rest transforms,
  pose transforms, and global pose transforms;
- optional requested property reads, with missing properties reported per node;
- optional direct-child/descendant summaries for bounded rig hierarchy
  inspection.

Measured versus derived:

- Every value read directly from a Godot node is marked `measured`.
- Computed values such as speed from a velocity vector are placed under
  `derived` and never presented as engine state.
- Unavailable fields are omitted or explicitly marked `available: false`; they
  are not filled with guesses.

Events:

- The fixture records gameplay events at the tick they occur, including plate
  entry/exit, gate state changes, player collision start/end, crate collision,
  goal reached, and reset.
- The observation result includes the event tick, simulation time, and event
  payload. It never claims a collision can be reconstructed after the fact.

Bounds:

- 32 target paths, 32 requested properties, 256 descendant nodes, 200 fixture
  events per run, and a 1 MiB bridge line limit.
- No full scene dump per frame.

### Humanoid and character intelligence design

The interface will inspect an existing humanoid asset from
`content/assets/character/humanoid-01.glb`. That asset is a rigid-part hierarchy
of 22 named mesh nodes, not a skinned `Skeleton3D`; it has no animations or bone
hierarchy. It can reliably demonstrate identity, hierarchy, transforms, and
semantic part names, but not bone-level skinning.

To exercise the skeleton branch without building a character generator, the
fixture will include one small `ProbeSkeleton` with a few named bones and a
`BoneAttachment3D` marker. This is an interface probe, not a procedural
humanoid generator and not a production character.

The future character interface is designed as separate, named layers:

- semantic skeleton: stable names and parent relationships;
- animation rig: clips, current state, playback time, and blend state;
- physics rig: bodies, collision shapes, mass, and grounded state;
- collision rig: weapon hitboxes and hurtboxes as separate volumes;
- gameplay events: attack windows, hit confirmation, damage, and state changes.

These layers remain distinct. A future Soulslike creature can use the same
observer if it exposes the same node paths and optional event method. This phase
does not infer bones from unskinned meshes, generate skeletons, retarget
animations, or implement weapons/hitboxes.

### Smallest useful scenario

Stage B starts with the existing Phase 9 door fixture: a windowed run captures
the locked attempt, key pickup, and open door, plus a short sampled approach
sequence. This tests visual observation on an existing fixture before adding a
new game scenario.

Stage C introduces one self-contained `fixtures/observation` project:

- one real `CharacterBody3D` player with normal fixed-tick `move_and_slide()`;
- one pressure plate (`Area3D`) on the path;
- one gate (`StaticBody3D`) that should open when the plate is pressed;
- one beacon with visibly red/green state and a looping animation;
- one small falling `RigidBody3D` crate to distinguish solver velocity from the
  player controller;
- the existing rigid-part humanoid asset and a small `ProbeSkeleton`;
- a HUD and event log that make the state visible and machine-readable.

The scenario is: reset, walk forward onto the plate, capture the live frame,
read the observation timeline, verify the gate/beacon/event correlation, and
verify that the gate blocks when closed.

Stage D introduces one controlled defect in this fixture: the gate update
condition is inverted. The same scenario should show the plate as pressed while
the gate is closed; the event timeline lacks `gate_open`, the beacon remains red,
and the player collision log shows the gate blocking. The AI must diagnose from
the visual and structured evidence, apply a one-line repair in a controlled
copy, and rerun the same test to pass.

## 5. Acceptance criteria and evidence

1. Baseline intact: protected refs and Phase 8/9 worktrees unchanged; Phase 8
   acceptance logs preserved.
2. Visual evidence: actual windowed captures with run id, scenario, input
   sequence, tick, simulation time, capture time, hashes, and dimensions.
3. Structured evidence: validated observation records with measured/derived
   distinction, units/spaces, and unavailable-data markers.
4. Correlation: one timeline links scenario inputs, screenshot frames, runtime
   fields, and recorded events.
5. Controlled defect: repeatable failing test before repair.
6. Diagnosis: written diagnosis cites the visible symptom and the runtime
   evidence, with confidence and uncertainty; it is not hardcoded in the
   observer.
7. Repair: same test passes after the one-line repair; regression tests pass.
8. Missing data is explicit: the report lists unavailable rig fields and any
   unsupported animation/collision data.
9. Reuse: the generic observer is exercised on the new fixture and on an
   unmodified copy of the Phase 9 door fixture.
10. Limitations: no general physics determinism, no video understanding, no
    full character intelligence, no inventory/persistence/network claim.

Evidence will be written only under `docs/phase10/`. Phase 8 and Phase 9
evidence is read-only.

## 6. Risks and costs

- Windowed capture depends on a display and is slower than headless; screenshots
  wait for a render frame and are not a performance benchmark.
- Real physics advance runs in wall-clock time; a short sequence takes seconds,
  not milliseconds.
- `AnimationPlayer` and `Skeleton3D` fields vary by Godot node type; the
  observer must report unavailable data rather than infer it.
- The twin-stick-style pressure-plate defect is intentionally local and simple;
  success does not imply general debugging ability.
- The bridge remains a loopback, unauthenticated local control surface.
- The humanoid asset has no skin or bones, so semantic skeleton mapping remains
  a design, not a demonstrated skinned-character result.
- A recorded frame sequence is not proof of live video understanding; the agent
  reads PNG frames and structured data.

## 7. Stopping conditions

Stop the stage and report a blocker instead of expanding scope if:

- the existing harness cannot capture actual frames in a windowed run;
- a structured observation cannot be validated without fixture-specific
  commands;
- collision events cannot be recorded at occurrence without custom engine
  stepping;
- the controlled defect cannot be made reproducible or the same test cannot be
  rerun;
- a phase worktree or protected ref would need to be modified.

## 8. Commit plan

- Stage A: this design and the preflight baseline evidence.
- Stage B: generic capture and sequence operations, windowed door captures, and
  stage report.
- Stage C: observation bridge contract, controller observation API, new
  observation fixture, humanoid/rig inspection, and evidence.
- Stage D: defect/repair runner, diagnosis, before/after captures, and same-test
  verification.
- Final: regression results and Phase 10 report.

No merge, push, reset, rebase, retag, or Phase 8/9 evidence change is allowed.
