# Phase 19 implementation task: voxel world data module

You are implementing one bounded module in a disposable copy of a Godot 4.7
project. There is no shell, no Godot executable, and no network. You may read
the surrounding project for context, but you may edit **only**:

- `project/scripts/voxel_data.gd`

Do not edit the scene, player, renderer, HUD, harness, save store, or any other
file. Do not create or edit tests. Your output is verified outside this sandbox
with hidden acceptance tests after you finish.

Write `project/IMPLEMENTATION.md` when the code is complete. It must contain
these sections:

- `# Voxel data implementation`
- `## Chosen approach`
- `## Files changed`
- `## Data model`
- `## Edge cases`
- `## Limits`

# Required module

`VoxelWorldData` is a `RefCounted` pure-data module. It must not create nodes,
read input, render, use the filesystem, or depend on the player or HUD. The
starter file contains the public API and a few constant definitions. Keep the
public method signatures, constants, and class name.

## Constants and storage

- Dimensions default to `WIDTH=32`, `HEIGHT=16`, `DEPTH=32`.
- IDs: `AIR=0`, `GRASS=1`, `DIRT=2`, `STONE=3`, `LOG=4`, `LEAVES=5`.
- `blocks` and `base_blocks` are `PackedByteArray` values of length
  `width * height * depth`.
- Use a deterministic index. `index(x, y, z)` is public and must be consistent
  with `get_block`/`set_block`. Any layout is valid as long as it is in bounds.
- `_init(size_x, size_y, size_z)` already clamps dimensions and allocates both
  arrays. Keep it working.

## Basic access

- `is_inside(x, y, z)`: true only for in-bounds integer cells.
- `get_block(x, y, z)`: returns `AIR` for out-of-bounds coordinates.
- `set_block(x, y, z, block_id)`: returns false for out-of-bounds coordinates or
  a block id outside 0..5; otherwise writes the byte and returns true.
- `highest_solid_y(x, z)`: the highest non-air y in that column, or -1 outside
  the world / in an empty column.

## Deterministic terrain

`generate(seed_value)` must replace the world with a deterministic terrain for
that seed:

- Fill a height-varying 32 x 32 landscape. Height must vary meaningfully across
  the surface; a flat plane is not acceptable.
- The top solid block of each column is grass. The next two solid blocks below
  it are dirt, and deeper blocks are stone.
- Place at least one tree with a trunk of log blocks and a leaf canopy. Use
  seeded randomness or fixed positions so the same seed gives the same world.
- Keep the immediate spawn area clear enough that the player can stand there.
- After generation, copy the generated result into `base_blocks`. `blocks` is
  the mutable working copy. `world_seed` is the requested seed.
- The same seed must produce the same `hash()`; a different seed should normally
  produce a different terrain hash.

## Spawn

`spawn_point()` returns a world-space feet position near the centre of the map.
The cell below the spawn must be solid, and the two cells occupied by the player
capsule above the ground must be air. The returned Y should be the ground top
surface plus a tiny epsilon (for example `top + 1.02`), not the block centre.
Search nearby columns if the centre column is blocked by a tree.

## Counts and changes

- `counts()` returns a dictionary whose keys are the names in `BLOCK_NAMES`
  (`"air"`, `"grass"`, `"dirt"`, `"stone"`, `"log"`, `"leaves"`) and whose values
  are integer counts across all cells.
- `changed_blocks()` compares `blocks` against `base_blocks` and returns an array
  of dictionaries `{"x": int, "y": int, "z": int, "id": int}` in deterministic
  y, then z, then x order. A removed baseline block has `id: 0`. A world with no
  edits returns an empty array. Restoring a block to its baseline value removes
  it from the array.

## Save document

`to_save_dict()` returns exactly this shape:

```gdscript
{
    "version": 1,
    "world": {"width": 32, "height": 16, "depth": 32, "seed": 12345},
    "changes": [{"x": 4, "y": 5, "z": 6, "id": 0}],
}
```

Only edits relative to the generated baseline belong in `changes`.

`apply_save(data)` validates and applies a document **atomically**:

- Reject non-dictionary input, a version other than `SAVE_VERSION`, missing or
  malformed `world`/`changes`, width/height/depth that differ from this
  instance, non-integer or out-of-bounds cells, and ids outside 0..5.
- A change array larger than the world volume is invalid.
- On any error, return false and leave `blocks`, `base_blocks`, and
  `world_seed` byte-for-byte unchanged.
- On success, regenerate the baseline for the saved seed, apply the changes,
  update `blocks`, `base_blocks`, and `world_seed`, and return true.
- A successful save/load round trip must reproduce the same `hash()`.

## Grid raycast

`raycast(origin, direction, max_distance=6.0)` uses voxel grid traversal
(Amanatides-Woo or equivalent). It must return:

```gdscript
{
    "hit": true,
    "block": [x, y, z],       # first solid cell entered
    "previous": [x, y, z],    # last empty cell before it
    "normal": [nx, ny, nz],   # axis from previous to block, e.g. [0, 1, 0]
    "distance": 2.5,          # from origin to the entry face
    "block_id": 1,
}
```

On a miss, return `hit: false`, empty `block`/`previous`/`normal`, `distance`
equal to `max_distance`, and `block_id: AIR`. Normalize the direction, handle
zero-length directions, and stop at `max_distance`. A ray that starts inside a
solid cell may report that cell with distance 0.

## Hash

`hash()` returns a stable string derived from the dimensions, seed, and block
bytes. It must change when a block changes and return to the earlier value when
the block is restored.

# Verification expectations

The hidden tests are behavioral. They will check determinism, terrain types and
height variation, spawn safety, boundaries, set/get, changed-block semantics,
save round trips, invalid-save atomicity, downward/nearest-face raycasts, misses,
and hash sensitivity. They do not inspect your implementation style and do not
require one particular terrain formula. No test should require a specific seed's
height map.

Work carefully in GDScript 4.7 syntax. When you are done, write
`project/IMPLEMENTATION.md` and stop.
