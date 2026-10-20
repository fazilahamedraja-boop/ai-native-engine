extends SceneTree

## Headless acceptance tests for the sentry benchmark. Run with:
##   godot --headless --path . -s res://tests/run_tests.gd

const SentryStateScript = preload("res://scripts/sentry_state.gd")

var passed := 0
var failed := 0


func _init() -> void:
	_test_initial()
	_test_detection_rise()
	_test_detection_decay()
	_test_loss_precedence()
	_test_exit_win()
	_test_reset_determinism()
	_test_outside_cones()

	print("RESULT passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)


func _check(name: String, condition: bool, detail: String) -> void:
	if condition:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])


func _test_initial() -> void:
	var state = SentryStateScript.new()
	state.reset()
	var snap: Dictionary = state.snapshot(Vector3.ZERO)
	_check(
		"sentry-initial",
		snap["phase"] == "active" and is_zero_approx(snap["detection"]) and snap["seen_by"].is_empty(),
		"phase=%s detection=%.6f seen=%s" % [snap["phase"], snap["detection"], str(snap["seen_by"])]
	)


func _test_detection_rise() -> void:
	var state = SentryStateScript.new()
	state.reset()
	for i in range(60):
		state.tick(Vector3(0.0, 0.85, -4.0))
	var snap: Dictionary = state.snapshot(Vector3(0.0, 0.85, -4.0))
	var seen: Array = snap["seen_by"]
	_check(
		"sentry-detection-rise",
		snap["phase"] == "active"
		and is_equal_approx(snap["detection"], 60.0 / 90.0)
		and snap["detection_percent"] == 67
		and seen.size() == 1
		and seen[0] == "guard-a"
		and state.seeing_guards(Vector3(0.0, 0.85, -4.0)).size() == 1,
		"phase=%s detection=%.6f percent=%d seen=%s" % [
			snap["phase"], snap["detection"], snap["detection_percent"], str(seen)
		]
	)


func _test_detection_decay() -> void:
	var state = SentryStateScript.new()
	state.reset()
	for i in range(60):
		state.tick(Vector3(0.0, 0.85, -4.0))
	for i in range(60):
		state.tick(Vector3(6.0, 0.85, -4.0))
	var snap: Dictionary = state.snapshot(Vector3(6.0, 0.85, -4.0))
	_check(
		"sentry-detection-decay",
		snap["phase"] == "active"
		and is_equal_approx(snap["detection"], 60.0 / 90.0 - 60.0 / 180.0)
		and snap["detection_percent"] == 33
		and snap["seen_by"].is_empty(),
		"phase=%s detection=%.6f percent=%d seen=%s" % [
			snap["phase"], snap["detection"], snap["detection_percent"], str(snap["seen_by"])
		]
	)


func _test_loss_precedence() -> void:
	var state = SentryStateScript.new()
	state.reset()
	for i in range(90):
		state.tick(Vector3(0.0, 0.85, -4.0))
	var lost: Dictionary = state.snapshot(Vector3(0.0, 0.85, -4.0))
	state.tick(Vector3(0.0, 0.85, -18.0))
	var terminal: Dictionary = state.snapshot(Vector3(0.0, 0.85, -18.0))

	var overlap = SentryStateScript.new()
	overlap.reset()
	overlap.exit_pos = Vector3(0.0, 0.8, -4.0)
	overlap.detection = 89.0 / 90.0
	overlap.tick(Vector3(0.0, 0.85, -4.0))

	_check(
		"sentry-loss-precedence",
		lost["phase"] == "lost"
		and is_equal_approx(lost["detection"], 1.0)
		and lost["detection_percent"] == 100
		and terminal["phase"] == "lost"
		and is_equal_approx(terminal["detection"], 1.0)
		and overlap.phase_name() == "lost"
		and is_equal_approx(overlap.detection, 1.0),
		"lost=%s/%.6f terminal=%s/%.6f simultaneous=%s/%.6f" % [
			lost["phase"], lost["detection"], terminal["phase"], terminal["detection"],
			overlap.phase_name(), overlap.detection
		]
	)


func _test_exit_win() -> void:
	var state = SentryStateScript.new()
	state.reset()
	state.tick(Vector3(0.0, 0.85, -18.0))
	var won: Dictionary = state.snapshot(Vector3(0.0, 0.85, -18.0))
	for i in range(90):
		state.tick(Vector3(0.0, 0.85, -4.0))
	var terminal: Dictionary = state.snapshot(Vector3(0.0, 0.85, -4.0))
	_check(
		"sentry-exit-win",
		won["phase"] == "won"
		and is_zero_approx(won["detection"])
		and won["exit_distance"] <= 2.0
		and terminal["phase"] == "won"
		and is_zero_approx(terminal["detection"]),
		"won=%s/%.6f exit=%.3f terminal=%s/%.6f" % [
			won["phase"], won["detection"], won["exit_distance"], terminal["phase"], terminal["detection"]
		]
	)


func _test_reset_determinism() -> void:
	var state = SentryStateScript.new()
	state.reset()
	for i in range(90):
		state.tick(Vector3(0.0, 0.85, -4.0))
	var lost_phase: String = state.phase_name()
	state.reset()
	var reset: Dictionary = state.snapshot(Vector3.ZERO)
	var first := _sequence_signature()
	var second := _sequence_signature()
	_check(
		"sentry-reset-determinism",
		lost_phase == "lost"
		and reset["phase"] == "active"
		and is_zero_approx(reset["detection"])
		and reset["seen_by"].is_empty()
		and first == second,
		"lost=%s reset=%s/%.6f seen=%s runA=%s runB=%s" % [
			lost_phase, reset["phase"], reset["detection"], str(reset["seen_by"]), first, second
		]
	)


func _test_outside_cones() -> void:
	var state = SentryStateScript.new()
	state.reset()
	for i in range(60):
		state.tick(Vector3(5.0, 0.85, 0.0))
	var snap: Dictionary = state.snapshot(Vector3(5.0, 0.85, 0.0))
	_check(
		"sentry-outside-cones",
		snap["phase"] == "active"
		and is_zero_approx(snap["detection"])
		and snap["seen_by"].is_empty(),
		"phase=%s detection=%.6f seen=%s" % [snap["phase"], snap["detection"], str(snap["seen_by"])]
	)


func _sequence_signature() -> String:
	var state = SentryStateScript.new()
	state.reset()
	for i in range(30):
		state.tick(Vector3(0.0, 0.85, -4.0))
	for i in range(40):
		state.tick(Vector3(6.0, 0.85, -4.0))
	for i in range(70):
		state.tick(Vector3(0.0, 0.85, -4.0))
	return state.signature()
