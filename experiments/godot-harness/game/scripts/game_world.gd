extends Node3D

## Phase 16 - Deflect Arena.
##
## One player, one enemy, one arena. The game owns three things the harness
## needs: a deterministic fixed-tick simulation that the bridge can pause and
## advance, an observable snapshot, and an event stream. It deliberately uses
## Godot's CharacterBody3D, physics shape queries, and scene graph; no custom
## engine, renderer, or observation layer is added.
##
## Combat is tick-based rather than animation-driven:
##   attack: 6 windup + 8 active + 14 recover ticks
##   parry:  14-tick deflection window
##   enemy:  30 windup + 9 active + 18 recover ticks
## The sword hitbox is a BoxShape3D queried against the enemy collision layer
## only during active ticks, so an attack cannot damage anything before or
## after its active window.

const FighterRigScript = preload("res://scripts/fighter_rig.gd")
const EnemyAIScript = preload("res://scripts/enemy_ai.gd")

const WORLD_LAYER := 1
const PLAYER_LAYER := 2
const ENEMY_LAYER := 4

const ARENA_HALF := 12.0
const PLAYER_SPAWN := Vector3(0.0, 0.02, 4.4)
const ENEMY_SPAWN := Vector3(0.0, 0.02, 0.8)

const PLAYER_SPEED := 4.4
const PLAYER_ACCEL := 26.0
const ENEMY_SPEED := 2.2
const GRAVITY := 18.0
const TURN_SHARPNESS := 12.0
const ENEMY_TURN_SHARPNESS := 8.0

const PLAYER_MAX_HEALTH := 4
const ATTACK_WINDUP_TICKS := 6
const ATTACK_ACTIVE_TICKS := 8
const ATTACK_RECOVER_TICKS := 14
const ATTACK_COOLDOWN_TICKS := 6
const PARRY_WINDOW_TICKS := 14
const PARRY_RECOVER_TICKS := 8

## Phase 17 dodge-roll. All values are fixed physics ticks so the burst is
## reproducible under the harness.
const DODGE_ACTIVE_TICKS := 18
const DODGE_RECOVERY_TICKS := 10
const DODGE_COOLDOWN_TICKS := 45
const DODGE_SPEED := 9.0
const DODGE_INVULN_START_TICK := 3
const DODGE_INVULN_END_TICK := 14

const PLAYER_HITBOX_SIZE := Vector3(1.5, 1.3, 2.0)
const PLAYER_HITBOX_CENTER := Vector3(0.0, 1.0, -1.3)
const ENEMY_HITBOX_SIZE := Vector3(1.3, 1.3, 2.2)
const ENEMY_HITBOX_CENTER := Vector3(0.0, 1.0, -1.25)

const MAX_EVENTS := 200
const CAMERA_OFFSET := Vector3(1.1, 2.7, 4.7)
const CAMERA_TARGET_HEIGHT := 1.15
const CAMERA_BLEND := 0.35

var player: CharacterBody3D
var player_rig
var enemy: CharacterBody3D
var enemy_rig
var enemy_ai
var camera: Camera3D
var status_label: Label
var center_label: Label
var feedback_label: Label

var step := 0
var sim_time := 0.0
var player_health := PLAYER_MAX_HEALTH
var attack_phase := "idle"
var attack_tick := 0
var attack_cooldown := 0
var attack_hit := false
var last_hitbox_query_step := -1
var parry_ticks := 0
var parry_cooldown := 0
var parry_result := "none"
var dodge_phase := "idle"
var dodge_tick := 0
var dodge_cooldown := 0
var dodge_direction := Vector3.ZERO
var dodge_invulnerable := false
var dodge_evaded_this_dodge := false
var enemy_ai_enabled := true
var outcome := "playing"
var player_facing_yaw := 0.0
var feedback_text := ""
var feedback_ticks := 0

var events: Array[Dictionary] = []
var event_sequence := 0
var last_event_type := ""

var harness_mode := false
var harness_input := {
	"forward": 0.0,
	"strafe": 0.0,
	"attack": false,
	"parry": false,
	"dodge": false,
	"restart": false,
}


func _ready() -> void:
	_ensure_input_actions()
	_build_environment()
	_build_arena()
	_build_player()
	_build_enemy()
	_build_camera()
	_build_hud()
	reset_game()
	add_to_group("harness_game")


func _physics_process(delta: float) -> void:
	if player == null or enemy == null:
		return
	var frame_input: Dictionary
	if harness_mode:
		frame_input = harness_input.duplicate(true)
	else:
		frame_input = _read_live_input()
	_step_simulation(delta, frame_input)
	if harness_mode:
		_consume_edges()


func _read_live_input() -> Dictionary:
	return {
		"forward": Input.get_action_strength("move_forward") - Input.get_action_strength("move_back"),
		"strafe": Input.get_action_strength("move_right") - Input.get_action_strength("move_left"),
		"attack": Input.is_action_just_pressed("attack"),
		"parry": Input.is_action_just_pressed("parry"),
		"dodge": Input.is_action_just_pressed("dodge"),
		"restart": Input.is_action_just_pressed("restart"),
	}
	
	
func _consume_edges() -> void:
	harness_input["attack"] = false
	harness_input["parry"] = false
	harness_input["dodge"] = false
	harness_input["restart"] = false


