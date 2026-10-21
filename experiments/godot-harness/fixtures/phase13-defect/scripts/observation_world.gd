extends Node3D

## Self-contained Phase 10 observation fixture.
##
## It combines one real CharacterBody3D player, a pressure plate (Area3D), a
## gate (StaticBody3D), a beacon with an AnimationPlayer, a falling RigidBody3D
## crate, one existing rigid-part humanoid asset, and one small Skeleton3D
## interface probe. The harness uses only generic operations.

const ObservationPlayerScript = preload("res://scripts/observation_player.gd")
const HumanoidProbeScript = preload("res://scripts/humanoid_probe.gd")

const SPAWN := Vector3(0.0, 0.85, 5.5)
const PLATE_CENTER := Vector3(0.0, 0.10, -1.1)
const PLATE_SIZE := Vector3(1.8, 0.2, 2.2)
const GATE_CENTER := Vector3(0.0, 1.30, -2.5)
const GATE_SIZE := Vector3(4.0, 2.6, 0.3)
const GATE_OPEN_Y := 4.30
const GOAL_Z := -4.60
const CRATE_SPAWN := Vector3(4.2, 3.0, 2.5)
const GROUND_CENTER := Vector3(0.0, -0.25, 0.0)
const GROUND_SIZE := Vector3(24.0, 0.5, 24.0)
const MAX_EVENTS := 200
const PROBE_LABEL := "HUMANOID + PROBE"

var player
var plate: Area3D
var plate_mesh: MeshInstance3D
var plate_material: StandardMaterial3D
var gate: StaticBody3D
var gate_collision: CollisionShape3D
var gate_label: Label3D
var beacon: Node3D
var beacon_mesh: MeshInstance3D
var beacon_material: StandardMaterial3D
var beacon_label: Label3D
var beacon_animation: AnimationPlayer
var goal: Node3D
var goal_label: Label3D
var humanoid
var crate: RigidBody3D
var camera: Camera3D
var hud_label: Label

var physics_steps := 0
var last_delta := 0.0
var last_motion := Vector3.ZERO
var plate_pressed := false
var gate_open := false
var gate_collision_enabled := true
var beacon_state := "red"
var goal_reached := false
var interaction_count := 0
var feedback := "PLATE CLEAR - GATE CLOSED"
var events: Array[Dictionary] = []
var event_sequence := 0
var _last_player_colliders: Dictionary = {}
var _crate_contacts: Dictionary = {}
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
	_build_corridor()
	_build_plate()
	_build_gate()
	_build_beacon()
	_build_goal()
	_build_player()
	_build_crate()
	_build_humanoid()
	_build_camera()
	_build_hud()
	reset_game()
	add_to_group("harness_game")


func _physics_process(delta: float) -> void:
	if player == null or gate == null or gate_collision == null:
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

	_update_player_collisions()
	_check_goal()
	if bool(frame_actions.get("interact", false)):
		interaction_count += 1

	harness_input["jump"] = false
	harness_input["restart"] = false
	harness_input["actions"]["interact"] = false
	_update_camera()
	_update_visuals()
	_update_hud()


func reset_game() -> void:
	physics_steps = 0
	last_delta = 0.0
	last_motion = Vector3.ZERO
	plate_pressed = false
	gate_open = false
	gate_collision_enabled = true
	beacon_state = "red"
	goal_reached = false
	interaction_count = 0
	feedback = "PLATE CLEAR - GATE CLOSED"
	events.clear()
	event_sequence = 0
	_last_player_colliders.clear()
	_crate_contacts.clear()
	harness_input = {
		"forward": 0.0,
		"strafe": 0.0,
		"jump": false,
		"restart": false,
		"actions": {"interact": false},
	}
	player.reset_to(SPAWN)
	gate.position = GATE_CENTER
	gate_collision.disabled = false
	if crate != null:
		crate.global_position = CRATE_SPAWN
		crate.linear_velocity = Vector3.ZERO
		crate.angular_velocity = Vector3.ZERO
		crate.sleeping = false
	_update_camera()
	_update_visuals()
	_update_hud()
	_record_event("reset", {"label": "harness_reset"})


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
	push_error("observation fixture does not support harness_step; use advance_physics")
	return snapshot()


