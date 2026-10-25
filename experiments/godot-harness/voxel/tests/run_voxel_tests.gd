extends SceneTree

## Phase 19 gameplay acceptance suite.
##
## The tests drive the real main scene through the same physics loop used by
## play. They inspect world/player state and event records; they do not merely
## check that scripts or nodes exist.
##
## Run:
##   godot --headless --path experiments/godot-harness/voxel \
##     -s res://tests/run_voxel_tests.gd

const DataScript = preload("res://scripts/voxel_data.gd")
const TEST_SAVE := "user://phase19-acceptance.json"

var passed := 0
var failed := 0
var world: Node
var spawn := Vector3.ZERO
var feet_y := 0


func _initialize() -> void:
	_run()


func _run() -> void:
	var packed: PackedScene = load("res://main.tscn")
	world = packed.instantiate()
	root.add_child(world)
	await process_frame
	await physics_frame
	await _advance(8)
	spawn = _vec3(world.snapshot()["player_position"])
	feet_y = floori(spawn.y + 0.05)

	await _test_startup()
	await _test_movement()
	await _test_jump()
	await _test_collision()
	await _test_targeting()
	await _test_mining()
	await _test_placement()
	await _test_hotbar()
	await _test_rejections()
	await _test_save_load()
	await _test_invalid_saves()
	await _test_recovery_and_mouse()

	world.queue_free()
	await process_frame
	_finish()


func _test_startup() -> void:
	var snap: Dictionary = await _fresh()
	var counts: Dictionary = snap["world"]["block_counts"]
	_check(
		"startup-world",
		int(snap["world"]["width"]) == 32
		and int(snap["world"]["height"]) == 16
		and int(snap["world"]["depth"]) == 32
		and int(snap["world"]["seed"]) == 20261023
		and int(snap["world"]["chunk_count"]) == 16
		and int(snap["world"]["modified_blocks"]) == 0,
		"world=%s" % JSON.stringify(snap["world"])
	)
	_check(
		"startup-block-types",
		int(counts.get("grass", 0)) > 0
		and int(counts.get("dirt", 0)) > 0
		and int(counts.get("stone", 0)) > 0
		and int(counts.get("log", 0)) > 0
		and int(counts.get("leaves", 0)) > 0,
		"counts=%s" % JSON.stringify(counts)
	)
	_check(
		"startup-spawn-safe",
		bool(snap["grounded"])
		and _player_standing_on_solid()
		and _vec3(snap["player_position"]).distance_to(spawn) < 0.2,
		"pos=%s grounded=%s" % [str(snap["player_position"]), str(snap["grounded"])]
	)
	_check(
		"startup-hud",
		world.hud_layer != null
		and world.info_label != null
		and world.target_label != null
		and world.feedback_label != null
		and world.hotbar_entries.size() == 4
		and String(world.info_label.text).contains("VOXEL SANDBOX")
		and world.info_label.get_parent().find_child("Crosshair", false, false) != null,
		"hotbar=%d" % world.hotbar_entries.size()
	)
	_check(
		"startup-hotbar-and-inventory",
		int(snap["selected_slot"]) == 1
		and int(snap["selected_block_id"]) == DataScript.GRASS
		and int(snap["inventory"].get(DataScript.GRASS, 0)) == 16
		and bool(snap["hotbar"][0]["selected"]),
		"selected=%s inventory=%s" % [str(snap["selected_slot"]), JSON.stringify(snap["inventory"])]
	)


