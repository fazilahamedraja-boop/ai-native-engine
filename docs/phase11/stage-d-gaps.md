# Phase 11 — Stage D: gap report and the smallest useful next task

Status: **complete**. This document closes Phase 11. It states what is now proven, what is still
missing, and it recommends exactly one next engineering task — it does not implement it.

- Worktree: `C:\Users\<user>\ai-native-engine-phase11` (branch `experiment/phase11-audit`, base `e72ba64`)
- Dashboard: <http://127.0.0.1:8111/phase11/> (static, served from `docs/`)
- Stage documents: [`stage-a-capabilities.md`](stage-a-capabilities.md) ·
  [`stage-b-character.md`](stage-b-character.md) ·
  [`stage-c-diagnosis.md`](stage-c-diagnosis.md)

---

## 1. What Phase 11 established

| Stage | Claim | Primary evidence |
| --- | --- | --- |
| A | The existing harness already observes scene tree, properties, transforms, `Skeleton3D` bones and poses, `AnimationPlayer` state, collision bodies and direct-child shapes, plus fixed-tick time advance and windowed PNG capture. | `stage-a/stage-a-audit.json`, `stage-a/stage-a-runtime.json`, `stage-a/stage-a-native-api.json` |
| B | On a real skinned asset the harness reports bone identity, parent hierarchy, rest/pose/world spaces, and post-tick pose change. The project's own humanoids have **no rig at all** — that is missing data, not a missing capability. | `stage-b/stage-b-manifest.json`, `stage-b/*.png`, Stage B tests 4/4 |
| C | A one-line defect in a character/combat fixture was diagnosed from captured evidence alone (structured events + screenshots), repaired with a single constant, and proven by the byte-identical test (`sha256 93cbb7d5…e88ed2`) going 1/3 → 3/3 with `hits 0 → 1` and `HP 3/3 → 2/3`. An independent blind pass over the "before" bundle reached the same root cause and the same minimal fix without seeing the source. | `stage-c/` bundle, `stage-c-diagnosis.md`, `stage-c/blind-diagnosis.md` |

### 1.1 The independent blind pass

`docs/phase11/stage-c/blind-diagnosis.md` was produced by a separate agent that was given **only**
the "before" bundle (manifest, observation, snapshot, test output, PNGs) and was explicitly barred
from reading the fixture source, the "after" bundle, the repair diff, or any prior Phase 11
document. It reached the same conclusion independently:

> root cause: the hitbox `Area3D` is anchored 0.42 m behind the blade centre (local z 0.18 vs
> 0.60), so the hit volume never reaches the target capsule (≈0.20 m of clear space at the closest
> approach over the whole swing); minimal fix: set that local z back to 0.60.

It also produced the most useful finding of the whole phase: it **could not rule a collision
layer/mask mismatch in or out**, because the harness's `observe` output does not publish
`collision_layer` / `collision_mask` for observed collision objects. That is now gap §2.2 and it
is folded into the recommended task.

Phase 11 added **no new observation framework**. The new fixtures use the existing bridge
contract; the only new code is fixtures, runners, and evidence.

---

## 2. Genuine gaps

Each gap is classified, because three different things get called "a gap" and they need different
fixes.

- **Missing data** — the engine and the harness can inspect it; *this project* has no such data.
- **Unsupported surface** — the engine can do it; *the harness* has no operation for it.
- **Unproven** — the harness appears to cover it, but this phase did not exercise it.

### 2.1 Missing project data (content, not tooling)

| Gap | Evidence | Consequence |
| --- | --- | --- |
| No rigged humanoid | `humanoid-01.glb` = 26 nodes / 22 meshes / **0 skins** / **0 animations**; `placeholder-character.glb` = 9 / 6 / 0 / 0 (direct GLB parse) | No bone-, pose-, or animation-level claim can be made about any project character. Stage B's 19-bone result belongs to the CC-BY-4.0 `CesiumMan.glb` test sample only. |
| No animation clips | same parse; `AnimationPlayer` in the sample lists exactly one clip (`Animation`) | Animation *observation* is proven; animation *content* in the project does not exist. |
| No semantic bone mapping | sample bone names are importer names (`Skeleton_arm_joint_R__2_`); the rigid humanoid has part names and asset sockets only | An agent cannot ask "where is the right hand / weapon socket" in rig space. Stage C had to attach the weapon to the **rigid** `hand_r` node instead. |
| No combat target or enemy in the product | Stage C target exists only in `fixtures/combat/` | The audit proves a *method*, not a shipped feature. |

### 2.2 Unsupported harness surface (tooling)

