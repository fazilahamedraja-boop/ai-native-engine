extends SceneTree

## Phase 16 gameplay acceptance suite.
##
## This script adds the real scene to the SceneTree and advances normal fixed
## physics frames, so every assertion is an observable game outcome: positions,
## health, camera transform, collision-query results, and the event stream.
## It does not call private helpers to force a result and it never writes game
## state during an assertion.
##
## `harness_setup()` is used only to put the two bodies in a controlled starting
## arrangement (or to freeze the enemy AI while a hitbox is measured). Damage,
## parry timing, posture, and transitions still run through the same combat
## code used by live play.

const PLAYER_SPAWN := Vector3(0.0, 0.02, 4.4)
const ENEMY_SPAWN := Vector3(0.0, 0.02, 0.8)

var passed := 0
var failed := 0
var cases: Array = []
var trace: Dictionary = {}


func _initialize() -> void:
	_run()


func _run() -> void:
	var world = load("res://main.tscn").instantiate()
	root.add_child(world)
	var startup: Dictionary = await _advance(world, 3)
	_check("game-startup", (
		world.is_in_group("harness_game")
		and bool(startup["grounded"])
		and startup.has("player_position")
		and startup.has("enemy_position")
		and String(startup["outcome"]) == "playing"
	), "grounded=%s outcome=%s events=%d" % [
		str(startup["grounded"]),
		startup["outcome"],
		int(startup["events_count"]),
	])
	trace["startup"] = startup

	await _test_player_movement(world)
	await _test_camera_follow(world)
	await _test_camera_wall_clipping(world)
	await _test_attack_hitbox(world)
	await _test_attack_facing_away(world)
	await _test_enemy_damage(world)
	await _test_parry_success(world)
	await _test_parry_mistimed(world)
	await _test_enemy_stagger(world)
	await _test_enemy_defeat(world)
	await _test_player_defeat(world)
	await _test_restart(world)
	await _test_event_stream(world)
	await _test_hud(world)

	var summary := {
		"project": "deflect-arena",
		"godot": String(Engine.get_version_info().get("string", "")),
		"cases": cases,
		"trace": trace,
	}
	print("GAME_SUMMARY " + JSON.stringify(summary))
	print("RESULT passed=%d failed=%d" % [passed, failed])
	world.queue_free()
	quit(0 if failed == 0 else 1)


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

func _test_player_movement(world) -> void:
	world.harness_reset()
	var start: Dictionary = await _advance(world, 3)
	var moved: Dictionary = await _advance(world, 45, {"forward": 1.0})
	var dz: float = float(start["player_position"][2]) - float(moved["player_position"][2])
	var y: float = float(moved["player_position"][1])
	var facing: float = absf(float(moved["player_facing_deg"]))
	var ok: bool = (
		dz > 1.2
		and bool(moved["grounded"])
		and absf(y - 0.02) < 0.12
		and facing < 5.0
	)
	trace["movement"] = {"start": start, "moved": moved, "dz": dz}
	_check("game-player-moves-and-stays-grounded", ok, "dz=%.3f y=%.3f grounded=%s facing=%.1f" % [
		dz,
		y,
		str(moved["grounded"]),
		facing,
	])


func _test_camera_follow(world) -> void:
	world.harness_reset()
	var before: Dictionary = await _advance(world, 3)
	var after: Dictionary = await _advance(world, 30, {"forward": 1.0})
	var start_cam := _vec(before["camera_position"])
	var cam_now := _vec(after["camera_position"])
	var start_player := _vec(before["player_position"])
	var now_player := _vec(after["player_position"])
	var target := now_player + Vector3(0.0, 1.15, 0.0)
	var to_target := (target - cam_now).normalized()
	var camera_forward: Vector3 = -world.camera.global_transform.basis.z
	var distance := cam_now.distance_to(target)
	var moved := Vector2(cam_now.x - start_cam.x, cam_now.z - start_cam.z).length()
	var player_moved := Vector2(now_player.x - start_player.x, now_player.z - start_player.z).length()
	var ok: bool = (
		distance > 2.0
		and distance < 8.0
		and moved > player_moved * 0.8
		and cam_now.y > now_player.y + 1.0
		and camera_forward.dot(to_target) > 0.97
	)
	trace["camera"] = {"before": before, "after": after, "distance": distance, "moved": moved}
	_check("game-camera-follows", ok, "distance=%.2f moved=%.2f player_moved=%.2f dot=%.4f" % [
		distance,
		moved,
		player_moved,
		camera_forward.dot(to_target),
	])


