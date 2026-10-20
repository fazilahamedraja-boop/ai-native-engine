extends Node3D

## Self-contained locked-door/key fixture for Phase 9 Stage F.
##
## The harness uses only generic operations: real physics advance, input,
## snapshot, scene-tree/property inspection, reset, and screenshot. Door and
## key behavior live here, not in the harness.

const DoorScript = preload("res://scripts/door.gd")
const DoorPlayerScript = preload("res://scripts/door_player.gd")

const SPAWN := Vector3(0.0, 0.85, 5.5)
const KEY_POSITION := Vector3(2.0, 0.9, 4.5)
const KEY_PICKUP_RANGE := 1.0
const DOOR_INTERACT_RANGE := 2.2
const DOOR_HINGE := Vector3(-0.8, 0.0, 0.0)
const GROUND_CENTER := Vector3(0.0, -0.25, 0.0)
const GROUND_SIZE := Vector3(24.0, 0.5, 24.0)

var player
var door: StaticBody3D
var key_root: Node3D
var key_label: Label3D
var door_label: Label3D
var camera: Camera3D
var hud_label: Label

var physics_steps := 0
var last_delta := 0.0
var last_motion := Vector3.ZERO
var player_has_key := false
var key_available := true
var feedback := "LOCKED - FIND THE KEY"
var interaction_count := 0

var harness_input := {
	"forward": 0.0,
	"strafe": 0.0,
	"jump": false,
	"restart": false,
	"actions": {"interact": false},
}


func _ready() -> void:
	_build_environment()
	_build_ground()
	_build_walls()
	_build_door()
	_build_key()
	_build_player()
	_build_camera()
	_build_labels()
	_build_hud()
	reset_game()
	add_to_group("harness_game")


func _physics_process(delta: float) -> void:
	if player == null or door == null:
		return

	var frame_input := harness_input.duplicate(true)
	if bool(frame_input.get("restart", false)):
		reset_game()
		return

	var frame_actions: Dictionary = frame_input.get("actions", {})
	var before: Vector3 = player.global_position
	physics_steps += 1
	last_delta = delta
	player.step_physics(delta, frame_input)
	last_motion = player.global_position - before

	_try_pickup_key()
	if bool(frame_actions.get("interact", false)):
		interaction_count += 1
		feedback = door.try_interact(player_has_key, _door_distance())

	harness_input["jump"] = false
	harness_input["restart"] = false
	harness_input["actions"]["interact"] = false
	_update_camera()
	_update_labels()
	_update_hud()


func reset_game() -> void:
	physics_steps = 0
	last_delta = 0.0
	last_motion = Vector3.ZERO
	player_has_key = false
	key_available = true
	feedback = "LOCKED - FIND THE KEY"
	interaction_count = 0
	harness_input = {
		"forward": 0.0,
		"strafe": 0.0,
		"jump": false,
		"restart": false,
		"actions": {"interact": false},
	}
	player.reset_to(SPAWN)
	door.reset_door()
	key_root.visible = true
	_update_camera()
	_update_labels()
	_update_hud()


func set_harness_input(values: Dictionary) -> Dictionary:
	for key in ["forward", "strafe"]:
		if values.has(key):
			harness_input[key] = clampf(float(values[key]), -1.0, 1.0)
	for key in ["jump", "restart"]:
		if values.has(key):
			harness_input[key] = bool(values[key])
	if values.has("actions") and typeof(values["actions"]) == TYPE_DICTIONARY:
		var actions: Dictionary = values["actions"]
		for action_name in actions:
			if String(action_name) == "interact":
				harness_input["actions"]["interact"] = bool(actions[action_name])
	return harness_input.duplicate(true)


func harness_reset() -> Dictionary:
	reset_game()
	return snapshot()


## Manual stepping would bypass the physics server. Use advance_physics.
func harness_step(_delta: float) -> Dictionary:
	push_error("door fixture does not support harness_step; use advance_physics")
	return snapshot()


func harness_hash() -> String:
	var position: Vector3 = player.global_position
	var velocity: Vector3 = player.velocity
	var fields: Array[String] = [
		"step=%d" % physics_steps,
		"delta=%.9f" % last_delta,
		"position=%.9f,%.9f,%.9f" % [position.x, position.y, position.z],
		"velocity=%.9f,%.9f,%.9f" % [velocity.x, velocity.y, velocity.z],
		"motion=%.9f,%.9f,%.9f" % [last_motion.x, last_motion.y, last_motion.z],
		"grounded=%s" % str(player.grounded),
		"door_locked=%s" % str(door.locked),
		"door_open=%s" % str(door.open),
		"door_collision=%s" % str(door.collision_enabled),
		"door_rotation=%.9f" % rad_to_deg(door.rotation.y),
		"player_has_key=%s" % str(player_has_key),
		"key_available=%s" % str(key_available),
		"feedback=%s" % feedback,
		"locked_attempts=%d" % door.locked_attempts,
		"open_count=%d" % door.open_count,
		"interaction_count=%d" % interaction_count,
	]
	return "\n".join(fields).sha256_text()


