extends Node3D

## Phase 19 - small first-person voxel sandbox.
##
## The world data, chunk meshes, player controller, HUD, and save store are
## separate scripts. This node owns the real-time loop, the harness surface, and
## the gameplay rules (targeting, mining, placement, inventory, persistence).

const PlayerScript = preload("res://scripts/voxel_player.gd")
const SaveStoreScript = preload("res://scripts/voxel_save_store.gd")
const ChunkBuilder = preload("res://scripts/voxel_chunk_builder.gd")

const WORLD_SEED := 20261023
const WORLD_WIDTH := 32
const WORLD_HEIGHT := 16
const WORLD_DEPTH := 32
const CHUNK_SIZE := 8
const REACH := 6.0
const MAX_EVENTS := 200
const STARTING_BLOCKS := 16
const DEFAULT_SAVE_PATH := "user://voxel_save.json"
const BEDROCK_Y := 0
const PLAYER_BOUNDARY_MARGIN := 0.45
const MAX_FALL_Y := -6.0
const MOUSE_SENSITIVITY := 0.0025
const KEY_TURN_RATE := 1.7

const HOTBAR := [
	{"slot": 1, "id": VoxelWorldData.GRASS, "name": "GRASS", "color": Color(0.32, 0.67, 0.29)},
	{"slot": 2, "id": VoxelWorldData.DIRT, "name": "DIRT", "color": Color(0.48, 0.33, 0.20)},
	{"slot": 3, "id": VoxelWorldData.STONE, "name": "STONE", "color": Color(0.52, 0.54, 0.57)},
	{"slot": 4, "id": VoxelWorldData.LOG, "name": "LOG", "color": Color(0.43, 0.28, 0.13)},
]

var data: VoxelWorldData
var player: VoxelPlayer
var save_store: VoxelSaveStore
var material: StandardMaterial3D
var chunk_root: Node3D
var chunks: Dictionary = {}
var highlight: MeshInstance3D
var sun: DirectionalLight3D

var step := 0
var sim_time := 0.0
var inventory: Dictionary = {}
var selected_slot := 1
var current_target: Dictionary = {}
var events: Array = []
var event_sequence := 0
var last_event_type := ""
var feedback_text := ""
var feedback_kind := "info"
var feedback_ticks := 0
var modified_blocks := 0
var mouse_captured := true
var last_save_status: Dictionary = {}
var harness_mode := false
var harness_input: Dictionary = {}
var previous_actions: Dictionary = {}

var hud_layer: CanvasLayer
var info_label: Label
var status_label: Label
var target_label: Label
var feedback_label: Label
var hotbar_box: HBoxContainer
var hotbar_entries: Array = []


func _ready() -> void:
	add_to_group("harness_game")
	process_mode = Node.PROCESS_MODE_PAUSABLE
	_ensure_input_actions()
	_build_environment()
	data = VoxelWorldData.new(WORLD_WIDTH, WORLD_HEIGHT, WORLD_DEPTH)
	data.generate(WORLD_SEED)
	modified_blocks = 0
	_build_chunks()
	_build_player()
	_build_highlight()
	_build_hud()
	save_store = SaveStoreScript.new(DEFAULT_SAVE_PATH)
	_reset_runtime_state(false)
	mouse_captured = true
	Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
	_set_feedback("Voxel Sandbox ready. WASD move, Space jump, LMB mine, RMB place.", 180, "info")


# ---------------------------------------------------------------------------
# Public harness surface
# ---------------------------------------------------------------------------

func set_harness_input(values: Dictionary) -> Dictionary:
	harness_mode = true
	# Each call is a complete input frame; omitted fields are neutral.
	harness_input = {
		"forward": 0.0,
		"strafe": 0.0,
		"jump": false,
		"restart": false,
	}
	if values.has("forward"):
		harness_input["forward"] = clampf(float(values["forward"]), -1.0, 1.0)
	if values.has("strafe"):
		harness_input["strafe"] = clampf(float(values["strafe"]), -1.0, 1.0)
	if values.has("jump"):
		harness_input["jump"] = bool(values["jump"])
	if values.has("restart"):
		harness_input["restart"] = bool(values["restart"])
	var actions = values.get("actions", {})
	if actions is Dictionary:
		for key in actions:
			harness_input[key] = bool(actions[key])
	# Direct GDScript callers may pass action names at the top level.
	for key in ["mine", "place", "save", "load", "reset", "hotbar_next", "hotbar_prev",
			"select_1", "select_2", "select_3", "select_4",
			"look_left", "look_right", "look_up", "look_down",
			"release_mouse", "capture_mouse"]:
		if values.has(key):
			harness_input[key] = bool(values[key])
	return harness_input.duplicate(true)


func harness_reset() -> Dictionary:
	harness_mode = true
	_regenerate_world(WORLD_SEED)
	return snapshot()


func harness_step(delta: float = 1.0 / 60.0) -> Dictionary:
	_tick(delta)
	return snapshot()


