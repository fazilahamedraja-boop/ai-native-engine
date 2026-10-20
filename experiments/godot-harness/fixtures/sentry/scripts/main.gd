extends Node3D

## Godot implementation of the Phase 6 sentry-lines benchmark.
## The state machine lives in sentry_state.gd; this node owns the scene wiring,
## player input order, camera, and HUD.

const SentryStateScript = preload("res://scripts/sentry_state.gd")
const PlayerScript = preload("res://scripts/player.gd")

const SPAWN := Vector3(0.0, 0.85, 0.0)
const HINT := "WASD move · Space jump · R restart"

var state
var player
var camera: Camera3D
var status_label: Label
var hint_label: Label
var panel_style: StyleBoxFlat


func _ready() -> void:
	_ensure_input_actions()
	state = SentryStateScript.new()
	state.reset()

	_build_environment()
	_build_ground()
	_build_player()
	_build_guards()
	_build_exit()
	_build_camera()
	_build_hud()
	_update_camera()
	_update_hud()


func _process(_delta: float) -> void:
	_update_camera()


func _physics_process(delta: float) -> void:
	if Input.is_action_just_pressed("restart"):
		reset_game()
		return

	# Move first, then evaluate sight at the new position. This is the same
	# order as the reference engine's physics-then-game update. The HUD keeps
	# following the player after a terminal phase; only the state is frozen.
	player.step_movement(delta)
	if state.is_active():
		state.tick(player.global_position)
	_update_hud()


func reset_game() -> void:
	state.reset()
	player.reset_to(SPAWN)
	_update_camera()
	_update_hud()


## Compact, JSON-friendly state for external inspection and evidence capture.
func snapshot() -> Dictionary:
	var live_seen: Array[String] = state.seeing_guards(player.global_position)
	return {
		"player_position": [player.global_position.x, player.global_position.y, player.global_position.z],
		"phase": state.phase_name(),
		"detection": state.detection,
		"detection_percent": int(round(state.detection * 100.0)),
		"seen_by": live_seen,
		"exit_distance": state.exit_distance(player.global_position),
		"hud": status_label.text if status_label != null else "",
		"hint": hint_label.text if hint_label != null else "",
	}


func _ensure_input_actions() -> void:
	_add_key_action("move_left", KEY_A)
	_add_key_action("move_right", KEY_D)
	_add_key_action("move_forward", KEY_W)
	_add_key_action("move_back", KEY_S)
	_add_key_action("jump", KEY_SPACE)
	_add_key_action("restart", KEY_R)


func _add_key_action(action: StringName, keycode: int) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	if InputMap.action_get_events(action).is_empty():
		var event := InputEventKey.new()
		event.physical_keycode = keycode
		InputMap.action_add_event(action, event)


