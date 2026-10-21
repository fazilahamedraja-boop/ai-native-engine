# Phase 11 — Stage A: capability inventory

Status: **complete** (runtime audit `stage-a-audit.json`, native API probe
`stage-a-native-api.json`). This stage only inventories observation capability;
it does not add a new observer or an alternate Godot interface.

## Evidence labels

Every row below distinguishes four things that are easy to conflate:

- **Native**: a Godot 4.7 API/class/property that exists in this build. Presence
  is checked with `ClassDB` (`stage-a-native-api.json`); it is not proof that the
  behavior is useful to an agent.
- **Harness**: the existing project-local controller/bridge path that exposes
  the behavior. Citations are `file:line`.
- **Runtime**: exercised against a live fixture in this Phase 11 worktree.
- **Gap**: either *missing asset/data* (the engine/harness can inspect it, but
  this project has no such data) or *unsupported surface* (the harness has no
  operation for it). These are not the same claim.

Godot version measured: `4.7.2-stable (official)`.

## Matrix

| Capability | Native Godot | Existing harness | Direct evidence | Classification / gap |
| --- | --- | --- | --- | --- |
| Scene discovery and tree | `Node.get_children`, `Node.get_path`, `Node.get_class`, `Node.find_children`, `SceneTree.get_nodes_in_group` | `inspectState()` returns a tree; `sceneTree()` returns the raw tree; `observe(targets, descendants)` returns explicit node paths (`harness.mjs:900-917`, bridge `_observe_reply` at `bridge.gd:364`) | `stage-a-audit.json`: 48 scene nodes, max depth 7; targets include `/root/Main`, `CesiumMan`, `Humanoid`, `Ground` | **Supported**, but bounded: `descendants` is limited to 0–3 and 256 descendants (`bridge.gd:377-390`, `MAX_OBSERVE_DESCENDANTS`). Paths are explicit; there is no semantic search. |
| Node properties and local/world transforms | `Object.get`, `Object.get_property_list`, `Node3D.global_transform` / `transform` | `property(nodePath, property)`; `observe` includes measured `local_transform` and `global_transform` with origins, Euler/quaternion, scale (`bridge.gd:475-501`) | `stage-a-audit.json`: `AnimationPlayer.current_animation == "Animation"`, `Main.name == "Main"`; Stage B observations contain both spaces for every target | **Supported** for readable properties and transforms. Property writes are not exposed. Derived values are labelled `source: "derived"` rather than silently mixed with measured values. |
| Skeleton identity and bone hierarchy | `Skeleton3D.get_bone_count/name/parent/rest/pose/global_pose`, `is_bone_enabled`; `BoneAttachment3D` is a separate native node | `observe` on an explicit `Skeleton3D` returns all bones up to 128, parent indices, rest and pose transforms, skeleton-relative global poses, and derived world poses (`bridge.gd:575-648`) | Stage B: CesiumMan test-only sample has 19 bones; `Skeleton_torso_joint_1` is root; all parent indices valid; humanoid-01 has **0** skeletons | **Supported on a real skinned asset**, but the repository's only humanoid is **missing rig data** (0 skins in the GLB). The harness does not discover a nested skeleton automatically; the caller must target it. |
| Bone coordinate spaces and final pose | `get_bone_rest`/`get_bone_pose` are parent-relative; `get_bone_global_pose` is skeleton-relative; world pose requires `Skeleton3D.global_transform * global_pose` | Same decomposition, each field explicitly tagged `bone_parent`, `skeleton`, or `world`; world pose tagged `source: "derived"` (`bridge.gd:611-631`) | Stage B test `character-bone-spaces`: rest origin `[-0.000002, 0.000002, 0.064836]`, global pose `[0.047369, -0.022192, 1.141827]`, derived world `[-0.029959, 1.541466, 0.063948]` | **Supported and measured** for the sample rig. The humanoid's missing rig means no bone-space claim can be made for it. |
| Animation playback | `AnimationPlayer.play/stop/seek/is_playing/current_animation/current_animation_position/get_animation_list` | `observe` reports a target or direct-child `AnimationPlayer` (`bridge.gd:575-599`); fixture-specific `snapshot()` also exposes its own state | Stage B: initial 0.044389 s at step 3; later 0.443719 s at step 27; `is_playing == true`; 4/4 checks | **Supported** for `AnimationPlayer`. The observation is a post-tick value, not a callback inside the animation update. |
| Final evaluated bone pose after a tick | Godot updates the `Skeleton3D` pose during process/physics; `get_bone_global_pose` returns the evaluated pose | `observe` after `advancePhysics()` sees the post-tick state | Stage B: bone signature changed after 24 real fixed physics frames; `character-animation-advances` passes | **Supported at fixed-tick boundaries.** There is no operation to pause *inside* a bone evaluation or record every sub-tick update. |
| `AnimationTree` / state-machine blending | `AnimationTree` class and tree methods exist (`ClassDB` probe true) | None. `observe` only knows `AnimationPlayer` (`bridge.gd:575-584`); no fixture uses `AnimationTree` | `stage-a-native-api.json`; no runtime observation | **Unsupported surface**, not an engine gap. No existing character uses it, so Phase 11 did not add a speculative bridge for it. |
| Physics bodies and collision shapes | `CharacterBody3D`, `RigidBody3D`, `Area3D`, `CollisionShape3D`; `get_slide_collision*`, shape resources | `observe` adds `character`, `rigid_body`, and direct-child `collision_shapes` with shape type/dimensions and world transforms (`bridge.gd:503-573`) | Phase 10 observation fixture and Stage C combat fixture; Stage B reports no asset collision | **Supported for direct children.** Shapes must be direct children of the observed collision object (`bridge.gd:548-552`); deeper/nested shapes are not discovered. |
| Collision/event history | `Area3D.body_entered`, `RigidBody3D` contact monitoring, engine signals | Event history is **fixture-recorded** via `harness_events(since_tick)` (`bridge.gd:650-683`), not a generic engine event stream | Stage C records overlap enter/exit/attack events; Stage A reports the fixture event source | **Unsupported generic surface.** The harness can only report events the fixture chose to record. It does not install engine signal listeners generically. |
| Arbitrary physics-space queries | `PhysicsDirectSpaceState3D.intersect_shape/ray/point` (ClassDB true) | No controller or bridge operation; no query fixture | `stage-a-native-api.json` only | **Genuine harness gap** for diagnosis that needs “what is at this transform?” without a fixture-maintained overlap list. Stage C works around it with `Area3D.get_overlapping_bodies()` in fixture state. |
| Input control and input history | `Input.parse_input_event`, `Input.is_action_pressed` (ClassDB true) | `set_input()` / `advancePhysics({input})` drive the fixture's own `set_harness_input`; no native event injection and no generic event history | Stage A sees the bridge's `set_input`; Phase 10/Stage C fixtures publish their own input state | **Partial/supported for fixtures**, **not a generic input surface**. The agent can drive a fixture only through its declared input contract. |
| Single-frame visual capture | `Viewport.get_texture().get_image().save_png`; headless renderer has no window texture | `screenshot()` / `captureFrame()`; rejects headless with `SCREENSHOT_UNAVAILABLE_HEADLESS` (`bridge.gd:324-360`) | Stage B initial/later/walk PNGs; hashes match bridge results | **Supported**, windowed only. Stage A itself ran headless, so screenshots are proven in Stage B. |
| Sampled sequence / “recording” | Godot `MovieWriter`/Movie Maker exists; `ClassDB` probe found the class but not the expected methods | `captureSequence()` samples real frames after fixed ticks and saves PNGs (`harness.mjs:635-706`) | Stage B: four walk frames, each with tick, step, state, and hash | **Partial.** No real-time/video/audio recording surface. Sample cadence is explicit; interpolation between samples is not captured. |
| Debug collision overlay | `SceneTree.debug_collisions_hint` property exists (`ClassDB` true) | No setter in bridge/controller | `stage-a-native-api.json` | **Unsupported surface.** Phase 11 did not silently turn on engine debug rendering or claim that an overlay is part of the evidence. |
| Test execution | Godot script runner via harness | `runTests()` / `harness.mjs test`; parses `RESULT passed/failed` | `stage-a-audit.json`: character-audit 4 passed, 0 failed; baseline Phase 10 suite 27/27 (preflight) | **Supported.** A test can pass while the visual output is wrong; Stage C therefore couples identical tests with captures. |
| Existing project humanoid rig | glTF importer would expose skins/bones if present | Generic `Skeleton3D` observation is available | Binary/GLB parse and Stage B: `humanoid-01.glb` = 22 meshes, 0 skins, 0 animations; `placeholder-character.glb` = 6 meshes, 0 skins, 0 animations | **Missing asset data.** Not an engine or harness limitation. No skeleton was generated to hide this. |