| Gap | Evidence | Impact on an agent |
| --- | --- | --- |
| **No arbitrary physics-space queries** (`PhysicsDirectSpaceState3D.intersect_shape/ray/point`) | ClassDB confirms the class and methods; no controller or bridge operation exists. Stage C had to write a bespoke `tests/probe_collision.gd` to ask "what is at this transform?" | **Highest impact.** "No overlap" is ambiguous: no geometry, or a suppressed/stale query? Stage C §2.1 lost real time to exactly this. |
| **Collision layer/mask are not published by `observe`** | The Stage C blind diagnosis (§4, alternative 2) could not rule a layer/mask mismatch in or out from the capture: `observe` reports `collision_shapes` (shape class, dimensions, transforms, `disabled`) but no `collision_layer` / `collision_mask` / `monitoring` / `monitorable` for the body itself. | A latent mask bug cannot be excluded from evidence alone. Cheap to fix, and it is exactly the kind of fact a diagnosis needs. |
| No generic engine collision/event stream | Event history is fixture-recorded via `harness_events(since_tick)` (`bridge.gd:650-683`) | An agent can only see events a fixture chose to publish. |
| No `AnimationTree` / state-machine inspection | `observe` knows `AnimationPlayer` only (`bridge.gd:575-584`) | Blending and state transitions are invisible. No fixture uses `AnimationTree` yet, so adding it now would be speculative surface. |
| No native input injection / input event history | `set_input()` drives each fixture's declared contract | An agent can drive a fixture but cannot inject raw key/mouse events or read engine input state. |
| No debug collision / render overlay control | `SceneTree.debug_collisions_hint` exists in `ClassDB`; no setter | Visual debugging is a human convenience, not a machine-readable fact; turning it on would also change capture pixels and hashes. |
| No video/audio recording | Only sampled PNGs with hashes (`captureSequence`) | No time-continuous evidence; interpolation between samples is unobserved. |
| Read-only observation | No property writes, no skeleton-pose writes | The agent diagnoses; a human or script applies the fix. (Deliberate, and it kept this phase safe.) |
| Explicit paths / direct children only | `descendants` capped 0–3 and 256 descendants (`bridge.gd:377-390`); collision shapes must be direct children (`bridge.gd:548-552`) | Nested skeletons or shapes are not auto-discovered; the caller must know the path. |

### 2.3 Engine behaviour that is not in the documentation and cost real time

| Finding | Evidence | Why it matters to an agent |
| --- | --- | --- |
| `Area3D.monitorable = false` also suppresses **that area's own** `get_overlapping_bodies()` result, even though the docs describe `monitorable` as controlling whether *other* areas can detect it. | Stage C §2.1: a fresh `Area3D` at the same transform overlapped the target; the fixture's area did not; flipping `monitorable` to `true` fixed it. | A doc-only agent would have concluded "the target has no collider". It does. |
| An area's overlap list lags its own `body_entered` signal by one physics step. | Stage C §6.1: `hitbox_body_entered` at step 5, first `_check_hit` observing the overlap at step 6. | Frame-accurate "did it hit" assertions must tolerate a one-step lag, or they will read as flaky. |

### 2.4 Unproven (not gaps — simply not exercised)

- Bone evaluation *inside* a tick, or between sub-steps.
- Multi-character scenes, or any scene with more than one rig.
- Attaching a weapon to a **skinned** bone (Stage C attached to a rigid node).
- Determinism across machines / GPU drivers (all evidence came from one machine, one Godot build:
  `4.7.2-stable official`).
- Behaviour at scale (scene size, draw cost, capture latency under load).

---

## 3. Recommended next engineering task (one task)

> **Add a read-only physics-space query operation to the harness observation contract:**
> a `physicsQuery` action on the existing bridge (and a thin controller wrapper) that runs
> `PhysicsDirectSpaceState3D.intersect_shape` / `intersect_ray` / `intersect_point` at a supplied
> world transform and returns the colliders it hits.

**Why this one, and not something else**

1. **It is the gap that actually blocked this phase.** Stage C could not distinguish "the hitbox
   volume does not reach the target" from "the overlap query is not reporting" without writing a
   throwaway probe script (`fixtures/combat/tests/probe_collision.gd`). An agent working on a real
   project would hit the same wall immediately.
2. **It removes a fixture dependency from a measurement.** Right now "is the target in the
   hitbox?" is answered by the *fixture* (`hitbox.get_overlapping_bodies()` inside
   `combat_world.gd`). With a physics-space query, the harness itself can answer it against any
   scene, including the real project. That is the difference between a supported surface and an
   unsupported one, and it makes future findings engine-level instead of fixture-level.
3. **It is bounded.** One bridge action (~40–60 lines), one controller method (~20 lines), one
   node test, one live-fixture assertion. No new fixture, no new dependency, no engine-wide
   framework, no change to the existing observation contract for other actions.
4. **It is read-only and additive**, so the existing Phase 10 observation suite keeps passing
   unchanged.
5. **It does not need a rig.** It is useful today, against the current rigid project assets.

**Definition of done**

