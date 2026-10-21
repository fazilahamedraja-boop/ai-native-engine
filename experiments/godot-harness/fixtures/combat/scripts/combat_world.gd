extends Node3D

## Phase 11 Stage C combat fixture.
##
## The existing rigid humanoid is attached to a real CharacterBody3D. A target
## is a real StaticBody3D on a separate collision layer, and the weapon's Area3D
## tracks the visible blade. The attack is a small deterministic swing; no
## skeleton, animation framework, or AI character behavior is involved.
##
## HITBOX_CENTER_LOCAL is intentionally a single data constant. The Stage C
## benchmark injects one defect into a copy of this fixture, diagnoses it from
## evidence, then restores this value and reruns the identical test.

const MODEL_PATH := "res://assets/humanoid-01.glb"
const GROUND_LAYER := 1
const TARGET_LAYER := 2
const TARGET_MAX_HEALTH := 3
const BLADE_LENGTH := 1.2
const BLADE_CENTER_Z := BLADE_LENGTH * 0.5
const HITBOX_CENTER_LOCAL := Vector3(0.0, 0.0, 0.60)
const HITBOX_SIZE := Vector3(0.45, 0.25, 1.00)
const ATTACK_TOTAL_STEPS := 18
const ATTACK_ACTIVE_START := 4
const ATTACK_ACTIVE_END := 13
const ATTACK_COOLDOWN_STEPS := 12
const MAX_EVENTS := 200

var player: CharacterBody3D
var model: Node3D
var hand: Node3D
var weapon_pivot: Node3D
var blade: MeshInstance3D
var hitbox: Area3D
var hitbox_shape: CollisionShape3D
var target: StaticBody3D
var target_mesh: MeshInstance3D
var target_material: StandardMaterial3D
var target_label: Label3D
var camera: Camera3D
var hud_label: Label
var hitbox_debug: MeshInstance3D

var target_health := TARGET_MAX_HEALTH
var target_flash := 0
var attacks := 0
var hits := 0
var attack_state := "idle"
var attack_timer := 0
var attack_cooldown := 0
var prev_attack := false
var hit_this_attack := false
var physics_steps := 0
var last_hitbox_origin := Vector3.ZERO
var last_hit_target_origin := Vector3.ZERO
var last_hit_distance := -1.0
var events: Array[Dictionary] = []
var event_sequence := 0
var harness_input := {"actions": {}}


func _ready() -> void:
	_build_environment()
	_build_ground()
	_build_player()
	_build_target()
	_build_camera()
	_build_hud()
	reset_game()
	add_to_group("harness_game")


func _build_environment() -> void:
	RenderingServer.set_default_clear_color(Color("#a8bccb"))
	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#a8bccb")
	world_environment.environment = environment
	add_child(world_environment)

	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-48.0, -30.0, 0.0)
	sun.light_energy = 1.25
	sun.shadow_enabled = true
	add_child(sun)


func _build_ground() -> void:
	var ground := StaticBody3D.new()
	ground.name = "Ground"
	ground.collision_layer = GROUND_LAYER
	ground.collision_mask = 0
	add_child(ground)
	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = Vector3(14.0, 0.5, 10.0)
	collision.shape = shape
	collision.position = Vector3(0.0, -0.25, 1.0)
	ground.add_child(collision)
	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = Vector3(14.0, 0.5, 10.0)
	mesh.mesh = box
	mesh.position = Vector3(0.0, -0.25, 1.0)
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#b8a675")
	material.roughness = 0.95
	mesh.material_override = material
	ground.add_child(mesh)