## What was directly tested

Commands and artifacts:

```text
node controller/capability-audit.mjs
  -> 48 scene nodes, 19 observed bones, 4 timeline samples
  -> character-audit tests 4/4
  -> docs/phase11/stage-a/stage-a-audit.json
  -> docs/phase11/stage-a/stage-a-runtime.json

godot --headless --path fixtures/character-audit -s res://tests/native_api.gd
  -> docs/phase11/stage-a/stage-a-native-api.json
```

The runtime probe exercised `inspectState`, `property`, `observe`,
`observeTimeline`, `runTests`, and actual `advancePhysics`/`physics_frame`
sampling. It did **not** exercise windowed capture, generic collision events,
native input injection, `AnimationTree`, physics queries, debug overlay, or
`MovieWriter`.

## Missing vs unsupported

**Missing project data**

- No project humanoid has a skin, skeleton, or animation. The two GLBs were
  parsed directly; `humanoid-01` has 26 nodes / 22 meshes / 0 skins / 0
  animations, and `placeholder-character` has 9 nodes / 6 meshes / 0 skins / 0
  animations.
- No semantic bone mapping (which bone is the right hand, head, weapon socket)
  exists for any asset. The rigid humanoid has part names and asset sockets, but
  the sample rig's bone names are importer names such as
  `Skeleton_arm_joint_R__2_`.

