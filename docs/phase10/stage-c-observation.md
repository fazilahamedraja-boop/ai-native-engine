# Phase 10 - Stage C: structured observation

Status: complete. Stage D has not been started yet.

## Scope

Stage C adds a generic, read-only structured observation surface to the existing
Phase 9 harness pattern. It does not change the door fixture, add a new MCP
server, or replace the physics path.

The experiment has two parts:

- `fixtures/observation`: a small real-physics scene with a player capsule, a
  pressure plate, a gate, a beacon animation, a falling rigid-body crate, and one
  rigid-part humanoid asset plus a separate bone probe.
- `fixtures/observation/harness/bridge.gd`: a protocol-compatible bridge copy
  that adds the bounded `observe` command. The bridge is fixture-local in the
  same way the Phase 8/9 bridge copies are fixture-local; no shared runtime
  surface was introduced.

The controller additions are `HarnessSession.observe()` and
`HarnessSession.observeTimeline()`. Neither executes game-specific inspection
code; both ask the project bridge for the same bounded observation shape.

## Fixture

The scene is `fixtures/observation/main.tscn`, with one 60 Hz world and one
forward movement axis:

- player spawn `(0, 0.85, 5.5)`, plate at `(0, 0.10, -1.1)`, gate at
  `(0, 1.30, -2.5)`, goal line `z < -4.60`;
- the gate opens only while the plate is pressed; the correct fixture condition
  is `if plate_pressed == gate_open:`;
- the open gate moves to `y = 4.3` and its collision shape is disabled with a
  deferred write so the state change does not occur during a physics query;
- the crate starts at `(4.2, 3.0, 2.5)`, falls under real physics, and sleeps on
  the ground;
- the beacon has a real `AnimationPlayer` named `Pulse`;
- the humanoid is copied from `content/assets/character/humanoid-01.glb` and is
  loaded through `GLTFDocument` so the fixture does not depend on generated
  `.godot` import state.

The pressure plate was moved to `(0, 0.10, -1.1)` with size
`(1.8, 0.2, 2.2)` so the player remains on it while crossing the gate. The
earlier placement caused the gate to close before the player could reach it.

## Observation contract

`observe` accepts:

```text
targets: absolute /root/... paths, 1-32
properties: simple identifiers, 0-32
descendants: 0-3 levels, at most 256 descendant nodes
sinceTick: non-negative integer
```

Runtime data:

| Field | Source | Notes |
| --- | --- | --- |
| `tick`, `physics_frames` | measured | `Engine.get_physics_frames()` |
| `physics_ticks_per_second` | measured | 60 in this fixture |
| `sim_time_seconds` | derived | tick / physics ticks per second |
| `sim_time_seconds_source` | metadata | explicitly `derived` |
| `captured_at`, `unix_time`, `uptime_ms` | measured | UTC timestamp and process-relative time |
| `paused` | measured | whether the SceneTree is paused |
| `spaces`, `units` | metadata | parent/world spaces; metres, m/s, degrees, seconds |

Per target node:

| Area | Measured | Derived or unavailable |
| --- | --- | --- |
| identity | `path`, `name`, `class`, `process_mode`, `is_inside_tree`, `visible` | - |
| transforms | parent-relative `local_transform`, world `global_transform`, origin/quaternion/euler/scale | conversion between rotation representations is presentational, not gameplay state |
| character | `velocity`, `is_on_floor`, `is_on_wall`, `is_on_ceiling`, floor/wall normals, slide collisions | `derived.speed` and `derived.horizontal_speed` |
| rigid body | `linear_velocity`, `angular_velocity`, `mass`, `gravity_scale`, `sleeping`, `can_sleep` | `derived.speed` |
| collision | direct child `CollisionShape3D`/`CollisionPolygon3D`, class, disabled flag, parent/world transform, common dimensions | nested or generated shapes are not recursively searched |
| animation | direct/direct-child `AnimationPlayer` current/assigned animation, position, playing, speed | animation tracks and skeleton playback sampling are not inferred |
| skeleton | bone count, names, parents, parent-relative rest/pose, skeleton-space global pose, derived world pose, enabled flag | no rig repair, retargeting, or animation inference |
| events | optional `harness_events(since_tick)` items | `source: unavailable` when the method is absent; `invalid` when the return type is wrong |

The skeleton spaces are deliberately distinct:

- `rest` and `pose` use `space: "bone_parent"`;
- `global_pose` uses `space: "skeleton"` because Godot's
  `get_bone_global_pose()` is skeleton-relative;
- `derived_world_pose` is the skeleton global transform multiplied by the
  skeleton-space pose, labelled `source: "derived"`.

