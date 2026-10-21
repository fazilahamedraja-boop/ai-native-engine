# Phase 10 - Final report: verified AI observation

Status: complete. Stage evidence is committed; the worktree is clean. No merge
or push was performed.

## Outcome

Phase 10 added a verifiable observation loop for real Godot gameplay:

1. capture actual windowed frames from a running game with reproducible
   metadata;
2. expose bounded structured runtime, physics, collision, animation, skeleton,
   event, and clock observations;
3. use the same generic observation surface on an unchanged door scene; and
4. reproduce one controlled defect, correlate the screenshot with the structured
   state, diagnose it, repair one line, and rerun the identical test.

The phase proves those capabilities for the committed fixtures. It does not
prove live-video understanding, general physics determinism, general autonomous
repair, or character intelligence.

## Baseline and branch

- Worktree: `C:\Users\hacke\ai-native-engine-phase10`
- Branch: `experiment/phase10-observation`
- Baseline: `edff0ef` (`docs: correct phase 9 report timing table`)
- Godot: `4.7.2.stable.official.ed1daf0bf`
- Physics: 60 Hz

Baseline refs checked during the final audit:

```text
master             2c28ee23dd2a6a7d14f598bdd2ff4acf4daf094e
spike/sentry-mode  df973aafaa96847aa6f962337d8f1020f7e7d2b5
Phase 9 baseline    edff0effec5fe8c082c88e853a43dfe9bcbc96ee
```

Protected paths have no diff from the baseline:

```powershell
git diff --name-only edff0ef..HEAD -- docs/phase8 docs/phase9 experiments/godot-harness/fixtures/door
# empty
```

## Stage commits

| Stage | Commit | Result |
| --- | --- | --- |
| A - design and baseline | `0e2797e` | Design, acceptance criteria, risks, stopping conditions; Phase 8 acceptance preflight |
| A - capability inspection | `4d0b042` | Read-only Godot MCP assessment; rejected as a dependency |
| B - visual capture | `8a5df75` | Real windowed screenshots, sampled sequence, offline MP4, manifest |
| C - structured observation | `5d59e8b` | Generic `observe` / `observe_timeline`, observation fixture, tests, evidence |
| D - defect and repair | `088eb84` | Controlled gate defect, visual/structured diagnosis, one-line repair, same-test rerun |

## Stage A - design before implementation

`docs/phase10/stage-a-design.md` records:

- reusable capabilities: owned-process lifecycle, loopback bridge, real
  `advance_physics`, paused snapshots, image capture, and test parsing;
- missing observation data: identity/type, transforms, velocity, grounded and
  collision state, animation, collision shapes, events, and tick/time;
- the smallest useful experiment and its acceptance criteria;
- evidence, risks, cost, and stopping conditions.

The Phase 8 acceptance check was rerun from a clean temporary copy; its six
commands exited 0 before Phase 10 implementation began.

`docs/phase10/stage-a-godot-mcp.md` records the read-only MCP inspection. Godot
MCP was not adopted: it is editor/runtime-probe bound, the bridge was offline,
and it did not provide an owned-process headless lifecycle or project-local
fixed-tick control. The existing Phase 9 harness pattern was reused instead.

## Stage B - visual observation

`docs/phase10/stage-b-visual.md` and `docs/phase10/stage-b-captures.json` record
a windowed run of the existing door fixture:

- three state captures: locked, key held, door open;
- a seven-frame approach sequence sampled every 20 real physics ticks;
- an offline 5 fps MP4 encoding of that sequence;
- run id, scenario, input, ticks, simulation steps, capture timestamps, byte
  counts, dimensions, and SHA-256 hashes.

Observed:

- `npm run evidence:visual` exited 0 in 20.919 s;
- the process stopped with exit code 0 and `killed=false`;
- all captures were 1280x720 and non-empty;
- copy hashes matched the bridge capture hashes;
- frames 4-6 were identical because the locked door blocked movement; this is
  documented as collision evidence, not three unique frames.

The MP4 is an offline encoding of sampled PNGs, not a real-time recording. No
live-video-understanding claim is made.

Evidence: `stage-b-locked.png`, `stage-b-key.png`, `stage-b-open.png`,
`stage-b-frames/`, and `stage-b-approach.mp4`.

## Stage C - structured observation

`docs/phase10/stage-c-observation.md` and `docs/phase10/stage-c/` record a new
observation fixture with:

- a real `CharacterBody3D` player;
- a pressure plate and gate with a deferred collision toggle;
- a beacon with a real `AnimationPlayer`;
- a falling/sleeping `RigidBody3D` crate;
- one existing rigid-part humanoid asset and a separate four-bone probe.

The generic surface is `HarnessSession.observe()` and
`HarnessSession.observeTimeline()`, backed by a project bridge that implements
the bounded `observe` command. It exposes:

