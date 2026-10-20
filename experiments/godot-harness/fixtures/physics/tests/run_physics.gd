extends SceneTree

## Stage E real-physics acceptance suite.
##
## This script is run by the Phase 8 controller as a headless Godot process:
##   godot --headless --path fixtures/physics -s res://tests/run_physics.gd
##
## It adds the real scene to the SceneTree and waits for normal physics frames.
## It never calls harness_step() or move_and_collide() from a paused bridge.

const SPAWN_Y := 0.85

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

	await _test_floor_contact(world)
	await _test_forward_motion(world)
	await _test_wall_collision(world)
	await _test_no_pass_through(world)
	await _test_wall_slide(world)
	await _test_jump_land(world)
	await _test_reset(world)
	await _test_same_process_repeatability(world)
	await _test_missing_wall_collision(world)

	var summary := {
		"fixture": "physics",
		"godot": String(Engine.get_version_info().get("string", "")),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"cases": cases,
		"trace": trace,
	}
	print("PHYSICS_SUMMARY " + JSON.stringify(summary))
	print("RESULT passed=%d failed=%d" % [passed, failed])
	world.queue_free()
	quit(0 if failed == 0 else 1)


func _test_floor_contact(world) -> void:
	world.harness_reset()
	var snap: Dictionary = await _advance(world, 3, {})
	var ok: bool = (
		bool(snap["grounded"])
		and _within(float(snap["player_position"][1]), SPAWN_Y, 0.02)
		and absf(float(snap["player_velocity"][1])) < 0.01
		and int(snap["physics_ticks_per_second"]) == 60
	)
	trace["floor"] = snap
	_check("physics-floor-contact", ok, "y=%.6f vy=%.6f ticks=%d" % [
		snap["player_position"][1], snap["player_velocity"][1], snap["physics_ticks_per_second"]
	])


func _test_forward_motion(world) -> void:
	world.harness_reset()
	var snap: Dictionary = await _advance(world, 30, {"forward": 1.0})
	var ok: bool = (
		float(snap["player_position"][2]) < -1.5
		and absf(float(snap["player_position"][0])) < 0.05
		and bool(snap["grounded"])
	)
	trace["forward"] = snap
	_check("physics-forward-motion", ok, "x=%.6f z=%.6f grounded=%s" % [
		snap["player_position"][0], snap["player_position"][2], str(snap["grounded"])
	])


func _test_wall_collision(world) -> void:
	world.harness_reset()
	var snap: Dictionary = await _advance(world, 120, {"forward": 1.0})
	var z := float(snap["player_position"][2])
	var ok: bool = (
		_within(z, -3.35, 0.06)
		and bool(snap["wall_contact"])
		and absf(float(snap["player_motion"][2])) < 0.01
		and float(snap["wall_clearance"]) >= -0.02
	)
	trace["wall"] = snap
	_check("physics-wall-collision", ok, "z=%.6f motion_z=%.6f wall_clearance=%.6f contact=%s" % [
		z, snap["player_motion"][2], snap["wall_clearance"], str(snap["wall_contact"])
	])


func _test_no_pass_through(world) -> void:
	var snap: Dictionary = await _advance(world, 120, {"forward": 1.0})
	var z := float(snap["player_position"][2])
	var ok: bool = z > -3.42 and float(snap["wall_clearance"]) >= -0.02
	trace["no_pass_through"] = snap
	_check("physics-no-pass-through", ok, "z=%.6f wall_clearance=%.6f" % [
		z, snap["wall_clearance"]
	])


func _test_wall_slide(world) -> void:
	world.harness_reset()
	await _advance(world, 120, {"forward": 1.0})
	var snap: Dictionary = await _advance(world, 30, {"forward": 1.0, "strafe": 1.0})
	var x := float(snap["player_position"][0])
	var z := float(snap["player_position"][2])
	var ok: bool = (
		x > 0.8
		and _within(z, -3.35, 0.06)
		and bool(snap["wall_contact"])
		and float(snap["player_motion"][0]) > 0.0
	)
	trace["slide"] = snap
	_check("physics-wall-slide", ok, "x=%.6f z=%.6f motion_x=%.6f contact=%s" % [
		x, z, snap["player_motion"][0], str(snap["wall_contact"])
	])


