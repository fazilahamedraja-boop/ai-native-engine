extends SceneTree

## Hidden Phase 19 data-module acceptance suite. The external implementation
## agent never receives this file or its expected values. Run with:
##   godot --headless --path <project> -s res://tests/run_voxel_data_tests.gd

const DataScript = preload("res://scripts/voxel_data.gd")

var passed := 0
var failed := 0
var results: Array = []


func _initialize() -> void:
	_run()


func _run() -> void:
	_test_determinism()
	_test_required_blocks()
	_test_spawn()
	_test_boundaries()
	_test_set_get()
	_test_changed_blocks()
	_test_save_roundtrip()
	_test_invalid_save()
	_test_raycast_down()
	_test_raycast_miss()
	_test_raycast_nearest()
	_test_hash_tracks_changes()
	_finish()


func _test_determinism() -> void:
	var a = DataScript.new()
	var b = DataScript.new()
	var c = DataScript.new()
	a.generate(12345)
	b.generate(12345)
	c.generate(54321)
	_check("data-generation-deterministic", a.hash() == b.hash() and a.hash() != c.hash(), "hashes=%s/%s/%s" % [a.hash().left(12), b.hash().left(12), c.hash().left(12)])
	_check("data-save-version", int(a.to_save_dict().get("version", -1)) == DataScript.SAVE_VERSION, "version=%s" % str(a.to_save_dict().get("version", -1)))


func _test_required_blocks() -> void:
	var data = DataScript.new()
	data.generate(777)
	var counts: Dictionary = data.counts()
	var heights: Array[int] = []
	for x in [3, 8, 13, 18, 23, 28]:
		for z in [3, 10, 17, 24, 29]:
			heights.append(data.highest_solid_y(x, z))
	var spread: int = heights.max() - heights.min()
	_check(
		"data-required-block-types",
		int(counts.get("grass", 0)) > 0 and int(counts.get("dirt", 0)) > 0 and int(counts.get("stone", 0)) > 0 and int(counts.get("log", 0)) > 0,
		"counts=%s" % JSON.stringify(counts)
	)
	_check("data-height-variation", spread >= 2, "height spread=%d" % spread)


func _test_spawn() -> void:
	var data = DataScript.new()
	data.generate(20261023)
	var spawn: Vector3 = data.spawn_point()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	var below := floori(spawn.y - 0.05)
	var feet_cell := floori(spawn.y + 0.05)
	var head_cell := feet_cell + 1
	_check(
		"data-spawn-safe",
		data.is_inside(sx, int(below), sz)
		and data.get_block(sx, int(below), sz) != DataScript.AIR
		and data.get_block(sx, feet_cell, sz) == DataScript.AIR
		and data.get_block(sx, head_cell, sz) == DataScript.AIR,
		"spawn=%s below=%d feet=%d head=%d" % [str(spawn), below, feet_cell, head_cell]
	)


func _test_boundaries() -> void:
	var data = DataScript.new()
	data.generate(99)
	_check(
		"data-boundaries",
		data.get_block(-1, 0, 0) == DataScript.AIR
		and data.get_block(data.width, 0, 0) == DataScript.AIR
		and not data.set_block(-1, 0, 0, DataScript.STONE)
		and not data.set_block(data.width, 0, 0, DataScript.STONE)
		and data.is_inside(0, 0, 0)
		and not data.is_inside(0, -1, 0),
		"width=%d height=%d depth=%d" % [data.width, data.height, data.depth]
	)


func _test_set_get() -> void:
	var data = DataScript.new()
	data.generate(5)
	var spawn: Vector3 = data.spawn_point()
	var x := floori(spawn.x)
	var z := floori(spawn.z)
	var y := floori(spawn.y + 0.9)
	var before := data.get_block(x, y, z)
	var set_ok := data.set_block(x, y, z, DataScript.STONE)
	var middle := data.get_block(x, y, z)
	var restore_ok := data.set_block(x, y, z, before)
	_check(
		"data-set-get",
		before == DataScript.AIR and set_ok and middle == DataScript.STONE and restore_ok and data.get_block(x, y, z) == before,
		"cell=%d,%d,%d before=%d middle=%d" % [x, y, z, before, middle]
	)


func _test_changed_blocks() -> void:
	var data = DataScript.new()
	data.generate(4242)
	_check("data-changed-starts-empty", data.changed_blocks().is_empty(), "changes=%d" % data.changed_blocks().size())
	var x := 4
	var z := 4
	var top: int = data.highest_solid_y(x, z)
	var original := data.get_block(x, top, z)
	data.set_block(x, top, z, DataScript.AIR)
	var removed: Array = data.changed_blocks()
	var has_removal := false
	if removed.size() == 1:
		has_removal = int(removed[0].get("x", -1)) == x and int(removed[0].get("y", -1)) == top and int(removed[0].get("z", -1)) == z and int(removed[0].get("id", -1)) == DataScript.AIR
	data.set_block(x, top, z, original)
	_check(
		"data-changed-relative",
		has_removal and data.changed_blocks().is_empty(),
		"after_remove=%s after_restore=%d" % [JSON.stringify(removed), data.changed_blocks().size()]
	)


