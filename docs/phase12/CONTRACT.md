# Phase 12 — Read-Only Physics Space Query

## Contract

### Query inputs

| Parameter | Type | Description | Required | Default |
|---|---|---|---|---|
| `shape_type` | `string` | One of: `"box"`, `"sphere"`, `"capsule"`, `"ray"` | Yes | — |
| `transform` | `Transform3D` | World transform at which to query | No | `Transform3D.IDENTITY` |
| `size` | `Vector3` | Box half-extents (x, y, z) | No (for box) | `Vector3(1.0, 1.0, 1.0)` |
| `radius` | `float` | Sphere radius / capsule radius | No (for sphere/capsule) | `0.0` |
| `height` | `float` | Capsule height | No (for capsule) | `0.0` |

### Output schema

```json
{
  "results": Array,           // zero or more collider hits
  "shape_type": string,      // the shape type that was queried
  "transform": Transform,    // the world transform that was queried
  "source": "derived"        // disciplined as "measured" vs "derived"
}
```

Each item in `results` has:

| Field | Type | Description |
|---|---|---|
| `collider` | `string` | Path of the collider node (e.g. `"/root/Main/Target"`) |
| `collider_type` | `string` | Godot class name (e.g. `"StaticBody3D"`) |
| `hit_point` | `Vector3` | Point of intersection (ray only) |
| `hit_normal` | `Vector3` | Normal at intersection point (ray only) |
| `shape_index` | `int` | Index of the shape within the collider (box/sphere/capsule) |

### Error handling

- Missing or empty `shape_type` → `VALIDATION_ERROR` with message `"shape_type is required (box, sphere, capsule, ray)"`
- Invalid `shape_type` → `VALIDATION_ERROR` with message `"shape_type must be one of: box, sphere, capsule, ray"`
- Invalid `size` for box (less than 3 components) → `VALIDATION_ERROR`
- Invalid `radius` / `height` for sphere/capsule (non-positive) → `VALIDATION_ERROR`
- No colliders found → empty `results` array (not an error)

### Godot API used

- `PhysicsDirectSpaceState3D.intersect_shape()` with `PhysicsShapeQueryParameters3D`
- `PhysicsDirectSpaceState3D.intersect_ray()` with `PhysicsShapeQueryParameters3D`
- Collision masks set to `1` (default project layer)

### Read-only guarantee

- The operation only reads from `get_world_3d().direct_space_state`
- No scene mutations, no property writes, no physics changes
- The `source: "derived"` tag in the output disciplines the result as computed from engine state rather than a directly measured property

## Bridge implementation (`bridge.gd`)

Added function `_physics_query_reply(request_id: String, args: Dictionary) -> Dictionary` at line ~368.

The function:

1. Validates `shape_type` is one of `box`, `sphere`, `capsule`, `ray`
2. Builds the appropriate `PhysicsShapeQueryParameters3D` (or `PhysicsShapeQueryParameters3D` for ray)
3. Runs `space.intersect_shape()` or `space.intersect_ray()` against `get_world_3d().direct_space_state`
4. Returns an array of hit results with collider paths, types, and shape indices
5. Tags all results with `source: "derived"`
6. Returns structured output including `results`, `shape_type`, `transform`, and `source`

Each shape type is handled in a `match` block:

- **box**: `BoxShape3D` with `size`, `intersect_shape`
- **sphere**: `SphereShape3D` with `radius`, `intersect_shape`
- **capsule**: `CapsuleShape3D` with `radius` and `height`, `intersect_shape`
- **ray**: `intersect_ray` from `transform.origin` along `transform.basis.z` for 100m

## Controller implementation (`harness.mjs`)

Added method `physicsQuery({ shape_type, transform, size, radius, height } = {})` at line ~746 of `harness.mjs`.

The method:

1. Validates `shape_type` is a non-empty string and one of the four valid values
2. Builds a arguments object for the bridge, conditionally including `size`, `radius`, `height`, and `transform`
3. Sends the `physics_query` command to the bridge with a 10-second timeout
4. Returns the raw bridge response (structured as per the contract)

Input validation errors throw descriptive `Error` objects following the same pattern as other harness methods (e.g., `observe`, `advancePhysics`).

## Test patterns

The existing test suite (`tests/controller.test.mjs`, `tests/observation.test.mjs`, etc.) should remain unchanged. A focused test for the new operation would:

1. Start a Godot project with the bridge
2. Send a `physicsQuery` request with `shape_type: "box"` and a transform at the target position
3. Assert the response contains `results: []` (empty, since no colliders are in the test scene by default)
4. Send a `physicsQuery` request with `shape_type: "sphere"` and a transform at the known target — assert `results` contains the target collider path
5. Assert an empty query is handled gracefully (no crash, empty results)
6. Assert invalid `shape_type` throws a descriptive error

No gameplay code, combat fixtures, character assets, physics behavior, or existing observation semantics are modified.

## Known limitations

- The query uses a fixed collision mask of `1`; scenes with colliders on other layers won't be detected without modifying the bridge
- The ray query travels along the +Z axis for 100 units; scenes requiring longer ranges need bridge extension
- No `intersect_point` operation is included (could be added later as a separate minimal change)
- The operation is scoped to `direct_space_state`; indirect space queries (e.g., with `PhysicsServer3D`) are not supported