func _step_simulation(delta: float, frame_input: Dictionary) -> void:
	if bool(frame_input.get("restart", false)):
		reset_game()
		return

	step += 1
	sim_time += delta
	if feedback_ticks > 0:
		feedback_ticks -= 1
		if feedback_ticks == 0:
			feedback_text = ""

	if outcome == "playing":
		_step_player(delta, frame_input)
		_step_enemy(delta)
		_resolve_combat()
		_step_player_timers(delta)
	else:
		# The encounter is over, but an attempted dodge is still an observable
		# request. Record the rejection without touching any combat state.
		if bool(frame_input.get("dodge", false)):
			_record("dodge_rejected", {"reason": "not_playing"})

	_update_visuals(delta)
	_update_camera(CAMERA_BLEND)
	_update_hud()


# ---------------------------------------------------------------------------
# Player
# ---------------------------------------------------------------------------

func _step_player(delta: float, frame_input: Dictionary) -> void:
	var forward := clampf(float(frame_input.get("forward", 0.0)), -1.0, 1.0)
	var strafe := clampf(float(frame_input.get("strafe", 0.0)), -1.0, 1.0)
	var move := Vector3(strafe, 0.0, -forward)
	if move.length() > 1.0:
		move = move.normalized()

	# Advance dodge timers before reacting to this tick's input. A dodge that
	# started on an earlier tick therefore exposes tick 0 on the start tick and
	# tick 1 on the next one, which keeps the documented active ticks 0..17.
	_advance_dodge_state()

	if bool(frame_input.get("dodge", false)):
		_start_dodge(move)

	# A committed dodge owns the player's body until recovery ends. Attack and
	# deflect requests are ignored rather than cancelling the roll.
	if dodge_phase == "idle":
		if bool(frame_input.get("attack", false)):
			_start_attack()
		if bool(frame_input.get("parry", false)):
			_start_parry()

	if dodge_phase == "active":
		player.velocity.x = dodge_direction.x * DODGE_SPEED
		player.velocity.z = dodge_direction.z * DODGE_SPEED
	elif dodge_phase == "recovery":
		# Recovery carries no dodge movement; the player is vulnerable.
		player.velocity.x = 0.0
		player.velocity.z = 0.0
	else:
		var multiplier := 1.0
		if attack_phase != "idle":
			multiplier = 0.35
		elif parry_ticks > 0:
			multiplier = 0.55

		var target := move * PLAYER_SPEED * multiplier
		player.velocity.x = move_toward(player.velocity.x, target.x, PLAYER_ACCEL * delta)
		player.velocity.z = move_toward(player.velocity.z, target.z, PLAYER_ACCEL * delta)
	player.velocity.y -= GRAVITY * delta
	player.move_and_slide()

	# Movement input cannot steer an active/recovery dodge. The committed
	# direction stays visible through the player's facing.
	if dodge_phase == "idle" and move.length() > 0.05:
		player_facing_yaw = atan2(-move.x, -move.z)
	player.rotation.y = lerp_angle(
		player.rotation.y,
		player_facing_yaw,
		1.0 - exp(-TURN_SHARPNESS * delta),
	)

	if attack_phase == "windup":
		attack_tick += 1
		if attack_tick >= ATTACK_WINDUP_TICKS:
			attack_phase = "active"
			attack_tick = 0
			_record("attack_active")
	elif attack_phase == "active":
		attack_tick += 1
		_check_player_hit()
		if attack_tick >= ATTACK_ACTIVE_TICKS:
			attack_phase = "recover"
			attack_tick = 0
			_record("attack_recover")
	elif attack_phase == "recover":
		attack_tick += 1
		if attack_tick >= ATTACK_RECOVER_TICKS:
			attack_phase = "idle"
			attack_tick = 0
			attack_cooldown = ATTACK_COOLDOWN_TICKS


## Advance one tick of dodge bookkeeping. Called at the start of a playing tick
## so the phase/tick values visible in that tick's snapshot are the values used
## by combat resolution later in the same tick.
func _advance_dodge_state() -> void:
	if dodge_cooldown > 0:
		dodge_cooldown -= 1
	if dodge_phase == "active":
		dodge_tick += 1
		if dodge_tick >= DODGE_ACTIVE_TICKS:
			dodge_phase = "recovery"
			dodge_tick = 0
			_record("dodge_recovery")
	elif dodge_phase == "recovery":
		dodge_tick += 1
		if dodge_tick >= DODGE_RECOVERY_TICKS:
			dodge_phase = "idle"
			dodge_tick = 0
			dodge_direction = Vector3.ZERO
			_record("dodge_finished")
	dodge_invulnerable = (
		dodge_phase == "active"
		and dodge_tick >= DODGE_INVULN_START_TICK
		and dodge_tick < DODGE_INVULN_END_TICK
	)


