# Voxel block targeting repair

## Root cause

`VoxelWorldData.raycast()` walks the voxel grid one cell at a time and keeps a
`previous` cell for each step. When it found a solid block, however, the hit
result incorrectly populated `previous` with the hit cell itself instead of the
tracked prior cell.

Because `VoxelWorld._try_place()` places into the raycast's `previous` cell,
this made placement target the block under the crosshair instead of the adjacent
empty cell. Placement then either failed as occupied or replaced the aimed block,
rather than building against the hit face.

## Change

In the hit-result branch of `raycast()` in `project/scripts/voxel_data.gd`,
`previous` now returns the cell occupied on the preceding ray step:

```gdscript
"previous": [previous.x, previous.y, previous.z],
```

The step bookkeeping already updated `previous` before advancing `cell`, so this
reports the empty cell immediately before the hit block. For a downward ray
hitting a block from above, that cell is directly above the hit block, matching
the reported `[0, 1, 0]` face normal.

No other behavior changed: the hit block coordinates, `block_id`, `distance`,
`normal`, miss result, initial solid-origin case, public API, block ids, save
format, world generation, and spawn helpers are untouched.