func harness_setup(values: Dictionary) -> Dictionary:
	harness_mode = true
	if values.has("save_path"):
		save_store.set_path(String(values["save_path"]))
	if values.has("delete_save"):
		save_store.delete_save()
	if values.has("world_seed"):
		_regenerate_world(int(values["world_seed"]))
	if values.has("clear_inventory"):
		inventory = _empty_inventory()
	if values.has("inventory") and values["inventory"] is Dictionary:
		for key in values["inventory"]:
			inventory[int(key)] = maxi(0, int(values["inventory"][key]))
	if values.has("selected_slot"):
		selected_slot = clampi(int(values["selected_slot"]), 1, HOTBAR.size())
	if values.has("blocks") and values["blocks"] is Array:
		for entry in values["blocks"]:
			if entry is Dictionary:
				data.set_block(int(entry.get("x", 0)), int(entry.get("y", 0)), int(entry.get("z", 0)), int(entry.get("id", 0)))
		_refresh_modified_count()
		_rebuild_all_chunks()
	if values.has("player_position"):
		player.global_position = _to_vector3(values["player_position"])
		player.velocity = Vector3.ZERO
		player.force_update_transform()
	if values.has("yaw_deg") or values.has("pitch_deg"):
		var yaw_deg := rad_to_deg(player.yaw)
		var pitch_deg := rad_to_deg(player.pitch)
		if values.has("yaw_deg"):
			yaw_deg = float(values["yaw_deg"])
		if values.has("pitch_deg"):
			pitch_deg = float(values["pitch_deg"])
		player.set_look(yaw_deg, pitch_deg)
	if values.has("look_at") and values["look_at"] is Array and values["look_at"].size() >= 3:
		_look_at_block(_to_vector3(values["look_at"]))
	player.force_update_transform()
	_update_target()
	_update_hud()
	return snapshot()


func snapshot() -> Dictionary:
	var counts := data.counts()
	var target_data := current_target.duplicate(true)
	if bool(target_data.get("hit", false)):
		target_data["block_name"] = _block_name(int(target_data.get("block_id", 0)))
	var hotbar_state: Array = []
	for entry in HOTBAR:
		var block_id: int = int(entry["id"])
		hotbar_state.append({
			"slot": int(entry["slot"]),
			"block_id": block_id,
			"name": String(entry["name"]),
			"count": int(inventory.get(block_id, 0)),
			"selected": int(entry["slot"]) == selected_slot,
		})
	return {
		"step": step,
		"sim_time_seconds": sim_time,
		"physics_frames": Engine.get_physics_frames(),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"player_position": _vec3(player.global_position),
		"player_velocity": _vec3(player.velocity),
		"grounded": player.is_on_floor(),
		"player_facing_deg": rad_to_deg(player.yaw),
		"camera_position": _vec3(player.camera_position()),
		"camera_forward": _vec3(player.look_direction()),
		"camera_pitch_deg": rad_to_deg(player.pitch),
		"target": target_data,
		"target_block": target_data.get("block", []),
		"target_block_id": int(target_data.get("block_id", 0)),
		"target_distance": float(target_data.get("distance", 0.0)),
		"target_normal": target_data.get("normal", []),
		"selected_slot": selected_slot,
		"selected_block_id": int(_selected_entry()["id"]),
		"selected_block": String(_selected_entry()["name"]),
		"inventory": inventory.duplicate(true),
		"hotbar": hotbar_state,
		"world": {
			"width": data.width,
			"height": data.height,
			"depth": data.depth,
			"seed": data.world_seed,
			"block_counts": counts,
			"modified_blocks": modified_blocks,
			"chunk_count": chunks.size(),
		},
		"save": {
			"path": save_store.path,
			"absolute_path": save_store.absolute_path(),
			"exists": save_store.exists(),
			"last_status": last_save_status.duplicate(true),
		},
		"last_event_type": last_event_type,
		"events_count": events.size(),
		"events": events.duplicate(true),
		"feedback": feedback_text,
		"mouse_captured": mouse_captured,
		"performance": _performance_state(),
		"hud": _hud_text(),
		"hash": harness_hash(),
	}


func harness_events(since_tick: int = 0) -> Array:
	var result: Array = []
	for event in events:
		if int(event.get("tick", 0)) >= since_tick:
			result.append(event.duplicate(true))
	return result


## Fingerprint of the state a save/load round trip is expected to restore.
##
## Deliberately excludes harness-only counters (`step`) and transient physics
## state (`velocity`): after a reset+load the tick counter restarts at zero, so
## including it would make two identical worlds hash differently and turn a
## persistence check into a tick-count check.
func harness_hash() -> String:
	var position := player.global_position
	var fields: Array[String] = [
		"player=%.9f,%.9f,%.9f" % [position.x, position.y, position.z],
		"look=%.9f,%.9f" % [player.yaw, player.pitch],
		"selected=%d" % selected_slot,
		"inventory=%s" % JSON.stringify(inventory),
		"modified=%d" % modified_blocks,
		"world=%s" % data.hash(),
	]
	return "\n".join(fields).sha256_text()


# ---------------------------------------------------------------------------
# Physics loop and gameplay
# ---------------------------------------------------------------------------

func _physics_process(delta: float) -> void:
	_tick(delta)