func outcome_hash() -> String:
	var position: Vector3 = player.global_position
	var velocity: Vector3 = player.velocity
	var fields: Array[String] = [
		"step=%d" % physics_steps,
		"position_mm=%.3f,%.3f,%.3f" % [position.x, position.y, position.z],
		"velocity_mm=%.3f,%.3f,%.3f" % [velocity.x, velocity.y, velocity.z],
		"grounded=%s" % str(player.grounded),
		"door_locked=%s" % str(door.locked),
		"door_open=%s" % str(door.open),
		"door_collision=%s" % str(door.collision_enabled),
		"player_has_key=%s" % str(player_has_key),
		"key_available=%s" % str(key_available),
		"feedback=%s" % feedback,
		"locked_attempts=%d" % door.locked_attempts,
		"open_count=%d" % door.open_count,
		"interaction_count=%d" % interaction_count,
	]
	return "\n".join(fields).sha256_text()


func snapshot() -> Dictionary:
	var position: Vector3 = player.global_position
	var velocity: Vector3 = player.velocity
	return {
		"step": physics_steps,
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"physics_frames": Engine.get_physics_frames(),
		"player_position": [position.x, position.y, position.z],
		"player_velocity": [velocity.x, velocity.y, velocity.z],
		"player_motion": [last_motion.x, last_motion.y, last_motion.z],
		"grounded": player.grounded,
		"wall_contact": player.wall_contact,
		"door_locked": door.locked,
		"door_open": door.open,
		"door_collision_enabled": door.collision_enabled,
		"door_rotation_degrees": rad_to_deg(door.rotation.y),
		"player_has_key": player_has_key,
		"key_available": key_available,
		"key_visible": key_root.visible,
		"feedback": feedback,
		"prompt": _prompt(),
		"distance_to_door": _door_distance(),
		"distance_to_key": player.global_position.distance_to(key_root.global_position),
		"locked_attempts": door.locked_attempts,
		"open_count": door.open_count,
		"interaction_count": interaction_count,
		"last_delta": last_delta,
		"input": harness_input.duplicate(true),
		"hash": harness_hash(),
		"outcome_hash": outcome_hash(),
		"hud": hud_label.text if hud_label != null else "",
	}


func _try_pickup_key() -> void:
	if not key_available:
		return
	if player.global_position.distance_to(key_root.global_position) <= KEY_PICKUP_RANGE:
		key_available = false
		player_has_key = true
		key_root.visible = false
		feedback = "KEY ACQUIRED"


func _door_distance() -> float:
	return Vector2(player.global_position.x, player.global_position.z).length()


func _prompt() -> String:
	if door.open:
		return "DOOR OPEN - GO THROUGH"
	if _door_distance() > DOOR_INTERACT_RANGE:
		return "APPROACH THE DOOR"
	if player_has_key:
		return "PRESS E TO UNLOCK"
	return "PRESS E TO TRY THE DOOR"


func _build_environment() -> void:
	RenderingServer.set_default_clear_color(Color("#a9c6d8"))

	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#a9c6d8")
	world_environment.environment = environment
	add_child(world_environment)

	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-48.0, -32.0, 0.0)
	sun.light_energy = 1.15
	sun.shadow_enabled = true
	add_child(sun)


func _build_ground() -> void:
	_build_wall_segment("Ground", GROUND_CENTER, GROUND_SIZE, Color("#d8c99a"), true)


func _build_walls() -> void:
	_build_wall_segment("LeftWall", Vector3(-3.4, 1.15, 0.0), Vector3(5.2, 2.3, 0.3), Color("#66727b"), true)
	_build_wall_segment("RightWall", Vector3(3.4, 1.15, 0.0), Vector3(5.2, 2.3, 0.3), Color("#66727b"), true)
	_build_wall_segment("Lintel", Vector3(0.0, 2.4, 0.0), Vector3(1.6, 0.4, 0.3), Color("#66727b"), true)
	_build_wall_segment("BackWall", Vector3(0.0, 1.15, -8.0), Vector3(12.0, 2.3, 0.3), Color("#66727b"), true)