func _test_camera_wall_clipping(world) -> void:
	world.harness_reset()
	await _advance(world, 3)
	var pressed: Dictionary = await _advance(world, 200, {"forward": -1.0})
	var distance := float(pressed["camera_distance"])
	var cam_z := float(pressed["camera_position"][2])
	var player_z := float(pressed["player_position"][2])
	var ok: bool = (
		distance >= 1.0
		and distance <= 8.0
		and cam_z < 11.9
		and player_z > 9.0
	)
	trace["camera_wall"] = pressed
	_check("game-camera-avoids-wall-clipping", ok, "distance=%.2f cam_z=%.2f player_z=%.2f" % [
		distance,
		cam_z,
		player_z,
	])


func _test_attack_hitbox(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 3.0],
		"enemy_position": [0.0, 0.02, 0.9],
	})
	await _advance(world, 2)
	var windup: Dictionary = await _advance(world, 4, {"attack": true})
	var pre_ok: bool = (
		String(windup["player_attack_phase"]) == "windup"
		and int(windup["enemy_health"]) == 5
		and not bool(windup["hitbox_active"])
		and int(windup["last_hitbox_query_step"]) == -1
	)
	var hit: Dictionary = await _advance(world, 40)
	var post_ok: bool = (
		int(hit["enemy_health"]) == 4
		and _count(world, "player_hit_enemy") == 1
		and int(hit["last_hitbox_query_step"]) > 0
	)
	var settled: Dictionary = await _advance(world, 60)
	var stable_ok: bool = int(settled["enemy_health"]) == 4 and not bool(settled["hitbox_active"])
	trace["attack"] = {"windup": windup, "hit": hit, "settled": settled}
	_check("game-attack-windup-cannot-damage", pre_ok, "phase=%s health=%d hitbox=%s" % [
		windup["player_attack_phase"],
		int(windup["enemy_health"]),
		str(windup["hitbox_active"]),
	])
	_check("game-attack-hits-enemy-once", post_ok, "health=%d hit_events=%d" % [
		int(hit["enemy_health"]),
		_count(world, "player_hit_enemy"),
	])
	_check("game-attack-no-damage-outside-window", stable_ok, "health=%d hitbox=%s" % [
		int(settled["enemy_health"]),
		str(settled["hitbox_active"]),
	])


func _test_attack_facing_away(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 3.0],
		"enemy_position": [0.0, 0.02, 0.9],
		"player_rotation_deg": 180.0,
	})
	await _advance(world, 2)
	await _advance(world, 1, {"attack": true})
	var snap: Dictionary = await _advance(world, 40)
	var ok: bool = int(snap["enemy_health"]) == 5 and _count(world, "player_hit_enemy") == 0
	trace["facing_away"] = snap
	_check("game-attack-facing-away-misses", ok, "health=%d hit_events=%d" % [
		int(snap["enemy_health"]),
		_count(world, "player_hit_enemy"),
	])


func _test_enemy_damage(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"player_position": [0.0, 0.02, 2.6],
		"enemy_position": [0.0, 0.02, 0.8],
	})
	var snap: Dictionary = await _advance(world, 2)
	for _index in range(90):
		if int(snap["player_health"]) < 4:
			break
		snap = await _advance(world, 1)
	var ok: bool = (
		int(snap["player_health"]) == 3
		and _count(world, "enemy_hit_player") == 1
		and String(snap["outcome"]) == "playing"
	)
	trace["enemy_damage"] = snap
	_check("game-enemy-damages-player", ok, "player_health=%d hits=%d phase=%s" % [
		int(snap["player_health"]),
		_count(world, "enemy_hit_player"),
		snap["enemy_phase"],
	])