func _tick(delta: float) -> void:
	step += 1
	sim_time += delta

	var forward := 0.0
	var strafe := 0.0
	var jump_pressed := false
	var restart_pressed := false

	if harness_mode:
		forward = float(harness_input.get("forward", 0.0))
		strafe = float(harness_input.get("strafe", 0.0))
		jump_pressed = bool(harness_input.get("jump", false))
		restart_pressed = bool(harness_input.get("restart", false))
	else:
		forward = Input.get_action_strength("move_forward") - Input.get_action_strength("move_back")
		strafe = Input.get_action_strength("move_right") - Input.get_action_strength("move_left")
		jump_pressed = Input.is_action_just_pressed("jump")
		restart_pressed = Input.is_action_just_pressed("reset_world")

	if restart_pressed:
		_regenerate_world(WORLD_SEED)
		return

	# Look actions. Mouse motion is handled by _unhandled_input.
	if _action_held("look_left"):
		player.add_look(KEY_TURN_RATE * delta, 0.0)
	if _action_held("look_right"):
		player.add_look(-KEY_TURN_RATE * delta, 0.0)
	if _action_held("look_up"):
		player.add_look(0.0, KEY_TURN_RATE * delta)
	if _action_held("look_down"):
		player.add_look(0.0, -KEY_TURN_RATE * delta)

	player.step_movement(delta, forward, strafe, jump_pressed)
	_clamp_player_to_world()

	if player.global_position.y < MAX_FALL_Y:
		_handle_fall_out_of_world()

	if _action_pressed("release_mouse", "release_mouse"):
		mouse_captured = false
		Input.mouse_mode = Input.MOUSE_MODE_VISIBLE
		_set_feedback("Mouse released. Click the window to recapture.", 120, "info")
	if _action_pressed("capture_mouse", ""):
		mouse_captured = true
		Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
		_set_feedback("Mouse captured.", 90, "info")

	for index in range(HOTBAR.size()):
		if _action_pressed("select_%d" % (index + 1), "hotbar_%d" % (index + 1)):
			_select_slot(index + 1)
	if _action_pressed("hotbar_next", ""):
		_select_slot(selected_slot + 1)
	if _action_pressed("hotbar_prev", ""):
		_select_slot(selected_slot - 1)

	_update_target()

	if _action_pressed("mine", "mine"):
		_try_mine()
	if _action_pressed("place", "place"):
		_try_place()
	if _action_pressed("save", "save_world"):
		save_world()
	if _action_pressed("load", "load_world"):
		load_world()

	if feedback_ticks > 0:
		feedback_ticks -= 1
		if feedback_ticks == 0:
			feedback_text = ""
	_update_hud()
	_clear_action_edges()


func _action_pressed(harness_name: String, live_action: String) -> bool:
	if harness_mode:
		var current := bool(harness_input.get(harness_name, false))
		var was := bool(previous_actions.get(harness_name, false))
		previous_actions[harness_name] = current
		return current and not was
	if live_action.is_empty():
		return false
	return Input.is_action_just_pressed(live_action)


func _action_held(harness_name: String) -> bool:
	if harness_mode:
		return bool(harness_input.get(harness_name, false))
	return false


func _clear_action_edges() -> void:
	if harness_mode:
		for key in harness_input:
			if typeof(harness_input[key]) == TYPE_BOOL:
				previous_actions[key] = bool(harness_input[key])


func _clamp_player_to_world() -> void:
	var pos := player.global_position
	pos.x = clampf(pos.x, PLAYER_BOUNDARY_MARGIN, float(data.width) - PLAYER_BOUNDARY_MARGIN)
	pos.z = clampf(pos.z, PLAYER_BOUNDARY_MARGIN, float(data.depth) - PLAYER_BOUNDARY_MARGIN)
	player.global_position = pos


func _handle_fall_out_of_world() -> void:
	player.reset_at(data.spawn_point(), rad_to_deg(player.yaw), rad_to_deg(player.pitch))
	_set_feedback("Recovered from below the world.", 120, "reject")
	_record("player_recovered", {"reason": "fell_out_of_world"})


func _update_target() -> void:
	var result := data.raycast(player.camera_position(), player.look_direction(), REACH)
	current_target = result
	if bool(result.get("hit", false)):
		var block: Array = result["block"]
		highlight.visible = true
		highlight.global_position = Vector3(float(block[0]) + 0.5, float(block[1]) + 0.5, float(block[2]) + 0.5)
	else:
		highlight.visible = false


func _try_mine() -> bool:
	if not bool(current_target.get("hit", false)):
		_reject("mine", "no_target", "Mine rejected: no block in reach.")
		return false
	var block: Array = current_target["block"]
	var x := int(block[0])
	var y := int(block[1])
	var z := int(block[2])
	if y <= BEDROCK_Y:
		_reject("mine", "bedrock", "Mine rejected: bedrock layer is protected.")
		return false
	var block_id := data.get_block(x, y, z)
	if block_id == VoxelWorldData.AIR:
		_reject("mine", "empty", "Mine rejected: target is empty.")
		return false
	if not data.set_block(x, y, z, VoxelWorldData.AIR):
		_reject("mine", "write_failed", "Mine rejected: world write failed.")
		return false
	_rebuild_affected(x, z)
	inventory[block_id] = int(inventory.get(block_id, 0)) + 1
	_refresh_modified_count()
	_update_target()
	_set_feedback("Mined %s at (%d, %d, %d). +1 inventory." % [_block_name(block_id), x, y, z], 150, "success")
	_record("block_mined", {
		"block": [x, y, z],
		"block_id": block_id,
		"block_name": _block_name(block_id),
		"inventory_count": int(inventory.get(block_id, 0)),
		"modified_blocks": modified_blocks,
	})
	return true