func _test_jump_land(world) -> void:
	world.harness_reset()
	var baseline: Dictionary = await _advance(world, 3, {})
	var takeoff: Dictionary = await _advance(world, 1, {"jump": true})
	var air: Dictionary = await _advance(world, 10, {})
	var land: Dictionary = await _advance(world, 80, {})
	var ok: bool = (
		not bool(takeoff["grounded"])
		and float(air["player_position"][1]) > SPAWN_Y + 0.4
		and bool(land["grounded"])
		and _within(float(land["player_position"][1]), SPAWN_Y, 0.03)
	)
	trace["jump"] = {"baseline": baseline, "takeoff": takeoff, "air": air, "land": land}
	_check("physics-jump-land", ok, "takeoff_y=%.6f air_y=%.6f land_y=%.6f grounded=%s" % [
		takeoff["player_position"][1], air["player_position"][1], land["player_position"][1],
		str(land["grounded"])
	])


func _test_reset(world) -> void:
	world.harness_reset()
	var baseline: Dictionary = await _advance(world, 3, {})
	await _advance(world, 120, {"forward": 1.0})
	await _advance(world, 30, {"forward": 1.0, "strafe": 1.0})
	var before: Dictionary = world.snapshot()
	var immediate: Dictionary = world.harness_reset()
	var settled: Dictionary = await _advance(world, 3, {})
	var ok: bool = (
		int(immediate["step"]) == 0
		and _within(float(immediate["player_position"][0]), 0.0, 0.0001)
		and _within(float(immediate["player_position"][1]), SPAWN_Y, 0.0001)
		and _within(float(immediate["player_position"][2]), 0.0, 0.0001)
		and absf(float(immediate["player_velocity"][0])) < 0.0001
		and absf(float(immediate["player_velocity"][1])) < 0.0001
		and absf(float(immediate["player_velocity"][2])) < 0.0001
		and bool(immediate["grounded"])
		and settled["hash"] == baseline["hash"]
	)
	trace["reset"] = {"before": before, "immediate": immediate, "settled": settled}
	_check("physics-reset", ok, "before_step=%d immediate_step=%d settled_hash=%s baseline_hash=%s" % [
		before["step"], immediate["step"], settled["hash"], baseline["hash"]
	])


func _test_same_process_repeatability(world) -> void:
	var first: Dictionary = await _sequence(world)
	var second: Dictionary = await _sequence(world)
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
		"physics-same-process-outcome-repeatability",
		ok,
		"exact_hash_match=%s outcome_hash_match=%s position_delta=%.9f first_outcome=%s second_outcome=%s" % [
			str(exact_hash_match),
			str(outcome_hash_match),
			position_delta,
			first["outcome_hash"],
			second["outcome_hash"],
		]
	)


func _test_missing_wall_collision(world) -> void:
	world.set_wall_collision(false)
	await process_frame
	world.harness_reset()
	await _advance(world, 3, {})
	var snap: Dictionary = await _advance(world, 120, {"forward": 1.0})
	var z := float(snap["player_position"][2])
	var detected := z < -4.5 and float(snap["wall_clearance"]) < -1.0
	trace["missing_collision"] = snap
	_check("physics-missing-wall-collision-detected", detected, "wall_enabled=%s z=%.6f wall_clearance=%.6f" % [
		str(snap["wall_collision_enabled"]), z, snap["wall_clearance"]
	])
	world.set_wall_collision(true)
	await process_frame
	world.harness_reset()
	await _advance(world, 3, {})


func _sequence(world) -> Dictionary:
	world.harness_reset()
	await _advance(world, 3, {})
	await _advance(world, 120, {"forward": 1.0})
	await _advance(world, 30, {"forward": 1.0, "strafe": 1.0})
	var snap: Dictionary = await _advance(world, 10, {})
	return snap


func _advance(world, frames: int, input: Dictionary = {}) -> Dictionary:
	world.set_harness_input({
		"forward": 0.0,
		"strafe": 0.0,
		"jump": false,
		"restart": false,
	})
	if not input.is_empty():
		world.set_harness_input(input)
	for _index in range(frames):
		await physics_frame
	if frames > 0:
		await process_frame
	return world.snapshot()


func _within(actual: float, expected: float, tolerance: float) -> bool:
	return absf(actual - expected) <= tolerance


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