| Area | Observed |
| --- | --- |
| identity/type | path, name, class, process mode, visibility |
| transforms | parent-relative and world transforms, labelled spaces |
| character | velocity, floor/wall/ceiling state, normals, slide collisions, derived speed |
| rigid body | linear/angular velocity, mass, gravity scale, sleeping, derived speed |
| collision | direct collision children, shape class, disabled state, transforms, common dimensions |
| animation | direct `AnimationPlayer` current/assigned clip, position, playing, speed |
| skeleton | bone count/names/parents, parent-relative pose, skeleton-space global pose, derived world pose |
| events | optional fixture event stream with sequence, type, and timing |
| clocks | engine tick, simulation step, derived simulation time, capture timestamps |

The distinction between measured, derived, and unavailable data is explicit.
`sim_time_seconds` is labelled `derived`; bone world poses are labelled
`derived`; missing event providers return `unavailable`; wrong types return
`invalid`.

Final Stage C evidence run
`stage-c-80ab61ff-55d4-4c55-92c0-008b39819b28`:

- initial capture: step 0, engine tick 21, screenshot tick 29, gate closed, red
  beacon;
- open capture: step 90, engine tick 137, screenshot tick 145, gate open,
  collision disabled, green beacon;
- state/screenshot semantic fields matched at both captures;
- timeline samples: simulation steps 0/30/60/90, engine ticks 39/71/103/135;
- events: reset, player ground collision, crate collision, plate entered, gate
  open, with both engine tick and simulation step recorded;
- humanoid: 25 named parts = 22 `MeshInstance3D` meshes plus 3 pivot nodes; no
  skin or bone hierarchy from the imported glTF; a separate four-bone
  `ProbeSkeleton` with explicit `bone_parent`, `skeleton`, and derived world
  spaces;
- door reuse: a temporary copy of the Phase 9 door scene with only the bridge
  replaced; scene/scripts unchanged; key/door/player state observed.

The engine tick and simulation step are deliberately kept distinct. Paused
sampling and screenshot rendering advanced engine ticks without advancing the
fixture's fixed simulation step. No observer command, node name, or fixture
logic was added to the generic bridge for a specific diagnosis.

Evidence: `stage-c-initial.png`, `stage-c-open.png`, `stage-c-timeline.json`,
`stage-c-humanoid.json`, `stage-c-door-reuse.json`, and
`stage-c-observations.json`.

## Stage D - controlled defect and repair

`docs/phase10/stage-d-defect-repair.md` and `docs/phase10/stage-d/` record a
single inverted gate condition in a temporary copy of the observation fixture:

```gdscript
# correct
if plate_pressed == gate_open:
    return

# injected defect
if plate_pressed != gate_open:
    return
```

The copy and its injected line are not committed. The runner applies the
inversion exactly once, runs the unchanged acceptance suite, captures the defect,
applies the inverse replacement once, and runs the identical suite again.

### Before repair

- acceptance suite: 6 passed, 2 failed, exit 1;
- failing cases: `observation-plate-opens-gate` and
  `observation-gate-passable-after-plate`;
- screenshot: plate pressed, gate closed, collision enabled, beacon red, HUD
  `PLATE PRESSED`, `GATE CLOSED`, `GATE STUCK - WAIT`;
- structured state: player on plate at z=-0.1667; after 100 more forward frames
  the player stopped at z=-1.9497 with zero velocity, goal false;
- events: `plate_entered` present, `gate_open` absent, and a
  `player_collision_start` on `/root/Main/Gate` at simulation step 116.

### Diagnosis

The update guard skips the gate state change when plate and gate differ. In the
correct source, inequality means an update is needed; in the defect, inequality
returns early, so the gate can never follow the plate.

### After repair

- source SHA-256 restored to the original
  `97ca10f4673ea0a6b293207865f5c9506a430d25043c25e21c6ff32539331bdb`;
- repaired source matches the original fixture exactly;
- same test script SHA-256
  `abf91c78a6444f7203845311dd08223acbd12ab8fdabbfff55b4ae207b09413d`;
- acceptance suite: 8 passed, 0 failed, exit 0;
- repaired capture: gate open, collision disabled, green beacon, HUD
  `GATE OPEN - GO THROUGH`;
- after 100 more forward frames: goal reached at z=-7.1842; gate closed behind
  the player.

The defect and repaired captures are at the same behavioral checkpoint and were
compared field by field with paused observations. The observer, test, and
repair path contain no defect-specific branch; the repair is the controlled
inverse of the injected line.

Evidence: `stage-d-defect-plate.png`, `stage-d-defect-exit.png`,
`stage-d-repaired-plate.png`, `stage-d-repaired-exit.png`,
`stage-d-test-before.json`, `stage-d-test-after.json`, and
`stage-d-observations.json`.