func _build_player() -> void:
	player = CharacterBody3D.new()
	player.name = "Player"
	player.collision_layer = GROUND_LAYER
	player.collision_mask = GROUND_LAYER
	player.position = Vector3.ZERO
	add_child(player)
	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	collision.position = Vector3(0.0, 0.85, 0.0)
	var shape := CapsuleShape3D.new()
	shape.radius = 0.33
	shape.height = 1.7
	collision.shape = shape
	player.add_child(collision)
	model = _load_model(MODEL_PATH, "Humanoid")
	if model != null:
		player.add_child(model)
		hand = model.find_child("hand_r", true, false) as Node3D
	weapon_pivot = Node3D.new()
	weapon_pivot.name = "WeaponPivot"
	weapon_pivot.position = Vector3(0.295, 0.88, 0.0) if hand == null else Vector3.ZERO
	weapon_pivot.rotation_degrees = Vector3(0.0, -55.0, 0.0)
	if hand != null:
		hand.add_child(weapon_pivot)
	else:
		player.add_child(weapon_pivot)
	blade = MeshInstance3D.new()
	blade.name = "Blade"
	var blade_mesh := BoxMesh.new()
	blade_mesh.size = Vector3(0.12, 0.10, BLADE_LENGTH)
	blade.mesh = blade_mesh
	blade.position = Vector3(0.0, 0.0, BLADE_CENTER_Z)
	var blade_material := StandardMaterial3D.new()
	blade_material.albedo_color = Color("#d7e7f2")
	blade_material.metallic = 0.85
	blade_material.roughness = 0.22
	blade.material_override = blade_material
	weapon_pivot.add_child(blade)
	var guard := MeshInstance3D.new()
	guard.name = "Guard"
	var guard_mesh := BoxMesh.new()
	guard_mesh.size = Vector3(0.42, 0.09, 0.09)
	guard.mesh = guard_mesh
	guard.position = Vector3(0.0, 0.0, 0.04)
	guard.material_override = blade_material
	weapon_pivot.add_child(guard)
	hitbox = Area3D.new()
	hitbox.name = "WeaponHitbox"
	hitbox.collision_layer = 0
	hitbox.collision_mask = TARGET_LAYER
	hitbox.monitoring = true
	hitbox.monitorable = true
	hitbox.position = HITBOX_CENTER_LOCAL
	weapon_pivot.add_child(hitbox)
	hitbox_shape = CollisionShape3D.new()
	hitbox_shape.name = "Collision"
	var box_shape := BoxShape3D.new()
	box_shape.size = HITBOX_SIZE
	hitbox_shape.shape = box_shape
	hitbox.add_child(hitbox_shape)
	hitbox.body_entered.connect(_on_hitbox_body_entered)
	hitbox.body_exited.connect(_on_hitbox_body_exited)
	hitbox_debug = MeshInstance3D.new()
	hitbox_debug.name = "HitboxDebug"
	var debug_box := BoxMesh.new()
	debug_box.size = HITBOX_SIZE
	hitbox_debug.mesh = debug_box
	hitbox_debug.position = HITBOX_CENTER_LOCAL
	var debug_material := StandardMaterial3D.new()
	debug_material.albedo_color = Color(1.0, 0.16, 0.12, 0.22)
	debug_material.transparency = BaseMaterial3D.TRANSPARENCY_ALPHA
	debug_material.shading_mode = BaseMaterial3D.SHADING_MODE_UNSHADED
	debug_material.cull_mode = BaseMaterial3D.CULL_DISABLED
	hitbox_debug.material_override = debug_material
	hitbox_debug.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	weapon_pivot.add_child(hitbox_debug)


func _build_target() -> void:
	target = StaticBody3D.new()
	target.name = "Target"
	target.collision_layer = TARGET_LAYER
	target.collision_mask = 0
	target.position = Vector3(0.0, 0.0, 1.2)
	add_child(target)
	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	collision.position = Vector3(0.0, 0.75, 0.0)
	var shape := CapsuleShape3D.new()
	shape.radius = 0.32
	shape.height = 1.5
	collision.shape = shape
	target.add_child(collision)
	target_mesh = MeshInstance3D.new()
	target_mesh.name = "Mesh"
	var mesh := CapsuleMesh.new()
	mesh.radius = 0.32
	mesh.height = 1.5
	target_mesh.mesh = mesh
	target_mesh.position = Vector3(0.0, 0.75, 0.0)
	target_material = StandardMaterial3D.new()
	target_material.albedo_color = Color("#c85b5b")
	target_material.roughness = 0.7
	target_mesh.material_override = target_material
	target.add_child(target_mesh)
	target_label = Label3D.new()
	target_label.name = "TargetLabel"
	target_label.font_size = 42
	target_label.modulate = Color("#fff1e6")
	target_label.position = Vector3(0.0, 1.85, 0.0)
	target_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	target_label.no_depth_test = true
	target.add_child(target_label)


func _build_camera() -> void:
	camera = Camera3D.new()
	camera.name = "Camera"
	add_child(camera)
	camera.current = true
	camera.position = Vector3(3.1, 2.15, 3.8)
	camera.look_at(Vector3(0.0, 0.95, 0.62), Vector3.UP)


func _build_hud() -> void:
	var layer := CanvasLayer.new()
	layer.name = "HUD"
	layer.layer = 10
	add_child(layer)
	var panel := PanelContainer.new()
	panel.name = "Panel"
	panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	panel.position = Vector2(24.0, 24.0)
	panel.custom_minimum_size = Vector2(570.0, 0.0)
	layer.add_child(panel)
	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.035, 0.045, 0.065, 0.92)
	style.border_width_left = 3
	style.border_color = Color("#ffb4a2")
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
	hud_label.add_theme_color_override("font_color", Color("#f5e9e1"))
	margin.add_child(hud_label)


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
	var loaded := scene as Node3D
	if loaded == null:
		push_error("Root is not Node3D for %s" % path)
		return null
	loaded.name = node_name
	return loaded