func _build_environment() -> void:
	RenderingServer.set_default_clear_color(Color("#8fc3e8"))

	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#8fc3e8")
	world_environment.environment = environment
	add_child(world_environment)

	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-52.0, -35.0, 0.0)
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
	shape.size = Vector3(40.0, 0.4, 40.0)
	collision.shape = shape
	collision.position = Vector3(0.0, -0.2, 0.0)
	ground.add_child(collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = Vector3(40.0, 0.4, 40.0)
	mesh.mesh = box
	mesh.position = Vector3(0.0, -0.2, 0.0)
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#d8c99a")
	material.roughness = 0.95
	mesh.material_override = material
	ground.add_child(mesh)


func _build_player() -> void:
	player = PlayerScript.new()
	player.name = "Player"
	add_child(player)
	player.global_position = SPAWN


func _build_guards() -> void:
	var guard_material := StandardMaterial3D.new()
	guard_material.albedo_color = Color("#555b62")
	guard_material.roughness = 0.9

	var eye_material := StandardMaterial3D.new()
	eye_material.albedo_color = Color("#ff3b2f")
	eye_material.emission_enabled = true
	eye_material.emission = Color("#ff3b2f")
	eye_material.emission_energy_multiplier = 1.5

	var cone_material := StandardMaterial3D.new()
	cone_material.albedo_color = Color(0.70, 0.16, 0.08, 0.30)
	cone_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	cone_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	cone_material.cull_mode = BaseMaterial3D.CULL_DISABLED

	var index := 0
	for guard in state.guards:
		var guard_root := Node3D.new()
		guard_root.name = "GuardA" if index == 0 else "GuardB"
		guard_root.position = guard["pos"]
		add_child(guard_root)

		var body := MeshInstance3D.new()
		body.name = "Body"
		var body_mesh := CylinderMesh.new()
		body_mesh.top_radius = 0.45
		body_mesh.bottom_radius = 0.65
		body_mesh.height = 1.2
		body_mesh.radial_segments = 16
		body.mesh = body_mesh
		body.material_override = guard_material
		body.position = Vector3(0.0, 0.6, 0.0)
		guard_root.add_child(body)

		var eye := MeshInstance3D.new()
		eye.name = "Eye"
		var eye_mesh := SphereMesh.new()
		eye_mesh.radius = 0.12
		eye_mesh.height = 0.24
		eye.mesh = eye_mesh
		eye.material_override = eye_material
		eye.position = Vector3(0.0, 1.0, 0.5)
		guard_root.add_child(eye)

		var cone := MeshInstance3D.new()
		cone.name = "DetectionCone"
		cone.mesh = _cone_mesh(guard["range"], guard["half_angle_deg"])
		cone.material_override = cone_material
		cone.position = Vector3(0.0, 0.03, 0.0)
		cone.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
		guard_root.add_child(cone)

		index += 1


func _build_exit() -> void:
	var exit := MeshInstance3D.new()
	exit.name = "Exit"
	exit.position = state.exit_pos
	var sphere := SphereMesh.new()
	sphere.radius = 0.5
	sphere.height = 1.0
	exit.mesh = sphere
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#63d98b")
	material.emission_enabled = true
	material.emission = Color("#2fa45c")
	material.emission_energy_multiplier = 1.4
	exit.material_override = material
	add_child(exit)

	var light := OmniLight3D.new()
	light.name = "ExitLight"
	light.position = state.exit_pos + Vector3(0.0, 1.0, 0.0)
	light.light_color = Color("#67e69a")
	light.light_energy = 1.2
	light.omni_range = 3.0
	add_child(light)


func _build_camera() -> void:
	camera = Camera3D.new()
	camera.name = "Camera"
	camera.fov = 65.0
	camera.current = true
	add_child(camera)


func _build_hud() -> void:
	var layer := CanvasLayer.new()
	layer.name = "HUD"
	layer.layer = 10
	add_child(layer)

	var panel := PanelContainer.new()
	panel.name = "Panel"
	panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	panel.position = Vector2(24.0, 24.0)
	panel.custom_minimum_size = Vector2(470.0, 0.0)
	layer.add_child(panel)

	panel_style = StyleBoxFlat.new()
	panel_style.bg_color = Color(0.035, 0.045, 0.065, 0.88)
	panel_style.border_width_left = 3
	panel_style.border_width_top = 0
	panel_style.border_width_right = 0
	panel_style.border_width_bottom = 0
	panel_style.border_color = Color("#d9ecff")
	panel_style.corner_radius_top_left = 6
	panel_style.corner_radius_top_right = 6
	panel_style.corner_radius_bottom_left = 6
	panel_style.corner_radius_bottom_right = 6
	panel.add_theme_stylebox_override("panel", panel_style)

	var margin := MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 18)
	margin.add_theme_constant_override("margin_top", 14)
	margin.add_theme_constant_override("margin_right", 18)
	margin.add_theme_constant_override("margin_bottom", 14)
	panel.add_child(margin)

	var vbox := VBoxContainer.new()
	vbox.add_theme_constant_override("separation", 8)
	margin.add_child(vbox)

	status_label = Label.new()
	status_label.name = "Status"
	status_label.add_theme_font_size_override("font_size", 21)
	status_label.add_theme_color_override("font_color", Color("#d9ecff"))
	vbox.add_child(status_label)

	hint_label = Label.new()
	hint_label.name = "Hint"
	hint_label.text = HINT
	hint_label.add_theme_font_size_override("font_size", 14)
	hint_label.add_theme_color_override("font_color", Color("#9fb6c8"))
	vbox.add_child(hint_label)


func _update_camera() -> void:
	if player == null or camera == null:
		return
	var position: Vector3 = player.global_position
	camera.global_position = position + Vector3(0.0, 3.6, 6.2)
	camera.look_at(position + Vector3(0.0, 0.9, -3.5), Vector3.UP)


func _update_hud() -> void:
	if status_label == null:
		return

	var live_seen: Array[String] = state.seeing_guards(player.global_position)
	var percent := int(round(state.detection * 100.0))
	var seen_text := "SEEN" if live_seen.size() > 0 else "HIDDEN"
	var detection_line := "DETECTION %d%% · %s" % [percent, seen_text]
	var exit_line := "EXIT %.1f m" % state.exit_distance(player.global_position)
	var tone := Color("#d9ecff")

	match state.phase_name():
		"lost":
			status_label.text = "DETECTED\n%s · %s\npress R to restart." % [detection_line, exit_line]
			tone = Color("#ff6b5b")
		"won":
			status_label.text = "ESCAPED\n%s · %s\npress R to restart." % [detection_line, exit_line]
			tone = Color("#7ee7a8")
		_:
			status_label.text = "REACH THE BEACON\n%s\n%s · Avoid the sentry cones." % [detection_line, exit_line]
			if live_seen.size() > 0:
				tone = Color("#ffb08f")

	status_label.add_theme_color_override("font_color", tone)
	panel_style.border_color = tone


func _cone_mesh(radius: float, half_angle_deg: float, segments := 24) -> ArrayMesh:
	var half_angle := deg_to_rad(half_angle_deg)
	var vertices := PackedVector3Array()
	var indices := PackedInt32Array()
	vertices.append(Vector3.ZERO)
	for i in range(segments + 1):
		var angle := -half_angle + (2.0 * half_angle * float(i)) / float(segments)
		vertices.append(Vector3(sin(angle) * radius, 0.0, cos(angle) * radius))
	for i in range(segments):
		indices.append(0)
		indices.append(i + 1)
		indices.append(i + 2)

	var arrays: Array = []
	arrays.resize(Mesh.ARRAY_MAX)
	arrays[Mesh.ARRAY_VERTEX] = vertices
	arrays[Mesh.ARRAY_INDEX] = indices
	var mesh := ArrayMesh.new()
	mesh.add_surface_from_arrays(Mesh.PRIMITIVE_TRIANGLES, arrays)
	return mesh