func harness_events(since_tick: int = 0) -> Array:
	var result: Array = []
	for event in events:
		if int(event.get("tick", 0)) >= since_tick:
			result.append(event.duplicate(true))
	return result


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
		"plate_pressed=%s" % str(plate_pressed),
		"gate_open=%s" % str(gate_open),
		"gate_collision=%s" % str(gate_collision_enabled),
		"beacon_state=%s" % beacon_state,
		"goal_reached=%s" % str(goal_reached),
		"crate_position=%.9f,%.9f,%.9f" % [crate.global_position.x, crate.global_position.y, crate.global_position.z],
		"crate_velocity=%.9f,%.9f,%.9f" % [crate.linear_velocity.x, crate.linear_velocity.y, crate.linear_velocity.z],
		"feedback=%s" % feedback,
		"event_sequence=%d" % event_sequence,
	]
	return "\n".join(fields).sha256_text()


func outcome_hash() -> String:
	var position: Vector3 = player.global_position
	var fields: Array[String] = [
		"step=%d" % physics_steps,
		"position_mm=%.3f,%.3f,%.3f" % [position.x, position.y, position.z],
		"plate_pressed=%s" % str(plate_pressed),
		"gate_open=%s" % str(gate_open),
		"gate_collision=%s" % str(gate_collision_enabled),
		"beacon_state=%s" % beacon_state,
		"goal_reached=%s" % str(goal_reached),
		"crate_position_mm=%.3f,%.3f,%.3f" % [
			crate.global_position.x, crate.global_position.y, crate.global_position.z
		],
		"event_sequence=%d" % event_sequence,
	]
	return "\n".join(fields).sha256_text()


func snapshot() -> Dictionary:
	var position: Vector3 = player.global_position
	var velocity: Vector3 = player.velocity
	var last_event: Dictionary = events[-1] if not events.is_empty() else {}
	return {
		"step": physics_steps,
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"physics_frames": Engine.get_physics_frames(),
		"player_position": [position.x, position.y, position.z],
		"player_velocity": [velocity.x, velocity.y, velocity.z],
		"player_motion": [last_motion.x, last_motion.y, last_motion.z],
		"grounded": player.grounded,
		"wall_contact": player.wall_contact,
		"player_colliders": _last_player_colliders.keys(),
		"plate_pressed": plate_pressed,
		"gate_open": gate_open,
		"gate_collision_enabled": gate_collision_enabled,
		"beacon_state": beacon_state,
		"goal_reached": goal_reached,
		"crate_position": [crate.global_position.x, crate.global_position.y, crate.global_position.z],
		"crate_linear_velocity": [
			crate.linear_velocity.x, crate.linear_velocity.y, crate.linear_velocity.z
		],
		"crate_sleeping": crate.sleeping,
		"humanoid_mesh_count": humanoid.harness_mesh_count() if humanoid != null else 0,
		"humanoid_bones": humanoid.harness_bone_names() if humanoid != null else [],
		"interaction_count": interaction_count,
		"feedback": feedback,
		"prompt": _prompt(),
		"events_count": events.size(),
		"last_event_sequence": event_sequence,
		"last_event_type": String(last_event.get("type", "")),
		"input": harness_input.duplicate(true),
		"hash": harness_hash(),
		"outcome_hash": outcome_hash(),
		"hud": hud_label.text if hud_label != null else "",
	}


func _update_gate() -> void:
	# Correct pressure-plate relation: the gate follows the plate state.
	if plate_pressed == gate_open:
		return
	_set_gate_open(plate_pressed)


func _set_gate_open(open: bool) -> void:
	gate_open = open
	gate_collision_enabled = not open
	if gate_collision != null and is_instance_valid(gate_collision):
		gate_collision.set_deferred("disabled", open)
	if gate != null and is_instance_valid(gate):
		gate.position.y = GATE_OPEN_Y if open else GATE_CENTER.y
	beacon_state = "green" if open else "red"
	_record_event("gate_open" if open else "gate_close", {
		"collision_enabled": gate_collision_enabled,
		"plate_pressed": plate_pressed,
	})
	_update_visuals()
	_update_hud()


func _on_plate_body_entered(body: Node3D) -> void:
	if not is_instance_valid(player) or body != player or plate_pressed:
		return
	plate_pressed = true
	feedback = "PLATE PRESSED"
	_record_event("plate_entered", {"body": String(body.get_path())})
	_update_gate()