func reset_game() -> void:
	physics_steps = 0
	attacks = 0
	hits = 0
	target_health = TARGET_MAX_HEALTH
	target_flash = 0
	attack_state = "idle"
	attack_timer = 0
	attack_cooldown = 0
	prev_attack = false
	hit_this_attack = false
	last_hitbox_origin = Vector3.ZERO
	last_hit_target_origin = Vector3.ZERO
	last_hit_distance = -1.0
	harness_input = {"actions": {}}
	events.clear()
	event_sequence = 0
	if player != null:
		player.position = Vector3.ZERO
		player.velocity = Vector3.ZERO
	if weapon_pivot != null:
		weapon_pivot.rotation_degrees = Vector3(0.0, -55.0, 0.0)
	if hitbox != null:
		hitbox.position = HITBOX_CENTER_LOCAL
		hitbox.monitoring = true
	_update_visuals()
	_update_hud()
	_record_event("reset", {"label": "combat_fixture_reset"})


func _physics_process(_delta: float) -> void:
	physics_steps += 1
	if target_flash > 0:
		target_flash -= 1
	if attack_cooldown > 0:
		attack_cooldown -= 1
	var raw_attack := bool(harness_input.get("actions", {}).get("attack", false))
	var rising_edge := raw_attack and not prev_attack
	if rising_edge and attack_state == "idle" and attack_cooldown <= 0:
		_begin_attack()
	if attack_state == "swinging":
		attack_timer += 1
		var progress := clampf(float(attack_timer) / float(ATTACK_TOTAL_STEPS), 0.0, 1.0)
		weapon_pivot.rotation_degrees.y = lerpf(-55.0, 10.0, progress)
		if attack_timer >= ATTACK_ACTIVE_START and attack_timer <= ATTACK_ACTIVE_END:
			_check_hit()
		if attack_timer >= ATTACK_TOTAL_STEPS:
			attack_state = "idle"
			attack_cooldown = ATTACK_COOLDOWN_STEPS
			_record_event("attack_end", {"attack_index": attacks})
	prev_attack = raw_attack
	_update_visuals()
	_update_hud()


func _begin_attack() -> void:
	attacks += 1
	attack_state = "swinging"
	attack_timer = 0
	hit_this_attack = false
	weapon_pivot.rotation_degrees.y = -55.0
	_record_event("attack_start", {
		"attack_index": attacks,
		"hitbox_center_local": _vec3(HITBOX_CENTER_LOCAL),
		"blade_center_local_z": BLADE_CENTER_Z,
		"hitbox_global_origin": _vec3(hitbox.global_transform.origin),
		"blade_global_origin": _vec3(blade.global_transform.origin),
	})


func _check_hit() -> void:
	last_hitbox_origin = hitbox.global_transform.origin
	var overlaps := hitbox.get_overlapping_bodies()
	var target_overlap := target in overlaps
	if target_overlap and not hit_this_attack:
		_apply_hit(overlaps.size())
	else:
		_record_event("attack_active", {
			"attack_index": attacks,
			"hitbox_global_origin": _vec3(last_hitbox_origin),
			"target_origin": _vec3(target.global_transform.origin),
			"hitbox_overlap_count": overlaps.size(),
			"target_in_hitbox": target_overlap,
		})


func _apply_hit(overlap_count: int) -> void:
	target_health = maxi(0, target_health - 1)
	hits += 1
	hit_this_attack = true
	target_flash = 8
	last_hit_target_origin = target.global_transform.origin
	last_hit_distance = last_hitbox_origin.distance_to(last_hit_target_origin)
	_record_event("hit", {
		"attack_index": attacks,
		"damage": 1,
		"target_health": target_health,
		"target_max_health": TARGET_MAX_HEALTH,
		"hitbox_global_origin": _vec3(last_hitbox_origin),
		"target_origin": _vec3(last_hit_target_origin),
		"hitbox_target_distance": last_hit_distance,
		"hitbox_overlap_count": overlap_count,
	})


func _on_hitbox_body_entered(body: Node3D) -> void:
	if body == target:
		_record_event("hitbox_body_entered", {
			"target_health": target_health,
			"hitbox_global_origin": _vec3(hitbox.global_transform.origin),
		})


func _on_hitbox_body_exited(body: Node3D) -> void:
	if body == target:
		_record_event("hitbox_body_exited", {
			"target_health": target_health,
			"hitbox_global_origin": _vec3(hitbox.global_transform.origin),
		})


func set_harness_input(values: Dictionary) -> Dictionary:
	if values.has("actions") and typeof(values["actions"]) == TYPE_DICTIONARY:
		harness_input = values.duplicate(true)
	else:
		harness_input = {"actions": {}}
	return harness_input.duplicate(true)


func harness_reset() -> Dictionary:
	reset_game()
	return snapshot()