func _test_movement() -> void:
	var start_snap: Dictionary = await _fresh()
	var start := _vec3(start_snap["player_position"])
	var forward_snap: Dictionary = await _advance(36, {"forward": 1.0})
	var after_forward := _vec3(forward_snap["player_position"])
	var moved_forward := Vector2(after_forward.x - start.x, after_forward.z - start.z).length()
	_check(
		"movement-forward",
		moved_forward > 0.5 and bool(forward_snap["grounded"]) and absf(after_forward.y - start.y) < 0.8,
		"moved=%.3f from=%s to=%s" % [moved_forward, str(start), str(after_forward)]
	)

	start_snap = await _fresh()
	start = _vec3(start_snap["player_position"])
	var strafe_snap: Dictionary = await _advance(30, {"strafe": 1.0})
	var after_strafe := _vec3(strafe_snap["player_position"])
	var moved_strafe := Vector2(after_strafe.x - start.x, after_strafe.z - start.z).length()
	_check(
		"movement-strafe",
		moved_strafe > 0.4 and after_strafe.y > 1.0,
		"moved=%.3f from=%s to=%s grounded=%s" % [moved_strafe, str(start), str(after_strafe), str(strafe_snap["grounded"])]
	)


func _test_jump() -> void:
	var snap: Dictionary = await _fresh()
	var start_y := _vec3(snap["player_position"]).y
	var max_y := start_y
	for frame in range(34):
		world.set_harness_input({"jump": true} if frame == 0 else {})
		await physics_frame
		# physics_frame is emitted before _physics_process; wait for the tick.
		await process_frame
		max_y = maxf(max_y, world.player.global_position.y)
	var landed: Dictionary = await _advance(70)
	_check(
		"movement-jump-and-land",
		max_y > start_y + 0.7 and bool(landed["grounded"]) and absf(_vec3(landed["player_position"]).y - start_y) < 0.25,
		"start_y=%.3f max_y=%.3f landed=%s" % [start_y, max_y, str(landed["player_position"])]
	)


func _test_collision() -> void:
	var snap: Dictionary = await _fresh()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	var wall_z := sz - 1
	world.harness_setup({
		"blocks": [
			{"x": sx, "y": feet_y, "z": wall_z, "id": DataScript.STONE},
			{"x": sx, "y": feet_y + 1, "z": wall_z, "id": DataScript.STONE},
		],
	})
	var blocked: Dictionary = await _advance(60, {"forward": 1.0})
	var pos := _vec3(blocked["player_position"])
	_check(
		"collision-terrain-wall",
		pos.z >= float(wall_z) + 1.0 and bool(blocked["grounded"]),
		"wall_z=%d stopped_at=%s" % [wall_z, str(pos)]
	)


func _test_targeting() -> void:
	var snap: Dictionary = await _fresh()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	var ty := feet_y + 1
	var target_cell := Vector3i(sx, ty, sz - 2)
	var setup: Dictionary = world.harness_setup({
		"blocks": [{"x": target_cell.x, "y": target_cell.y, "z": target_cell.z, "id": DataScript.STONE}],
		"look_at": [target_cell.x, target_cell.y, target_cell.z],
	})
	var target: Dictionary = setup["target"]
	_check(
		"targeting-raycast-state",
		bool(target.get("hit", false))
		and target.get("block", []) == [target_cell.x, target_cell.y, target_cell.z]
		and int(target.get("block_id", 0)) == DataScript.STONE
		and float(target.get("distance", 0.0)) <= 6.0,
		"target=%s camera=%s" % [JSON.stringify(target), str(setup["camera_position"])]
	)
	_check(
		"targeting-highlight-and-hud",
		world.highlight.visible
		and world.highlight.global_position.distance_to(Vector3(target_cell) + Vector3(0.5, 0.5, 0.5)) < 0.01
		and String(world.target_label.text).contains("Stone"),
		"highlight=%s label=%s" % [str(world.highlight.visible), world.target_label.text]
	)
	# Looking straight up must clear the target and hide the highlight.
	snap = world.harness_setup({"yaw_deg": 0.0, "pitch_deg": 80.0})
	_check(
		"targeting-no-target",
		not bool(snap["target"].get("hit", false)) and not world.highlight.visible,
		"target=%s" % JSON.stringify(snap["target"])
	)