func _start_dodge(move: Vector3) -> void:
	var reason := ""
	if outcome != "playing":
		reason = "not_playing"
	elif dodge_phase != "idle":
		reason = "dodge_not_idle"
	elif dodge_cooldown > 0:
		reason = "cooldown"
	elif attack_phase != "idle":
		reason = "attacking"
	elif parry_ticks > 0:
		reason = "parrying"
	if not reason.is_empty():
		_record("dodge_rejected", {"reason": reason})
		return

	# Movement input defines the roll direction. With no input, roll backwards
	# relative to the facing the player had when the dodge was requested.
	var direction := move
	if direction.length() <= 0.05:
		direction = Vector3(sin(player_facing_yaw), 0.0, cos(player_facing_yaw))
	direction.y = 0.0
	if direction.length() <= 0.001:
		direction = Vector3(0.0, 0.0, 1.0)
	direction = direction.normalized()

	dodge_phase = "active"
	dodge_tick = 0
	dodge_cooldown = DODGE_COOLDOWN_TICKS
	dodge_direction = direction
	dodge_invulnerable = false
	dodge_evaded_this_dodge = false

	# Turn the rig toward the chosen direction so the roll reads clearly.
	player_facing_yaw = atan2(-direction.x, -direction.z)
	player.rotation.y = player_facing_yaw

	_record("dodge_started", {
		"direction": _vec3(direction),
		"dodge_direction": _vec3(direction),
		"cooldown": dodge_cooldown,
		"dodge_cooldown": dodge_cooldown,
	})
	_set_feedback("DODGE", 12)


func _dodge_available() -> bool:
	return (
		outcome == "playing"
		and dodge_phase == "idle"
		and dodge_cooldown <= 0
		and attack_phase == "idle"
		and parry_ticks <= 0
	)



func _start_attack() -> void:
	if dodge_phase != "idle" or attack_phase != "idle" or attack_cooldown > 0 or parry_ticks > 0:
		return
	attack_phase = "windup"
	attack_tick = 0
	attack_hit = false
	_record("attack_started")


func _start_parry() -> void:
	if dodge_phase != "idle" or attack_phase != "idle" or parry_ticks > 0 or parry_cooldown > 0:
		return
	parry_ticks = PARRY_WINDOW_TICKS
	parry_result = "active"
	_record("parry_started")


func _check_player_hit() -> void:
	if attack_hit or enemy_ai.is_defeated():
		return
	last_hitbox_query_step = step
	var hits := _query_box(_player_hitbox_transform(), PLAYER_HITBOX_SIZE, ENEMY_LAYER)
	if hits.is_empty():
		return
	attack_hit = true
	enemy_ai.apply_hit()
	enemy_rig.flash(Color("#ff5a4a"), 8)
	_set_feedback("HIT", 18)
	_record("player_hit_enemy", {
		"enemy_health": enemy_ai.health,
		"enemy_posture": enemy_ai.posture,
	})
	if enemy_ai.is_defeated():
		outcome = "victory"
		_record("enemy_defeated")
		_record("victory")


func _step_player_timers(_delta: float) -> void:
	if parry_ticks > 0:
		parry_ticks -= 1
		if parry_ticks == 0 and parry_result == "active":
			parry_result = "expired"
			parry_cooldown = PARRY_RECOVER_TICKS
			_record("parry_expired")
	elif parry_cooldown > 0:
		parry_cooldown -= 1
	if attack_phase == "idle" and attack_cooldown > 0:
		attack_cooldown -= 1


# ---------------------------------------------------------------------------
# Enemy
# ---------------------------------------------------------------------------

func _step_enemy(delta: float) -> void:
	var to_player := player.global_position - enemy.global_position
	to_player.y = 0.0
	var distance := to_player.length()
	if enemy_ai_enabled:
		enemy_ai.tick(distance)
		if enemy_ai.attack_started:
			_record("enemy_windup", {"distance": distance})
		if enemy_ai.entered_active:
			_record("enemy_active")

	var direction := Vector3.ZERO
	if distance > 0.001:
		direction = to_player / distance

	if enemy_ai.should_approach():
		enemy.velocity.x = direction.x * ENEMY_SPEED
		enemy.velocity.z = direction.z * ENEMY_SPEED
	elif enemy_ai.phase == "active" and enemy_ai.phase_tick <= 3:
		enemy.velocity.x = direction.x * 1.3
		enemy.velocity.z = direction.z * 1.3
	else:
		enemy.velocity.x = move_toward(enemy.velocity.x, 0.0, 22.0 * delta)
		enemy.velocity.z = move_toward(enemy.velocity.z, 0.0, 22.0 * delta)
	enemy.velocity.y -= GRAVITY * delta
	enemy.move_and_slide()

	if not enemy_ai.is_defeated() and distance > 0.05:
		var yaw := atan2(-direction.x, -direction.z)
		enemy.rotation.y = lerp_angle(
			enemy.rotation.y,
			yaw,
			1.0 - exp(-ENEMY_TURN_SHARPNESS * delta),
		)


func _resolve_combat() -> void:
	if enemy_ai.damage_window and outcome == "playing":
		var hits := _query_box(_enemy_hitbox_transform(), ENEMY_HITBOX_SIZE, PLAYER_LAYER)
		if not hits.is_empty():
			if dodge_invulnerable:
				if not dodge_evaded_this_dodge:
					dodge_evaded_this_dodge = true
					player_rig.flash(Color("#9fe8ff"), 8)
					_set_feedback("EVADE", 20)
					_record("dodge_evaded", {
						"player_health": player_health,
						"direction": _vec3(dodge_direction),
					})
			elif parry_ticks > 0:
				_resolve_parry()
			else:
				player_health -= 1
				player_rig.flash(Color("#ff5a4a"), 8)
				_set_feedback("STRUCK", 20)
				_record("enemy_hit_player", {"player_health": player_health})
				if player_health <= 0:
					player_health = 0
					outcome = "defeat"
					_record("player_defeated")


