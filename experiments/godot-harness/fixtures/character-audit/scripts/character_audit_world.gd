extends Node3D

## Small Phase 11 character audit fixture.
##
## It loads the repository's rigid humanoid and one existing skinned glTF
## sample. The CesiumMan asset is test-only; it is not a new character or a
## hand-authored skeleton. The generic observation bridge is copied from the
## Phase 10 fixture without changing its observation contract.

const CESIUM_PATH := "res://assets/CesiumMan.glb"
const HUMANOID_PATH := "res://assets/humanoid-01.glb"
const MAX_EVENTS := 200

var cesium_root: Node3D
var cesium_skeleton: Skeleton3D
var cesium_animation: AnimationPlayer
var humanoid_root: Node3D
var humanoid_skeleton: Skeleton3D
var humanoid_animation: AnimationPlayer
var camera: Camera3D
var hud_label: Label

var physics_steps := 0
var last_delta := 0.0
var events: Array[Dictionary] = []
var event_sequence := 0
var harness_input := {"actions": {}}


func _ready() -> void:
	_build_environment()
	_build_ground()
	cesium_root = _load_model(CESIUM_PATH, "CesiumMan")
	if cesium_root != null:
		cesium_root.position = Vector3(0.0, 0.0, 0.0)
		cesium_root.scale = Vector3(1.35, 1.35, 1.35)
		cesium_skeleton = _find_skeleton(cesium_root)
		cesium_animation = _find_animation(cesium_root)
	humanoid_root = _load_model(HUMANOID_PATH, "Humanoid")
	if humanoid_root != null:
		humanoid_root.position = Vector3(2.8, 0.0, 0.0)
		humanoid_skeleton = _find_skeleton(humanoid_root)
		humanoid_animation = _find_animation(humanoid_root)
	_build_labels()
	_build_camera()
	_build_hud()
	reset_game()
	add_to_group("harness_game")


func _build_environment() -> void:
	RenderingServer.set_default_clear_color(Color("#9db6c8"))
	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#9db6c8")
	world_environment.environment = environment
	add_child(world_environment)

	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-48.0, -28.0, 0.0)
	sun.light_energy = 1.2
	sun.shadow_enabled = true
	add_child(sun)


func _build_ground() -> void:
	var ground := StaticBody3D.new()
	ground.name = "Ground"
	add_child(ground)
	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = Vector3(12.0, 0.5, 8.0)
	collision.shape = shape
	collision.position = Vector3(0.0, -0.25, 0.0)
	ground.add_child(collision)
	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = Vector3(12.0, 0.5, 8.0)
	mesh.mesh = box
	mesh.position = Vector3(0.0, -0.25, 0.0)
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#c9b27a")
	material.roughness = 0.95
	mesh.material_override = material
	ground.add_child(mesh)


func _load_model(path: String, node_name: String) -> Node3D:
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	var error := document.append_from_file(path, state)
	if error != OK:
		push_error("Could not load %s: %s" % [path, error_string(error)])
		return null
	var scene := document.generate_scene(state)
	if scene == null:
		push_error("GLTFDocument produced no scene for %s" % path)
		return null
	var model := scene as Node3D
	if model == null:
		push_error("Root is not Node3D for %s" % path)
		return null
	model.name = node_name
	add_child(model)
	return model


func _find_skeleton(root: Node) -> Skeleton3D:
	var found := root.find_children("*", "Skeleton3D", true, false)
	return found[0] as Skeleton3D if not found.is_empty() else null


func _find_animation(root: Node) -> AnimationPlayer:
	var found := root.find_children("*", "AnimationPlayer", true, false)
	return found[0] as AnimationPlayer if not found.is_empty() else null


func _build_labels() -> void:
	_add_world_label("CesiumManLabel", "CESIUMMAN\nSKINNED + ANIMATED", Vector3(0.0, 2.25, 0.0))
	_add_world_label("HumanoidLabel", "HUMANOID-01\nRIGID MESHES", Vector3(2.8, 2.15, 0.0))


func _add_world_label(node_name: String, text: String, position: Vector3) -> void:
	var label := Label3D.new()
	label.name = node_name
	label.text = text
	label.font_size = 42
	label.modulate = Color("#ecf6ff")
	label.position = position
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.no_depth_test = true
	add_child(label)


func _build_camera() -> void:
	camera = Camera3D.new()
	camera.name = "Camera"
	add_child(camera)
	camera.current = true
	camera.position = Vector3(1.4, 2.0, 6.2)
	camera.look_at(Vector3(1.4, 0.95, 0.0), Vector3.UP)


func _build_hud() -> void:
	var layer := CanvasLayer.new()
	layer.name = "HUD"
	layer.layer = 10
	add_child(layer)
	var panel := PanelContainer.new()
	panel.name = "Panel"
	panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	panel.position = Vector2(24.0, 24.0)
	panel.custom_minimum_size = Vector2(600.0, 0.0)
	layer.add_child(panel)
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.035, 0.045, 0.065, 0.9)
	style.border_width_left = 3
	style.border_color = Color("#d9ecff")
	panel.add_theme_stylebox_override("panel", style)
	var margin := MarginContainer.new()
	margin.add_theme_constant_override("margin_left", 18)
	margin.add_theme_constant_override("margin_top", 14)
	margin.add_theme_constant_override("margin_right", 18)
	margin.add_theme_constant_override("margin_bottom", 14)
	panel.add_child(margin)
	hud_label = Label.new()
	hud_label.name = "Status"
	hud_label.add_theme_font_size_override("font_size", 17)
	hud_label.add_theme_color_override("font_color", Color("#d9ecff"))
	margin.add_child(hud_label)


