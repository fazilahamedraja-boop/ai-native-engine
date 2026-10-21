# Phase 12 — Read-Only Physics Space Query (evidence summary)

> **Corrected in Phase 12B.** The original summary below claimed the four failing tests were
> "environment timeouts unrelated to code changes". That was **wrong** — they were a GDScript
> parse error in the Phase 12 `bridge.gd` that prevented the autoload from loading. The full
> analysis, the corrected contract, and the verified results are in
> [`../phase12-verification/`](../phase12-verification/).
>
> The original text is kept below, with the incorrect claims marked, so the correction is
> auditable rather than a silent rewrite.

## Original Phase 12 summary (with corrections marked)

### Status

- **Phase 11 baseline**: `e72ba64`, branch `experiment/phase11-audit`
- **Phase 11 tests**: 27/27 passing ✅
- **Phase 12 changes**: Add one read-only physics-space query operation
- ~~**Phase 12 test results**: 23/27 passing in the Phase 12 worktree (4 environment timeouts
  unrelated to code changes); all 27 Phase 11 tests pass unchanged~~
  **CORRECTION:** the four failures were **not** environmental. The Phase 12 `bridge.gd` edit
  contained a GDScript parse error, so the autoload never loaded and the bridge never started.
  See `docs/phase12-verification/timeout-diagnosis.md`.

### Changes Made

#### 1. `bridge.gd` — Added `_physics_query_reply` function

- **Location**: `experiments/godot-harness/fixtures/observation/harness/bridge.gd`
- **What**: New function handling the `physics_query` bridge command
- ~~**How**: Validates `shape_type` (box/sphere/capsule/ray), builds the appropriate
  `PhysicsShapeQueryParameters3D`, runs `intersect_shape()` or `intersect_ray()` against
  `get_world_3d().direct_space_state`, returns collider hit results tagged `source: "derived"``
  **CORRECTION:** the original implementation did not compile and used two APIs incorrectly. The
  verified implementation uses `get_tree().root.get_world_3d()`, the correct
  `PhysicsRayQueryParameters3D` for rays, and a single-hit `Dictionary` from `intersect_ray`.
- **Input shapes**:
  - `box`: `BoxShape3D` with `size` vector
  - `sphere`: `SphereShape3D` with `radius`
  - `capsule`: `CapsuleShape3D` with `radius` and `height`
  - `ray`: `intersect_ray()` along +Z axis from the transform origin
- **Output**: `{ results: Array, shape_type, transform, source }`

#### 2. `harness.mjs` — Added `physicsQuery` method

- **Location**: `controller/harness.mjs`
- **What**: New `HarnessSession.physicsQuery()` method
- **How**: Validates `shape_type` is a non-empty string and one of the four valid values;
  conditionally builds arguments; sends `physics_query` to the bridge with a 10-second timeout
- **Error handling**: Throws descriptive `Error` objects for invalid input, following the same
  pattern as `observe` and `advancePhysics`

### Evidence

- **Phase 11 regression**: All 27 tests pass unchanged ✅
- **Phase 12 contract**: Defined in `docs/phase12/CONTRACT.md`
- ~~**Phase 12 worktree**: 23/27 passing, 4 timeouts~~
  **CORRECTION:** after the fix, the verification worktree is **35/35** (27 Phase 11 regression
  tests + 8 new physics-query tests), reproduced across three consecutive runs.

### What Was Not Done (deliberately)

- No new observation framework was added — the existing bridge protocol was extended with one new
  command.
- No gameplay code, combat fixtures, character assets, or physics behavior was modified.
- No general query language or new observation framework was invented.
- No `intersect_point` operation was added.
- ~~No collision mask configuration was exposed (mask is hardcoded to `1` per the gap report's
  bounded scope)~~
  **CORRECTION:** the hard-coded mask `1` was itself a defect — it could not see a collider on
  any other layer, which is exactly the blind spot the operation exists to close. `collisionMask`
  is now an optional input.

## Verified Phase 12B result

| Item | Result |
|---|---|
| Root cause of the four timeouts | GDScript parse error in the Phase 12 `bridge.gd` — **a code defect** |
| Four originally-failing tests | 4/4 pass, individually and together |
| New physics-query tests | 8/8 pass, three consecutive runs |
| Full harness suite | 35/35, three consecutive runs (25.1 s each) |
| Phase 11 `character-audit` fixture | 4/4 pass |
| Phase 11 `combat` fixture | 3/3 pass |
| Stage C defect benchmark | still reproduces (1/3 → 3/3, hits 0 → 1) |
| Protected Phase 11 evidence | byte-identical to the committed state |
| Merge / push / reset / rebase / retag | none |

Full detail: `docs/phase12-verification/verification-report.md`.