func _build_wall_segment(
	segment_name: String,
	center: Vector3,
	size: Vector3,
	color: Color,
	with_collision: bool,
) -> void:
	var body := StaticBody3D.new()
	body.name = segment_name
	add_child(body)

	if with_collision:
		var collision := CollisionShape3D.new()
		collision.name = "Collision"
		var shape := BoxShape3D.new()
		shape.size = size
		collision.shape = shape
		collision.position = center
		body.add_child(collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = size
	mesh.mesh = box
	mesh.position = center
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	material.roughness = 0.9
	mesh.material_override = material
	body.add_child(mesh)


func _build_door() -> void:
	door = DoorScript.new()
	door.name = "Door"
	door.position = DOOR_HINGE
	add_child(door)


func _build_key() -> void:
	key_root = Node3D.new()
	key_root.name = "Key"
	key_root.position = KEY_POSITION
	add_child(key_root)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var sphere := SphereMesh.new()
	sphere.radius = 0.22
	sphere.height = 0.44
	mesh.mesh = sphere
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#ffcf4d")
	material.metallic = 0.55
	material.roughness = 0.3
	mesh.material_override = material
	key_root.add_child(mesh)


func _build_player() -> void:
	player = DoorPlayerScript.new()
	player.name = "Player"
	add_child(player)
	player.global_position = SPAWN


func _build_camera() -> void:
	camera = Camera3D.new()
	camera.name = "Camera"
	add_child(camera)
	camera.current = true
	_update_camera()


func _build_labels() -> void:
	door_label = Label3D.new()
	door_label.name = "DoorLabel"
	door_label.text = "LOCKED"
	door_label.font_size = 72
	door_label.outline_size = 10
	door_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	door_label.position = Vector3(0.0, 2.85, 0.2)
	add_child(door_label)

	key_label = Label3D.new()
	key_label.name = "KeyLabel"
	key_label.text = "KEY"
	key_label.font_size = 56
	key_label.outline_size = 8
	key_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	key_label.position = Vector3(0.0, 0.55, 0.0)
	key_label.modulate = Color("#ffcf4d")
	key_root.add_child(key_label)


func _build_hud() -> void:
	var layer := CanvasLayer.new()
	layer.name = "HUD"
	layer.layer = 10
	add_child(layer)

	var panel := PanelContainer.new()
	panel.name = "Panel"
	panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	panel.position = Vector2(24.0, 24.0)
	panel.custom_minimum_size = Vector2(620.0, 0.0)
	layer.add_child(panel)

	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.035, 0.045, 0.065, 0.9)
	style.border_width_left = 3
	style.border_color = Color("#d9ecff")
	style.corner_radius_top_left = 6
	style.corner_radius_top_right = 6
	style.corner_radius_bottom_left = 6
	style.corner_radius_bottom_right = 6
	panel.add_theme_stylebox_override("panel", style)

	var margin := MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 18)
	margin.add_theme_constant_override("margin_top", 14)
	margin.add_theme_constant_override("margin_right", 18)
	margin.add_theme_constant_override("margin_bottom", 14)
	panel.add_child(margin)

	hud_label = Label.new()
	hud_label.name = "Status"
	hud_label.add_theme_font_size_override("font_size", 18)
	hud_label.add_theme_color_override("font_color", Color("#d9ecff"))
	margin.add_child(hud_label)


func _update_camera() -> void:
	if camera == null or player == null:
		return
	camera.global_position = player.global_position + Vector3(0.0, 5.0, 8.5)
	camera.look_at(player.global_position + Vector3(0.0, 0.8, -2.5), Vector3.UP)


func _update_labels() -> void:
	if door_label == null or door == null:
		return
	if door.open:
		door_label.text = "OPEN"
		door_label.modulate = Color("#73e09a")
	else:
		door_label.text = "LOCKED"
		door_label.modulate = Color("#ff6b5f")


func _update_hud() -> void:
	if hud_label == null or player == null or door == null:
		return
	var position: Vector3 = player.global_position
	var door_state := "OPEN" if door.open else ("LOCKED" if door.locked else "CLOSED")
	var key_state := "HELD" if player_has_key else ("AVAILABLE" if key_available else "MISSING")
	hud_label.text = "DOOR / KEY FIXTURE\nDOOR: %s | KEY: %s\nPROMPT: %s\nFEEDBACK: %s\nz=%.3f attempts=%d opens=%d" % [
		door_state,
		key_state,
		_prompt(),
		feedback,
		position.z,
		door.locked_attempts,
		door.open_count,
	]