func _resolve_parry() -> void:
	parry_ticks = 0
	parry_result = "success"
	parry_cooldown = PARRY_RECOVER_TICKS
	enemy_ai.apply_parry()
	player_rig.flash(Color("#9fe8ff"), 8)
	enemy_rig.flash(Color("#ffe08a"), 10)
	_set_feedback("DEFLECT", 30)
	_record("parry_success", {
		"enemy_posture": enemy_ai.posture,
		"enemy_phase": enemy_ai.phase,
	})
	if enemy_ai.is_staggered():
		_record("enemy_staggered")


# ---------------------------------------------------------------------------
# Physics hitboxes
# ---------------------------------------------------------------------------

func _player_hitbox_transform() -> Transform3D:
	return player.global_transform * Transform3D(Basis(), PLAYER_HITBOX_CENTER)


func _enemy_hitbox_transform() -> Transform3D:
	return enemy.global_transform * Transform3D(Basis(), ENEMY_HITBOX_CENTER)


func _query_box(box_transform: Transform3D, size: Vector3, mask: int) -> Array:
	var shape := BoxShape3D.new()
	shape.size = size
	var query := PhysicsShapeQueryParameters3D.new()
	query.shape = shape
	query.transform = box_transform
	query.collision_mask = mask
	query.collide_with_bodies = true
	query.collide_with_areas = false
	return player.get_world_3d().direct_space_state.intersect_shape(query, 8)


# ---------------------------------------------------------------------------
# Reset and harness surface
# ---------------------------------------------------------------------------

func reset_game() -> void:
	step = 0
	sim_time = 0.0
	player_health = PLAYER_MAX_HEALTH
	attack_phase = "idle"
	attack_tick = 0
	attack_cooldown = 0
	attack_hit = false
	last_hitbox_query_step = -1
	parry_ticks = 0
	parry_cooldown = 0
	parry_result = "none"
	dodge_phase = "idle"
	dodge_tick = 0
	dodge_cooldown = 0
	dodge_direction = Vector3.ZERO
	dodge_invulnerable = false
	dodge_evaded_this_dodge = false
	enemy_ai_enabled = true
	outcome = "playing"
	player_facing_yaw = 0.0
	feedback_text = ""
	feedback_ticks = 0
	events.clear()
	event_sequence = 0
	last_event_type = ""

	player.global_position = PLAYER_SPAWN
	player.velocity = Vector3.ZERO
	player.rotation = Vector3.ZERO
	enemy.global_position = ENEMY_SPAWN
	enemy.velocity = Vector3.ZERO
	enemy.rotation = Vector3.ZERO
	enemy_ai.reset()

	player_rig.reset_pose()
	enemy_rig.reset_pose()
	_update_visuals(0.0)
	_update_camera(1.0)
	_update_hud()
	_record("reset")


func set_harness_input(values: Dictionary) -> Dictionary:
	harness_mode = true
	for key in ["forward", "strafe"]:
		if values.has(key):
			harness_input[key] = clampf(float(values[key]), -1.0, 1.0)
	for key in ["attack", "parry", "dodge", "restart"]:
		if values.has(key):
			harness_input[key] = bool(values[key])
	# The controller validates a fixed schema: movement at the top level and
	# one-shot actions under `actions`. Direct GDScript callers may also pass
	# the flat keys above, which keeps the in-engine suite simple.
	var actions = values.get("actions", null)
	if actions is Dictionary:
		for key in ["attack", "parry", "dodge"]:
			if actions.has(key):
				harness_input[key] = bool(actions[key])
	return harness_input.duplicate(true)


func harness_reset() -> Dictionary:
	harness_mode = true
	harness_input = {
		"forward": 0.0,
		"strafe": 0.0,
		"attack": false,
		"parry": false,
		"dodge": false,
		"restart": false,
	}
	reset_game()
	return snapshot()


func harness_step(delta: float = 1.0 / 60.0) -> Dictionary:
	_step_simulation(delta, harness_input.duplicate(true))
	_consume_edges()
	return snapshot()


