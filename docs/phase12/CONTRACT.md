# Phase 12 — Read-Only Physics Space Query

> **Corrected in Phase 12B.** The first version of this document specified a
> `Transform3D` for the `transform` input and a `Vector3` for `size`. Neither can cross the
> bridge's newline-delimited JSON protocol, and the implementation as first written did not
> compile. The verified contract is below. See
> [`../phase12-verification/verification-report.md`](../phase12-verification/verification-report.md).

## Contract

### Query inputs

| Parameter | JSON type | Description | Required | Default |
|---|---|---|---|---|
| `shape_type` | string | One of `"box"`, `"sphere"`, `"capsule"`, `"ray"` | Yes | — |
| `transform` | object | `{ origin: [x, y, z], rotation_degrees: [x, y, z] }` | No | identity |
| `size` | `[x, y, z]` | Box **full** extents | For `box` | `[1, 1, 1]` |
| `radius` | number | Sphere or capsule radius | For `sphere` / `capsule` | — |
| `height` | number | Capsule height | For `capsule` | — |
| `collision_mask` | integer | Collision layers the query may hit | No | `1` |

`transform.origin` and `transform.rotation_degrees` are optional; the Euler rotation is applied in
degrees about X, Y, Z in that order.

### Output schema

```json
{
  "results": Array,           // zero or more collider hits
  "shape_type": string,      // the shape type that was queried
  "transform": Object,       // the world transform that was queried
  "collision_mask": integer, // the mask the query used
  "source": "derived"        // derived from engine state, not a directly measured property
}
```

Each entry in `results`:

| Field | Type | Description |
|---|---|---|
| `collider` | string \| null | Path of the collider node, e.g. `"/root/Main/Gate"` |
| `collider_type` | string \| null | Godot class name, e.g. `"StaticBody3D"` |
| `shape_index` | integer \| null | Index of the shape within the collider |
| `hit_point` | `[x, y, z]` \| null | Contact point — **ray only** |
| `hit_normal` | `[x, y, z]` \| null | Contact normal — **ray only** |
| `source` | string | Always `"derived"` |

`transform` uses the bridge's existing transform shape: `{ space, origin, rotation_degrees,
quaternion, scale, source }`.

### Error handling

| Condition | Result |
|---|---|
| `shape_type` missing or empty | `VALIDATION_ERROR` — `shape_type is required (box, sphere, capsule, ray).` |
| `shape_type` unknown | `VALIDATION_ERROR` — `Unknown shape_type: '…'.` |
| `size` not a 3-number array | `VALIDATION_ERROR` — `size must be an array of three numbers.` |
| `size` component ≤ 0 | `VALIDATION_ERROR` — `size components must be greater than zero.` |
| `radius` missing or ≤ 0 | `VALIDATION_ERROR` — `radius must be a number greater than zero.` |
| `height` missing or ≤ 0 | `VALIDATION_ERROR` — `height must be a number greater than zero.` |
| No colliders found | **Not an error** — `results` is `[]` |

The controller validates `shape_type`, `transform`, `size`, `radius`, `height` and
`collisionMask` **before** any bridge call and throws a descriptive `Error`, matching the style
of `observe` and `advancePhysics`. The bridge validates again, so the contract holds for a caller
that speaks the protocol directly.

### Godot APIs used

Probed from the installed build (`ClassDB.class_get_method_list`), not assumed:

| API | Signature | Returns |
|---|---|---|
| `PhysicsDirectSpaceState3D.intersect_shape` | `(PhysicsShapeQueryParameters3D, int)` | `Array` |
| `PhysicsDirectSpaceState3D.intersect_ray` | `(PhysicsRayQueryParameters3D)` | `Dictionary` (one hit, empty on a miss) |

Godot 4.7 changed the ray query relative to earlier assumptions: it takes
`PhysicsRayQueryParameters3D`, not `PhysicsShapeQueryParameters3D`, and returns a single
`Dictionary`, not an `Array`. The bridge normalises that single hit into the `results` array.

### Read-only guarantee

- The operation only reads `get_tree().root.get_world_3d().direct_space_state`.
- It creates no nodes, sets no properties, and mutates no physics state.
- Verified by a test that compares `snapshot.step`, `snapshot.hash`,
  `snapshot.outcome_hash`, every observed `global_transform`, and every observed `collision`
  block before and after two queries.

## Bridge implementation

`fixtures/observation/harness/bridge.gd`:

- `_physics_query_reply(request_id, args)` — the command handler.
- `_query_transform(value)` — rebuilds a world `Transform3D` from the JSON wire form.
- `_query_vec3(value)`, `_query_number(value)` — typed JSON scalar parsing.
- `_query_mask(value)` — the optional collision mask, defaulting to `1`.
- `_query_hits(hits)` — normalises `intersect_shape` results.
- `_query_ray_hit(hit)` — normalises the single `intersect_ray` result.

The operation is also exposed through `observe`: every observed collision object now publishes a
`collision` block with `collision_layer`, `collision_mask`, and — for `Area3D` — `monitoring` and
`monitorable`. This closes the Stage 11 blind spot where a layer/mask mismatch could not be ruled
in or out from a capture.

## Controller implementation

`controller/harness.mjs`:

- `physicsQuery({ shape_type, transform, size, radius, height, collisionMask })`
- `validatePhysicsTransform(transform)`

## Test

`tests/physics-query.test.mjs` — eight focused checks: input validation, box hit/miss, sphere
hit/miss, capsule hit/miss, ray hit with contact point and normal plus a miss, collision-mask
behaviour, read-only behaviour, and the published collision layer/mask.

```powershell
npm run test:physics-query
```

## Known limitations

- Only the observation fixture's bridge implements the command. The other fixtures keep their own
  smaller bridges, as they always have.
- The default collision mask is `1`; a caller must pass `collisionMask` to select another layer.
- The ray length is fixed at `QUERY_RAY_LENGTH = 100.0`.
- `intersect_ray` reports only the nearest hit — this engine version has no multi-hit ray.
- `intersect_point` is not implemented.
- The query reflects the most recent flushed physics state, not a sub-tick snapshot.
