# Injected controlled defect

Single-function replacement in `scripts/voxel_data.gd`: the procedural
height function was replaced with a constant, seed-independent height.

## Before (healthy)

```gdscript
func _terrain_height(x: int, z: int) -> int:
	var seed_phase := float((world_seed % 101) - 50) * 0.04
	var n := (
		sin(float(x) * 0.30 + seed_phase)
		+ cos(float(z) * 0.24 - seed_phase * 0.7)
		+ sin(float(x + z) * 0.13)
	)
	return clampi(5 + int(round(n * 1.65)), 2, 12)
```

## After (defective)

```gdscript
func _terrain_height(_x: int, _z: int) -> int:
	# Controlled defect: seed-independent flat terrain.
	return 5
```