## Test-only scenario setup. It moves the two bodies and can freeze the enemy
## AI so a hitbox or parry assertion is not racing an enemy decision. It does
## not fabricate outcomes: all damage still runs through the same combat code.
func harness_setup(values: Dictionary) -> Dictionary:
	if values.has("enemy_ai_enabled"):
		enemy_ai_enabled = bool(values["enemy_ai_enabled"])
	if values.has("player_position"):
		player.global_position = _to_vector3(values["player_position"])
		player.velocity = Vector3.ZERO
	if values.has("enemy_position"):
		enemy.global_position = _to_vector3(values["enemy_position"])
		enemy.velocity = Vector3.ZERO
	if values.has("player_rotation_deg"):
		player.rotation.y = deg_to_rad(float(values["player_rotation_deg"]))
		player_facing_yaw = player.rotation.y
	if values.has("player_health"):
		player_health = clampi(int(values["player_health"]), 0, PLAYER_MAX_HEALTH)
	if values.has("enemy_health"):
		enemy_ai.health = clampi(int(values["enemy_health"]), 0, EnemyAIScript.MAX_HEALTH)
	if values.has("enemy_posture"):
		enemy_ai.posture = clampf(float(values["enemy_posture"]), 0.0, EnemyAIScript.MAX_POSTURE)
	enemy_ai.attack_started = false
	enemy_ai.entered_active = false
	enemy_ai.damage_window = false
	attack_phase = "idle"
	attack_tick = 0
	attack_cooldown = 0
	attack_hit = false
	parry_ticks = 0
	parry_cooldown = 0
	parry_result = "none"
	dodge_phase = "idle"
	dodge_tick = 0
	dodge_cooldown = 0
	dodge_direction = Vector3.ZERO
	dodge_invulnerable = false
	dodge_evaded_this_dodge = false
	player_facing_yaw = player.rotation.y
	_update_visuals(0.0)
	_update_camera(1.0)
	_update_hud()
	return snapshot()


func snapshot() -> Dictionary:
	return {
		"step": step,
		"sim_time_seconds": sim_time,
		"player_position": _vec3(player.global_position),
		"player_velocity": _vec3(player.velocity),
		"grounded": player.is_on_floor(),
		"player_facing_deg": rad_to_deg(player.rotation.y),
		"player_health": player_health,
		"player_attack_phase": attack_phase,
		"player_attack_tick": attack_tick,
		"hitbox_active": attack_phase == "active",
		"last_hitbox_query_step": last_hitbox_query_step,
		"parry_ticks": parry_ticks,
		"parry_result": parry_result,
		"parry_cooldown": parry_cooldown,
		"dodge_phase": dodge_phase,
		"dodge_tick": dodge_tick,
		"dodge_cooldown": dodge_cooldown,
		"dodge_invulnerable": dodge_invulnerable,
		"dodge_direction": _vec3(dodge_direction),
		"dodge_available": _dodge_available(),
		"enemy_position": _vec3(enemy.global_position),
		"enemy_health": enemy_ai.health,
		"enemy_posture": enemy_ai.posture,
		"enemy_phase": enemy_ai.phase,
		"enemy_phase_tick": enemy_ai.phase_tick,
		"enemy_stagger_ticks": enemy_ai.stagger_ticks,
		"enemy_staggered": enemy_ai.is_staggered(),
		"enemy_defeated": enemy_ai.is_defeated(),
		"enemy_ai_enabled": enemy_ai_enabled,
		"outcome": outcome,
		"camera_position": _vec3(camera.global_position),
		"camera_distance": camera.global_position.distance_to(
			player.global_position + Vector3(0.0, CAMERA_TARGET_HEIGHT, 0.0)
		),
		"last_event_type": last_event_type,
		"events_count": events.size(),
		"input": harness_input.duplicate(true),
		"hud": status_label.text if status_label != null else "",
		"hash": harness_hash(),
	}


func harness_events(since_tick: int = 0) -> Array:
	var result: Array = []
	for event in events:
		if int(event.get("tick", 0)) >= since_tick:
			result.append(event.duplicate(true))
	return result


func harness_hash() -> String:
	var fields: Array[String] = [
		"step=%d" % step,
		"player=%.9f,%.9f,%.9f" % [player.global_position.x, player.global_position.y, player.global_position.z],
		"enemy=%.9f,%.9f,%.9f" % [enemy.global_position.x, enemy.global_position.y, enemy.global_position.z],
		"player_health=%d" % player_health,
		"enemy_health=%d" % enemy_ai.health,
		"posture=%.6f" % enemy_ai.posture,
		"attack=%s:%d" % [attack_phase, attack_tick],
		"parry=%d:%s" % [parry_ticks, parry_result],
		"dodge=%s:%d:%d:%s" % [dodge_phase, dodge_tick, dodge_cooldown, str(dodge_invulnerable)],
		"enemy_phase=%s:%d" % [enemy_ai.phase, enemy_ai.phase_tick],
		"outcome=%s" % outcome,
	]
	return "\n".join(fields).sha256_text()


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


func _set_feedback(text: String, ticks: int) -> void:
	feedback_text = text
	feedback_ticks = ticks


# ---------------------------------------------------------------------------
# Visuals
# ---------------------------------------------------------------------------

func _update_visuals(_delta: float) -> void:
	_update_player_visual()
	_update_enemy_visual()


func _update_player_visual() -> void:
	var planar := Vector2(player.velocity.x, player.velocity.z).length()
	var speed01 := clampf(planar / PLAYER_SPEED, 0.0, 1.0)
	var pose := {"speed01": speed01, "time": sim_time}
	if outcome == "defeat":
		pose["mode"] = "defeated"
	elif dodge_phase != "idle":
		pose["mode"] = "dodge"
		pose["dodge_progress"] = _dodge_visual_progress()
	elif attack_phase != "idle":
		pose["mode"] = "attack"
		pose["attack_progress"] = _player_attack_progress()
	elif parry_ticks > 0:
		pose["mode"] = "parry"
		pose["parry_progress"] = 1.0 - float(parry_ticks) / float(PARRY_WINDOW_TICKS)
	else:
		pose["mode"] = "locomotion"
	player_rig.animate(pose)
	player_rig.tick_visual()