func _on_plate_body_exited(body: Node3D) -> void:
	if not is_instance_valid(player) or body != player or not plate_pressed:
		return
	plate_pressed = false
	feedback = "PLATE CLEAR - GATE CLOSED"
	_record_event("plate_exited", {"body": String(body.get_path())})
	_update_gate()


func _check_goal() -> void:
	if goal_reached or player == null:
		return
	if player.global_position.z >= GOAL_Z:
		return
	goal_reached = true
	feedback = "GOAL REACHED"
	_record_event("goal_reached", {"z": player.global_position.z})


func _update_player_collisions() -> void:
	var current: Dictionary = {}
	for index in range(player.get_slide_collision_count()):
		var collision: KinematicCollision3D = player.get_slide_collision(index)
		var collider = collision.get_collider()
		if collider == null:
			continue
		var collider_path := String(collider.get_path())
		current[collider_path] = {
			"collider": collider_path,
			"normal": _vec3_array(collision.get_normal()),
			"position": _vec3_array(collision.get_position()),
		}
	for collider_path in current:
		if not _last_player_colliders.has(collider_path):
			_record_event("player_collision_start", current[collider_path])
	for collider_path in _last_player_colliders:
		if not current.has(collider_path):
			_record_event("player_collision_end", {"collider": collider_path})
	_last_player_colliders = current


func _on_crate_body_entered(body: Node) -> void:
	if body == null or not is_instance_valid(crate) or not crate.is_inside_tree():
		return
	var body_path := String(body.get_path())
	if _crate_contacts.has(body_path):
		return
	_crate_contacts[body_path] = true
	_record_event("crate_collision_start", {
		"body": body_path,
		"crate_position": _vec3_array(crate.global_position),
	})


func _on_crate_body_exited(body: Node) -> void:
	if body == null:
		return
	var body_path := String(body.get_path())
	if not _crate_contacts.has(body_path):
		return
	_crate_contacts.erase(body_path)
	_record_event("crate_collision_end", {"body": body_path})


func _record_event(event_type: String, payload: Dictionary = {}) -> void:
	event_sequence += 1
	var tick := Engine.get_physics_frames()
	var ticks_per_second := Engine.physics_ticks_per_second
	var event := {
		"sequence": event_sequence,
		"tick": tick,
		"tick_domain": "engine_physics_frames",
		"sim_time_seconds": float(tick) / float(ticks_per_second),
		"wall_time_ms": Time.get_ticks_msec(),
		"simulation_step": physics_steps,
		"simulation_time_seconds": float(physics_steps) / float(ticks_per_second),
		"type": event_type,
		"source": "fixture_recorded",
	}
	for key in payload:
		event[key] = payload[key]
	events.append(event)
	if events.size() > MAX_EVENTS:
		events.pop_front()


func _update_visuals() -> void:
	if plate_material != null:
		plate_material.albedo_color = Color("#8fff8f") if plate_pressed else Color("#ffd45a")
	if beacon_material != null:
		beacon_material.albedo_color = Color("#63ff8a") if gate_open else Color("#ff5f5f")
		beacon_material.emission = Color("#63ff8a") if gate_open else Color("#ff5f5f")
	if beacon_label != null and is_instance_valid(beacon_label):
		beacon_label.text = "BEACON GREEN" if gate_open else "BEACON RED"
	if gate_label != null and is_instance_valid(gate_label):
		gate_label.text = "GATE OPEN" if gate_open else "GATE CLOSED"


func _update_camera() -> void:
	if camera == null or player == null or not is_instance_valid(player) or not player.is_inside_tree():
		return
	camera.global_position = player.global_position + Vector3(0.0, 5.0, 8.5)
	camera.look_at(player.global_position + Vector3(0.0, 0.9, -3.0), Vector3.UP)


func _update_hud() -> void:
	if hud_label == null or not is_instance_valid(hud_label):
		return
	var position := Vector3.ZERO
	if player != null and is_instance_valid(player) and player.is_inside_tree():
		position = player.global_position
	var crate_height := 0.0
	if crate != null and is_instance_valid(crate) and crate.is_inside_tree():
		crate_height = crate.global_position.y
	hud_label.text = (
		"OBSERVATION FIXTURE\n"
		+ "PLATE: %s   GATE: %s\n"
		+ "BEACON: %s   CRATE: %.2f m\n"
		+ "PLAYER z=%.2f   STEP: %d   TICK: %d\n"
		+ "EVENTS: %d   FEEDBACK: %s"
	) % [
		"PRESSED" if plate_pressed else "CLEAR",
		"OPEN" if gate_open else "CLOSED",
		beacon_state.to_upper(),
		crate_height,
		position.z,
		physics_steps,
		Engine.get_physics_frames(),
		event_sequence,
		feedback,
	]