func _test_mining() -> void:
	await _fresh()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	# Mine a generated surface block rather than a test-placed one, so the
	# change is measured against the generated world baseline.
	var target_y := feet_y - 1
	var setup: Dictionary = world.harness_setup({"look_at": [sx, target_y, sz]})
	var target: Dictionary = setup["target"]
	var mined_id := int(target.get("block_id", DataScript.AIR))
	var before := int(world.snapshot()["inventory"].get(mined_id, 0))
	var before_modified := int(world.snapshot()["world"]["modified_blocks"])
	await _advance(1, {"actions": {"mine": true}})
	await _advance(2)
	var snap: Dictionary = world.snapshot()
	var event: Dictionary = _last_event()
	_check(
		"mining-removes-block",
		bool(target.get("hit", false))
		and target.get("block", []) == [sx, target_y, sz]
		and mined_id != DataScript.AIR
		and world.data.get_block(sx, target_y, sz) == DataScript.AIR
		and int(snap["inventory"].get(mined_id, 0)) == before + 1
		and int(snap["world"]["modified_blocks"]) == before_modified + 1
		and String(event.get("type", "")) == "block_mined"
		and event.get("block", []) == [sx, target_y, sz],
		"target=%s block=%s inventory=%s modified=%s event=%s" % [
			JSON.stringify(target),
			str(world.data.get_block(sx, target_y, sz)),
			str(snap["inventory"]),
			str(snap["world"]["modified_blocks"]),
			JSON.stringify(event),
		]
	)
	_check(
		"mining-feedback",
		String(snap["feedback"]).contains("Mined ")
		and String(event.get("block_name", "")) != ""
		and String(snap["feedback"]).contains(String(event.get("block_name", ""))),
		"feedback=%s event=%s" % [snap["feedback"], JSON.stringify(event)]
	)


func _test_placement() -> void:
	await _fresh()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	var ty := feet_y + 1
	var cell := Vector3i(sx, ty, sz - 2)
	var setup: Dictionary = world.harness_setup({
		"blocks": [{"x": cell.x, "y": cell.y, "z": cell.z, "id": DataScript.STONE}],
		"look_at": [cell.x, cell.y, cell.z],
		"selected_slot": 1,
	})
	var previous: Array = setup["target"].get("previous", [])
	var before := int(world.snapshot()["inventory"].get(DataScript.GRASS, 0))
	await _advance(1, {"actions": {"place": true}})
	await _advance(2)
	var snap: Dictionary = world.snapshot()
	var event: Dictionary = _last_event()
	var placed_id: int = -1
	if previous.size() >= 3:
		placed_id = world.data.get_block(int(previous[0]), int(previous[1]), int(previous[2]))
	_check(
		"placement-adjacent-cell",
		previous.size() >= 3
		and placed_id == DataScript.GRASS
		and int(snap["inventory"].get(DataScript.GRASS, 0)) == before - 1
		and String(event.get("type", "")) == "block_placed",
		"previous=%s placed=%d inventory=%s event=%s" % [str(previous), placed_id, JSON.stringify(snap["inventory"]), JSON.stringify(event)]
	)
	_check(
		"placement-feedback",
		String(snap["feedback"]).contains("Placed Grass"),
		"feedback=%s" % snap["feedback"]
	)


func _test_hotbar() -> void:
	await _fresh()
	var snap: Dictionary = await _advance(1, {"actions": {"select_3": true}})
	_check(
		"hotbar-number-key",
		int(snap["selected_slot"]) == 3 and int(snap["selected_block_id"]) == DataScript.STONE,
		"selected=%s" % str(snap["selected_slot"])
	)
	snap = await _advance(1, {"actions": {"hotbar_next": true}})
	_check(
		"hotbar-next",
		int(snap["selected_slot"]) == 4 and int(snap["selected_block_id"]) == DataScript.LOG,
		"selected=%s" % str(snap["selected_slot"])
	)
	var wheel := InputEventMouseButton.new()
	wheel.button_index = MOUSE_BUTTON_WHEEL_DOWN
	wheel.pressed = true
	world._unhandled_input(wheel)
	snap = world.snapshot()
	_check(
		"hotbar-mouse-wheel-wraps",
		int(snap["selected_slot"]) == 1 and bool(snap["hotbar"][0]["selected"]),
		"selected=%s" % str(snap["selected_slot"])
	)
	var setup: Dictionary = world.harness_setup({"selected_slot": 2})
	_check(
		"hotbar-selected-matches-placement-tool",
		int(setup["selected_slot"]) == 2
		and int(setup["selected_block_id"]) == DataScript.DIRT
		and String(setup["hotbar"][1]["name"]) == "DIRT"
		and bool(setup["hotbar"][1]["selected"]),
		"selected=%s block=%s" % [str(setup["selected_slot"]), setup["selected_block"]]
	)