func _test_save_roundtrip() -> void:
	var data = DataScript.new()
	data.generate(31337)
	var spawn: Vector3 = data.spawn_point()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	var top: int = data.highest_solid_y(sx, sz)
	var removed_y := top
	var added_y := floori(spawn.y + 0.9)
	var removed_id := data.get_block(sx, removed_y, sz)
	data.set_block(sx, removed_y, sz, DataScript.AIR)
	data.set_block(sx, added_y, sz, DataScript.STONE)
	var document: Dictionary = data.to_save_dict()
	var other = DataScript.new()
	var applied: bool = other.apply_save(document)
	_check(
		"data-save-roundtrip",
		applied
		and other.hash() == data.hash()
		and other.get_block(sx, removed_y, sz) == DataScript.AIR
		and other.get_block(sx, added_y, sz) == DataScript.STONE,
		"applied=%s changes=%d removed=%s" % [str(applied), document.get("changes", []).size(), str(removed_id)]
	)


func _test_invalid_save() -> void:
	var data = DataScript.new()
	data.generate(6060)
	var original_hash := data.hash()
	var document: Dictionary = data.to_save_dict()
	var bad_version: Dictionary = document.duplicate(true)
	bad_version["version"] = 999
	var version_rejected := not data.apply_save(bad_version)
	var bad_dimensions: Dictionary = document.duplicate(true)
	bad_dimensions["world"]["width"] = data.width + 1
	var dimensions_rejected := not data.apply_save(bad_dimensions)
	var bad_changes: Dictionary = document.duplicate(true)
	bad_changes["changes"] = [{"x": -1, "y": 99, "z": 0, "id": DataScript.STONE}]
	var changes_rejected := not data.apply_save(bad_changes)
	_check(
		"data-invalid-save-atomic",
		version_rejected and dimensions_rejected and changes_rejected and data.hash() == original_hash,
		"version=%s dimensions=%s changes=%s hash_stable=%s" % [str(version_rejected), str(dimensions_rejected), str(changes_rejected), str(data.hash() == original_hash)]
	)


func _test_raycast_down() -> void:
	var data = DataScript.new()
	data.generate(1234)
	var spawn: Vector3 = data.spawn_point()
	var x := floori(spawn.x)
	var z := floori(spawn.z)
	var top: int = data.highest_solid_y(x, z)
	var origin := Vector3(float(x) + 0.5, float(top + 3) + 0.5, float(z) + 0.5)
	var result: Dictionary = data.raycast(origin, Vector3.DOWN, 6.0)
	var block: Array = result.get("block", [])
	var previous: Array = result.get("previous", [])
	var normal: Array = result.get("normal", [])
	_check(
		"data-raycast-down",
		bool(result.get("hit", false))
		and block == [x, top, z]
		and previous == [x, top + 1, z]
		and normal == [0, 1, 0]
		and abs(float(result.get("distance", 0.0)) - 2.5) < 0.02
		and int(result.get("block_id", 0)) == data.get_block(x, top, z),
		"result=%s" % JSON.stringify(result)
	)


func _test_raycast_miss() -> void:
	var data = DataScript.new()
	data.generate(8080)
	var spawn: Vector3 = data.spawn_point()
	var result: Dictionary = data.raycast(spawn + Vector3(0.0, 0.5, 0.0), Vector3.UP, 5.0)
	_check(
		"data-raycast-miss",
		not bool(result.get("hit", true)) and (result.get("block", []) as Array).is_empty() and (result.get("previous", []) as Array).is_empty(),
		"result=%s" % JSON.stringify(result)
	)


func _test_raycast_nearest() -> void:
	var data = DataScript.new()
	data.generate(9090)
	var spawn: Vector3 = data.spawn_point()
	var x := floori(spawn.x)
	var z := floori(spawn.z)
	var top: int = data.highest_solid_y(x, z)
	var target_y := top + 2
	data.set_block(x, target_y, z, DataScript.STONE)
	var origin := Vector3(float(x) + 0.5, float(top + 3) + 0.5, float(z) + 0.5)
	var result: Dictionary = data.raycast(origin, Vector3.DOWN, 5.0)
	_check(
		"data-raycast-nearest",
		bool(result.get("hit", false))
		and result.get("block", []) == [x, target_y, z]
		and int(result.get("block_id", 0)) == DataScript.STONE
		and abs(float(result.get("distance", 0.0)) - 0.5) < 0.02,
		"result=%s" % JSON.stringify(result)
	)


func _test_hash_tracks_changes() -> void:
	var data = DataScript.new()
	data.generate(11)
	var before := data.hash()
	data.set_block(0, 0, 0, DataScript.AIR)
	var changed := data.hash()
	data.set_block(0, 0, 0, DataScript.AIR)
	var same := data.hash()
	_check("data-hash-tracks-changes", before != changed and changed == same, "before=%s changed=%s" % [before.left(12), changed.left(12)])


func _check(name: String, condition: bool, detail: String) -> void:
	if condition:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])
	results.append({"name": name, "passed": condition, "detail": detail})


func _finish() -> void:
	print("RESULT passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)
