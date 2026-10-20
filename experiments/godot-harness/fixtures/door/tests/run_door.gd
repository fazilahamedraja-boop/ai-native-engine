extends SceneTree

## Stage F locked-door/key acceptance suite.
##
## This script adds the real scene to the SceneTree and waits for normal physics
## frames. It uses the same generic game contract as the live harness:
## set_harness_input(), snapshot(), and harness_reset().

const SPAWN := Vector3(0.0, 0.85, 5.5)
const KEY_APPROACH_STRAFE_FRAMES := 30
const KEY_APPROACH_FORWARD_FRAMES := 15
const DOOR_APPROACH_FRAMES := 100
const DOOR_PASS_FRAMES := 60

var passed := 0
var failed := 0
var cases: Array = []
var trace: Dictionary = {}


func _initialize() -> void:
	_run()


func _run() -> void:
	var world = load("res://main.tscn").instantiate()
	root.add_child(world)
	await _advance(world, 3, {})
	trace["initial"] = world.snapshot()

	await _test_initial_state(world)
	await _test_too_far_feedback(world)
	await _test_locked_no_key(world)
	await _test_key_pickup(world)
	await _test_unlock_and_open(world)
	await _test_reset(world)
	await _test_same_process_outcomes(world)

	var summary := {
		"fixture": "door",
		"godot": String(Engine.get_version_info().get("string", "")),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"cases": cases,
		"trace": trace,
	}
	print("DOOR_SUMMARY " + JSON.stringify(summary))
	print("RESULT passed=%d failed=%d" % [passed, failed])
	world.queue_free()
	quit(0 if failed == 0 else 1)


func _test_initial_state(world) -> void:
	world.harness_reset()
	var snap: Dictionary = await _advance(world, 3, {})
	var ok: bool = (
		bool(snap["door_locked"])
		and not bool(snap["door_open"])
		and not bool(snap["player_has_key"])
		and bool(snap["key_available"])
		and bool(snap["key_visible"])
		and int(snap["locked_attempts"]) == 0
		and int(snap["open_count"]) == 0
		and float(snap["door_rotation_degrees"]) == 0.0
		and int(snap["physics_ticks_per_second"]) == 60
		and snap["prompt"] == "APPROACH THE DOOR"
	)
	trace["initial_state"] = snap
	_check("door-initial-state", ok, "locked=%s open=%s key_available=%s prompt=%s" % [
		str(snap["door_locked"]),
		str(snap["door_open"]),
		str(snap["key_available"]),
		snap["prompt"],
	])