func _update_enemy_visual() -> void:
	var planar := Vector2(enemy.velocity.x, enemy.velocity.z).length()
	var speed01 := clampf(planar / ENEMY_SPEED, 0.0, 1.0)
	var pose := {"speed01": speed01, "time": sim_time}
	if enemy_ai.is_defeated():
		pose["mode"] = "defeated"
	elif enemy_ai.is_staggered():
		pose["mode"] = "stagger"
		pose["stagger_progress"] = enemy_ai.phase_progress()
	elif enemy_ai.phase == "windup":
		pose["mode"] = "attack"
		pose["attack_progress"] = 0.22 * enemy_ai.phase_progress()
	elif enemy_ai.phase == "active":
		pose["mode"] = "attack"
		pose["attack_progress"] = 0.22 + 0.30 * enemy_ai.phase_progress()
	elif enemy_ai.phase == "recover":
		pose["mode"] = "attack"
		pose["attack_progress"] = 0.52 + 0.48 * enemy_ai.phase_progress()
	else:
		pose["mode"] = "locomotion"
	enemy_rig.animate(pose)
	enemy_rig.set_telegraph(enemy_ai.telegraphing())
	enemy_rig.tick_visual()


func _player_attack_progress() -> float:
	match attack_phase:
		"windup":
			return 0.22 * float(attack_tick) / float(ATTACK_WINDUP_TICKS)
		"active":
			return 0.22 + 0.30 * float(attack_tick) / float(ATTACK_ACTIVE_TICKS)
		"recover":
			return 0.52 + 0.48 * float(attack_tick) / float(ATTACK_RECOVER_TICKS)
		_:
			return 0.0


func _dodge_visual_progress() -> float:
	var total := float(DODGE_ACTIVE_TICKS + DODGE_RECOVERY_TICKS)
	if dodge_phase == "active":
		return clampf(float(dodge_tick) / total, 0.0, 1.0)
	if dodge_phase == "recovery":
		return clampf(float(DODGE_ACTIVE_TICKS + dodge_tick) / total, 0.0, 1.0)
	return 0.0


func _update_camera(blend: float) -> void:
	if player == null or camera == null:
		return
	var target := player.global_position + Vector3(0.0, CAMERA_TARGET_HEIGHT, 0.0)
	var desired := player.global_position + CAMERA_OFFSET
	var query := PhysicsRayQueryParameters3D.create(target, desired, WORLD_LAYER)
	query.collide_with_areas = false
	query.exclude = [player.get_rid(), enemy.get_rid()]
	var hit := player.get_world_3d().direct_space_state.intersect_ray(query)
	if not hit.is_empty():
		var normal: Vector3 = hit.get("normal", Vector3.ZERO)
		desired = hit.position + normal * 0.35
		desired.y = maxf(desired.y, player.global_position.y + 1.3)
		# With the player's back to a wall the boom can collapse to almost
		# nothing. Raise the camera instead of pushing it through the wall, so
		# the view becomes a close top-down angle rather than an inside-the-
		# geometry shot.
		var boom := desired - target
		var minimum_boom := 1.6
		if boom.length() < minimum_boom:
			desired += Vector3(0.0, minimum_boom - boom.length(), 0.0)
	desired.y = maxf(desired.y, player.global_position.y + 1.4)
	camera.global_position = camera.global_position.lerp(desired, blend)
	camera.look_at(target, Vector3.UP)


func _update_hud() -> void:
	if status_label == null:
		return
	var incoming: bool = enemy_ai.phase == "windup" or enemy_ai.phase == "active"
	var state_line := "duel"
	if outcome == "victory":
		state_line = "enemy defeated"
	elif outcome == "defeat":
		state_line = "you fell"
	elif incoming:
		state_line = "INCOMING ATTACK - press K to deflect"
	elif enemy_ai.is_staggered():
		state_line = "enemy staggered"
	elif attack_phase != "idle":
		state_line = "attacking"
	elif parry_ticks > 0:
		state_line = "deflecting"
	elif dodge_phase != "idle":
		state_line = "dodging"

	var dodge_status := "READY"
	if dodge_phase == "active":
		dodge_status = "ACTIVE"
	elif dodge_phase == "recovery":
		dodge_status = "RECOVERY"
	elif dodge_cooldown > 0:
		dodge_status = "COOLDOWN %.2fs" % (float(dodge_cooldown) / 60.0)

	status_label.text = "\n".join([
		"DEFLECT ARENA",
		"PLAYER  HP %d/%d  %s" % [player_health, PLAYER_MAX_HEALTH, _pips(player_health, PLAYER_MAX_HEALTH)],
		"ENEMY   HP %d/%d  %s" % [enemy_ai.health, EnemyAIScript.MAX_HEALTH, _pips(enemy_ai.health, EnemyAIScript.MAX_HEALTH)],
		"POSTURE %d/%d  %s" % [
			int(round(enemy_ai.posture)),
			int(EnemyAIScript.MAX_POSTURE),
			_bar(float(enemy_ai.posture) / EnemyAIScript.MAX_POSTURE, 14),
		],
		"STATE   %s" % state_line,
		"DODGE   %s" % dodge_status,
		"J attack    K deflect    SPACE dodge    R restart",
	])

	if outcome == "victory":
		center_label.text = "VICTORY\npress R to restart"
		center_label.visible = true
	elif outcome == "defeat":
		center_label.text = "DEFEATED\npress R to restart"
		center_label.visible = true
	else:
		center_label.visible = false

	feedback_label.text = feedback_text
	feedback_label.visible = feedback_ticks > 0 and outcome == "playing"