## Verification

| Check | Command | Result |
| --- | --- | --- |
| Full headless gate | `npm test` | 27/27 passed, exit 0, 24,608 ms |
| Observation fixture suite | `node controller/harness.mjs test --project fixtures/observation --script res://tests/run_observation.gd --timeout-ms 30000` | 8/8 passed, exit 0 |
| Observation controller | `node --test tests/observation.test.mjs` | 5/5 passed, exit 0 |
| Stage C evidence | `npm run evidence:observation` | exit 0, two windowed PNGs + JSON, stop exit 0 |
| Stage D evidence | `npm run evidence:defect` | exit 0, 6/8 failing -> 8/8 repaired, four windowed PNGs |
| Door suite | `npm run test:door` | 7/7 passed, exit 0 |
| Door bridge control | `npm run test:door-control` | 1/1 passed, exit 0 |
| JavaScript syntax | `node --check controller/harness.mjs`, `controller/defect-suite.mjs` | exit 0 |
| Whitespace | `git diff --check` | no output |
| Protected paths | `git diff --name-only edff0ef..HEAD -- docs/phase8 docs/phase9 experiments/godot-harness/fixtures/door` | no output |
| Worktree | `git status --short --branch` | clean, branch only |

Stage B's recorded checks were `node --test tests/capture.test.mjs` 3/3 and
`npm run evidence:visual` exit 0. Its `npm test` run at that point was 22/22;
the later observation additions brought the final gate to 27/27.

Process note: `npm run test:door-control` regenerated
`docs/phase9/stage-f-inspect.json` as a side effect of running its live evidence
helper. The file was restored exactly from `edff0ef`; the final protected-path
diff is empty.

## Requirements checklist

| Requirement | Result |
| --- | --- |
| Stage A before implementation | Pass: design, acceptance, risks, stopping conditions, MCP assessment |
| Stage B real reproducible screenshots | Pass: three state captures, seven sampled frames, manifest |
| Stage B recordings if practical | Pass: offline MP4 from sampled images; no live-video claim |
| Stage C identity/type/transforms/velocity | Pass: generic node and character/rigid-body observations |
| Stage C grounded/collision/events/tick/time | Pass: measured flags, shapes, event stream, dual clocks |
| Stage C measured/derived/unavailable | Pass: explicit source labels and fallbacks |
| One humanoid rig, distinct rigs | Pass: 22 meshes plus separate four-bone probe; no skin claim |
| Stage D one reproducible defect | Pass: one-line inversion in a temporary copy |
| Correlate visual and structured evidence | Pass: four captures matched four state fields |
| Minimal repair and same test | Pass: source hash restored; identical script, 6/8 -> 8/8 |
| No diagnosis hardcoded in observer | Pass: generic observation only |
| Character intelligence design-only | Pass: no character intelligence implemented |
| Phase 9 physics boundaries | Pass: door fixture unchanged; no direct position updates |
| No general physics determinism claim | Pass: state hashes are diagnostic only |
| Separate stage evidence and commits | Pass: Stage A/B/C/D commits and separate evidence directories |
| Leave worktree clean | Pass after the final report commit |
| No merge or push | Pass: branch remains unmerged and local |

## Limits

- Stage B frames are paused/sampled states, not a real-time recording. The MP4
  is an offline 5 fps encoding. There is no live video understanding.
- The observation contract is bounded: 32 targets, 32 properties, three
  descendant levels, 256 descendant nodes, 128 bones, and 200 events.
- Collision, animation, and child-skeleton discovery is intentionally limited to
  direct or direct-child nodes. Deep generated hierarchies are not traversed.
- Event streams are fixture-defined. The bridge reports `unavailable` or
  `invalid`; it does not discover an event bus a game does not provide.
- The imported humanoid GLB has 22 rigid mesh instances and no skin or bone
  hierarchy. The four-bone probe is an inspection interface, not a generated or
  skinned character.
- Engine physics-frame ticks and fixture simulation steps are different clocks.
  Screenshot rendering advances the former during paused capture.
- The Stage D defect is a controlled injected inversion, not a naturally
  occurring bug. It demonstrates one diagnosis/repair loop, not general
  autonomous repair or diagnosis accuracy.
- Stage C/D state hashes are diagnostic. The Phase 9 Stage E wall-contact
  limitation still applies; no general determinism claim is made.

## Deferred

The following remain design-only or outside Phase 10:

- character intelligence;
- a skinned character skeleton or animation retargeting;
- deep/recursive collision and rig discovery;
- a general game event bus;
- live video analysis;
- general autonomous repair.

Phase 10 stops with this report. No merge, push, reset, rebase, or retag was
performed.