func _test_parry_success(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"player_position": [0.0, 0.02, 2.6],
		"enemy_position": [0.0, 0.02, 0.8],
	})
	var snap: Dictionary = await _advance(world, 2)
	snap = await _wait_for_enemy_windup(world, snap)
	snap = await _advance_to_windup_tick(world, snap, 25)
	await _advance(world, 1, {"parry": true})
	var after: Dictionary = await _advance(world, 18)
	var parry_event := _first_event(world, "parry_success")
	var ok: bool = (
		String(after["parry_result"]) == "success"
		and int(after["player_health"]) == 4
		and _count(world, "parry_success") == 1
		and _count(world, "enemy_hit_player") == 0
		and not parry_event.is_empty()
		and float(parry_event.get("enemy_posture", 0.0)) >= 54.0
		and float(after["enemy_posture"]) > 45.0
	)
	trace["parry_success"] = {"after": after, "event": parry_event}
	_check("game-parry-success", ok, "result=%s player_health=%d posture=%.1f parry_events=%d" % [
		after["parry_result"],
		int(after["player_health"]),
		float(after["enemy_posture"]),
		_count(world, "parry_success"),
	])


func _test_parry_mistimed(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"player_position": [0.0, 0.02, 2.6],
		"enemy_position": [0.0, 0.02, 0.8],
	})
	var snap: Dictionary = await _advance(world, 2)
	snap = await _wait_for_enemy_windup(world, snap)
	await _advance(world, 1, {"parry": true})
	snap = await _advance(world, 60)
	var ok: bool = (
		_count(world, "parry_success") == 0
		and int(snap["player_health"]) == 3
		and _count(world, "enemy_hit_player") == 1
		and String(snap["parry_result"]) == "expired"
	)
	trace["parry_mistimed"] = snap
	_check("game-parry-mistimed-does-not-register", ok, "player_health=%d result=%s parry_events=%d" % [
		int(snap["player_health"]),
		snap["parry_result"],
		_count(world, "parry_success"),
	])


func _test_enemy_stagger(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"player_position": [0.0, 0.02, 2.6],
		"enemy_position": [0.0, 0.02, 0.8],
		"enemy_posture": 60.0,
	})
	var snap: Dictionary = await _advance(world, 2)
	snap = await _wait_for_enemy_windup(world, snap)
	snap = await _advance_to_windup_tick(world, snap, 25)
	await _advance(world, 1, {"parry": true})
	snap = await _advance(world, 12)
	var staggered_ok: bool = (
		bool(snap["enemy_staggered"])
		and _count(world, "enemy_staggered") >= 1
		and float(snap["enemy_posture"]) <= 0.01
		and int(snap["enemy_stagger_ticks"]) > 0
	)
	var safe: Dictionary = await _advance(world, 40)
	var safe_ok: bool = int(safe["player_health"]) == 4
	trace["stagger"] = {"staggered": snap, "safe": safe}
	_check("game-enemy-stagger-transition", staggered_ok, "staggered=%s posture=%.2f ticks=%d" % [
		str(snap["enemy_staggered"]),
		float(snap["enemy_posture"]),
		int(snap["enemy_stagger_ticks"]),
	])
	_check("game-staggered-enemy-cannot-attack", safe_ok, "player_health=%d" % int(safe["player_health"]))


func _test_enemy_defeat(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"enemy_ai_enabled": false,
		"player_position": [0.0, 0.02, 3.0],
		"enemy_position": [0.0, 0.02, 0.9],
		"enemy_health": 2,
	})
	await _advance(world, 2)
	for _hit in range(2):
		await _advance(world, 1, {"attack": true})
		await _advance(world, 45)
	var snap: Dictionary = await _advance(world, 2)
	var ok: bool = (
		int(snap["enemy_health"]) == 0
		and bool(snap["enemy_defeated"])
		and String(snap["outcome"]) == "victory"
		and _count(world, "victory") == 1
		and _count(world, "enemy_defeated") == 1
	)
	trace["enemy_defeat"] = snap
	_check("game-enemy-defeat-victory", ok, "health=%d defeated=%s outcome=%s" % [
		int(snap["enemy_health"]),
		str(snap["enemy_defeated"]),
		snap["outcome"],
	])


func _test_player_defeat(world) -> void:
	world.harness_reset()
	world.harness_setup({
		"player_position": [0.0, 0.02, 2.6],
		"enemy_position": [0.0, 0.02, 0.8],
		"player_health": 1,
	})
	var snap: Dictionary = await _advance(world, 2)
	for _index in range(120):
		if String(snap["outcome"]) == "defeat":
			break
		snap = await _advance(world, 1)
	var ok: bool = (
		int(snap["player_health"]) == 0
		and String(snap["outcome"]) == "defeat"
		and _count(world, "player_defeated") == 1
	)
	trace["player_defeat"] = snap
	_check("game-player-defeat", ok, "health=%d outcome=%s" % [
		int(snap["player_health"]),
		snap["outcome"],
	])