func _try_place() -> bool:
	if not bool(current_target.get("hit", false)):
		_reject("place", "no_target", "Place rejected: no block in reach.")
		return false
	var previous: Array = current_target.get("previous", [])
	if previous.size() < 3:
		_reject("place", "no_previous", "Place rejected: no adjacent cell.")
		return false
	var x := int(previous[0])
	var y := int(previous[1])
	var z := int(previous[2])
	if not data.is_inside(x, y, z):
		_reject("place", "outside_world", "Place rejected: outside the world boundary.")
		return false
	if y <= BEDROCK_Y or y >= data.height:
		_reject("place", "boundary_layer", "Place rejected: protected world boundary.")
		return false
	if data.get_block(x, y, z) != VoxelWorldData.AIR:
		_reject("place", "occupied", "Place rejected: target cell is occupied.")
		return false
	if _placement_overlaps_player(x, y, z):
		_reject("place", "player_overlap", "Place rejected: that cell intersects the player.")
		return false
	var entry := _selected_entry()
	var block_id: int = int(entry["id"])
	if int(inventory.get(block_id, 0)) <= 0:
		_reject("place", "empty_inventory", "Place rejected: no %s blocks left." % entry["name"])
		return false
	if not data.set_block(x, y, z, block_id):
		_reject("place", "write_failed", "Place rejected: world write failed.")
		return false
	_rebuild_affected(x, z)
	inventory[block_id] = int(inventory.get(block_id, 0)) - 1
	_refresh_modified_count()
	_update_target()
	_set_feedback("Placed %s at (%d, %d, %d). -1 inventory." % [_block_name(block_id), x, y, z], 150, "success")
	_record("block_placed", {
		"block": [x, y, z],
		"block_id": block_id,
		"block_name": _block_name(block_id),
		"selected_slot": selected_slot,
		"inventory_count": int(inventory.get(block_id, 0)),
		"modified_blocks": modified_blocks,
	})
	return true


func _placement_overlaps_player(x: int, y: int, z: int) -> bool:
	var block_min := Vector3(float(x), float(y), float(z))
	var block_max := block_min + Vector3.ONE
	var feet := player.global_position
	var player_min := Vector3(feet.x - 0.38, feet.y - 0.04, feet.z - 0.38)
	var player_max := Vector3(feet.x + 0.38, feet.y + 1.82, feet.z + 0.38)
	return (
		block_min.x < player_max.x and block_max.x > player_min.x
		and block_min.y < player_max.y and block_max.y > player_min.y
		and block_min.z < player_max.z and block_max.z > player_min.z
	)


func _select_slot(slot: int) -> void:
	var wrapped := (slot - 1) % HOTBAR.size()
	if wrapped < 0:
		wrapped += HOTBAR.size()
	var next_slot := wrapped + 1
	if next_slot == selected_slot:
		return
	selected_slot = next_slot
	var entry := _selected_entry()
	_set_feedback("Selected %s (%d/%d)." % [entry["name"], int(inventory.get(int(entry["id"]), 0)), HOTBAR.size()], 100, "info")
	_record("hotbar_selected", {
		"selected_slot": selected_slot,
		"selected_block_id": int(entry["id"]),
		"selected_block": String(entry["name"]),
	})
	_update_hud()


func _selected_entry() -> Dictionary:
	return HOTBAR[selected_slot - 1]


# ---------------------------------------------------------------------------
# Save and load
# ---------------------------------------------------------------------------

func save_world() -> Dictionary:
	var document := {
		"schema": "phase19.voxel.save.v1",
		"saved_at": Time.get_datetime_string_from_system(true) + "Z",
		"world": data.to_save_dict(),
		"player": {
			"position": _vec3(player.global_position),
			"yaw_deg": rad_to_deg(player.yaw),
			"pitch_deg": rad_to_deg(player.pitch),
			"selected_slot": selected_slot,
			"inventory": inventory.duplicate(true),
		},
	}
	var result := save_store.save(document)
	last_save_status = result
	if bool(result.get("ok", false)):
		_set_feedback("Saved %d changed blocks to %s." % [modified_blocks, save_store.path], 180, "success")
		_record("world_saved", {
			"path": save_store.path,
			"bytes": int(result.get("bytes", 0)),
			"modified_blocks": modified_blocks,
			"sha256": String(result.get("sha256", "")),
		})
	else:
		_set_feedback("Save failed: %s" % result.get("message", "unknown error"), 180, "reject")
		_record("save_rejected", {"code": result.get("code", "error"), "message": result.get("message", "")})
	return result


func load_world() -> Dictionary:
	var loaded := save_store.load_document()
	if not bool(loaded.get("ok", false)):
		last_save_status = loaded
		_set_feedback("Load failed: %s" % loaded.get("message", "missing save"), 180, "reject")
		_record("load_rejected", {"code": loaded.get("code", "error"), "message": loaded.get("message", "")})
		return loaded
	var document: Dictionary = loaded["data"]
	var world_document = document.get("world", {})
	if typeof(world_document) != TYPE_DICTIONARY:
		var invalid := {
			"ok": false,
			"code": "INVALID_DOCUMENT",
			"message": "Save document has no world object.",
			"path": save_store.path,
		}
		last_save_status = invalid
		_set_feedback("Load failed: invalid save document.", 180, "reject")
		_record("load_rejected", {"code": "INVALID_DOCUMENT", "message": "missing world object"})
		return invalid
	if not data.apply_save(world_document):
		var rejected := {
			"ok": false,
			"code": "INVALID_WORLD",
			"message": "Saved world failed validation.",
			"path": save_store.path,
		}
		last_save_status = rejected
		_set_feedback("Load failed: saved world is invalid; current world kept.", 180, "reject")
		_record("load_rejected", {"code": "INVALID_WORLD", "message": "world validation failed"})
		return rejected

	var player_doc = document.get("player", {})
	if typeof(player_doc) == TYPE_DICTIONARY:
		if player_doc.has("inventory") and typeof(player_doc["inventory"]) == TYPE_DICTIONARY:
			var restored := _empty_inventory()
			for key in player_doc["inventory"]:
				var id := int(key)
				if id >= VoxelWorldData.GRASS and id <= VoxelWorldData.LEAVES:
					restored[id] = clampi(int(player_doc["inventory"][key]), 0, 9999)
			inventory = restored
		selected_slot = clampi(int(player_doc.get("selected_slot", 1)), 1, HOTBAR.size())
		var saved_position = player_doc.get("position", [])
		if saved_position is Array and saved_position.size() >= 3:
			var candidate := _to_vector3(saved_position)
			if _safe_player_position(candidate):
				player.reset_at(
					candidate,
					float(player_doc.get("yaw_deg", 0.0)),
					float(player_doc.get("pitch_deg", -14.0))
				)
			else:
				player.reset_at(data.spawn_point(), 24.0, -18.0)
		else:
			player.reset_at(data.spawn_point(), 24.0, -18.0)
	else:
		player.reset_at(data.spawn_point(), 24.0, -18.0)

	_rebuild_all_chunks()
	_refresh_modified_count()
	_update_target()
	_update_hud()
	last_save_status = {
		"ok": true,
		"code": "LOADED",
		"message": "Loaded world and player state.",
		"path": save_store.path,
	}
	_set_feedback("Loaded %d changed blocks from %s." % [modified_blocks, save_store.path], 180, "success")
	_record("world_loaded", {
		"path": save_store.path,
		"modified_blocks": modified_blocks,
		"player_position": _vec3(player.global_position),
	})
	return last_save_status