func _pips(value: int, maximum: int) -> String:
	var text := "["
	for index in range(maximum):
		text += "#" if index < value else "-"
	return text + "]"


func _bar(fraction: float, width: int) -> String:
	var filled := int(round(clampf(fraction, 0.0, 1.0) * float(width)))
	var text := "["
	for index in range(width):
		text += "#" if index < filled else "."
	return text + "]"


# ---------------------------------------------------------------------------
# Scene construction
# ---------------------------------------------------------------------------

func _build_environment() -> void:
	RenderingServer.set_default_clear_color(Color("#151a26"))

	var world_environment := WorldEnvironment.new()
	world_environment.name = "WorldEnvironment"
	var environment := Environment.new()
	environment.background_mode = Environment.BG_COLOR
	environment.background_color = Color("#151a26")
	environment.ambient_light_source = Environment.AMBIENT_SOURCE_COLOR
	environment.ambient_light_color = Color("#a3b4d0")
	environment.ambient_light_energy = 0.78
	environment.tonemap_mode = Environment.TONE_MAPPER_FILMIC
	world_environment.environment = environment
	add_child(world_environment)

	var sun := DirectionalLight3D.new()
	sun.name = "Sun"
	sun.rotation_degrees = Vector3(-52.0, -38.0, 0.0)
	sun.light_color = Color("#ffe6c4")
	sun.light_energy = 1.45
	sun.shadow_enabled = true
	add_child(sun)


func _build_arena() -> void:
	var stone := StandardMaterial3D.new()
	stone.albedo_color = Color("#3a3f48")
	stone.roughness = 0.92

	var wall_material := StandardMaterial3D.new()
	wall_material.albedo_color = Color("#262a32")
	wall_material.roughness = 0.95

	var ring_material := StandardMaterial3D.new()
	ring_material.albedo_color = Color("#22262e")
	ring_material.roughness = 1.0

	_add_box_body("Floor", Vector3(0.0, -0.25, 0.0), Vector3(ARENA_HALF * 2.0, 0.5, ARENA_HALF * 2.0), stone)
	_add_box_body("WallNorth", Vector3(0.0, 1.2, -ARENA_HALF - 0.3), Vector3(ARENA_HALF * 2.0 + 1.2, 2.4, 0.6), wall_material)
	_add_box_body("WallSouth", Vector3(0.0, 1.2, ARENA_HALF + 0.3), Vector3(ARENA_HALF * 2.0 + 1.2, 2.4, 0.6), wall_material)
	_add_box_body("WallEast", Vector3(ARENA_HALF + 0.3, 1.2, 0.0), Vector3(0.6, 2.4, ARENA_HALF * 2.0 + 1.2), wall_material)
	_add_box_body("WallWest", Vector3(-ARENA_HALF - 0.3, 1.2, 0.0), Vector3(0.6, 2.4, ARENA_HALF * 2.0 + 1.2), wall_material)

	var ring := MeshInstance3D.new()
	ring.name = "DuelRing"
	var ring_mesh := CylinderMesh.new()
	ring_mesh.top_radius = 3.6
	ring_mesh.bottom_radius = 3.6
	ring_mesh.height = 0.02
	ring_mesh.radial_segments = 48
	ring_mesh.rings = 1
	ring.mesh = ring_mesh
	ring.position = Vector3(0.0, 0.011, 2.6)
	ring.material_override = ring_material
	ring.cast_shadow = GeometryInstance3D.SHADOW_CASTING_SETTING_OFF
	add_child(ring)

	var pillar_material := StandardMaterial3D.new()
	pillar_material.albedo_color = Color("#4a4f59")
	pillar_material.roughness = 0.9
	for x in [-7.0, 7.0]:
		for z in [-7.0, 7.0]:
			_add_pillar(Vector3(x, 0.0, z), pillar_material)