func _test_rejections() -> void:
	await _fresh()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	var ty := feet_y + 1

	# Player-overlap placement is tested with a precise target so the rule is
	# deterministic; mining and placement above still use real ray targets.
	var before_hash: String = world.data.hash()
	world.current_target = {
		"hit": true,
		"block": [sx, ty, sz + 1],
		"previous": [sx, feet_y, sz],
		"normal": [0, 1, 0],
		"distance": 0.5,
		"block_id": DataScript.STONE,
	}
	var placed_overlap: bool = world._try_place()
	var overlap_event: Dictionary = _last_event()
	_check(
		"placement-rejects-player-overlap",
		not placed_overlap
		and String(overlap_event.get("type", "")) == "place_rejected"
		and String(overlap_event.get("reason", "")) == "player_overlap"
		and world.data.hash() == before_hash,
		"event=%s" % JSON.stringify(overlap_event)
	)

	world.current_target = {
		"hit": true,
		"block": [sx, ty, sz - 2],
		"previous": [world.data.width, ty, sz - 2],
		"normal": [-1, 0, 0],
		"distance": 1.0,
		"block_id": DataScript.STONE,
	}
	var placed_outside: bool = world._try_place()
	var outside_event: Dictionary = _last_event()
	_check(
		"placement-rejects-outside-world",
		not placed_outside and String(outside_event.get("reason", "")) == "outside_world",
		"event=%s" % JSON.stringify(outside_event)
	)

	world.current_target = {
		"hit": true,
		"block": [sx, 1, sz - 2],
		"previous": [sx, 0, sz - 2],
		"normal": [0, 1, 0],
		"distance": 1.0,
		"block_id": DataScript.STONE,
	}
	var placed_bedrock: bool = world._try_place()
	var bedrock_place_event: Dictionary = _last_event()
	_check(
		"placement-rejects-bedrock-layer",
		not placed_bedrock and String(bedrock_place_event.get("reason", "")) == "boundary_layer",
		"event=%s" % JSON.stringify(bedrock_place_event)
	)

	world.current_target = {
		"hit": true,
		"block": [sx, 0, sz - 2],
		"previous": [sx, 1, sz - 2],
		"normal": [0, -1, 0],
		"distance": 1.0,
		"block_id": DataScript.STONE,
	}
	var mined_bedrock: bool = world._try_mine()
	var bedrock_mine_event: Dictionary = _last_event()
	_check(
		"mining-rejects-bedrock",
		not mined_bedrock and String(bedrock_mine_event.get("reason", "")) == "bedrock",
		"event=%s" % JSON.stringify(bedrock_mine_event)
	)

	world.current_target = {"hit": false}
	var mined_none: bool = world._try_mine()
	var mine_none_event: Dictionary = _last_event()
	var placed_none: bool = world._try_place()
	var place_none_event: Dictionary = _last_event()
	_check(
		"targeting-rejects-empty-target",
		not mined_none and not placed_none
		and String(mine_none_event.get("reason", "")) == "no_target"
		and String(place_none_event.get("reason", "")) == "no_target",
		"mine=%s place=%s" % [JSON.stringify(mine_none_event), JSON.stringify(place_none_event)]
	)

	# Empty inventory is tested by selecting a block the player has none of.
	await _fresh()
	world.harness_setup({"inventory": {DataScript.LOG: 0}, "selected_slot": 4})
	var cell := Vector3i(sx, ty, sz - 2)
	world.harness_setup({
		"blocks": [{"x": cell.x, "y": cell.y, "z": cell.z, "id": DataScript.STONE}],
		"look_at": [cell.x, cell.y, cell.z],
	})
	var before: String = world.data.hash()
	var placed_empty: bool = world._try_place()
	var empty_event: Dictionary = _last_event()
	_check(
		"placement-rejects-empty-inventory",
		not placed_empty
		and String(empty_event.get("reason", "")) == "empty_inventory"
		and world.data.hash() == before,
		"event=%s" % JSON.stringify(empty_event)
	)