func _test_restart(world) -> void:
	var reset: Dictionary = await _advance(world, 1, {"restart": true})
	var ok: bool = (
		int(reset["step"]) == 0
		and int(reset["player_health"]) == 4
		and int(reset["enemy_health"]) == 5
		and String(reset["outcome"]) == "playing"
		and String(reset["last_event_type"]) == "reset"
		and String(reset["parry_result"]) == "none"
		and _position_close(reset["player_position"], PLAYER_SPAWN)
		and _position_close(reset["enemy_position"], ENEMY_SPAWN)
		and int(reset["events_count"]) == 1
	)
	trace["restart"] = reset
	_check("game-restart-restores-initial-state", ok, "step=%d player_hp=%d enemy_hp=%d outcome=%s event=%s" % [
		int(reset["step"]),
		int(reset["player_health"]),
		int(reset["enemy_health"]),
		reset["outcome"],
		reset["last_event_type"],
	])


func _test_event_stream(world) -> void:
	world.harness_reset()
	await _advance(world, 2)
	await _advance(world, 1, {"attack": true})
	await _advance(world, 45)
	var events: Array = world.harness_events(0)
	var ordered := true
	var expected_sequence := 1
	for event in events:
		if int(event.get("sequence", -1)) != expected_sequence:
			ordered = false
		expected_sequence += 1
	var types: Array = []
	for event in events:
		types.append(String(event.get("type", "")))
	var has_attack: bool = types.has("attack_started") and types.has("attack_active")
	var ok: bool = events.size() >= 4 and ordered and has_attack
	trace["event_stream"] = {"count": events.size(), "types": types, "ordered": ordered}
	_check("game-event-stream", ok, "count=%d ordered=%s types=%s" % [
		events.size(),
		str(ordered),
		str(types),
	])


func _test_hud(world) -> void:
	var snap: Dictionary = await _advance(world, 1)
	var hud := String(snap["hud"])
	var ok: bool = (
		hud.contains("DEFLECT ARENA")
		and hud.contains("PLAYER  HP")
		and hud.contains("ENEMY   HP")
		and hud.contains("POSTURE")
		and hud.contains("STATE")
	)
	trace["hud"] = hud
	_check("game-hud-reflects-state", ok, "hud_lines=%d" % hud.split("\n").size())


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

func _advance(world, frames: int, input: Dictionary = {}) -> Dictionary:
	var values := {
		"forward": 0.0,
		"strafe": 0.0,
		"attack": false,
		"parry": false,
		"restart": false,
	}
	for key in input:
		values[key] = input[key]
	world.set_harness_input(values)
	for _index in range(frames):
		await physics_frame
	await process_frame
	return world.snapshot()


func _wait_for_enemy_windup(world, snap: Dictionary) -> Dictionary:
	for _index in range(120):
		if String(snap["enemy_phase"]) == "windup":
			return snap
		snap = await _advance(world, 1)
	return snap


func _advance_to_windup_tick(world, snap: Dictionary, target_tick: int) -> Dictionary:
	for _index in range(40):
		if String(snap["enemy_phase"]) != "windup":
			return snap
		if int(snap["enemy_phase_tick"]) >= target_tick:
			return snap
		snap = await _advance(world, 1)
	return snap


func _first_event(world, event_type: String) -> Dictionary:
	for event in world.harness_events(0):
		if String(event.get("type", "")) == event_type:
			return event
	return {}


func _count(world, event_type: String) -> int:
	var total := 0
	for event in world.harness_events(0):
		if String(event.get("type", "")) == event_type:
			total += 1
	return total


func _vec(value: Array) -> Vector3:
	return Vector3(float(value[0]), float(value[1]), float(value[2]))


func _position_close(value: Array, expected: Vector3) -> bool:
	return (
		absf(float(value[0]) - expected.x) < 0.01
		and absf(float(value[1]) - expected.y) < 0.01
		and absf(float(value[2]) - expected.z) < 0.01
	)


func _check(name: String, condition: bool, detail: String) -> void:
	var ok: bool = bool(condition)
	if ok:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])
	cases.append({"name": name, "ok": ok, "detail": detail})
