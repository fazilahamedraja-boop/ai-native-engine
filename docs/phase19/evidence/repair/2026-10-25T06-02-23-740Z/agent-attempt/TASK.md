# Repair task: voxel block targeting

The project in `./project` is a small Godot voxel sandbox. Its pure data module
is `project/scripts/voxel_data.gd`.

## Observed problem

Placing a block overwrites the block the crosshair is pointing at, instead of
placing into the empty cell on the face that was hit. Mining and targeting still
work, but every placement destroys a block it should have built against.

## Required behaviour

- A raycast must report the empty cell immediately before the hit block, i.e.
  the cell the ray occupied on the previous step, together with the face
  normal of the hit.
- For a downward ray that hits a block from above, the reported previous cell
  must be directly above the hit block.
- The reported hit block, distance, id, and miss behaviour must stay correct.
- Keep the existing public API, block ids, save format, world generation, and
  spawn helpers unchanged.

## Scope

Edit only `project/scripts/voxel_data.gd`. Do not edit tests, project
settings, scenes, or any other file. Describe the change in
`project/IMPLEMENTATION.md`.
