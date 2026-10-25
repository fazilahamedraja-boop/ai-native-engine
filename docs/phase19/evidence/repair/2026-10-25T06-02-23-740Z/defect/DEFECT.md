# Injected controlled defect

One-line change in `scripts/voxel_data.gd`: the raycast hit reply reports
the hit cell as the previous cell, so placement targets the block itself
instead of the empty cell against the hit face.

## Before (healthy)

```gdscript
					"block": [cell.x, cell.y, cell.z],
					"previous": [previous.x, previous.y, previous.z],
```

## After (defective)

```gdscript
					"block": [cell.x, cell.y, cell.z],
					"previous": [cell.x, cell.y, cell.z],
```