func _prompt() -> String:
	if goal_reached:
		return "GOAL REACHED"
	if gate_open:
		return "GATE OPEN - GO THROUGH"
	if plate_pressed:
		return "GATE STUCK - WAIT"
	return "WALK ONTO THE PLATE"


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
	_wall_segment("Ground", GROUND_CENTER, GROUND_SIZE, Color("#d8c99a"), true)


func _build_corridor() -> void:
	_wall_segment("LeftWall", Vector3(-4.6, 1.55, -2.5), Vector3(5.2, 3.1, 0.4), Color("#66727b"), true)
	_wall_segment("RightWall", Vector3(4.6, 1.55, -2.5), Vector3(5.2, 3.1, 0.4), Color("#66727b"), true)
	_wall_segment("LeftPost", Vector3(-2.2, 1.55, -2.5), Vector3(0.4, 3.1, 0.4), Color("#7b8792"), true)
	_wall_segment("RightPost", Vector3(2.2, 1.55, -2.5), Vector3(0.4, 3.1, 0.4), Color("#7b8792"), true)
	_wall_segment("Lintel", Vector3(0.0, 3.25, -2.5), Vector3(5.2, 0.4, 0.4), Color("#7b8792"), true)


func _build_plate() -> void:
	plate = Area3D.new()
	plate.name = "Plate"
	plate.position = PLATE_CENTER
	plate.monitorable = true
	plate.monitoring = true
	add_child(plate)

	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = PLATE_SIZE
	collision.shape = shape
	plate.add_child(collision)

	plate_mesh = MeshInstance3D.new()
	plate_mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = PLATE_SIZE
	plate_mesh.mesh = box
	plate_material = StandardMaterial3D.new()
	plate_material.albedo_color = Color("#ffd45a")
	plate_material.roughness = 0.7
	plate_mesh.material_override = plate_material
	plate.add_child(plate_mesh)

	var label := Label3D.new()
	label.name = "PlateLabel"
	label.text = "PRESSURE PLATE"
	label.font_size = 40
	label.modulate = Color("#372f1b")
	label.position = Vector3(0.0, 0.35, 0.0)
	plate.add_child(label)

	plate.body_entered.connect(_on_plate_body_entered)
	plate.body_exited.connect(_on_plate_body_exited)