func reset_game() -> void:
	physics_steps = 0
	last_delta = 0.0
	events.clear()
	event_sequence = 0
	harness_input = {"actions": {}}
	if cesium_animation != null and is_instance_valid(cesium_animation):
		cesium_animation.stop()
		cesium_animation.seek(0.0, true)
		var names := cesium_animation.get_animation_list()
		if not names.is_empty():
			cesium_animation.play(String(names[0]))
	if humanoid_animation != null and is_instance_valid(humanoid_animation):
		humanoid_animation.stop()
	_record_event("reset", {"label": "character_audit_reset"})
	_update_hud()


func _physics_process(delta: float) -> void:
	physics_steps += 1
	last_delta = delta
	harness_input.clear()
	_update_hud()


func set_harness_input(values: Dictionary) -> Dictionary:
	# This fixture is an inspection fixture; it has no movement controls.
	if values.has("actions") and typeof(values["actions"]) == TYPE_DICTIONARY:
		harness_input["actions"] = values["actions"].duplicate(true)
	return harness_input.duplicate(true)


func harness_reset() -> Dictionary:
	reset_game()
	return snapshot()


func harness_step(_delta: float) -> Dictionary:
	push_error("character audit fixture does not support harness_step; use advance_physics")
	return snapshot()


func harness_events(since_tick: int = 0) -> Array:
	var result: Array = []
	for event in events:
		if int(event.get("tick", 0)) >= since_tick:
			result.append(event.duplicate(true))
	return result


func harness_hash() -> String:
	var fields: Array[String] = [
		"step=%d" % physics_steps,
		"animation=%s" % (cesium_animation.current_animation if cesium_animation != null else ""),
		"animation_position=%.9f" % (cesium_animation.current_animation_position if cesium_animation != null else 0.0),
		"bone_count=%d" % (cesium_skeleton.get_bone_count() if cesium_skeleton != null else 0),
		"humanoid_meshes=%d" % harness_humanoid_mesh_count(),
	]
	return "\n".join(fields).sha256_text()


func snapshot() -> Dictionary:
	var animation_names: Array = []
	if cesium_animation != null:
		animation_names = cesium_animation.get_animation_list()
	var bone_names: Array = []
	if cesium_skeleton != null:
		for index in range(cesium_skeleton.get_bone_count()):
			bone_names.append(String(cesium_skeleton.get_bone_name(index)))
	var animation_position := 0.0
	var animation_name := ""
	var animation_playing := false
	if cesium_animation != null:
		animation_position = cesium_animation.current_animation_position
		animation_name = cesium_animation.current_animation
		animation_playing = cesium_animation.is_playing()
	return {
		"step": physics_steps,
		"physics_frames": Engine.get_physics_frames(),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"cesium_root": String(cesium_root.get_path()) if cesium_root != null else null,
		"cesium_skeleton": String(cesium_skeleton.get_path()) if cesium_skeleton != null else null,
		"cesium_animation": String(cesium_animation.get_path()) if cesium_animation != null else null,
		"cesium_animation_name": animation_name,
		"cesium_animation_position": animation_position,
		"cesium_animation_playing": animation_playing,
		"cesium_animation_names": animation_names,
		"cesium_bone_count": cesium_skeleton.get_bone_count() if cesium_skeleton != null else 0,
		"cesium_bones": bone_names,
		"humanoid_root": String(humanoid_root.get_path()) if humanoid_root != null else null,
		"humanoid_mesh_count": harness_humanoid_mesh_count(),
		"humanoid_skeleton": String(humanoid_skeleton.get_path()) if humanoid_skeleton != null else null,
		"humanoid_animation": String(humanoid_animation.get_path()) if humanoid_animation != null else null,
		"hash": harness_hash(),
		"hud": hud_label.text if hud_label != null else "",
	}


func harness_humanoid_mesh_count() -> int:
	if humanoid_root == null:
		return 0
	var count := 0
	var stack: Array[Node] = [humanoid_root]
	while not stack.is_empty():
		var node: Node = stack.pop_back()
		if node is MeshInstance3D:
			count += 1
		for child in node.get_children():
			stack.append(child)
	return count


func _update_hud() -> void:
	if hud_label == null:
		return
	hud_label.text = "CHARACTER AUDIT\n%s\nSTEP: %d   TICK: %d" % [
		"CesiumMan skinned rig + humanoid-01 rigid meshes",
		physics_steps,
		Engine.get_physics_frames(),
	]


func _record_event(event_type: String, payload: Dictionary = {}) -> void:
	event_sequence += 1
	var event := {
		"sequence": event_sequence,
		"tick": Engine.get_physics_frames(),
		"simulation_step": physics_steps,
		"type": event_type,
		"source": "fixture_recorded",
	}
	for key in payload:
		event[key] = payload[key]
	events.append(event)
	if events.size() > MAX_EVENTS:
		events.pop_front()