func _safe_player_position(candidate: Vector3) -> bool:
	if not is_finite(candidate.x) or not is_finite(candidate.y) or not is_finite(candidate.z):
		return false
	if candidate.x < 0.0 or candidate.x > float(data.width):
		return false
	if candidate.z < 0.0 or candidate.z > float(data.depth):
		return false
	if candidate.y < 0.0 or candidate.y > float(data.height + 8):
		return false
	return true


# ---------------------------------------------------------------------------
# Reset and regeneration
# ---------------------------------------------------------------------------

func _regenerate_world(seed_value: int) -> void:
	data.generate(seed_value)
	_rebuild_all_chunks()
	_reset_runtime_state(true)
	_set_feedback("World regenerated (seed %d)." % seed_value, 150, "info")


func _reset_runtime_state(record_reset: bool) -> void:
	step = 0
	sim_time = 0.0
	inventory = _empty_inventory()
	selected_slot = 1
	current_target = {}
	events.clear()
	event_sequence = 0
	last_event_type = ""
	feedback_text = ""
	feedback_kind = "info"
	feedback_ticks = 0
	harness_input = {}
	previous_actions = {}
	modified_blocks = data.changed_blocks().size() if data != null else 0
	player.reset_at(data.spawn_point(), 24.0, -18.0)
	player.force_update_transform()
	_update_target()
	_update_hud()
	if record_reset:
		_record("world_reset", {"seed": data.world_seed, "spawn": _vec3(player.global_position)})


func _empty_inventory() -> Dictionary:
	return {
		VoxelWorldData.GRASS: STARTING_BLOCKS,
		VoxelWorldData.DIRT: STARTING_BLOCKS,
		VoxelWorldData.STONE: STARTING_BLOCKS,
		VoxelWorldData.LOG: STARTING_BLOCKS,
	}


func _look_at_block(block: Vector3) -> void:
	var eye := player.global_position + Vector3(0.0, VoxelPlayer.EYE_HEIGHT, 0.0)
	var target := block + Vector3(0.5, 0.5, 0.5)
	var direction := (target - eye).normalized()
	var yaw_degrees := rad_to_deg(atan2(-direction.x, -direction.z))
	var pitch_degrees := rad_to_deg(asin(clampf(direction.y, -1.0, 1.0)))
	player.set_look(yaw_degrees, pitch_degrees)


# ---------------------------------------------------------------------------
# Chunk lifecycle
# ---------------------------------------------------------------------------

func _build_chunks() -> void:
	chunk_root = Node3D.new()
	chunk_root.name = "ChunkRoot"
	add_child(chunk_root)
	material = StandardMaterial3D.new()
	material.resource_name = "VoxelMaterial"
	material.vertex_color_use_as_albedo = true
	material.roughness = 0.94
	material.metallic = 0.0
	material.specular_mode = BaseMaterial3D.SPECULAR_DISABLED
	material.cull_mode = BaseMaterial3D.CULL_BACK
	for cx in range(0, data.width, CHUNK_SIZE):
		for cz in range(0, data.depth, CHUNK_SIZE):
			_create_chunk(cx, cz)


func _create_chunk(chunk_x: int, chunk_z: int) -> void:
	var result = ChunkBuilder.build(data, chunk_x, chunk_z, CHUNK_SIZE, CHUNK_SIZE)
	var mesh_instance := MeshInstance3D.new()
	mesh_instance.name = "Mesh_%d_%d" % [chunk_x, chunk_z]
	mesh_instance.mesh = result["mesh"]
	mesh_instance.material_override = material
	mesh_instance.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_ON
	chunk_root.add_child(mesh_instance)

	var body := StaticBody3D.new()
	body.name = "Body_%d_%d" % [chunk_x, chunk_z]
	body.collision_layer = 1
	body.collision_mask = 0
	var shape_node := CollisionShape3D.new()
	shape_node.name = "Collision"
	var shape := ConcavePolygonShape3D.new()
	shape.set_faces(result["collision_faces"])
	shape_node.shape = shape
	body.add_child(shape_node)
	chunk_root.add_child(body)

	chunks[Vector2i(chunk_x, chunk_z)] = {
		"mesh_instance": mesh_instance,
		"body": body,
		"shape_node": shape_node,
		"shape": shape,
		"visible_faces": int(result["visible_faces"]),
	}


