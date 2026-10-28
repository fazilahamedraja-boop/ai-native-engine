extends SceneTree

## Arena acceptance suite (read-only).
##
## The Studio runs this file and a pristine copy of it from the template, so
## editing the copy inside a project cannot change verification. It drives the
## real scene through the documented `set_input` / `tick` / `get_state` /
## `reset` API and checks gameplay state, not just that scripts exist.
##
## Run manually:
##   godot --headless --path <project> -s res://tests/run_arena_tests.gd

const MAIN_SCENE := "res://scenes/main.tscn"
const TICK := 1.0 / 60.0
const START_HEALTH := 100.0

var passed := 0
var failed := 0
var arena: Node3D


func _initialize() -> void:
	_run()


func _run() -> void:
	var packed = load(MAIN_SCENE)
	if packed == null or not (packed is PackedScene):
		_fail("scene-loads", "Could not load %s" % MAIN_SCENE)
		_summary()
		return
	var instance = packed.instantiate()
	if not (instance is Node3D):
		_fail("scene-loads", "The main scene root is not a Node3D.")
		_summary()
		return
	arena = instance
	root.add_child(arena)
	await process_frame
	await process_frame
	# Deterministic stepping: stop any per-frame loop the scene added.
	arena.set_process(false)
	paused = true

	_test_scene()
	_test_api()
	_test_initial_state()
	_test_visuals()
	_test_controls_text()
	_test_movement()
	_test_enemy_chase()
	_test_attack_range()
	_test_attack_damage()
	_test_contact_damage()
	_test_win()
	_test_loss()
	_test_restart()
	_summary()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

func _test_scene() -> void:
	_pass(
		"scene-loads",
		arena != null and arena.is_inside_tree(),
		"main scene instantiated as %s" % arena.get_class(),
	)


func _test_api() -> void:
	var missing: Array[String] = []
	for name in ["set_input", "tick", "get_state", "reset"]:
		if not arena.has_method(name):
			missing.append(name)
	_pass("api-surface", missing.is_empty(), "missing: %s" % ", ".join(missing))


func _test_initial_state() -> void:
	_reset()
	var state := _state()
	var keys := [
		"player_health",
		"enemy_health",
		"outcome",
		"player_position",
		"enemy_position",
		"controls_text",
		"enemy_visible",
	]
	var missing: Array[String] = []
	for key in keys:
		if not state.has(key):
			missing.append(key)
	var ok: bool = missing.is_empty() \
		and _num("player_health") > 0.0 \
		and _num("enemy_health") > 0.0 \
		and String(state.get("outcome", "")) == "playing" \
		and _state().get("enemy_visible") == true
	_pass(
		"initial-state",
		ok,
		"missing=%s player=%.0f enemy=%.0f outcome=%s visible=%s" % [
			", ".join(missing),
			_num("player_health"),
			_num("enemy_health"),
			String(state.get("outcome", "")),
			str(state.get("enemy_visible")),
		],
	)


func _test_visuals() -> void:
	_reset()
	var camera := _first_node(arena, func(node): return node is Camera3D and node.current)
	var light := _first_node(arena, func(node): return node is Light3D and node.is_visible_in_tree())
	var floor_size := Vector2.ZERO
	for node in _all_nodes(arena):
		if node is MeshInstance3D and node.is_visible_in_tree() and node.mesh != null:
			var extent := _horizontal_extent(node)
			if extent.length() > floor_size.length():
				floor_size = extent
	var player := get_first_node_in_group("player")
	var enemy := get_first_node_in_group("enemy")
	# A camera that points away from the arena still passes "is there a camera",
	# but every windowed capture then comes out blank. Require the arena centre
	# to be inside the camera frustum: that accepts a third-person view, a
	# first-person view and a top-down view, and rejects a sky-facing camera.
	var sees_arena := false
	if camera is Camera3D:
		sees_arena = camera.is_position_in_frustum(Vector3(0.0, 0.9, 0.0))
	_pass(
		"readable-arena",
		camera != null and sees_arena and light != null and floor_size.x >= 12.0 and floor_size.y >= 12.0,
		"camera=%s sees_arena=%s light=%s floor=%.1fx%.1f" % [
			str(camera != null),
			str(sees_arena),
			str(light != null),
			floor_size.x,
			floor_size.y,
		],
	)
	_pass(
		"player-visible",
		player != null and player.is_visible_in_tree() and _has_visible_mesh(player),
		"group player present=%s" % str(player != null),
	)
	_pass(
		"enemy-visible",
		enemy != null and enemy.is_visible_in_tree() and _has_visible_mesh(enemy),
		"group enemy present=%s" % str(enemy != null),
	)