func _test_too_far_feedback(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	var snap: Dictionary = await _advance(world, 1, {"actions": {"interact": true}})
	var ok: bool = (
		snap["feedback"] == "TOO FAR"
		and bool(snap["door_locked"])
		and not bool(snap["door_open"])
		and int(snap["locked_attempts"]) == 0
		and int(snap["interaction_count"]) == 1
	)
	trace["too_far"] = snap
	_check("door-too-far-feedback", ok, "feedback=%s locked_attempts=%d distance=%.6f" % [
		snap["feedback"], snap["locked_attempts"], snap["distance_to_door"]
	])


func _test_locked_no_key(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	var before: Dictionary = await _advance(world, DOOR_APPROACH_FRAMES, {"forward": 1.0})
	var snap: Dictionary = await _advance(world, 1, {"actions": {"interact": true}})
	var blocked: Dictionary = await _advance(world, 30, {"forward": 1.0})
	var z := float(snap["player_position"][2])
	var blocked_z := float(blocked["player_position"][2])
	var ok: bool = (
		before["prompt"] == "PRESS E TO TRY THE DOOR"
		and float(before["distance_to_door"]) <= 2.2
		and snap["feedback"] == "LOCKED - KEY REQUIRED"
		and bool(snap["door_locked"])
		and not bool(snap["door_open"])
		and bool(snap["door_collision_enabled"])
		and int(snap["locked_attempts"]) == 1
		and z > 0.4
		and blocked_z > 0.4
		and blocked_z < 0.7
	)
	trace["locked_no_key"] = {"before": before, "after_interact": snap, "blocked": blocked}
	_check("door-locked-no-key", ok, "feedback=%s z=%.6f blocked_z=%.6f attempts=%d" % [
		snap["feedback"], z, blocked_z, snap["locked_attempts"]
	])


func _test_key_pickup(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	await _advance(world, KEY_APPROACH_STRAFE_FRAMES, {"strafe": 1.0})
	var snap: Dictionary = await _advance(world, KEY_APPROACH_FORWARD_FRAMES, {"forward": 1.0})
	var ok: bool = (
		bool(snap["player_has_key"])
		and not bool(snap["key_available"])
		and not bool(snap["key_visible"])
		and snap["feedback"] == "KEY ACQUIRED"
		and float(snap["distance_to_key"]) < 0.2
		and not bool(snap["door_open"])
	)
	trace["key_pickup"] = snap
	_check("door-key-required-and-acquired", ok, "has_key=%s key_available=%s key_visible=%s distance=%.6f" % [
		str(snap["player_has_key"]),
		str(snap["key_available"]),
		str(snap["key_visible"]),
		snap["distance_to_key"],
	])


func _test_unlock_and_open(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	await _advance(world, KEY_APPROACH_STRAFE_FRAMES, {"strafe": 1.0})
	await _advance(world, KEY_APPROACH_FORWARD_FRAMES, {"forward": 1.0})
	await _advance(world, KEY_APPROACH_STRAFE_FRAMES, {"strafe": -1.0})
	var at_door: Dictionary = await _advance(world, DOOR_APPROACH_FRAMES, {"forward": 1.0})
	var opened: Dictionary = await _advance(world, 1, {"actions": {"interact": true}})
	var passed_through: Dictionary = await _advance(world, DOOR_PASS_FRAMES, {"forward": 1.0})
	var z := float(passed_through["player_position"][2])
	var ok: bool = (
		at_door["prompt"] == "PRESS E TO UNLOCK"
		and opened["feedback"] == "UNLOCKED - DOOR OPEN"
		and not bool(opened["door_locked"])
		and bool(opened["door_open"])
		and not bool(opened["door_collision_enabled"])
		and int(opened["open_count"]) == 1
		and absf(float(opened["door_rotation_degrees"]) - 100.0) < 0.01
		and z < -1.0
	)
	trace["unlock_open"] = {
		"at_door": at_door,
		"opened": opened,
		"passed_through": passed_through,
	}
	_check("door-unlock-open-pass", ok, "feedback=%s locked=%s open=%s z=%.6f opens=%d" % [
		opened["feedback"],
		str(opened["door_locked"]),
		str(opened["door_open"]),
		z,
		opened["open_count"],
	])


func _test_reset(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	var baseline: Dictionary = world.snapshot()
	await _unlock_sequence(world)
	var before: Dictionary = world.snapshot()
	var immediate: Dictionary = world.harness_reset()
	var settled: Dictionary = await _advance(world, 3, {})
	var fields_ok: bool = (
		int(immediate["step"]) == 0
		and _position_close(immediate["player_position"], SPAWN)
		and bool(immediate["door_locked"])
		and not bool(immediate["door_open"])
		and bool(immediate["door_collision_enabled"])
		and not bool(immediate["player_has_key"])
		and bool(immediate["key_available"])
		and bool(immediate["key_visible"])
		and int(immediate["locked_attempts"]) == 0
		and int(immediate["open_count"]) == 0
		and int(immediate["interaction_count"]) == 0
		and immediate["feedback"] == "LOCKED - FIND THE KEY"
		and absf(float(immediate["door_rotation_degrees"])) < 0.01
	)
	var hash_ok: bool = settled["hash"] == baseline["hash"]
	var ok: bool = fields_ok and hash_ok
	trace["reset"] = {
		"before": before,
		"immediate": immediate,
		"settled": settled,
		"baseline": baseline,
	}
	_check("door-reset", ok, "fields_ok=%s hash_ok=%s immediate_step=%d settled_hash=%s baseline_hash=%s" % [
		str(fields_ok),
		str(hash_ok),
		immediate["step"],
		settled["hash"],
		baseline["hash"],
	])


func _test_same_process_outcomes(world) -> void:
	var first: Dictionary = await _unlock_sequence(world)
	var second: Dictionary = await _unlock_sequence(world)
	var exact_hash_match: bool = first["hash"] == second["hash"]
	var outcome_hash_match: bool = first["outcome_hash"] == second["outcome_hash"]
	var position_delta: float = _max_position_delta(first, second)
	var ok: bool = outcome_hash_match and position_delta <= 0.001
	trace["repeatability"] = {
		"first": first,
		"second": second,
		"exact_hash_match": exact_hash_match,
		"outcome_hash_match": outcome_hash_match,
		"position_delta": position_delta,
	}
	_check(
		"door-same-process-outcome-repeatability",
		ok,
		"exact_hash_match=%s outcome_hash_match=%s position_delta=%.9f first_outcome=%s second_outcome=%s" % [
			str(exact_hash_match),
			str(outcome_hash_match),
			position_delta,
			first["outcome_hash"],
			second["outcome_hash"],
		]
	)


func _unlock_sequence(world) -> Dictionary:
	world.harness_reset()
	await _advance(world, 3, {})
	await _advance(world, KEY_APPROACH_STRAFE_FRAMES, {"strafe": 1.0})
	await _advance(world, KEY_APPROACH_FORWARD_FRAMES, {"forward": 1.0})
	await _advance(world, KEY_APPROACH_STRAFE_FRAMES, {"strafe": -1.0})
	await _advance(world, DOOR_APPROACH_FRAMES, {"forward": 1.0})
	await _advance(world, 1, {"actions": {"interact": true}})
	return await _advance(world, DOOR_PASS_FRAMES, {"forward": 1.0})


func _advance(world, frames: int, input: Dictionary = {}) -> Dictionary:
	world.set_harness_input({
		"forward": 0.0,
		"strafe": 0.0,
		"jump": false,
		"restart": false,
		"actions": {"interact": false},
	})
	if not input.is_empty():
		world.set_harness_input(input)
	for _index in range(frames):
		await physics_frame
	if frames > 0:
		await process_frame
	return world.snapshot()


func _position_close(value: Array, expected: Vector3) -> bool:
	return (
		absf(float(value[0]) - expected.x) < 0.001
		and absf(float(value[1]) - expected.y) < 0.001
		and absf(float(value[2]) - expected.z) < 0.001
	)


func _max_position_delta(first: Dictionary, second: Dictionary) -> float:
	var a: Array = first["player_position"]
	var b: Array = second["player_position"]
	var delta := 0.0
	for index in range(3):
		delta = maxf(delta, absf(float(a[index]) - float(b[index])))
	return delta


func _check(name: String, condition: bool, detail: String) -> void:
	var ok: bool = bool(condition)
	if ok:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])
	cases.append({"name": name, "ok": ok, "detail": detail})
