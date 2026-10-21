extends SceneTree

## Phase 10 observation-fixture acceptance suite.
##
## This script adds the real scene to the SceneTree and advances normal fixed
## physics frames. It uses the same generic game contract as the live harness:
## set_harness_input(), snapshot(), harness_reset(), and harness_events().
##
## The failing case before a controlled repair is intentionally behavior-level:
## it checks the observable plate/gate/beacon relation, not a source token.

const PLATE_APPROACH_FRAMES := 85
const GATE_PASS_FRAMES := 100
const OFF_PLATE_STRAFE_FRAMES := 22
const OFF_PLATE_FORWARD_FRAMES := 130
const CRATE_SETTLE_FRAMES := 90
const SPAWN := Vector3(0.0, 0.85, 5.5)

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
	await _test_plate_opens_gate(world)
	await _test_gate_passable_after_plate(world)
	await _test_closed_gate_blocks_off_plate(world)
	await _test_event_stream(world)
	await _test_reset(world)
	await _test_humanoid_probe(world)
	await _test_crate_falls(world)

	var summary := {
		"fixture": "observation",
		"godot": String(Engine.get_version_info().get("string", "")),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"cases": cases,
		"trace": trace,
	}
	print("OBSERVATION_SUMMARY " + JSON.stringify(summary))
	print("RESULT passed=%d failed=%d" % [passed, failed])
	world.queue_free()
	quit(0 if failed == 0 else 1)


func _test_initial_state(world) -> void:
	world.harness_reset()
	var snap: Dictionary = await _advance(world, 3, {})
	var ok: bool = (
		not bool(snap["plate_pressed"])
		and not bool(snap["gate_open"])
		and bool(snap["gate_collision_enabled"])
		and snap["beacon_state"] == "red"
		and not bool(snap["goal_reached"])
		and int(snap["physics_ticks_per_second"]) == 60
		and bool(snap["grounded"])
		and _position_close(snap["player_position"], SPAWN)
	)
	trace["initial_state"] = snap
	_check("observation-initial-state", ok, "plate=%s gate=%s collision=%s beacon=%s grounded=%s position=%s" % [
		str(snap["plate_pressed"]),
		str(snap["gate_open"]),
		str(snap["gate_collision_enabled"]),
		snap["beacon_state"],
		str(snap["grounded"]),
		str(snap["player_position"]),
	])