**Unsupported by the current harness**

- Generic engine collision event capture; fixture events are the only source.
- Physics-space queries (shape/ray/point) at arbitrary world transforms.
- `AnimationTree`/state-machine inspection and blend state.
- Native input event injection/history and pointer/keyboard event streams.
- Debug collision/render overlay control.
- Real-time video/audio recording; sampled PNGs only.
- Writes to arbitrary properties or skeleton poses; observation is read-only.
- Automatic discovery of nested skeletons and nested collision shapes; explicit
  paths/direct children are required.

## Reuse decision

No new observation framework was added. The existing `HarnessSession` and the
observation protocol cover the Stage B/C facts that were needed. The new
fixtures use the same bridge contract and add only character/combat state.
Stage A does not justify a generalized “AI character API”; it identifies
specific missing data and a small set of bounded query gaps.

## Sources

- Local bridge: `experiments/godot-harness/fixtures/observation/harness/bridge.gd`
- Local controller: `experiments/godot-harness/controller/harness.mjs`
- Stage A runtime: `docs/phase11/stage-a/stage-a-audit.json`,
  `docs/phase11/stage-a/stage-a-runtime.json`
- Native API inventory: `docs/phase11/stage-a/stage-a-native-api.json`
- Godot class references: [Skeleton3D](https://docs.godotengine.org/en/stable/classes/class_skeleton3d.html),
  [AnimationPlayer](https://docs.godotengine.org/en/stable/classes/class_animationplayer.html),
  [AnimationTree](https://docs.godotengine.org/en/stable/classes/class_animationtree.html),
  [PhysicsDirectSpaceState3D](https://docs.godotengine.org/en/stable/classes/class_physicsdirectspacestate3d.html)
