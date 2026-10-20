extends Node3D

## Minimal real-physics fixture for Stage E.
##
## The scene uses a StaticBody3D ground and wall, a CharacterBody3D player, and
## move_and_slide() inside the engine's normal fixed physics tick. The harness
## can set input with set_harness_input() and wait for real physics frames; it
## must not call harness_step(), because that would bypass the physics server.

const PhysicsPlayerScript = preload("res://scripts/physics_player.gd")

const SPAWN := Vector3(0.0, 0.85, 0.0)
const PLAYER_RADIUS := 0.4
const GROUND_CENTER := Vector3(0.0, -0.25, 0.0)
const GROUND_SIZE := Vector3(24.0, 0.5, 24.0)
const WALL_CENTER := Vector3(0.0, 1.0, -4.0)
const WALL_SIZE := Vector3(6.0, 2.0, 0.5)
const WALL_FRONT_Z := -3.75
const WALL_CONTACT_Z := WALL_FRONT_Z + PLAYER_RADIUS

var player
var wall: StaticBody3D
var wall_collision: CollisionShape3D
var wall_collision_enabled := true
var physics_steps := 0
var last_delta := 0.0
var last_motion := Vector3.ZERO
var hud_label: Label

var harness_input := {
	"forward": 0.0,
	"strafe": 0.0,
	"jump": false,
	"restart": false,
}


func _ready() -> void:
	_build_environment()
	_build_ground()
	_build_wall()
	_build_player()
	_build_camera()
	_build_hud()
	_update_hud()
	add_to_group("harness_game")


func _physics_process(delta: float) -> void:
	if player == null:
		return

	var frame_input := harness_input.duplicate()
	if bool(frame_input.get("restart", false)):
		reset_game()
		return

	var before: Vector3 = player.global_position
	physics_steps += 1
	last_delta = delta
	player.step_physics(delta, frame_input)
	last_motion = player.global_position - before
	harness_input["jump"] = false
	harness_input["restart"] = false
	_update_hud()


func reset_game() -> void:
	physics_steps = 0
	last_delta = 0.0
	last_motion = Vector3.ZERO
	harness_input = {
		"forward": 0.0,
		"strafe": 0.0,
		"jump": false,
		"restart": false,
	}
	player.reset_to(SPAWN)
	_update_hud()


func set_harness_input(values: Dictionary) -> Dictionary:
	for key in ["forward", "strafe"]:
		if values.has(key):
			harness_input[key] = clampf(float(values[key]), -1.0, 1.0)
	for key in ["jump", "restart"]:
		if values.has(key):
			harness_input[key] = bool(values[key])
	return harness_input.duplicate()


func harness_reset() -> Dictionary:
	reset_game()
	return snapshot()


## Manual stepping is intentionally unsupported. The bridge's generic
## advance_physics operation waits for real fixed ticks instead.
func harness_step(_delta: float) -> Dictionary:
	push_error("physics fixture does not support harness_step; use advance_physics")
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
		"wall_contact=%s" % str(player.wall_contact),
		"wall_clearance=%.9f" % (position.z - WALL_CONTACT_Z),
		"physics_ticks_per_second=%d" % Engine.physics_ticks_per_second,
	]
	return "\n".join(fields).sha256_text()


## A deliberately quantized hash for outcome repeatability. The exact physics
## state can differ by a few float ULPs after contact solving; millimetre
## rounding is the documented tolerance for the Stage E claim.
func outcome_hash() -> String:
	var position: Vector3 = player.global_position
	var velocity: Vector3 = player.velocity
	var fields: Array[String] = [
		"step=%d" % physics_steps,
		"position_mm=%.3f,%.3f,%.3f" % [position.x, position.y, position.z],
		"velocity_mm=%.3f,%.3f,%.3f" % [velocity.x, velocity.y, velocity.z],
		"grounded=%s" % str(player.grounded),
		"wall_contact=%s" % str(player.wall_contact),
		"wall_clearance_mm=%.3f" % (position.z - WALL_CONTACT_Z),
		"physics_ticks_per_second=%d" % Engine.physics_ticks_per_second,
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
		"wall_clearance": position.z - WALL_CONTACT_Z,
		"wall_front_z": WALL_FRONT_Z,
		"wall_contact_z": WALL_CONTACT_Z,
		"wall_collision_enabled": wall_collision_enabled,
		"last_delta": last_delta,
		"input": harness_input.duplicate(),
		"hash": harness_hash(),
		"outcome_hash": outcome_hash(),
		"hud": hud_label.text if hud_label != null else "",
	}


func set_wall_collision(enabled: bool) -> void:
	wall_collision_enabled = enabled
	wall_collision.set_deferred("disabled", not enabled)


func _build_environment() -> void:
	RenderingServer.set_default_clear_color(Color("#9fbfd6"))

	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#9fbfd6")
	world_environment.environment = environment
	add_child(world_environment)

	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-50.0, -35.0, 0.0)
	sun.light_energy = 1.15
	sun.shadow_enabled = true
	add_child(sun)


func _build_ground() -> void:
	var ground := StaticBody3D.new()
	ground.name = "Ground"
	add_child(ground)

	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = GROUND_SIZE
	collision.shape = shape
	collision.position = GROUND_CENTER
	ground.add_child(collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = GROUND_SIZE
	mesh.mesh = box
	mesh.position = GROUND_CENTER
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#d8c99a")
	material.roughness = 0.95
	mesh.material_override = material
	ground.add_child(mesh)


func _build_wall() -> void:
	wall = StaticBody3D.new()
	wall.name = "Wall"
	add_child(wall)

	wall_collision = CollisionShape3D.new()
	wall_collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = WALL_SIZE
	wall_collision.shape = shape
	wall_collision.position = WALL_CENTER
	wall.add_child(wall_collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = WALL_SIZE
	mesh.mesh = box
	mesh.position = WALL_CENTER
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#5f6d78")
	material.roughness = 0.9
	mesh.material_override = material
	wall.add_child(mesh)


func _build_player() -> void:
	player = PhysicsPlayerScript.new()
	player.name = "Player"
	add_child(player)
	player.global_position = SPAWN


func _build_camera() -> void:
	var camera := Camera3D.new()
	camera.name = "Camera"
	add_child(camera)
	camera.position = Vector3(0.0, 4.2, 7.2)
	camera.look_at(Vector3(0.0, 0.9, -2.8), Vector3.UP)
	camera.current = true


func _build_hud() -> void:
	var layer := CanvasLayer.new()
	layer.name = "HUD"
	layer.layer = 10
	add_child(layer)

	var panel := PanelContainer.new()
	panel.name = "Panel"
	panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	panel.position = Vector2(24.0, 24.0)
	panel.custom_minimum_size = Vector2(520.0, 0.0)
	layer.add_child(panel)

	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.035, 0.045, 0.065, 0.88)
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


func _update_hud() -> void:
	if hud_label == null or player == null:
		return
	var position: Vector3 = player.global_position
	var wall_state := "WALL CONTACT" if player.wall_contact else "NO WALL CONTACT"
	var floor_state := "ON FLOOR" if player.grounded else "AIRBORNE"
	hud_label.text = "PHYSICS FIXTURE\n%s | %s\nz=%.3f wall=%s" % [
		floor_state,
		wall_state,
		position.z,
		str(wall_collision_enabled),
	]
