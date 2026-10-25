extends SceneTree

## Phase 19 CPU-side measurements for the voxel world.
##
## Runs headless and prints one JSON line prefixed with `MEASURE_JSON `. These
## are process-local timings for data generation and chunk-mesh building only;
## they are not a frame-rate claim. Run with:
##   godot --headless --path <project> -s res://tests/measure_voxel.gd

const DataScript = preload("res://scripts/voxel_data.gd")
const ChunkBuilder = preload("res://scripts/voxel_chunk_builder.gd")
const SEED := 20261023
const CHUNK_SIZE := 8
const GENERATION_RUNS := 10
const CHUNK_RUNS := 5


func _initialize() -> void:
	var report := _measure()
	print("MEASURE_JSON %s" % JSON.stringify(report))
	quit(0)


func _percentile(sorted_values: Array, fraction: float) -> float:
	if sorted_values.is_empty():
		return 0.0
	var index := clampi(int(round(float(sorted_values.size() - 1) * fraction)), 0, sorted_values.size() - 1)
	return float(sorted_values[index])


func _stats(values: Array) -> Dictionary:
	var sorted_values := values.duplicate()
	sorted_values.sort()
	var total := 0.0
	for value in sorted_values:
		total += float(value)
	return {
		"runs": sorted_values.size(),
		"min_ms": snappedf(float(sorted_values[0]) / 1000.0, 0.001),
		"median_ms": snappedf(_percentile(sorted_values, 0.5) / 1000.0, 0.001),
		"mean_ms": snappedf((total / float(sorted_values.size())) / 1000.0, 0.001),
		"max_ms": snappedf(float(sorted_values[sorted_values.size() - 1]) / 1000.0, 0.001),
	}


func _measure() -> Dictionary:
	var data := DataScript.new()
	var generation_us: Array = []
	for _run in range(GENERATION_RUNS):
		var started := Time.get_ticks_usec()
		data.generate(SEED)
		generation_us.append(Time.get_ticks_usec() - started)

	var counts: Dictionary = data.counts()
	var cells := data.width * data.height * data.depth
	var solid := 0
	for name in counts:
		if String(name) != "air":
			solid += int(counts[name])

	var chunk_us: Array = []
	var visible_faces := 0
	var vertex_count := 0
	var chunk_count := 0
	for _run in range(CHUNK_RUNS):
		visible_faces = 0
		vertex_count = 0
		chunk_count = 0
		var started := Time.get_ticks_usec()
		for cz in range(0, data.depth, CHUNK_SIZE):
			for cx in range(0, data.width, CHUNK_SIZE):
				var built: Dictionary = ChunkBuilder.build(data, cx, cz, CHUNK_SIZE, CHUNK_SIZE)
				visible_faces += int(built["visible_faces"])
				vertex_count += int(built["vertex_count"])
				chunk_count += 1
		chunk_us.append(Time.get_ticks_usec() - started)

	var spawn: Vector3 = data.spawn_point()
	return {
		"seed": SEED,
		"dimensions": {
			"width": data.width,
			"height": data.height,
			"depth": data.depth,
			"cells": cells,
			"chunk_size": CHUNK_SIZE,
			"chunk_count": chunk_count,
		},
		"blocks": {
			"counts": counts,
			"solid_total": solid,
			"air_total": int(counts.get("air", 0)),
		},
		"geometry": {
			"visible_faces": visible_faces,
			"vertices": vertex_count,
			"triangles": vertex_count / 3,
		},
		"spawn": [snappedf(spawn.x, 0.001), snappedf(spawn.y, 0.001), snappedf(spawn.z, 0.001)],
		"timing": {
			"generation": {
				"sample": _stats(generation_us),
				"note": "generate(seed) including tree placement, per fresh instance",
			},
			"chunk_build": {
				"sample": _stats(chunk_us),
				"note": "all %d chunks meshed from data, excluding physics bodies and rendering" % chunk_count,
			},
		},
		"engine": String(Engine.get_version_info().get("string", "")),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
	}
