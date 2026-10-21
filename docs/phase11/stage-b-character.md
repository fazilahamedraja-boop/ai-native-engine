# Phase 11 — Stage B: existing humanoid and skeleton inspection

Status: **complete**. Evidence was produced through the current harness
`HarnessSession` and the copied Phase 10 observation bridge. No skeleton was
authored for this stage.

## Asset reality first

The repository's two humanoids were inspected at the source GLB level and
through Godot's importer:

| Asset | Nodes | Meshes | Skins | Animations | Meaning |
| --- | ---: | ---: | ---: | ---: | --- |
| `content/assets/character/humanoid-01.glb` | 26 | 22 | **0** | **0** | Rigid part hierarchy; named parts such as `head`, `chest`, `hand_r`; no bind pose or bones |
| `content/assets/character/placeholder-character.glb` | 9 | 6 | **0** | **0** | Also rigid; no skeleton or clip |
| Test-only `CesiumMan.glb` | 22 | 1 | **1** (19 joints) | **1** (57 channels) | Pre-existing CC-BY-4.0 glTF sample used only to exercise the real Godot skin/animation path |

Source evidence: `stage-b-source-assets.json` (sha256, node names, skin joint
names, animation channels). The project humanoid's missing rig is **missing
asset data**, not an engine failure. No skeleton was generated to conceal it.

## What was inspected

Fixture: `experiments/godot-harness/fixtures/character-audit`. It loads both
the unchanged project humanoid and the test-only skinned sample at runtime with
`GLTFDocument`, then uses the same bridge contract as Phase 10.

The live skeleton path is:

```text
/root/Main/CesiumMan/Z_UP/Armature/Skeleton3D
```

The animation path is:

```text
/root/Main/CesiumMan/AnimationPlayer
```

### Skeleton identity and hierarchy

- Skeleton node: `Skeleton3D`, bone count **19**, all 19 enabled.
- Root bone: index `0`, `Skeleton_torso_joint_1`, parent `-1`.
- Parent indices are valid for every bone; no cycles were observed by the
  test's parent-range check.
- Bone names come from the imported asset. They are **not** a semantic humanoid
  map; names such as `Skeleton_arm_joint_R__2_` identify an arm chain but there
  is no project contract that says “right hand”, “weapon socket”, or “head”.

Hierarchy measured from the observation:

```text
Skeleton_torso_joint_1 (0, root)
├─ leg_joint_R_1 (1) → leg_joint_R_2 (2) → leg_joint_R_3 (3) → leg_joint_R_5 (4)
├─ leg_joint_L_1 (5) → leg_joint_L_2 (6) → leg_joint_L_3 (7) → leg_joint_L_5 (8)
└─ Skeleton_torso_joint_2 (9)
   └─ torso_joint_3 (10)
      ├─ Skeleton_arm_joint_R (11) → Skeleton_arm_joint_R__2_ (12) → Skeleton_arm_joint_R__3_ (13)
      ├─ Skeleton_arm_joint_L__4_ (14) → Skeleton_arm_joint_L__3_ (15) → Skeleton_arm_joint_L__2_ (16)
      └─ Skeleton_neck_joint_1 (17) → Skeleton_neck_joint_2 (18)
```

### Coordinate spaces

The harness reports each transform with an explicit space, and marks derived
values instead of presenting them as measurements:

| Value | Space | Source |
| --- | --- | --- |
| `rest` | `bone_parent` | measured |
| `pose` | `bone_parent` | measured |
| `global_pose` | `skeleton` | measured |
| `derived_world_pose` | `world` | derived: `skeleton.global_transform * global_pose` |
| Skeleton node transform | `world` | measured |

The skeleton node's measured world transform in the captured run had origin
`[0, 0, 0]`, quaternion `[0.5, 0.5, 0.5, -0.5]` (Euler approximately
`[-90, -90, 0]` degrees), and uniform scale `1.35`. The unusual orientation is
the imported `Z_UP` armature correction, not a character-facing assumption.

A concrete chain check from `stage-b-test.json`:

```text
bone 17 = Skeleton_neck_joint_1
rest origin (parent-relative)   = [-0.000002366, 0.000002414, 0.064836]
global pose (skeleton-relative) = [0.048129, -0.022040, 1.143364]
derived world origin            = [-0.029754, 1.543541, 0.064974]
```

The world value is not the same as either the rest or skeleton-relative value;
the fixture computes it explicitly and labels it derived.

### Animation state and evaluated pose

At fixed step 3, `AnimationPlayer` was playing `Animation` at `0.044389 s`.
After 24 real fixed physics ticks (step 27), it was at `0.443719 s` and still
playing. The test also sampled a reset run at `0.008502 s` → `0.415357 s`.
Bone pose signatures differed before/after, so this is not just a timer
advancing: the evaluated `Skeleton3D` pose changed.

The later observation is taken after the fixed tick completes. It therefore
answers “what was the final evaluated bone transform after this tick?” It does
not prove where in an animation callback the value was written.

Visual evidence:

- `stage-b-initial.png` — step 3, `0.044389 s`
- `stage-b-later.png` — step 27, `0.443719 s`
- `stage-b-walk-000.png` … `stage-b-walk-003.png` — four sampled walk frames,
  each with a recorded tick and state hash in `stage-b-manifest.json`

### Physics and collision

Neither character asset contains a `CharacterBody3D`, `RigidBody3D`, or
`CollisionShape3D`. The fixture's ground is a separate `StaticBody3D`; it is
not part of either character. The skeleton observation therefore describes
visual/rig transforms only. There is no character collider, hitbox, or contact
event to inspect in this stage.

This is a data/authoring gap for gameplay, not an observation limitation:
Godot and the bridge can inspect collision shapes when a fixture supplies them.
Stage C supplies a real target and hitbox, and records actual overlap events.

## Checks

Command:

```powershell
node controller/harness.mjs test --project fixtures/character-audit `
  --script res://tests/run_character_audit.gd --timeout-ms 30000 --json
```

Result (saved as `stage-b-test.json`):

```text
passed 4 / failed 0
PASS character-rigid-humanoid       meshes=22, skeleton=null, animation=null
PASS character-skinned-skeleton     bones=19, parent indices valid, Animation playing
PASS character-animation-advances   position 0.008502 -> 0.415357, poses changed
PASS character-bone-spaces          rest/global/world values distinct
```

## Missing vs unsupported

- **Missing:** project character skins, bones, clips, bind poses, semantic bone
  aliases, and character collision. The project humanoid cannot provide a
  meaningful final bone pose because it has no bones.
- **Unsupported by the current harness:** automatic nested skeleton discovery,
  `AnimationTree` state, bone attachment resolution, and character-collision
  event capture. Stage B uses an explicit skeleton path, a plain
  `AnimationPlayer`, and no character collider.
- **Not inferred:** the test-only sample's bone names were not promoted into a
  general humanoid semantic map. Any future character work must add that mapping
  explicitly or verify it per asset.

## Artifacts

- `docs/phase11/stage-b/stage-b-manifest.json` — run id, ticks, screenshot
  hashes, sequence states, assertions
- `docs/phase11/stage-b/stage-b-initial.json`, `stage-b-later.json` — raw
  bounded observations (including all 19 bones)
- `docs/phase11/stage-b/stage-b-source-assets.json` — GLB source inventory
- `docs/phase11/stage-b/stage-b-test.json` — acceptance test result
- `docs/phase11/stage-b/README.md` — asset attribution and fixture commands