func _rebuild_all_chunks() -> void:
	for key in chunks:
		_rebuild_chunk(key.x, key.y)


func _rebuild_chunk(chunk_x: int, chunk_z: int) -> void:
	var key := Vector2i(chunk_x, chunk_z)
	if not chunks.has(key):
		return
	var result = ChunkBuilder.build(data, chunk_x, chunk_z, CHUNK_SIZE, CHUNK_SIZE)
	var record: Dictionary = chunks[key]
	record["mesh_instance"].mesh = result["mesh"]
	var shape := ConcavePolygonShape3D.new()
	shape.set_faces(result["collision_faces"])
	record["shape_node"].shape = shape
	record["shape"] = shape
	record["visible_faces"] = int(result["visible_faces"])


func _rebuild_affected(x: int, z: int) -> void:
	var chunk_x := int(floor(float(x) / float(CHUNK_SIZE))) * CHUNK_SIZE
	var chunk_z := int(floor(float(z) / float(CHUNK_SIZE))) * CHUNK_SIZE
	_rebuild_chunk(chunk_x, chunk_z)
	if x % CHUNK_SIZE == 0:
		_rebuild_chunk(chunk_x - CHUNK_SIZE, chunk_z)
	if (x + 1) % CHUNK_SIZE == 0:
		_rebuild_chunk(chunk_x + CHUNK_SIZE, chunk_z)
	if z % CHUNK_SIZE == 0:
		_rebuild_chunk(chunk_x, chunk_z - CHUNK_SIZE)
	if (z + 1) % CHUNK_SIZE == 0:
		_rebuild_chunk(chunk_x, chunk_z + CHUNK_SIZE)


func _refresh_modified_count() -> void:
	modified_blocks = data.changed_blocks().size()


# ---------------------------------------------------------------------------
# Scene construction
# ---------------------------------------------------------------------------

func _build_environment() -> void:
	var environment := Environment.new()
	environment.background_mode = Environment.BG_SKY
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_SKY
	environment.ambient_light_energy = 0.72
	environment.tonemap_mode = Environment.TONE_MAPPER_ACES
	environment.fog_enabled = true
	environment.fog_light_color = Color(0.67, 0.79, 0.91)
	environment.fog_density = 0.006
	environment.fog_sky_affect = 0.2
	var sky := Sky.new()
	var sky_material := ProceduralSkyMaterial.new()
	sky_material.sky_top_color = Color(0.25, 0.50, 0.80)
	sky_material.sky_horizon_color = Color(0.73, 0.84, 0.93)
	sky_material.ground_bottom_color = Color(0.19, 0.24, 0.27)
	sky_material.ground_horizon_color = Color(0.55, 0.65, 0.68)
	sky_material.sun_angle_max = 20.0
	sky.sky_material = sky_material
	environment.sky = sky
	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	world_environment.environment = environment
	add_child(world_environment)

	sun = DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-52.0, -32.0, 0.0)
	sun.light_color = Color(1.0, 0.95, 0.84)
	sun.light_energy = 1.15
	sun.shadow_enabled = true
	sun.directional_shadow_max_distance = 60.0
	add_child(sun)


func _build_player() -> void:
	player = PlayerScript.new()
	add_child(player)
	player.reset_at(data.spawn_point(), 24.0, -18.0)


func _build_highlight() -> void:
	highlight = MeshInstance3D.new()
	highlight.name = "TargetHighlight"
	var box := BoxMesh.new()
	box.size = Vector3(1.035, 1.035, 1.035)
	highlight.mesh = box
	var mat := StandardMaterial3D.new()
	mat.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	mat.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	mat.albedo_color = Color(1.0, 0.86, 0.24, 0.38)
	mat.cull_mode = BaseMaterial3D.CULL_DISABLED
	mat.render_priority = 1
	highlight.material_override = mat
	highlight.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	highlight.visible = false
	add_child(highlight)


func _build_hud() -> void:
	hud_layer = CanvasLayer.new()
	hud_layer.name = "HUD"
	add_child(hud_layer)
	var root := Control.new()
	root.name = "HUDRoot"
	root.set_anchors_and_offsets_preset(Control.PRESET_FULL_RECT)
	root.mouse_filter = Control.MOUSE_FILTER_IGNORE
	hud_layer.add_child(root)

	info_label = _make_label(root, "", 16, Color(0.96, 0.97, 0.98))
	info_label.position = Vector2(18, 14)
	info_label.size = Vector2(610, 150)
	info_label.text = "VOXEL SANDBOX\nWASD move | Space jump | Mouse look\nLMB mine | RMB place | 1-4 or wheel select\nF5 save | F9 load | R reset | Esc release mouse"

	status_label = _make_label(root, "", 14, Color(0.92, 0.95, 1.0))
	status_label.position = Vector2(780, 14)
	status_label.size = Vector2(482, 120)
	status_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_RIGHT

	target_label = _make_label(root, "", 17, Color(1.0, 0.91, 0.55))
	target_label.anchor_left = 0.5
	target_label.anchor_right = 0.5
	target_label.anchor_top = 0.0
	target_label.anchor_bottom = 0.0
	target_label.offset_left = -330.0
	target_label.offset_right = 330.0
	target_label.offset_top = 82.0
	target_label.offset_bottom = 108.0
	target_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER

	feedback_label = _make_label(root, "", 18, Color(0.92, 1.0, 0.90))
	feedback_label.anchor_left = 0.5
	feedback_label.anchor_right = 0.5
	feedback_label.anchor_top = 1.0
	feedback_label.anchor_bottom = 1.0
	feedback_label.offset_left = -440.0
	feedback_label.offset_right = 440.0
	feedback_label.offset_top = -138.0
	feedback_label.offset_bottom = -108.0
	feedback_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER

	_build_crosshair(root)
	_build_hotbar(root)