func _test_save_load() -> void:
	await _fresh()
	var sx := floori(spawn.x)
	var sz := floori(spawn.z)
	var remove_top: int = world.data.highest_solid_y(4, 4)
	var add_cell := Vector3i(sx, feet_y + 2, sz - 2)
	var inventory := {DataScript.GRASS: 7, DataScript.DIRT: 3, DataScript.STONE: 5, DataScript.LOG: 2}
	world.harness_setup({
		"blocks": [
			{"x": 4, "y": remove_top, "z": 4, "id": DataScript.AIR},
			{"x": add_cell.x, "y": add_cell.y, "z": add_cell.z, "id": DataScript.STONE},
		],
		"player_position": [spawn.x, spawn.y, spawn.z],
		"yaw_deg": 35.0,
		"pitch_deg": -11.0,
		"selected_slot": 2,
		"inventory": inventory,
	})
	var world_hash: String = world.data.hash()
	var saved_position := _vec3(world.snapshot()["player_position"])
	var saved_harness_hash: String = world.harness_hash()
	var save_result: Dictionary = world.save_world()
	var saved_bytes := int(save_result.get("bytes", 0))
	var save_path := String(world.save_store.path)
	var absolute_path := String(world.save_store.absolute_path())
	_check(
		"save-writes-outside-repository",
		bool(save_result.get("ok", false))
		and world.save_store.exists()
		and saved_bytes > 100
		and save_path.begins_with("user://")
		and not absolute_path.to_lower().begins_with("c:\\users\\hacke\\ai-native-engine-phase19"),
		"result=%s path=%s absolute=%s" % [JSON.stringify(save_result), save_path, absolute_path]
	)

	world.harness_reset()
	var reset_hash: String = world.data.hash()
	var reset_harness_hash: String = world.harness_hash()
	var loaded: Dictionary = world.load_world()
	var after: Dictionary = world.snapshot()
	_check(
		"load-restores-world-and-player",
		reset_hash != world_hash
		and bool(loaded.get("ok", false))
		and world.data.hash() == world_hash
		and _vec3(after["player_position"]).distance_to(saved_position) < 0.01
		and int(after["selected_slot"]) == 2
		and int(after["inventory"].get(DataScript.GRASS, 0)) == 7
		and int(after["world"]["modified_blocks"]) == 2
		and String(after["last_event_type"]) == "world_loaded",
		"loaded=%s hash_match=%s pos=%s modified=%s" % [
			JSON.stringify(loaded),
			str(world.data.hash() == world_hash),
			str(after["player_position"]),
			str(after["world"]["modified_blocks"]),
		]
	)
	_check(
		"load-restores-harness-hash",
		reset_harness_hash != saved_harness_hash
		and world.harness_hash() == saved_harness_hash,
		"saved=%s reset=%s loaded=%s" % [
			saved_harness_hash.left(12),
			reset_harness_hash.left(12),
			world.harness_hash().left(12),
		]
	)
	_check(
		"load-feedback-and-hud",
		String(after["feedback"]).contains("Loaded 2 changed blocks")
		and String(world.status_label.text).contains("Changed blocks  2"),
		"feedback=%s status=%s" % [after["feedback"], world.status_label.text]
	)