func _test_controls_text() -> void:
	var hint := String(_state().get("controls_text", ""))
	var upper := hint.to_upper()
	var letters := 0
	for letter in ["W", "A", "S", "D"]:
		if upper.contains(letter):
			letters += 1
	var attack_hint: bool = upper.contains("SPACE") \
		or upper.contains("ENTER") \
		or upper.contains("ATTACK") \
		or upper.contains("CLICK") \
		or upper.contains("LMB")
	var texts: Array[String] = []
	_collect_texts(arena, texts)
	_pass(
		"controls-text",
		not hint.is_empty() and letters >= 2 and attack_hint and not texts.is_empty(),
		"hint='%s' on_screen_labels=%d" % [hint.substr(0, 90), texts.size()],
	)


func _test_movement() -> void:
	_reset()
	var start := _pos("player_position")
	var enemy_start := _pos("enemy_position")
	var gap_before := _flat_distance(start, enemy_start)
	_step(60, {"move_forward": true})
	var after := _pos("player_position")
	var moved := _flat_distance(start, after)
	var gap_after := _flat_distance(after, _pos("enemy_position"))
	_pass(
		"movement-forward",
		moved >= 2.5 and gap_before - gap_after >= 1.5 and absf(after.y - start.y) <= 0.75,
		"moved=%.2f closed=%.2f dy=%.2f" % [moved, gap_before - gap_after, after.y - start.y],
	)

	_reset()
	start = _pos("player_position")
	enemy_start = _pos("enemy_position")
	var toward_enemy := _flat_normal(start, enemy_start)
	_step(60, {"move_right": true})
	after = _pos("player_position")
	moved = _flat_distance(start, after)
	var direction := _flat_normal(start, after)
	var alignment := absf(direction.dot(toward_enemy))
	_pass(
		"movement-strafe",
		moved >= 2.5 and alignment <= 0.6,
		"moved=%.2f alignment=%.2f" % [moved, alignment],
	)

	_reset()
	start = _pos("player_position")
	var gap := _flat_distance(start, _pos("enemy_position"))
	_step(60, {"move_back": true})
	gap = _flat_distance(_pos("player_position"), _pos("enemy_position")) - gap
	_pass("movement-back", gap >= 1.0, "gap grew by %.2f" % gap)


func _test_enemy_chase() -> void:
	_reset()
	var before := _flat_distance(_pos("player_position"), _pos("enemy_position"))
	_step(60, {})
	var after := _flat_distance(_pos("player_position"), _pos("enemy_position"))
	_pass("enemy-chases", before - after >= 1.0, "closing speed=%.2f u/s" % (before - after))


func _test_attack_range() -> void:
	_reset()
	var distance := _flat_distance(_pos("player_position"), _pos("enemy_position"))
	var before := _num("enemy_health")
	_press("attack")
	var after := _num("enemy_health")
	_pass(
		"attack-range",
		distance >= 4.0 and before - after <= 0.01,
		"distance=%.2f damage=%.2f" % [distance, before - after],
	)


func _test_attack_damage() -> void:
	_reset()
	_step(60, {"move_forward": true})
	var distance := _flat_distance(_pos("player_position"), _pos("enemy_position"))
	var before := _num("enemy_health")
	_press("attack")
	var after := _num("enemy_health")
	_pass(
		"attack-damage",
		distance <= 3.0 and before - after >= 25.0,
		"distance=%.2f damage=%.2f" % [distance, before - after],
	)


func _test_contact_damage() -> void:
	_reset()
	var reached := false
	for _frame in range(400):
		arena.tick(TICK)
		if _flat_distance(_pos("player_position"), _pos("enemy_position")) <= 1.75:
			reached = true
			break
	var before := _num("player_health")
	_step(60, {})
	var after := _num("player_health")
	_pass(
		"contact-damage",
		reached and before - after >= 7.0,
		"contact=%s damage_in_1s=%.2f" % [str(reached), before - after],
	)


func _test_win() -> void:
	_reset()
	var won := false
	for _round in range(14):
		var distance := _flat_distance(_pos("player_position"), _pos("enemy_position"))
		if distance > 2.4:
			_step(10, {"move_forward": true})
		else:
			_step(2, {})
		_press("attack")
		if String(_state().get("outcome", "")) == "won":
			won = true
			break
	var state := _state()
	_pass(
		"win-condition",
		won and _num("enemy_health") <= 0.0 and state.get("enemy_visible") != true,
		"outcome=%s enemy_health=%.2f visible=%s" % [
			String(state.get("outcome", "")),
			_num("enemy_health"),
			str(state.get("enemy_visible")),
		],
	)
	_step(60, {})
	_pass(
		"outcome-stable",
		String(_state().get("outcome", "")) == "won",
		"outcome after 1s=%s" % String(_state().get("outcome", "")),
	)