func _add_box_body(node_name: String, center: Vector3, size: Vector3, material: Material) -> void:
	var body := StaticBody3D.new()
	body.name = node_name
	body.collision_layer = WORLD_LAYER
	body.collision_mask = 0
	body.position = center
	add_child(body)

	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = size
	collision.shape = shape
	body.add_child(collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var box := BoxMesh.new()
	box.size = size
	mesh.mesh = box
	mesh.material_override = material
	body.add_child(mesh)


func _add_pillar(position: Vector3, material: Material) -> void:
	var body := StaticBody3D.new()
	body.name = "Pillar"
	body.collision_layer = WORLD_LAYER
	body.collision_mask = 0
	body.position = position
	add_child(body)

	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var shape := CylinderShape3D.new()
	shape.radius = 0.45
	shape.height = 2.8
	collision.shape = shape
	collision.position = Vector3(0.0, 1.4, 0.0)
	body.add_child(collision)

	var mesh := MeshInstance3D.new()
	mesh.name = "Mesh"
	var cylinder := CylinderMesh.new()
	cylinder.top_radius = 0.4
	cylinder.bottom_radius = 0.5
	cylinder.height = 2.8
	cylinder.radial_segments = 14
	mesh.mesh = cylinder
	mesh.position = Vector3(0.0, 1.4, 0.0)
	mesh.material_override = material
	body.add_child(mesh)


func _build_player() -> void:
	player = CharacterBody3D.new()
	player.name = "Player"
	player.collision_layer = PLAYER_LAYER
	player.collision_mask = WORLD_LAYER | ENEMY_LAYER
	add_child(player)

	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.34
	capsule.height = 1.7
	collision.shape = capsule
	collision.position = Vector3(0.0, 0.85, 0.0)
	player.add_child(collision)

	player_rig = FighterRigScript.new()
	player_rig.name = "Rig"
	player.add_child(player_rig)
	player_rig.build(Color("#3d6f92"), Color("#9fe8ff"), Color("#d5dde6"))


func _build_enemy() -> void:
	enemy = CharacterBody3D.new()
	enemy.name = "Enemy"
	enemy.collision_layer = ENEMY_LAYER
	enemy.collision_mask = WORLD_LAYER | PLAYER_LAYER
	add_child(enemy)

	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.38
	capsule.height = 1.65
	collision.shape = capsule
	collision.position = Vector3(0.0, 0.825, 0.0)
	enemy.add_child(collision)

	enemy_rig = FighterRigScript.new()
	enemy_rig.name = "Rig"
	enemy.add_child(enemy_rig)
	enemy_rig.build(Color("#8c3f36"), Color("#ff9a72"), Color("#cdbba6"))

	enemy_ai = EnemyAIScript.new()


func _build_camera() -> void:
	camera = Camera3D.new()
	camera.name = "Camera"
	camera.fov = 62.0
	camera.current = true
	add_child(camera)


func _build_hud() -> void:
	var layer := CanvasLayer.new()
	layer.name = "HUD"
	layer.layer = 10
	add_child(layer)

	var panel := PanelContainer.new()
	panel.name = "StatusPanel"
	panel.set_anchors_preset(Control.PRESET_TOP_LEFT)
	panel.position = Vector2(24.0, 24.0)
	panel.custom_minimum_size = Vector2(620.0, 0.0)
	layer.add_child(panel)

	var style := StyleBoxFlat.new()
	style.bg_color = Color(0.03, 0.04, 0.06, 0.82)
	style.border_width_left = 3
	style.border_color = Color("#9fe8ff")
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

	status_label = Label.new()
	status_label.name = "Status"
	status_label.add_theme_font_size_override("font_size", 18)
	status_label.add_theme_color_override("font_color", Color("#d9ecff"))
	status_label.add_theme_constant_override("line_spacing", 6)
	margin.add_child(status_label)

	center_label = Label.new()
	center_label.name = "Center"
	center_label.set_anchors_preset(Control.PRESET_CENTER)
	center_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	center_label.vertical_alignment = VERTICAL_ALIGNMENT_CENTER
	center_label.add_theme_font_size_override("font_size", 46)
	center_label.add_theme_color_override("font_color", Color("#ffe6a8"))
	center_label.visible = false
	center_label.grow_horizontal = Control.GROW_DIRECTION_BOTH
	center_label.grow_vertical = Control.GROW_DIRECTION_BOTH
	layer.add_child(center_label)

	feedback_label = Label.new()
	feedback_label.name = "Feedback"
	feedback_label.set_anchors_preset(Control.PRESET_CENTER_TOP)
	feedback_label.position = Vector2(150.0, 120.0)
	feedback_label.horizontal_alignment = HORIZONTAL_ALIGNMENT_CENTER
	feedback_label.add_theme_font_size_override("font_size", 34)
	feedback_label.add_theme_color_override("font_color", Color("#9fe8ff"))
	feedback_label.visible = false
	feedback_label.grow_horizontal = Control.GROW_DIRECTION_BOTH
	layer.add_child(feedback_label)


func _ensure_input_actions() -> void:
	_add_key_action("move_left", KEY_A)
	_add_key_action("move_right", KEY_D)
	_add_key_action("move_forward", KEY_W)
	_add_key_action("move_back", KEY_S)
	_add_key_action("attack", KEY_J)
	_add_key_action("parry", KEY_K)
	_add_key_action("dodge", KEY_SPACE)
	_add_key_action("restart", KEY_R)
	_add_mouse_action("attack", MOUSE_BUTTON_LEFT)


func _add_key_action(action: StringName, keycode: int) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	if InputMap.action_get_events(action).is_empty():
		var event := InputEventKey.new()
		event.physical_keycode = keycode
		InputMap.action_add_event(action, event)


func _add_mouse_action(action: StringName, button_index: int) -> void:
	if not InputMap.has_action(action):
		InputMap.add_action(action)
	for event in InputMap.action_get_events(action):
		if event is InputEventMouseButton and event.button_index == button_index:
			return
	var mouse := InputEventMouseButton.new()
	mouse.button_index = button_index
	InputMap.action_add_event(action, mouse)


func _vec3(value: Vector3) -> Array:
	return [value.x, value.y, value.z]


func _to_vector3(value) -> Vector3:
	if value is Vector3:
		return value
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return Vector3.ZERO