func _test_invalid_saves() -> void:
	await _fresh()
	world.load_world()
	var missing: Dictionary = world.last_save_status.duplicate(true)
	var missing_hash: String = world.data.hash()
	_check(
		"load-missing-save-safe",
		String(missing.get("code", "")) == "MISSING"
		and String(world.last_event_type) == "load_rejected"
		and world.data.hash() == missing_hash,
		"status=%s" % JSON.stringify(missing)
	)

	world.save_store.write_raw("{ this is not json")
	var invalid_json_hash: String = world.data.hash()
	var invalid_json_status: Dictionary = world.load_world()
	_check(
		"load-invalid-json-safe",
		String(invalid_json_status.get("code", "")) == "INVALID_JSON"
		and world.data.hash() == invalid_json_hash,
		"status=%s" % JSON.stringify(invalid_json_status)
	)

	var document: Dictionary = {
		"version": 1,
		"world": {
			"version": 1,
			"world": {"width": 32, "height": 16, "depth": 32, "seed": 20261023},
			"changes": [{"x": -1, "y": 99, "z": 0, "id": DataScript.STONE}],
		},
	}
	world.save_store.write_raw(JSON.stringify(document))
	var invalid_world_hash: String = world.data.hash()
	var invalid_world_status: Dictionary = world.load_world()
	_check(
		"load-invalid-world-atomic",
		String(invalid_world_status.get("code", "")) == "INVALID_WORLD"
		and world.data.hash() == invalid_world_hash
		and String(world.last_event_type) == "load_rejected",
		"status=%s" % JSON.stringify(invalid_world_status)
	)


func _test_recovery_and_mouse() -> void:
	var snap: Dictionary = await _fresh()
	world.harness_setup({"player_position": [spawn.x, -20.0, spawn.z]})
	await _advance(2)
	snap = world.snapshot()
	_check(
		"player-fall-recovery",
		_vec3(snap["player_position"]).y > 0.0
		and String(snap["last_event_type"]) == "player_recovered",
		"pos=%s event=%s" % [str(snap["player_position"]), snap["last_event_type"]]
	)

	world.harness_setup({"player_position": [-5.0, spawn.y, -5.0]})
	await _advance(2)
	snap = world.snapshot()
	var clamped := _vec3(snap["player_position"])
	_check(
		"player-boundary-clamp",
		clamped.x >= 0.44 and clamped.x <= 31.56 and clamped.z >= 0.44 and clamped.z <= 31.56,
		"pos=%s" % str(clamped)
	)

	snap = await _advance(1, {"actions": {"release_mouse": true}})
	var released := not bool(snap["mouse_captured"]) and String(snap["feedback"]).contains("Mouse released")
	snap = await _advance(1, {"actions": {"capture_mouse": true}})
	var captured := bool(snap["mouse_captured"]) and String(snap["feedback"]).contains("Mouse captured")
	_check(
		"mouse-release-and-recapture",
		released and captured,
		"released=%s captured=%s feedback=%s" % [str(released), str(captured), snap["feedback"]]
	)


func _fresh() -> Dictionary:
	world.harness_setup({"save_path": TEST_SAVE, "delete_save": true})
	world.harness_reset()
	return await _advance(8)


func _advance(frames: int, input: Dictionary = {}) -> Dictionary:
	world.set_harness_input(input)
	for _frame in range(frames):
		await physics_frame
	await process_frame
	return world.snapshot()


func _player_standing_on_solid() -> bool:
	var pos: Vector3 = world.player.global_position
	var below := floori(pos.y - 0.08)
	return world.data.get_block(floori(pos.x), below, floori(pos.z)) != DataScript.AIR


func _last_event() -> Dictionary:
	var events: Array = world.harness_events(0)
	return events[events.size() - 1] if not events.is_empty() else {}


func _vec3(value) -> Vector3:
	if value is Vector3:
		return value
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return Vector3.ZERO


func _check(name: String, condition: bool, detail: String) -> void:
	if condition:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])


func _finish() -> void:
	print("RESULT passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)