func _build_gate() -> void:
	gate = StaticBody3D.new()
	gate.name = "Gate"
	gate.position = GATE_CENTER
	add_child(gate)

	gate_collision = CollisionShape3D.new()
	gate_collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = GATE_SIZE
	gate_collision.shape = shape
	gate.add_child(gate_collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = GATE_SIZE
	mesh.mesh = box
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#b06b4f")
	material.roughness = 0.75
	mesh.material_override = material
	gate.add_child(mesh)

	gate_label = Label3D.new()
	gate_label.name = "GateLabel"
	gate_label.text = "GATE CLOSED"
	gate_label.font_size = 64
	gate_label.modulate = Color("#ffd9c9")
	gate_label.position = Vector3(0.0, 0.0, 0.25)
	gate.add_child(gate_label)


func _build_beacon() -> void:
	beacon = Node3D.new()
	beacon.name = "Beacon"
	beacon.position = Vector3(2.8, 0.0, -1.0)
	add_child(beacon)

	var pole := MeshInstance3D.new()
	pole.name = "Pole"
	var cylinder := CylinderMesh.new()
	cylinder.top_radius = 0.08
	cylinder.bottom_radius = 0.08
	cylinder.height = 1.3
	pole.mesh = cylinder
	pole.position = Vector3(0.0, 0.65, 0.0)
	var pole_material := StandardMaterial3D.new()
	pole_material.albedo_color = Color("#44505c")
	pole.material_override = pole_material
	beacon.add_child(pole)

	beacon_mesh = MeshInstance3D.new()
	beacon_mesh.name = "Orb"
	var sphere := SphereMesh.new()
	sphere.radius = 0.28
	sphere.height = 0.56
	beacon_mesh.mesh = sphere
	beacon_mesh.position = Vector3(0.0, 1.5, 0.0)
	beacon_material = StandardMaterial3D.new()
	beacon_material.albedo_color = Color("#ff5f5f")
	beacon_material.emission_enabled = true
	beacon_material.emission = Color("#ff5f5f")
	beacon_material.emission_energy_multiplier = 1.4
	beacon_mesh.material_override = beacon_material
	beacon.add_child(beacon_mesh)

	beacon_label = Label3D.new()
	beacon_label.name = "BeaconLabel"
	beacon_label.text = "BEACON RED"
	beacon_label.font_size = 44
	beacon_label.modulate = Color("#ffe0e0")
	beacon_label.position = Vector3(0.0, 2.05, 0.0)
	beacon_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	beacon.add_child(beacon_label)

	beacon_animation = AnimationPlayer.new()
	beacon_animation.name = "Pulse"
	beacon_animation.root_node = NodePath("..")
	beacon.add_child(beacon_animation)
	var library := AnimationLibrary.new()
	var animation := Animation.new()
	animation.length = 2.0
	animation.loop_mode = Animation.LOOP_LINEAR
	var track := animation.add_track(Animation.TYPE_VALUE)
	animation.track_set_path(track, NodePath("Orb:scale"))
	animation.track_insert_key(track, 0.0, Vector3.ONE)
	animation.track_insert_key(track, 1.0, Vector3(1.25, 1.25, 1.25))
	animation.track_insert_key(track, 2.0, Vector3.ONE)
	library.add_animation("pulse", animation)
	beacon_animation.add_animation_library("", library)
	beacon_animation.play("pulse")


func _build_goal() -> void:
	goal = Node3D.new()
	goal.name = "Goal"
	goal.position = Vector3(0.0, 0.0, GOAL_Z)
	add_child(goal)

	var disc := MeshInstance3D.new()
	disc.name = "Disc"
	var cylinder := CylinderMesh.new()
	cylinder.top_radius = 1.2
	cylinder.bottom_radius = 1.2
	cylinder.height = 0.08
	disc.mesh = cylinder
	disc.position = Vector3(0.0, 0.05, 0.0)
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#73e09a")
	material.emission_enabled = true
	material.emission = Color("#2a8f55")
	material.emission_energy_multiplier = 0.7
	disc.material_override = material
	goal.add_child(disc)

	goal_label = Label3D.new()
	goal_label.name = "GoalLabel"
	goal_label.text = "GOAL"
	goal_label.font_size = 54
	goal_label.modulate = Color("#d9ffe7")
	goal_label.position = Vector3(0.0, 1.1, 0.0)
	goal_label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	goal.add_child(goal_label)


func _build_player() -> void:
	player = ObservationPlayerScript.new()
	player.name = "Player"
	add_child(player)
	player.global_position = SPAWN


func _build_crate() -> void:
	crate = RigidBody3D.new()
	crate.name = "Crate"
	crate.position = CRATE_SPAWN
	crate.mass = 1.0
	crate.gravity_scale = 1.0
	crate.linear_damp = 0.15
	crate.angular_damp = 0.15
	crate.can_sleep = true
	crate.contact_monitor = true
	crate.max_contacts_reported = 8
	add_child(crate)

	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = Vector3(0.7, 0.7, 0.7)
	collision.shape = shape
	crate.add_child(collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = Vector3(0.7, 0.7, 0.7)
	mesh.mesh = box
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#e69b48")
	material.roughness = 0.8
	mesh.material_override = material
	crate.add_child(mesh)

	crate.body_entered.connect(_on_crate_body_entered)
	crate.body_exited.connect(_on_crate_body_exited)


func _build_humanoid() -> void:
	humanoid = HumanoidProbeScript.new()
	humanoid.name = "Humanoid"
	humanoid.position = Vector3(3.2, 0.0, 1.0)
	add_child(humanoid)


func _build_camera() -> void:
	camera = Camera3D.new()
	camera.name = "Camera"
	add_child(camera)
	camera.current = true
	_update_camera()


func _build_hud() -> void:
	var layer := CanvasLayer.new()
	layer.name = "HUD"
	layer.layer = 10
	add_child(layer)

	var panel := PanelContainer.new()
	panel.name = "Panel"
	panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	panel.position = Vector2(24.0, 24.0)
	panel.custom_minimum_size = Vector2(640.0, 0.0)
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


func _wall_segment(
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


func _vec3_array(value: Vector3) -> Array:
	return [value.x, value.y, value.z]