The imported humanoid glTF has no skin or bone hierarchy in this asset. Its 25
named parts are 22 `MeshInstance3D` nodes plus the `head`, `hand_l`, and `hand_r`
`Node3D` pivots. The separate four-bone `ProbeSkeleton` is an interface probe,
not a generated or skinned character skeleton. The probe's marker is visible to
a recursive observation but is not counted as part of the imported model.

Event records in this fixture now include both clocks:

```text
tick (Engine physics frame), tick_domain, sim_time_seconds,
simulation_step, simulation_time_seconds, wall_time_ms, sequence, type, source
```

The bridge preserves fixture event fields and marks the stream
`fixture_recorded`; it does not invent an event bus for games that do not
provide one.

## Evidence

Evidence directory:
`C:\Users\hacke\ai-native-engine-phase10\docs\phase10\stage-c\`

Final run:

```text
run_id: stage-c-80ab61ff-55d4-4c55-92c0-008b39819b28
Godot: 4.7.2-stable (official)
windowed: true
PID: 5016
started: 2026-10-21T14:44:32.814Z
finished: 2026-10-21T14:44:37.362Z
stop: exit 0, killed false
```

### Captures

| Checkpoint | Simulation step | Engine tick at state | Screenshot tick | State |
| --- | ---: | ---: | ---: | --- |
| `stage-c-initial.png` | 0 | 21 | 29 | plate false, gate closed, collision enabled, beacon red |
| `stage-c-open.png` | 90 | 137 | 145 | plate true, gate open, collision disabled, beacon green |

- `stage-c-initial.png`: 1280x720, 54,597 bytes, SHA-256
  `10d70530660e61bec3f5ef7385dd0b4ba8fb624a91dfe7d8c6a1f9d414e916d8`.
- `stage-c-open.png`: 1280x720, 64,299 bytes, SHA-256
  `3a82d43cfe2590102c89ecd53344362b780466938ac837476959b1700b76621a`.

The four compared semantic fields matched the paused state in both captures:
plate state, gate state, collision-enabled state, and beacon state. The
screenshot tick is later than the state tick because the paused capture waits
for viewport rendering; this is an engine-frame offset, not a simulation-step
change. The evidence records `engine_tick_delta` and `screenshot_tick_delta`
rather than claiming the clocks are identical.

Initial state hash:
`a7934e7944b1023eeaafc406eb4e196f37c634db01f1468bc3d7f46da1ecf113`.

Open state hash:
`24fca830b20e87c196b82ce32078054a556c99f045671213ade3b8146d25ce79`.

At the open state, structured observation measured:

- player position `(0, 0.85, -0.4999974668)`, velocity `(0, 0, -4)`,
  on floor, one slide collision against `/root/Main/Ground`;
- derived horizontal speed `4`;
- gate collision world origin `(0, 4.3000001907, -2.5)`, disabled `true`,
  `BoxShape3D` size `(4, 2.6, 0.3)`;
- beacon `Pulse` playing at position `1.5010583030`, speed scale `1`;
- crate sleeping, mass `1`, world origin `(4.2000055313, 0.3472249508,
  2.5000050068)`.

### Timeline

The timeline advanced 90 real physics frames in three chunks of 30, sampling
before the first chunk and after each chunk.

| Sample | Engine tick | Simulation step | Simulation time | Plate | Gate | Collision | Beacon |
| ---: | ---: | ---: | ---: | --- | --- | --- | --- |
| 0 | 39 | 0 (pre-advance; from reset) | 0 s | false | false | enabled | red |
| 1 | 71 | 30 | 0.5 s | false | false | enabled | red |
| 2 | 103 | 60 | 1.0 s | false | false | enabled | red |
| 3 | 135 | 90 | 1.5 s | true | true | disabled | green |

The engine tick increased by 32 per 30-frame chunk because paused observation
and sampling overhead still advances Godot's physics-frame counter. The
fixture simulation step increased by exactly 30. The timeline reports both
`engine_tick` and `simulation_step` and marks the distinction in its `timing`
metadata, so it does not mislabel engine overhead as simulated time.

Events were de-duplicated across samples and remained ordered:

| Sequence | Type | Engine tick | Simulation step | Simulation time |
| ---: | --- | ---: | ---: | ---: |
| 1 | `reset` | 37 | 0 | 0 s |
| 2 | `player_collision_start` | 41 | 1 | 0.0167 s |
| 3 | `crate_collision_start` | 89 | 46 | 0.7667 s |
| 4 | `plate_entered` | 124 | 79 | 1.3167 s |
| 5 | `gate_open` | 124 | 79 | 1.3167 s |

`plate_entered` and `gate_open` share a simulation step because the gate state
update is part of the same physics step as plate entry. The event `tick` is the
engine-frame clock; `simulation_step` is the fixed-step gameplay clock.

### Humanoid inspection

`stage-c-humanoid.json` records one model and one separate skeleton probe:

- model `Humanoid`: 25 named parts, 22 `MeshInstance3D` nodes;
- no skin, `Skeleton3D`, or bone hierarchy from the imported glTF;
- `ProbeSkeleton`: 4 bones `root`, `spine`, `chest`, `head`;
- skeleton global transform `(-3.2, 0, 1)`;
- every bone has parent-relative rest/pose, skeleton-space global pose, and a
  derived world pose; the head's derived world Y is `1.1`;
- the probe marker is present but is not counted as an imported model mesh.

This verifies reliable inspection of one humanoid-shaped asset while keeping
the rigid model, the separate skeleton, animation, physics, and collision
representations distinct. It does not claim character intelligence or a
skinned character rig.

### Door reuse

`stage-c-door-reuse.json` observes a temporary copy of the Phase 9 door scene.
Only the temporary copy's `harness/bridge.gd` was replaced with the observation
bridge. The scene and scripts were hashed before and after and remained
unchanged:

```text
main.tscn unchanged: true
scripts/door_world.gd unchanged: true
scripts/door_player.gd unchanged: true
```

Observed values: `key_available=true`, door `locked=true`, `open=false`,
`collision_enabled=true`, `open_count=0`, player on floor, door shape
`BoxShape3D`, disabled `false`. This is evidence that the observation shape is
not tied to the observation fixture's node names or game logic.

## Acceptance criteria

| Criterion | Result |
| --- | --- |
| Capture observations from a real running game, not a mocked scene | Pass: windowed Godot run, real fixed physics, real screenshots |
| Expose identity/type and parent/world transforms | Pass: measured, labelled spaces |
| Expose velocity and grounded/collision state | Pass: CharacterBody3D and RigidBody3D paths |
| Expose collision shapes and disabled state | Pass: plate/gate/crate/door shapes |
| Expose animation state | Pass: beacon AnimationPlayer |
| Expose events with order and timing | Pass: 5 fixture events with sequence, engine tick, simulation step |
| Expose tick/time and capture timestamps | Pass: runtime, capture, timeline, and event clocks |
| Distinguish measured, derived, and unavailable data | Pass: source labels, `derived` blocks, `unavailable` fallback |
| Inspect one humanoid asset without conflating rigs | Pass: 22 model meshes, separate 4-bone probe |
| Reuse the observation surface on an unchanged scene | Pass: door copy with only the temporary bridge replaced |
| Preserve the Phase 9 fixture and evidence | Pass: door source hashes unchanged; no Phase 9 file edited |

## Commands and results

Focused controller tests:

```powershell
node --test tests/observation.test.mjs
```

Result: 5/5 tests passed, exit 0. Coverage: validation, live structured
observation, humanoid/skeleton spaces, timeline sampling and event
de-duplication, and unmodified door reuse.

Observation fixture suite:

```powershell
node controller/harness.mjs test --project fixtures/observation `
  --script res://tests/run_observation.gd --timeout-ms 30000
```