func _test_loss() -> void:
	_reset()
	var lost := false
	var frames := 0
	while frames < 1500:
		arena.tick(TICK)
		frames += 1
		if String(_state().get("outcome", "")) == "lost":
			lost = true
			break
	_pass(
		"loss-condition",
		lost and _num("player_health") <= 0.0,
		"outcome=%s player_health=%.2f frames=%d" % [
			String(_state().get("outcome", "")),
			_num("player_health"),
			frames,
		],
	)
	_step(60, {})
	_pass(
		"loss-stable",
		String(_state().get("outcome", "")) == "lost",
		"outcome after 1s=%s" % String(_state().get("outcome", "")),
	)


func _test_restart() -> void:
	arena.set_input({"restart": true})
	arena.tick(TICK)
	arena.set_input({"restart": false})
	arena.tick(TICK)
	var state := _state()
	_pass(
		"restart",
		String(state.get("outcome", "")) == "playing" \
			and _num("player_health") > 0.0 \
			and _num("enemy_health") > 0.0 \
			and state.get("enemy_visible") == true,
		"outcome=%s player=%.0f enemy=%.0f" % [
			String(state.get("outcome", "")),
			_num("player_health"),
			_num("enemy_health"),
		],
	)
	arena.reset()
	state = _state()
	_pass(
		"reset-restores",
		String(state.get("outcome", "")) == "playing" \
			and is_equal_approx(_num("player_health"), START_HEALTH) \
			and is_equal_approx(_num("enemy_health"), START_HEALTH),
		"outcome=%s player=%.0f enemy=%.0f" % [
			String(state.get("outcome", "")),
			_num("player_health"),
			_num("enemy_health"),
		],
	)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

func _state() -> Dictionary:
	var value = arena.get_state()
	return value if value is Dictionary else {}


func _num(key: String) -> float:
	return float(_state().get(key, 0.0))


func _pos(key: String) -> Vector3:
	var value = _state().get(key, [0.0, 0.0, 0.0])
	if value is Vector3:
		return value
	if value is Array and value.size() >= 3:
		return Vector3(float(value[0]), float(value[1]), float(value[2]))
	return Vector3.ZERO


func _reset() -> void:
	arena.reset()
	arena.set_input({})


func _step(frames: int, input: Dictionary = {}) -> void:
	arena.set_input(input)
	for _frame in range(frames):
		arena.tick(TICK)


func _press(action: String) -> void:
	arena.set_input({action: true})
	arena.tick(TICK)
	arena.set_input({action: false})
	arena.tick(TICK)


func _flat_distance(a: Vector3, b: Vector3) -> float:
	return Vector2(a.x - b.x, a.z - b.z).length()


func _flat_normal(a: Vector3, b: Vector3) -> Vector2:
	var delta := Vector2(b.x - a.x, b.z - a.z)
	return delta.normalized() if delta.length() > 0.0001 else Vector2.ZERO


func _all_nodes(start: Node) -> Array[Node]:
	var out: Array[Node] = [start]
	var index := 0
	while index < out.size():
		var node: Node = out[index]
		index += 1
		for child in node.get_children():
			out.append(child)
	return out


func _first_node(start: Node, predicate: Callable) -> Node:
	for node in _all_nodes(start):
		if predicate.call(node):
			return node
	return null


func _has_visible_mesh(start: Node) -> bool:
	for node in _all_nodes(start):
		if node is MeshInstance3D and node.mesh != null and node.is_visible_in_tree():
			return true
	return false


func _horizontal_extent(node: MeshInstance3D) -> Vector2:
	if node.mesh == null:
		return Vector2.ZERO
	var aabb: AABB = node.mesh.get_aabb()
	var scale := node.global_transform.basis.get_scale()
	return Vector2(absf(aabb.size.x * scale.x), absf(aabb.size.z * scale.z))


func _collect_texts(start: Node, out: Array[String]) -> void:
	for node in _all_nodes(start):
		if node is Label3D and node.is_visible_in_tree() and not node.text.is_empty():
			out.append(node.text)
		elif node is Label and node.is_visible_in_tree() and not node.text.is_empty():
			out.append(node.text)
		elif node is RichTextLabel and node.is_visible_in_tree() and not node.get_parsed_text().is_empty():
			out.append(node.get_parsed_text())


func _pass(name: String, ok: bool, detail: String = "") -> void:
	if ok:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])


func _fail(name: String, detail: String = "") -> void:
	failed += 1
	print("FAIL %s %s" % [name, detail])


func _summary() -> void:
	print("RESULT passed=%d failed=%d" % [passed, failed])
	quit(0 if failed == 0 else 1)
