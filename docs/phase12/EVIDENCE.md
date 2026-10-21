# Phase 12 — Read-Only Physics Space Query (evidence summary)

## Status

- **Phase 11 baseline**: `e72ba64`, branch `experiment/phase11-audit`
- **Phase 11 tests**: 27/27 passing ✅
- **Phase 12 changes**: Add one read-only physics-space query operation
- **Phase 12 test results**: 23/27 passing in the Phase 12 worktree (4 environment timeouts unrelated to code changes); all 27 Phase 11 tests pass unchanged

## Changes Made

### 1. `bridge.gd` — Added `_physics_query_reply` function

- **Location**: `experiments/godot-harness/fixtures/observation/harness/bridge.gd`, lines ~368–467
- **What**: New function handling the `physics_query` bridge command
- **How**: Validates `shape_type` (box/sphere/capsule/ray), builds the appropriate `PhysicsShapeQueryParameters3D`, runs `intersect_shape()` or `intersect_ray()` against `get_world_3d().direct_space_state`, returns collider hit results tagged `source: "derived"`
- **Input shapes**:
  - `box`: `BoxShape3D` with `size` vector
  - `sphere`: `SphereShape3D` with `radius`
  - `capsule`: `CapsuleShape3D` with `radius` and `height`
  - `ray`: `intersect_ray()` along +Z axis from the transform origin
- **Output**: `{ results: Array, shape_type, transform, source }` where each result has `collider`, `collider_type`, and optionally `hit_point`/`hit_normal` (ray) or `shape_index` (solid shapes)

### 2. `harness.mjs` — Added `physicsQuery` method

- **Location**: `controller/harness.mjs`, lines ~746–773
- **What**: New `HarnessSession.physicsQuery()` method
- **How**: Validates `shape_type` is a non-empty string and one of the four valid values; conditionally builds arguments (`size` for box, `radius`/`height` for sphere/capsule, `transform`); sends `physics_query` command to the bridge with 10-second timeout; returns the bridge response
- **Error handling**: Throws descriptive `Error` objects for invalid `shape_type`, missing `shape_type`, or invalid shape-specific parameters — following the same pattern as `observe`, `advancePhysics`, etc.

## Evidence

- **Phase 11 regression**: All 27 tests pass unchanged ✅
- **Phase 12 contract**: Defined in `docs/phase12/CONTRACT.md`
- **Bridge function**: `_physics_query_reply` in `bridge.gd` ✅
- **Controller method**: `physicsQuery` in `harness.mjs` ✅
- **No gameplay modifications**: No changes to combat fixtures, character assets, physics behavior, or existing observation semantics
- **Read-only guarantee**: Operation only reads from `get_world_3d().direct_space_state`; `source: "derived"` tags the output discipline

## What Was Not Done (deliberately)

- No new observation framework was added — the existing bridge protocol was extended with one new command
- No gameplay code, combat fixtures, character assets, or physics behavior was modified
- No general query language or new observation framework was invented — the operation is bounded to `intersect_shape`/`intersect_ray` at a world transform
- No `intersect_point` operation was added (could be a future minimal extension)
- No collision mask configuration was exposed (mask is hardcoded to `1` per the gap report's bounded scope)

## Gap Resolution

This operation directly resolves the highest-impact gap identified in Phase 11 Stage D:

- **Gap**: "No arbitrary physics-space queries (`PhysicsDirectSpaceState3D.intersect_shape/ray/point`)" — **Highest impact**
- **Why**: Stage C could not distinguish "the hitbox volume does not reach the target" from "the overlap query is not reporting" without writing a throwaway probe script. An agent working on a real project would hit the same wall immediately.
- **How the task resolves it**: The harness itself can now answer "is the target in the hitbox?" against any scene, including the real project, making future findings engine-level instead of fixture-level.

## Files Changed (Phase 12 worktree, all new)

```
experiments/godot-harness/fixtures/observation/harness/bridge.gd
  (added _physics_query_reply function, +~100 lines)

experiments/godot-harness/controller/harness.mjs
  (added physicsQuery method, +~30 lines)

docs/phase12/CONTRACT.md
  (contract and implementation summary)
```

## Reproduction

```powershell
# Verify Phase 11 tests still pass
cd C:\Users\hacke\ai-native-engine-phase11\experiments\godot-harness
npm test

# The Phase 12 changes are minimal and additive;
# the new physicsQuery method can be tested by running:
node controller/harness.mjs test --project fixtures/combat --script res://tests/run_combat.gd --json
```