func harness_step(_delta: float) -> Dictionary:
	push_error("combat fixture does not support harness_step; use advance_physics")
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
		"attacks=%d" % attacks,
		"hits=%d" % hits,
		"target_health=%d" % target_health,
		"state=%s" % attack_state,
		"attack_timer=%d" % attack_timer,
		"hitbox=%s" % str(hitbox.global_transform.origin) if hitbox != null else "none",
	]
	return "\n".join(fields).sha256_text()


func snapshot() -> Dictionary:
	var overlaps: Array = []
	if hitbox != null:
		for body in hitbox.get_overlapping_bodies():
			overlaps.append(String(body.get_path()))
	var target_shape_size: Array = []
	var target_collision := target.get_node_or_null("Collision") as CollisionShape3D
	if target_collision != null and target_collision.shape is CapsuleShape3D:
		var capsule := target_collision.shape as CapsuleShape3D
		target_shape_size = [capsule.radius, capsule.height]
	var hitbox_shape_size: Array = []
	if hitbox_shape != null and hitbox_shape.shape is BoxShape3D:
		var box := hitbox_shape.shape as BoxShape3D
		hitbox_shape_size = _vec3(box.size)
	return {
		"step": physics_steps,
		"physics_frames": Engine.get_physics_frames(),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"player": {
			"path": String(player.get_path()),
			"position": _vec3(player.position),
			"rotation_degrees": _vec3(player.rotation_degrees),
		},
		"target": {
			"path": String(target.get_path()),
			"health": target_health,
			"max_health": TARGET_MAX_HEALTH,
			"origin": _vec3(target.global_transform.origin),
			"center": _vec3(target.global_transform * Vector3(0.0, 0.75, 0.0)),
			"collision_shape": target_shape_size,
		},
		"combat": {
			"attacks": attacks,
			"hits": hits,
			"target_health": target_health,
			"target_max_health": TARGET_MAX_HEALTH,
			"attack_state": attack_state,
			"attack_timer": attack_timer,
			"attack_cooldown": attack_cooldown,
			"last_hit_distance": last_hit_distance,
			"last_hitbox_origin": _vec3(last_hitbox_origin),
		},
		"weapon": {
			"pivot_path": String(weapon_pivot.get_path()) if weapon_pivot != null else null,
			"pivot_global_transform": _transform(weapon_pivot.global_transform) if weapon_pivot != null else {},
			"blade_path": String(blade.get_path()) if blade != null else null,
			"blade_center_local_z": BLADE_CENTER_Z,
			"blade_center_world": _vec3(blade.global_transform.origin) if blade != null else [],
			"blade_tip_world": _vec3(blade.global_transform * Vector3(0.0, 0.0, BLADE_LENGTH * 0.5)) if blade != null else [],
			"hitbox_path": String(hitbox.get_path()) if hitbox != null else null,
			"hitbox_center_local": _vec3(HITBOX_CENTER_LOCAL),
			"hitbox_global_transform": _transform(hitbox.global_transform) if hitbox != null else {},
			"hitbox_center_world": _vec3(hitbox.global_transform.origin) if hitbox != null else [],
			"hitbox_shape_size": hitbox_shape_size,
			"hitbox_overlaps": overlaps,
			"target_in_hitbox": target in hitbox.get_overlapping_bodies() if hitbox != null else false,
		},
		"event_count": events.size(),
		"hash": harness_hash(),
	}


func _transform(value: Transform3D) -> Dictionary:
	return {
		"origin": _vec3(value.origin),
		"quaternion": _quat(value.basis.get_rotation_quaternion()),
		"rotation_degrees": _vec3(value.basis.get_euler() * (180.0 / PI)),
	}


func _vec3(value: Vector3) -> Array:
	return [value.x, value.y, value.z]


func _quat(value: Quaternion) -> Array:
	return [value.x, value.y, value.z, value.w]


func _update_visuals() -> void:
	if target_material != null:
		target_material.albedo_color = Color("#ffd166") if target_flash > 0 else Color("#c85b5b")
	if target_label != null:
		target_label.text = "TARGET\nHP %d/%d" % [target_health, TARGET_MAX_HEALTH]
	if hitbox_debug != null:
		hitbox_debug.position = HITBOX_CENTER_LOCAL


func _update_hud() -> void:
	if hud_label == null:
		return
	hud_label.text = "COMBAT AUDIT\nTARGET HP %d/%d\nATTACKS %d   HITS %d\nSTATE %s   TIMER %d\nHITBOX CENTER z=%.2f   BLADE CENTER z=%.2f\nHITBOX SIZE z=%.2f" % [
		target_health,
		TARGET_MAX_HEALTH,
		attacks,
		hits,
		attack_state,
		attack_timer,
		HITBOX_CENTER_LOCAL.z,
		BLADE_CENTER_Z,
		HITBOX_SIZE.z,
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