func _build_crosshair(root: Control) -> void:
	var crosshair := Control.new()
	crosshair.name = "Crosshair"
	crosshair.anchor_left = 0.5
	crosshair.anchor_right = 0.5
	crosshair.anchor_top = 0.5
	crosshair.anchor_bottom = 0.5
	crosshair.offset_left = -14.0
	crosshair.offset_right = 14.0
	crosshair.offset_top = -14.0
	crosshair.offset_bottom = 14.0
	crosshair.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(crosshair)
	var horizontal := ColorRect.new()
	horizontal.color = Color(1.0, 1.0, 1.0, 0.92)
	horizontal.position = Vector2(1.0, 13.0)
	horizontal.size = Vector2(26.0, 2.0)
	crosshair.add_child(horizontal)
	var vertical := ColorRect.new()
	vertical.color = Color(1.0, 1.0, 1.0, 0.92)
	vertical.position = Vector2(13.0, 1.0)
	vertical.size = Vector2(2.0, 26.0)
	crosshair.add_child(vertical)


func _build_hotbar(root: Control) -> void:
	hotbar_box = HBoxContainer.new()
	hotbar_box.name = "Hotbar"
	hotbar_box.anchor_left = 0.5
	hotbar_box.anchor_right = 0.5
	hotbar_box.anchor_top = 1.0
	hotbar_box.anchor_bottom = 1.0
	hotbar_box.offset_left = -210.0
	hotbar_box.offset_right = 210.0
	hotbar_box.offset_top = -96.0
	hotbar_box.offset_bottom = -20.0
	hotbar_box.alignment = BoxContainer.ALIGNMENT_CENTER
	hotbar_box.add_theme_constant_override("separation", 7)
	hotbar_box.mouse_filter = Control.MOUSE_FILTER_IGNORE
	root.add_child(hotbar_box)

	for entry in HOTBAR:
		var panel := PanelContainer.new()
		panel.custom_minimum_size = Vector2(94, 72)
		panel.mouse_filter = Control.MOUSE_FILTER_IGNORE
		var margin := MarginContainer.new()
		margin.add_theme_constant_override("margin_left", 5)
		margin.add_theme_constant_override("margin_right", 5)
		margin.add_theme_constant_override("margin_top", 4)
		margin.add_theme_constant_override("margin_bottom", 4)
		var column := VBoxContainer.new()
		column.add_theme_constant_override("separation", 2)
		var swatch := ColorRect.new()
		swatch.color = entry["color"]
		swatch.custom_minimum_size = Vector2(0, 30)
		column.add_child(swatch)
		var label := Label.new()
		label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
		label.add_theme_font_size_override("font_size", 12)
		label.add_theme_color_override("font_color", Color(0.97, 0.97, 0.97))
		label.add_theme_color_override("font_outline_color", Color(0.0, 0.0, 0.0))
		label.add_theme_constant_override("outline_size", 3)
		column.add_child(label)
		margin.add_child(column)
		panel.add_child(margin)
		hotbar_box.add_child(panel)
		hotbar_entries.append({
			"panel": panel,
			"label": label,
			"entry": entry,
		})


func _make_label(parent: Control, text: String, font_size: int, color: Color) -> Label:
	var label := Label.new()
	label.text = text
	label.mouse_filter = Control.MOUSE_FILTER_IGNORE
	label.add_theme_font_size_override("font_size", font_size)
	label.add_theme_color_override("font_color", color)
	label.add_theme_color_override("font_outline_color", Color(0.02, 0.03, 0.04))
	label.add_theme_constant_override("outline_size", 4)
	parent.add_child(label)
	return label


func _update_hud() -> void:
	if info_label == null:
		return
	var target_text := "No block in reach (%.1f m)" % REACH
	if bool(current_target.get("hit", false)):
		var block: Array = current_target["block"]
		target_text = "Target: %s  (%d, %d, %d)  %.1f m" % [
			_block_name(int(current_target.get("block_id", 0))),
			int(block[0]), int(block[1]), int(block[2]),
			float(current_target.get("distance", 0.0)),
		]
	target_label.text = target_text
	status_label.text = "Position  %.1f, %.1f, %.1f\nGrounded  %s\nSelected  %s  x%d\nChanged blocks  %d\nSave  %s" % [
		player.global_position.x, player.global_position.y, player.global_position.z,
		"yes" if player.is_on_floor() else "no",
		_selected_entry()["name"],
		int(inventory.get(int(_selected_entry()["id"]), 0)),
		modified_blocks,
		save_store.path if save_store != null else DEFAULT_SAVE_PATH,
	]
	feedback_label.text = feedback_text
	feedback_label.add_theme_color_override("font_color", _feedback_color())

	for entry in hotbar_entries:
		var block_id: int = int(entry["entry"]["id"])
		var selected: bool = int(entry["entry"]["slot"]) == selected_slot
		var label: Label = entry["label"]
		label.text = "%d %s\nx%d" % [
			int(entry["entry"]["slot"]),
			String(entry["entry"]["name"]),
			int(inventory.get(block_id, 0)),
		]
		var style := StyleBoxFlat.new()
		style.bg_color = Color(0.07, 0.09, 0.11, 0.82) if not selected else Color(0.16, 0.15, 0.08, 0.92)
		style.border_color = Color(1.0, 0.86, 0.24) if selected else Color(0.64, 0.69, 0.74, 0.65)
		var border := 3 if selected else 1
		style.border_width_left = border
		style.border_width_right = border
		style.border_width_top = border
		style.border_width_bottom = border
		style.corner_radius_top_left = 4
		style.corner_radius_top_right = 4
		style.corner_radius_bottom_left = 4
		style.corner_radius_bottom_right = 4
		entry["panel"].add_theme_stylebox_override("panel", style)
		label.add_theme_color_override("font_color", Color(1.0, 0.93, 0.61) if selected else Color(0.94, 0.95, 0.96))


