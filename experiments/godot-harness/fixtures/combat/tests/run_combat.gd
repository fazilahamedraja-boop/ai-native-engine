extends SceneTree

## Phase 11 Stage C acceptance test.
##
## The same file is used for the defective copy and the repaired copy. It tests
## the player-visible contract: a target in front of the humanoid must lose
## health when the attack passes through it. It does not assert which internal
## field caused a failure.

var passed := 0
var failed := 0
var cases: Array = []
var trace: Dictionary = {}


func _initialize() -> void:
	_run()


func _run() -> void:
	var world = load("res://main.tscn").instantiate()
	root.add_child(world)
	await _advance(world, 3)
	world.harness_reset()
	trace["after_reset"] = world.snapshot()
	world.set_harness_input({
		"forward": 0.0,
		"strafe": 0.0,
		"jump": false,
		"restart": false,
		"actions": {"attack": true},
	})
	await _advance(world, 24)
	var snap: Dictionary = world.snapshot()
	trace["after_attack"] = snap
	var attacks := int(snap["combat"]["attacks"])
	var hits := int(snap["combat"]["hits"])
	var health := int(snap["combat"]["target_health"])
	_check("combat-attack-started", attacks == 1, "attacks=%d expected=1" % attacks)
	_check("combat-hit-registers", hits == 1, "hits=%d expected=1 target_health=%d" % [hits, health])
	_check("combat-target-health-decreases", health == 2, "target_health=%d expected=2" % health)
	var summary := {
		"fixture": "combat",
		"godot": String(Engine.get_version_info().get("string", "")),
		"cases": cases,
		"trace": trace,
		"events": world.harness_events(0),
	}
	print("COMBAT_SUMMARY " + JSON.stringify(summary))
	print("RESULT passed=%d failed=%d" % [passed, failed])
	world.queue_free()
	quit(0 if failed == 0 else 1)


func _advance(world, frames: int) -> void:
	for _index in range(frames):
		await physics_frame
	if frames > 0:
		await process_frame


func _check(name: String, condition: bool, detail: String) -> void:
	if condition:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])
	cases.append({"name": name, "ok": condition, "detail": detail})