- `bridge.gd` gains one action that returns, for a given shape (box/sphere/capsule) or ray and a
  world transform: the collider paths, collider types, shape index, and the contact point/normal
  where available — all tagged with the same `source: "derived"` vs measured discipline the current
  bridge uses.
- As part of the same bridge change, `observe` publishes `collision_layer`, `collision_mask`,
  `monitoring` and `monitorable` for every observed collision object. This is a handful of lines
  and it closes the one blind spot the Stage C blind diagnosis could not rule out.
- `harness.mjs` exposes it as one method with the same shape as the existing observation calls.
- One `node --test` case asserts the request/response contract against a controlled fixture.
- One live assertion against `fixtures/combat` reproduces the Stage C question directly:
  "does the hitbox volume overlap the target capsule?" — answered by the harness, not the fixture.
- `docs/project-state.md` records the new operation in the harness capability list.

**Explicitly out of scope for that task:** changing any gameplay behaviour, adding an enemy AI, and
anything that writes to the scene.

---

## 4. Alternatives that were considered and rejected for now

| Candidate | Why not now |
| --- | --- |
| `AnimationTree` / state-machine inspection | No `AnimationTree` exists in the project or in any fixture; adding the surface before a consumer exists is speculative. Revisit when a rigged character with blending is actually in the project. |
| Debug collision overlay toggle | Produces pixels, not facts; it changes capture hashes and is not machine-readable. Cheap to add later if humans need it. |
| Generic engine collision/event capture | Larger and riskier than the physics query (it means installing listeners on arbitrary nodes); the physics query removes most of the diagnostic need. Fixture-recorded events already cover the current use. |
| Native input event injection | The harness already drives fixtures deterministically through their declared input contract; raw event injection is not needed for evidence. |
| `MovieWriter` video recording | Sampled PNGs with hashes are sufficient for regression evidence; video is not needed to close the current gaps. |
| Importing / building a rigged humanoid | Content work, not audit work, and explicitly out of scope for this phase (no user request). |
| **Character intelligence** (targeting, behaviour trees, navigation, weapon AI) | **Explicitly excluded by the phase brief and not justified by the evidence.** Nothing in Stages A–C shows the project needs autonomous characters; the project has no rig, no clips, and no enemy. The measurement gap (physics queries) is the bottleneck, not behaviour. Do not start this before the query task and before there is a rigged character to drive. |

---

## 5. What Phase 11 did **not** establish (non-claims)

- It did **not** show that Godot can inspect the project's humanoid rig — there is no project rig.
- It did **not** add gameplay, an enemy, combat logic to the product, or any AI behaviour.
- It did **not** prove the harness can diagnose arbitrary bugs; it proved the method on one
  controlled defect.
- It did **not** merge, push, retag, reset or rebase anything; Phase 8–10 fixtures, tests, evidence
  and refs are byte-unchanged (`git status` in the Phase 11 worktree shows only new, untracked
  Phase 11 paths — no modified pre-existing file).
- It did **not** weaken any existing test. The Phase 10 suites were re-run unchanged as a
  preflight and again as a final check.

---

## 6. Evidence index

| Artefact | Path |
| --- | --- |
| Stage A capability matrix | `docs/phase11/stage-a-capabilities.md` |
| Stage A runtime + native API | `docs/phase11/stage-a/stage-a-audit.json`, `stage-a-runtime.json`, `stage-a-native-api.json` |
| Stage B findings | `docs/phase11/stage-b-character.md` |
| Stage B captures + manifest | `docs/phase11/stage-b/` |
| Stage C diagnosis | `docs/phase11/stage-c-diagnosis.md` |
| Stage C independent blind diagnosis | `docs/phase11/stage-c/blind-diagnosis.md` |
| Stage C before/after bundles | `docs/phase11/stage-c/before/`, `docs/phase11/stage-c/after/` |
| Stage C one-line repair | `docs/phase11/stage-c/repair.diff` |
| Live dashboard | `docs/phase11/index.html` → <http://127.0.0.1:8111/phase11/> |
| Fixture (combat) | `experiments/godot-harness/fixtures/combat/` |
| Fixture (character audit) | `experiments/godot-harness/fixtures/character-audit/` |
| Runners | `experiments/godot-harness/controller/{capability-audit,character-inspection,glb-inventory,combat-defect}.mjs` |

## 7. Reproduce Phase 11

```powershell
cd C:\Users\<user>\ai-native-engine-phase11\experiments\godot-harness

node controller/capability-audit.mjs                       # Stage A
node controller/character-inspection.mjs                    # Stage B (windowed captures)
node controller/glb-inventory.mjs                           # source asset inventory
node controller/harness.mjs test --project fixtures/character-audit --script res://tests/run_character_audit.gd --json
node controller/harness.mjs test --project fixtures/combat --script res://tests/run_combat.gd --json
node controller/combat-defect.mjs                           # Stage C: inject → capture → repair → capture
```