Result: 8/8 cases passed, exit 0, no parsed Godot errors.

Evidence generation:

```powershell
npm run evidence:observation
```

Result: exit 0, stop exit 0, two screenshots, initial/open observations,
timeline, humanoid inspection, and door reuse written under
`docs/phase10/stage-c/`.

The normal headless gate was subsequently extended to include
`tests/observation.test.mjs`; its full result is recorded in the Phase 10 final
report.

## Limits and stopping conditions

- Screenshots are paused viewport captures, not live video understanding. The
  screenshot path waits for rendering and can advance engine ticks; semantic
  comparison is done against the recorded paused state, and tick deltas are
  kept.
- Engine `tick` and fixture `simulation_step` are separate clocks. Consumers
  must use the field appropriate to their question.
- Event streams are fixture-defined. The bridge can report `unavailable` or
  `invalid`; it cannot discover events a game never records.
- Collision, animation, and child-skeleton discovery is limited to direct
  children (and direct-child animation players). Deep generated hierarchies are
  outside this stage.
- Requested properties are shallow reads and are bounded; they are not an
  arbitrary script or expression surface.
- The imported humanoid has rigid meshes and no skin. The four-bone probe is
  not a general skeleton, animation, or character controller.
- This fixture is a small closed scene. Its state hashes are diagnostic and do
  not establish general physics determinism, consistent with the Phase 9 Stage E
  limit.
- Character intelligence remains design-only.

Stage C stops here: the observation data, tests, evidence, and documentation
exist. Stage D will use one controlled defect in a copy of this fixture to
correlate visual and structured evidence, diagnose, repair, and rerun the same
acceptance test. No merge or push is part of this stage.