func _test_plate_opens_gate(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	var snap: Dictionary = await _advance(world, PLATE_APPROACH_FRAMES, {"forward": 1.0})
	var event_types := _event_types(world)
	var ok: bool = (
		bool(snap["plate_pressed"])
		and bool(snap["gate_open"])
		and not bool(snap["gate_collision_enabled"])
		and snap["beacon_state"] == "green"
		and "plate_entered" in event_types
		and "gate_open" in event_types
	)
	trace["plate_opens_gate"] = {"snapshot": snap, "event_types": event_types}
	_check("observation-plate-opens-gate", ok, "plate=%s gate=%s collision=%s beacon=%s events=%s" % [
		str(snap["plate_pressed"]),
		str(snap["gate_open"]),
		str(snap["gate_collision_enabled"]),
		snap["beacon_state"],
		str(event_types),
	])


func _test_gate_passable_after_plate(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	await _advance(world, PLATE_APPROACH_FRAMES, {"forward": 1.0})
	var snap: Dictionary = await _advance(world, GATE_PASS_FRAMES, {"forward": 1.0})
	var event_types := _event_types(world)
	var z := float(snap["player_position"][2])
	var ok: bool = (
		bool(snap["goal_reached"])
		and z < -4.0
		and "goal_reached" in event_types
		and "gate_close" in event_types
	)
	trace["gate_passable"] = {"snapshot": snap, "event_types": event_types}
	_check("observation-gate-passable-after-plate", ok, "goal=%s z=%.3f events=%s" % [
		str(snap["goal_reached"]),
		z,
		str(event_types),
	])


func _test_closed_gate_blocks_off_plate(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	await _advance(world, OFF_PLATE_STRAFE_FRAMES, {"strafe": 1.0})
	var snap: Dictionary = await _advance(world, OFF_PLATE_FORWARD_FRAMES, {"forward": 1.0})
	var gate_collision_seen := false
	for event in world.harness_events(0):
		if (
			String(event.get("type", "")) == "player_collision_start"
			and String(event.get("collider", "")).contains("/Gate")
		):
			gate_collision_seen = true
	var z := float(snap["player_position"][2])
	var ok: bool = (
		not bool(snap["plate_pressed"])
		and not bool(snap["gate_open"])
		and bool(snap["gate_collision_enabled"])
		and z > -2.2
		and gate_collision_seen
	)
	trace["closed_gate_blocks"] = {
		"snapshot": snap,
		"gate_collision_seen": gate_collision_seen,
		"event_types": _event_types(world),
	}
	_check("observation-closed-gate-blocks", ok, "plate=%s gate=%s z=%.3f gate_collision_seen=%s" % [
		str(snap["plate_pressed"]),
		str(snap["gate_open"]),
		z,
		str(gate_collision_seen),
	])


func _test_event_stream(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	await _advance(world, PLATE_APPROACH_FRAMES, {"forward": 1.0})
	var events: Array = world.harness_events(0)
	var ordered := true
	var last_tick := -1
	var last_sequence := 0
	for event in events:
		var tick := int(event.get("tick", -1))
		var sequence := int(event.get("sequence", -1))
		if tick < last_tick or sequence != last_sequence + 1:
			ordered = false
		last_tick = tick
		last_sequence = sequence
	var fields_ok := true
	for event in events:
		if (
			not event.has("tick")
			or not event.has("sim_time_seconds")
			or not event.has("simulation_step")
			or not event.has("simulation_time_seconds")
			or not event.has("type")
			or event.get("source", "") != "fixture_recorded"
		):
			fields_ok = false
	var ok: bool = events.size() > 0 and ordered and fields_ok
	trace["event_stream"] = {
		"count": events.size(),
		"ordered": ordered,
		"fields_ok": fields_ok,
		"events": events,
	}
	_check("observation-event-stream", ok, "count=%d ordered=%s fields_ok=%s" % [
		events.size(),
		str(ordered),
		str(fields_ok),
	])


func _test_reset(world) -> void:
	world.harness_reset()
	var immediate: Dictionary = world.snapshot()
	var settled: Dictionary = await _advance(world, 3, {})
	var ok: bool = (
		int(immediate["step"]) == 0
		and not bool(immediate["plate_pressed"])
		and not bool(immediate["gate_open"])
		and bool(immediate["gate_collision_enabled"])
		and immediate["beacon_state"] == "red"
		and not bool(immediate["goal_reached"])
		and immediate["last_event_type"] == "reset"
		and _position_close(immediate["player_position"], SPAWN)
		and float(settled["crate_position"][1]) > 2.8
	)
	trace["reset"] = {"immediate": immediate, "settled": settled}
	_check("observation-reset", ok, "step=%d plate=%s gate=%s beacon=%s crate_y=%.3f last_event=%s" % [
		int(immediate["step"]),
		str(immediate["plate_pressed"]),
		str(immediate["gate_open"]),
		immediate["beacon_state"],
		float(settled["crate_position"][1]),
		immediate["last_event_type"],
	])


func _test_humanoid_probe(world) -> void:
	world.harness_reset()
	var snap: Dictionary = await _advance(world, 3, {})
	var bones: Array = snap["humanoid_bones"]
	var ok: bool = (
		int(snap["humanoid_mesh_count"]) == 22
		and bones == ["root", "spine", "chest", "head"]
	)
	trace["humanoid_probe"] = snap
	_check("observation-humanoid-probe", ok, "mesh_count=%d bones=%s" % [
		int(snap["humanoid_mesh_count"]),
		str(bones),
	])


func _test_crate_falls(world) -> void:
	world.harness_reset()
	await _advance(world, 3, {})
	var snap: Dictionary = await _advance(world, CRATE_SETTLE_FRAMES, {})
	var crate_ground_collision := false
	for event in world.harness_events(0):
		if (
			String(event.get("type", "")) == "crate_collision_start"
			and String(event.get("body", "")).contains("/Ground")
		):
			crate_ground_collision = true
	var y := float(snap["crate_position"][1])
	var ok: bool = y < 0.6 and crate_ground_collision
	trace["crate_falls"] = {
		"snapshot": snap,
		"crate_ground_collision": crate_ground_collision,
		"event_types": _event_types(world),
	}
	_check("observation-crate-falls", ok, "crate_y=%.3f ground_collision=%s sleeping=%s" % [
		y,
		str(crate_ground_collision),
		str(snap["crate_sleeping"]),
	])


func _event_types(world) -> Array:
	var result: Array = []
	for event in world.harness_events(0):
		result.append(String(event.get("type", "")))
	return result


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


func _check(name: String, condition: bool, detail: String) -> void:
	var ok: bool = bool(condition)
	if ok:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])
	cases.append({"name": name, "ok": ok, "detail": detail})