func _feedback_color() -> Color:
	match feedback_kind:
		"success":
			return Color(0.66, 1.0, 0.63)
		"reject":
			return Color(1.0, 0.64, 0.55)
		_:
			return Color(0.92, 1.0, 0.90)


func _performance_state() -> Dictionary:
	return {
		"fps": Engine.get_frames_per_second(),
		"process_frames": Engine.get_process_frames(),
		"static_memory_bytes": int(Performance.get_monitor(Performance.MEMORY_STATIC)),
		"render_primitives": int(Performance.get_monitor(Performance.RENDER_TOTAL_PRIMITIVES_IN_FRAME)),
		"render_draw_calls": int(Performance.get_monitor(Performance.RENDER_TOTAL_DRAW_CALLS_IN_FRAME)),
	}


func _hud_text() -> String:
	var target_text := "none"
	if bool(current_target.get("hit", false)):
		var block: Array = current_target["block"]
		target_text = "%s @ %d,%d,%d" % [
			_block_name(int(current_target.get("block_id", 0))),
			int(block[0]), int(block[1]), int(block[2]),
		]
	return "selected=%s count=%d target=%s grounded=%s modified=%d save=%s feedback=%s" % [
		_selected_entry()["name"],
		int(inventory.get(int(_selected_entry()["id"]), 0)),
		target_text,
		str(player.is_on_floor()),
		modified_blocks,
		save_store.path if save_store != null else DEFAULT_SAVE_PATH,
		feedback_text,
	]


# ---------------------------------------------------------------------------
# Input and events
# ---------------------------------------------------------------------------

func _unhandled_input(event: InputEvent) -> void:
	if event is InputEventMouseMotion and mouse_captured:
		player.add_look(-event.relative.x * MOUSE_SENSITIVITY, -event.relative.y * MOUSE_SENSITIVITY)
	elif event is InputEventMouseButton and event.pressed:
		if not mouse_captured:
			mouse_captured = true
			Input.mouse_mode = Input.MOUSE_MODE_CAPTURED
			return
		if event.button_index == MOUSE_BUTTON_WHEEL_UP:
			_select_slot(selected_slot - 1)
		elif event.button_index == MOUSE_BUTTON_WHEEL_DOWN:
			_select_slot(selected_slot + 1)


func _ensure_input_actions() -> void:
	_add_key_action("move_forward", KEY_W)
	_add_key_action("move_back", KEY_S)
	_add_key_action("move_left", KEY_A)
	_add_key_action("move_right", KEY_D)
	_add_key_action("jump", KEY_SPACE)
	_add_key_action("hotbar_1", KEY_1)
	_add_key_action("hotbar_2", KEY_2)
	_add_key_action("hotbar_3", KEY_3)
	_add_key_action("hotbar_4", KEY_4)
	_add_key_action("save_world", KEY_F5)
	_add_key_action("load_world", KEY_F9)
	_add_key_action("reset_world", KEY_R)
	_add_key_action("release_mouse", KEY_ESCAPE)
	_add_mouse_action("mine", MOUSE_BUTTON_LEFT)
	_add_mouse_action("place", MOUSE_BUTTON_RIGHT)


func _add_key_action(action: StringName, keycode: Key) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	var event := InputEventKey.new()
	event.physical_keycode = keycode
	InputMap.action_add_event(action, event)


func _add_mouse_action(action: StringName, button_index: MouseButton) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	var event := InputEventMouseButton.new()
	event.button_index = button_index
	InputMap.action_add_event(action, event)


func _block_name(block_id: int) -> String:
	return String(VoxelWorldData.BLOCK_NAMES.get(block_id, "unknown")).capitalize()


func _set_feedback(text: String, ticks: int = 120, kind: String = "info") -> void:
	feedback_text = text
	feedback_ticks = ticks
	feedback_kind = kind
	if feedback_label != null:
		feedback_label.text = feedback_text
		feedback_label.add_theme_color_override("font_color", _feedback_color())


func _reject(action: String, reason: String, message: String) -> void:
	_set_feedback(message, 180, "reject")
	_record("%s_rejected" % action, {
		"reason": reason,
		"selected_slot": selected_slot,
		"target": current_target.get("block", []),
	})


func _record(event_type: String, fields: Dictionary = {}) -> void:
	event_sequence += 1
	var event := {
		"sequence": event_sequence,
		"tick": step,
		"sim_time_seconds": sim_time,
		"type": event_type,
	}
	for key in fields:
		event[key] = fields[key]
	events.append(event)
	if events.size() > MAX_EVENTS:
		events.pop_front()
	last_event_type = event_type


func _vec3(value: Vector3) -> Array:
	return [value.x, value.y, value.z]


func _to_vector3(value) -> Vector3:
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	if value is Vector3:
		return value
	return Vector3.ZERO
