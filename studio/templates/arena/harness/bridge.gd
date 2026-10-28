extends Node

## Project-local control bridge for the Phase 10 observation fixture.
##
## It is intentionally small and opt-in: the bridge only starts when the
## controller passes `--harness-port=<n>` after Godot's `--` separator. It binds
## to loopback, speaks newline-delimited JSON, and exposes read/control
## operations. It is not an MCP server and does not modify the engine.

const PROTOCOL_VERSION := 1
const MAX_LINE_BYTES := 1024 * 1024
const MAX_TREE_DEPTH := 12
const MAX_TREE_CHILDREN := 80
const MAX_EVENTS := 200
const MAX_OBSERVE_TARGETS := 32
const MAX_OBSERVE_PROPERTIES := 32
const MAX_OBSERVE_DESCENDANTS := 256
const MAX_OBSERVE_BONES := 128
const QUERY_RAY_LENGTH := 100.0

var _server: TCPServer
var _clients: Array[StreamPeerTCP] = []
var _buffers: Dictionary = {}
var _port := 0
var _events: Array[String] = []
var _started_msec := 0
var _physics_busy := false


func _ready() -> void:
	process_mode = Node.PROCESS_MODE_ALWAYS
	_started_msec = Time.get_ticks_msec()

	var requested_port := -1
	for arg in OS.get_cmdline_user_args():
		if arg.begins_with("--harness-port="):
			requested_port = int(arg.get_slice("=", 1))
	if requested_port < 0:
		return

	_server = TCPServer.new()
	var err := _server.listen(requested_port, "127.0.0.1")
	if err != OK:
		push_error("Harness bridge could not listen on 127.0.0.1:%d (error %d)" % [requested_port, err])
		get_tree().quit(2)
		return

	_port = _server.get_local_port()
	_event("listening on 127.0.0.1:%d" % _port)
	print("HARNESS_READY " + JSON.stringify({
		"protocol": PROTOCOL_VERSION,
		"port": _port,
		"pid": OS.get_process_id(),
		"project": String(ProjectSettings.get_setting("application/config/name", "")),
	}))


func _process(_delta: float) -> void:
	if _server == null:
		return

	while _server.is_connection_available():
		var peer := _server.take_connection()
		if peer == null:
			break
		_clients.append(peer)
		_buffers[peer.get_instance_id()] = ""
		_event("client connected")

	for raw_peer in _clients.duplicate():
		var peer: StreamPeerTCP = raw_peer
		peer.poll()
		if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
			_drop_client(peer)
			continue

		var available: int = peer.get_available_bytes()
		if available <= 0:
			continue
		var packet: Array = peer.get_data(available)
		if packet[0] != OK:
			_drop_client(peer)
			continue
		var key: int = peer.get_instance_id()
		var buffer: String = String(_buffers.get(key, "")) + (packet[1] as PackedByteArray).get_string_from_utf8()
		if buffer.length() > MAX_LINE_BYTES:
			_send(peer, {"id": "", "ok": false, "error": {"code": "LINE_TOO_LONG", "message": "Command exceeds the line limit."}})
			_drop_client(peer)
			continue

		while buffer.contains("\n"):
			var newline := buffer.find("\n")
			var line := buffer.substr(0, newline).strip_edges()
			buffer = buffer.substr(newline + 1)
			if not line.is_empty():
				_handle_line(peer, line)
		_buffers[key] = buffer


func _exit_tree() -> void:
	for peer in _clients:
		peer.disconnect_from_host()
	_clients.clear()
	_buffers.clear()
	if _server != null:
		_server.stop()
		_server = null


func _handle_line(peer: StreamPeerTCP, line: String) -> void:
	var parsed = JSON.parse_string(line)
	if typeof(parsed) != TYPE_DICTIONARY:
		_send(peer, {"id": "", "ok": false, "error": {"code": "BAD_JSON", "message": "Expected a JSON object."}})
		return
	var request: Dictionary = parsed
	var request_id := String(request.get("id", ""))
	var command := String(request.get("cmd", ""))
	var args = request.get("args", {})
	if typeof(args) != TYPE_DICTIONARY:
		args = {}

	match command:
		"ping":
			_send(peer, _reply(request_id, true, _ping()))
		"snapshot":
			_send(peer, _reply(request_id, true, _snapshot()))
		"pause":
			get_tree().paused = true
			_event("paused")
			_send(peer, _reply(request_id, true, _runtime_state()))
		"resume":
			get_tree().paused = false
			_event("resumed")
			_send(peer, _reply(request_id, true, _runtime_state()))
		"set_input":
			_send(peer, _set_input_reply(request_id, args))
		"step":
			_send(peer, _step_reply(request_id, args))
		"advance_physics":
			_advance_physics_reply(peer, request_id, args)
		"reset":
			get_tree().paused = true
			_event("reset")
			_send(peer, _reset_reply(request_id))
		"harness_setup":
			_send(peer, _harness_setup_reply(request_id, args))
		"screenshot":
			_send(peer, _screenshot_reply(request_id, args))
		"scene_tree":
			_send(peer, _reply(request_id, true, {"tree": _tree_node(get_tree().root, 0)}))
		"property":
			_send(peer, _property_reply(request_id, args))
		"observe":
			_send(peer, _observe_reply(request_id, args))
		"logs":
			_send(peer, _reply(request_id, true, {
				"events": _events,
				"started_msec": _started_msec,
				"uptime_ms": Time.get_ticks_msec() - _started_msec,
			}))
		"quit":
			_send(peer, _reply(request_id, true, {"quitting": true}))
			_event("quit requested")
			call_deferred("_quit_process")
		"physics_query":
			_send(peer, _physics_query_reply(request_id, args))
		_:
			_send(peer, _fail(request_id, "UNKNOWN_COMMAND", "Unknown command '%s'." % command))


func _quit_process() -> void:
	get_tree().quit(0)


func _ping() -> Dictionary:
	var game = _game()
	return {
		"protocol": PROTOCOL_VERSION,
		"godot": String(Engine.get_version_info().get("string", "")),
		"project": String(ProjectSettings.get_setting("application/config/name", "")),
		"pid": OS.get_process_id(),
		"paused": get_tree().paused,
		"game_ready": game != null,
		"headless": DisplayServer.get_name() == "headless",
		"uptime_ms": Time.get_ticks_msec() - _started_msec,
	}


func _snapshot() -> Dictionary:
	var game = _game()
	if game == null:
		return {"game_ready": false}
	var state: Dictionary = game.snapshot()
	state["game_ready"] = true
	state["paused"] = get_tree().paused
	state["uptime_ms"] = Time.get_ticks_msec() - _started_msec
	return state


func _runtime_state() -> Dictionary:
	return {"paused": get_tree().paused, "snapshot": _snapshot()}


func _property_reply(request_id: String, args: Dictionary) -> Dictionary:
	var node_path := String(args.get("node_path", ""))
	var property := String(args.get("property", ""))
	if not node_path.begins_with("/root/"):
		return _fail(request_id, "VALIDATION_ERROR", "node_path must be an absolute /root/... path.")
	if property.is_empty():
		return _fail(request_id, "VALIDATION_ERROR", "property is required.")
	var node := get_node_or_null(node_path)
	if node == null:
		return _fail(request_id, "NODE_NOT_FOUND", "No node at '%s'." % node_path)
	var found := false
	for entry in node.get_property_list():
		if String(entry.get("name", "")) == property:
			found = true
			break
	if not found:
		return _fail(request_id, "PROPERTY_NOT_FOUND", "Node '%s' has no property '%s'." % [node_path, property])
	return _reply(request_id, true, {
		"node_path": node_path,
		"property": property,
		"value": _jsonable(node.get(property)),
	})


func _set_input_reply(request_id: String, args: Dictionary) -> Dictionary:
	var game = _game()
	if game == null:
		return _fail(request_id, "GAME_NOT_READY", "The game scene is not ready.")
	return _reply(request_id, true, {
		"input": game.set_harness_input(args),
		"snapshot": _snapshot(),
	})


func _step_reply(request_id: String, args: Dictionary) -> Dictionary:
	var game = _game()
	if game == null:
		return _fail(request_id, "GAME_NOT_READY", "The game scene is not ready.")
	var steps := int(args.get("steps", 1))
	var delta := float(args.get("delta", 1.0 / 60.0))
	var record_every := int(args.get("record_every", 0))
	if steps < 0 or steps > 100000:
		return _fail(request_id, "VALIDATION_ERROR", "steps must be between 0 and 100000.")
	if delta < 0.0001 or delta > 0.25:
		return _fail(request_id, "VALIDATION_ERROR", "delta must be between 0.0001 and 0.25.")
	if record_every < 0 or record_every > steps:
		return _fail(request_id, "VALIDATION_ERROR", "record_every must be between 0 and steps.")
	if args.has("input"):
		if typeof(args["input"]) != TYPE_DICTIONARY:
			return _fail(request_id, "VALIDATION_ERROR", "input must be an object.")
		game.set_harness_input(args["input"])

	get_tree().paused = true
	var samples: Array = []
	for index in range(steps):
		var sample: Dictionary = game.harness_step(delta)
		if record_every > 0 and (index % record_every == 0 or index == steps - 1):
			samples.append(sample)
	return _reply(request_id, true, {
		"steps": steps,
		"delta": delta,
		"paused": true,
		"samples": samples,
		"final": _snapshot(),
	})


func _advance_physics_reply(peer: StreamPeerTCP, request_id: String, args: Dictionary) -> void:
	var game = _game()
	if game == null:
		_send(peer, _fail(request_id, "GAME_NOT_READY", "The game scene is not ready."))
		return
	if _physics_busy:
		_send(peer, _fail(request_id, "BUSY", "Another physics advance is already running."))
		return
	var frames := int(args.get("frames", 1))
	if frames < 0 or frames > 100000:
		_send(peer, _fail(request_id, "VALIDATION_ERROR", "frames must be between 0 and 100000."))
		return
	if args.has("input") and typeof(args["input"]) != TYPE_DICTIONARY:
		_send(peer, _fail(request_id, "VALIDATION_ERROR", "input must be an object."))
		return
	if args.has("input"):
		game.set_harness_input(args["input"])

	if frames == 0:
		_send(peer, _reply(request_id, true, {
			"frames": 0,
			"paused": get_tree().paused,
			"final": _snapshot(),
		}))
		return

	_physics_busy = true
	var started_msec := Time.get_ticks_msec()
	var target := Engine.get_physics_frames() + frames
	get_tree().paused = false
	_event("advance_physics start frames=%d target=%d" % [frames, target])
	while Engine.get_physics_frames() < target:
		await get_tree().physics_frame
	# physics_frame is emitted before node _physics_process. Wait for the idle
	# frame so the final requested tick has completed before sampling.
	await get_tree().process_frame
	get_tree().paused = true
	var final := _snapshot()
	_physics_busy = false
	_event("advance_physics done frames=%d" % frames)
	_send(peer, _reply(request_id, true, {
		"frames": frames,
		"duration_ms": Time.get_ticks_msec() - started_msec,
		"paused": true,
		"final": final,
	}))


func _reset_reply(request_id: String) -> Dictionary:
	var game = _game()
	if game == null:
		return _fail(request_id, "GAME_NOT_READY", "The game scene is not ready.")
	return _reply(request_id, true, {
		"paused": true,
		"snapshot": game.harness_reset(),
	})


## Test-only setup for reproducible visual captures. The game already exposes
## harness_setup() to its acceptance tests; this bridge command makes the same
## bounded setup available to the live capture runner without adding a second
## state-mutation path.
func _harness_setup_reply(request_id: String, args: Dictionary) -> Dictionary:
	var game = _game()
	if game == null:
		return _fail(request_id, "GAME_NOT_READY", "The game scene is not ready.")
	if not game.has_method("harness_setup"):
		return _fail(request_id, "UNSUPPORTED", "This project does not expose harness_setup().")
	return _reply(request_id, true, {
		"paused": get_tree().paused,
		"snapshot": game.harness_setup(args),
	})


func _screenshot_reply(request_id: String, args: Dictionary) -> Dictionary:
	if DisplayServer.get_name() == "headless":
		return _fail(request_id, "SCREENSHOT_UNAVAILABLE_HEADLESS", "Screenshots require a windowed run.")
	var rel_path := String(args.get("path", "res://artifacts/harness.png"))
	if not rel_path.begins_with("res://") or not rel_path.ends_with(".png"):
		return _fail(request_id, "VALIDATION_ERROR", "path must be a res:// .png path.")
	var absolute_path := ProjectSettings.globalize_path(rel_path).simplify_path()
	var project_root := ProjectSettings.globalize_path("res://").simplify_path().trim_suffix("/") + "/"
	if not absolute_path.begins_with(project_root):
		return _fail(request_id, "VALIDATION_ERROR", "path escapes the selected project.")
	var directory := absolute_path.get_base_dir()
	var dir_error := DirAccess.make_dir_recursive_absolute(directory)
	if dir_error != OK:
		return _fail(request_id, "WRITE_ERROR", "Could not create '%s' (error %d)." % [directory, dir_error])
	var texture := get_viewport().get_texture()
	if texture == null:
		return _fail(request_id, "NO_FRAME", "The viewport has no texture.")
	var image := texture.get_image()
	if image == null or image.is_empty():
		return _fail(request_id, "NO_FRAME", "The viewport has no readable image.")
	var save_error := image.save_png(absolute_path)
	if save_error != OK:
		return _fail(request_id, "WRITE_ERROR", "Could not save '%s' (error %d)." % [absolute_path, save_error])
	return _reply(request_id, true, {
		"path": rel_path,
		"absolute_path": absolute_path,
		"sha256": FileAccess.get_sha256(absolute_path),
		"bytes": FileAccess.get_file_as_bytes(absolute_path).size(),
		"width": image.get_width(),
		"height": image.get_height(),
		"tick": Engine.get_physics_frames(),
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"sim_time_seconds": float(Engine.get_physics_frames()) / Engine.physics_ticks_per_second,
		"captured_at": Time.get_datetime_string_from_system(true) + "Z",
		"paused": get_tree().paused,
		"source": "measured",
		"headless": DisplayServer.get_name() == "headless",
	})




func _physics_query_reply(request_id: String, args: Dictionary) -> Dictionary:
	var shape_type := String(args.get("shape_type", ""))
	if shape_type.is_empty():
		return _fail(request_id, "VALIDATION_ERROR", "shape_type is required (box, sphere, capsule, ray).")
	if not ["box", "sphere", "capsule", "ray"].has(shape_type):
		return _fail(request_id, "VALIDATION_ERROR", "Unknown shape_type: '%s'. Use box, sphere, capsule, or ray." % shape_type)

	var transform := _query_transform(args.get("transform", null))
	var space := get_tree().root.get_world_3d().direct_space_state
	var collision_mask := _query_mask(args.get("collision_mask", null))
	var results: Array = []

	match shape_type:
		"box":
			var size_value = _query_vec3(args.get("size", null))
			if size_value == null:
				return _fail(request_id, "VALIDATION_ERROR", "size must be an array of three numbers.")
			var size: Vector3 = size_value
			if size.x <= 0.0 or size.y <= 0.0 or size.z <= 0.0:
				return _fail(request_id, "VALIDATION_ERROR", "size components must be greater than zero.")
			var query := PhysicsShapeQueryParameters3D.new()
			var box := BoxShape3D.new()
			box.size = size
			query.shape = box
			query.transform = transform
			query.collision_mask = collision_mask
			results = _query_hits(space.intersect_shape(query, 8))
		"sphere":
			var radius_value = _query_number(args.get("radius", null))
			if radius_value == null or radius_value <= 0.0:
				return _fail(request_id, "VALIDATION_ERROR", "radius must be a number greater than zero.")
			var radius: float = radius_value
			var query := PhysicsShapeQueryParameters3D.new()
			var sphere := SphereShape3D.new()
			sphere.radius = radius
			query.shape = sphere
			query.transform = transform
			query.collision_mask = collision_mask
			results = _query_hits(space.intersect_shape(query, 8))
		"capsule":
			var radius_value = _query_number(args.get("radius", null))
			var height_value = _query_number(args.get("height", null))
			if radius_value == null or radius_value <= 0.0:
				return _fail(request_id, "VALIDATION_ERROR", "radius must be a number greater than zero.")
			if height_value == null or height_value <= 0.0:
				return _fail(request_id, "VALIDATION_ERROR", "height must be a number greater than zero.")
			var radius: float = radius_value
			var height: float = height_value
			var query := PhysicsShapeQueryParameters3D.new()
			var capsule := CapsuleShape3D.new()
			capsule.radius = radius
			capsule.height = height
			query.shape = capsule
			query.transform = transform
			query.collision_mask = collision_mask
			results = _query_hits(space.intersect_shape(query, 8))
		"ray":
			var from := transform.origin
			var to := from + transform.basis.z * QUERY_RAY_LENGTH
			var query := PhysicsRayQueryParameters3D.new()
			query.from = from
			query.to = to
			query.collision_mask = collision_mask
			results = _query_ray_hit(space.intersect_ray(query))
		_:
			return _fail(request_id, "VALIDATION_ERROR", "Unknown shape_type: '%s'. Use box, sphere, capsule, or ray." % shape_type)

	return _reply(request_id, true, {
		"results": results,
		"shape_type": shape_type,
		"transform": _transform_state(transform, "world"),
		"collision_mask": collision_mask,
		"source": "derived",
	})


## Rebuild a world Transform3D from the plain numbers the JSON bridge carries.
## `transform` is an object with an optional `origin` array [x, y, z] and an
## optional `rotation_degrees` array [x, y, z].
func _query_transform(value) -> Transform3D:
	if typeof(value) != TYPE_DICTIONARY:
		return Transform3D.IDENTITY
	var data: Dictionary = value
	var origin := Vector3.ZERO
	var raw_origin = data.get("origin", null)
	if typeof(raw_origin) == TYPE_ARRAY and (raw_origin as Array).size() >= 3:
		var origin_array: Array = raw_origin
		origin = Vector3(
			float(origin_array[0]),
			float(origin_array[1]),
			float(origin_array[2])
		)
	var rotation := Vector3.ZERO
	var raw_rotation = data.get("rotation_degrees", null)
	if typeof(raw_rotation) == TYPE_ARRAY and (raw_rotation as Array).size() >= 3:
		var rotation_array: Array = raw_rotation
		rotation = Vector3(
			float(rotation_array[0]),
			float(rotation_array[1]),
			float(rotation_array[2])
		)
	return Transform3D(Basis.from_euler(rotation * (PI / 180.0)), origin)


## Parse a JSON array of three numbers into a Vector3, or null when invalid.
func _query_vec3(value):
	if typeof(value) != TYPE_ARRAY:
		return null
	var array: Array = value
	if array.size() < 3:
		return null
	for entry in array:
		if typeof(entry) != TYPE_INT and typeof(entry) != TYPE_FLOAT:
			return null
	return Vector3(float(array[0]), float(array[1]), float(array[2]))


## Parse a JSON number, or null when the value is absent or not numeric.
func _query_number(value):
	if typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT:
		return null
	return float(value)


## Parse the optional collision mask. The default is layer 1, matching the
## engine default. A caller must pass the mask explicitly to see colliders on
## another layer.
func _query_mask(value) -> int:
	if value == null:
		return 1
	if typeof(value) != TYPE_INT and typeof(value) != TYPE_FLOAT:
		return 1
	var mask := int(value)
	if mask < 0:
		return 1
	return mask


## Convert intersect_shape hits into the documented result schema.
func _query_hits(hits: Array) -> Array:
	var results: Array = []
	for hit in hits:
		var entry: Dictionary = hit
		var collider = entry.get("collider", null)
		var collider_path: Variant = null
		var collider_type: Variant = null
		if collider is Node:
			collider_path = String((collider as Node).get_path())
			collider_type = String((collider as Node).get_class())
		results.append({
			"collider": collider_path,
			"collider_type": collider_type,
			"shape_index": entry.get("shape", null),
			"source": "derived",
		})
	return results


## Convert a single intersect_ray hit into the documented result schema.
## `intersect_ray` returns one Dictionary, or an empty Dictionary on a miss.
func _query_ray_hit(hit: Dictionary) -> Array:
	if hit.is_empty():
		return []
	var collider = hit.get("collider", null)
	var collider_path: Variant = null
	var collider_type: Variant = null
	if collider is Node:
		collider_path = String((collider as Node).get_path())
		collider_type = String((collider as Node).get_class())
	var position = hit.get("position", null)
	var normal = hit.get("normal", null)
	return [{
		"collider": collider_path,
		"collider_type": collider_type,
		"shape_index": hit.get("shape", null),
		"hit_point": _vec3(position) if position is Vector3 else null,
		"hit_normal": _vec3(normal) if normal is Vector3 else null,
		"source": "derived",
	}]


func _observe_reply(request_id: String, args: Dictionary) -> Dictionary:
	var targets = args.get("targets", [])
	if typeof(targets) != TYPE_ARRAY:
		return _fail(request_id, "VALIDATION_ERROR", "targets must be an array.")
	if targets.size() > MAX_OBSERVE_TARGETS:
		return _fail(request_id, "VALIDATION_ERROR", "targets exceeds the %d target limit." % MAX_OBSERVE_TARGETS)
	var properties = args.get("properties", [])
	if typeof(properties) != TYPE_ARRAY:
		return _fail(request_id, "VALIDATION_ERROR", "properties must be an array.")
	if properties.size() > MAX_OBSERVE_PROPERTIES:
		return _fail(request_id, "VALIDATION_ERROR", "properties exceeds the %d property limit." % MAX_OBSERVE_PROPERTIES)
	for raw_property in properties:
		if typeof(raw_property) != TYPE_STRING or not _valid_property_name(String(raw_property)):
			return _fail(request_id, "VALIDATION_ERROR", "properties must contain simple identifiers.")
	var descendants := 0
	if args.has("descendants"):
		var raw_descendants = args["descendants"]
		if typeof(raw_descendants) != TYPE_INT and typeof(raw_descendants) != TYPE_FLOAT:
			return _fail(request_id, "VALIDATION_ERROR", "descendants must be an integer.")
		var descendant_value := float(raw_descendants)
		if descendant_value != floor(descendant_value) or descendant_value < 0.0 or descendant_value > 3.0:
			return _fail(request_id, "VALIDATION_ERROR", "descendants must be an integer between 0 and 3.")
		descendants = int(descendant_value)
	var since_tick := 0
	if args.has("since_tick"):
		var raw_since = args["since_tick"]
		if typeof(raw_since) != TYPE_INT and typeof(raw_since) != TYPE_FLOAT:
			return _fail(request_id, "VALIDATION_ERROR", "since_tick must be an integer.")
		var since_value := float(raw_since)
		if since_value != floor(since_value) or since_value < 0.0:
			return _fail(request_id, "VALIDATION_ERROR", "since_tick must be a non-negative integer.")
		since_tick = int(since_value)

	var observed_nodes: Array = []
	for raw_target in targets:
		if typeof(raw_target) != TYPE_STRING:
			return _fail(request_id, "VALIDATION_ERROR", "targets must contain strings.")
		var node_path := String(raw_target)
		if not _valid_node_path(node_path):
			return _fail(request_id, "VALIDATION_ERROR", "targets must be absolute /root/... node paths without . or .. segments.")
		var node := get_node_or_null(node_path)
		if node == null:
			return _fail(request_id, "NODE_NOT_FOUND", "No node at '%s'." % node_path)
		var budget := {"remaining": MAX_OBSERVE_DESCENDANTS}
		observed_nodes.append(_observe_node(node, descendants, properties, budget))

	return _reply(request_id, true, {
		"runtime": _observe_runtime(),
		"nodes": observed_nodes,
		"events": _observe_events(since_tick),
	})


func _observe_runtime() -> Dictionary:
	var tick := Engine.get_physics_frames()
	return {
		"tick": tick,
		"physics_frames": tick,
		"physics_ticks_per_second": Engine.physics_ticks_per_second,
		"sim_time_seconds": float(tick) / float(Engine.physics_ticks_per_second),
		"sim_time_seconds_source": "derived",
		"captured_at": Time.get_datetime_string_from_system(true) + "Z",
		"unix_time": Time.get_unix_time_from_system(),
		"uptime_ms": Time.get_ticks_msec() - _started_msec,
		"paused": get_tree().paused,
		"godot": String(Engine.get_version_info().get("string", "")),
		"spaces": {"local": "parent", "global": "world"},
		"units": {"position": "m", "velocity": "m/s", "rotation": "deg", "time": "s"},
		"source": "measured",
	}


func _observe_node(
	node: Node,
	descendants: int,
	properties: Array,
	budget: Dictionary,
) -> Dictionary:
	var data := _observe_base(node)
	if node is CharacterBody3D:
		data["character"] = _character_state(node)
	elif node is RigidBody3D:
		data["rigid_body"] = _rigid_body_state(node)
	if node is CollisionObject3D:
		data["collision_shapes"] = _collision_shapes(node)
		data["collision"] = _collision_state(node)
	var animations := _animation_states(node)
	if not animations.is_empty():
		data["animations"] = animations
	if node is Skeleton3D:
		data["skeleton"] = _skeleton_state(node)
	var skeletons := _child_skeletons(node)
	if not skeletons.is_empty():
		data["skeletons"] = skeletons
	if not properties.is_empty():
		data["properties"] = _property_values(node, properties)
	if descendants > 0:
		data["children"] = _observe_children(node, descendants, budget)
		data["descendant_limit"] = MAX_OBSERVE_DESCENDANTS
		data["descendant_truncated"] = int(budget["remaining"]) <= 0
	return data


func _observe_base(node: Node) -> Dictionary:
	var data := {
		"path": String(node.get_path()),
		"name": String(node.name),
		"class": String(node.get_class()),
		"process_mode": node.process_mode,
		"is_inside_tree": node.is_inside_tree(),
		"source": "measured",
	}
	if node is Node3D or node is CanvasItem:
		data["visible"] = bool(node.visible)
	if node is Node3D:
		data["local_transform"] = _transform_state(node.transform, "parent")
		data["global_transform"] = _transform_state(node.global_transform, "world")
	return data


func _character_state(node: CharacterBody3D) -> Dictionary:
	var collisions: Array = []
	for index in range(node.get_slide_collision_count()):
		var collision := node.get_slide_collision(index)
		var collider = collision.get_collider()
		collisions.append({
			"collider": String(collider.get_path()) if collider != null else null,
			"normal": _vec3(collision.get_normal()),
			"position": _vec3(collision.get_position()),
		})
	return {
		"velocity": _vec3(node.velocity),
		"is_on_floor": node.is_on_floor(),
		"is_on_wall": node.is_on_wall(),
		"is_on_ceiling": node.is_on_ceiling(),
		"floor_normal": _vec3(node.get_floor_normal()),
		"wall_normal": _vec3(node.get_wall_normal()),
		"slide_collision_count": node.get_slide_collision_count(),
		"slide_collisions": collisions,
		"derived": {
			"speed": node.velocity.length(),
			"horizontal_speed": Vector2(node.velocity.x, node.velocity.z).length(),
		},
		"source": "measured",
	}


func _rigid_body_state(node: RigidBody3D) -> Dictionary:
	return {
		"linear_velocity": _vec3(node.linear_velocity),
		"angular_velocity": _vec3(node.angular_velocity),
		"mass": node.mass,
		"gravity_scale": node.gravity_scale,
		"sleeping": node.sleeping,
		"can_sleep": node.can_sleep,
		"derived": {"speed": node.linear_velocity.length()},
		"source": "measured",
	}


func _collision_state(node: CollisionObject3D) -> Dictionary:
	var state := {
		"collision_layer": node.collision_layer,
		"collision_mask": node.collision_mask,
		"source": "measured",
	}
	if node is Area3D:
		state["monitoring"] = (node as Area3D).monitoring
		state["monitorable"] = (node as Area3D).monitorable
	return state


func _collision_shapes(node: CollisionObject3D) -> Array:
	var shapes: Array = []
	for child in node.get_children():
		if child is CollisionShape3D:
			var shape = child.shape
			shapes.append({
				"name": String(child.name),
				"path": String(child.get_path()),
				"class": String(child.get_class()),
				"disabled": child.disabled,
				"transform": _transform_state(child.transform, "parent"),
				"global_transform": _transform_state(child.global_transform, "world"),
				"shape_class": String(shape.get_class()) if shape != null else null,
				"shape": _shape_state(shape),
				"source": "measured",
			})
		elif child is CollisionPolygon3D:
			shapes.append({
				"name": String(child.name),
				"path": String(child.get_path()),
				"class": String(child.get_class()),
				"disabled": child.disabled,
				"transform": _transform_state(child.transform, "parent"),
				"global_transform": _transform_state(child.global_transform, "world"),
				"shape_class": String(child.get_class()),
				"shape": {"polygon_points": child.polygon.size(), "depth": child.depth},
				"source": "measured",
			})
	return shapes


func _shape_state(shape) -> Dictionary:
	if shape == null:
		return {}
	var state := {}
	if shape is BoxShape3D:
		state["size"] = _vec3(shape.size)
	elif shape is SphereShape3D:
		state["radius"] = shape.radius
	elif shape is CapsuleShape3D:
		state["radius"] = shape.radius
		state["height"] = shape.height
	elif shape is CylinderShape3D:
		state["radius"] = shape.radius
		state["height"] = shape.height
	elif shape is ConvexPolygonShape3D:
		state["points"] = shape.points.size()
	elif shape is ConcavePolygonShape3D:
		state["faces"] = shape.get_faces().size()
	return state


func _animation_states(node: Node) -> Array:
	var states: Array = []
	if node is AnimationPlayer:
		states.append(_animation_player_state(node))
	for child in node.get_children():
		if child is AnimationPlayer:
			states.append(_animation_player_state(child))
	return states


func _animation_player_state(node: AnimationPlayer) -> Dictionary:
	var assigned = null
	if _has_property(node, "assigned_animation"):
		assigned = node.get("assigned_animation")
	return {
		"name": String(node.name),
		"path": String(node.get_path()),
		"current_animation": String(node.current_animation),
		"current_animation_position": node.current_animation_position,
		"is_playing": node.is_playing(),
		"speed_scale": node.speed_scale,
		"assigned_animation": assigned,
		"source": "measured",
	}


func _skeleton_state(node: Skeleton3D) -> Dictionary:
	var bone_count := node.get_bone_count()
	var bones: Array = []
	var skeleton_global := node.global_transform
	for index in range(mini(bone_count, MAX_OBSERVE_BONES)):
		var global_pose := node.get_bone_global_pose(index)
		bones.append({
			"index": index,
			"name": String(node.get_bone_name(index)),
			"parent": node.get_bone_parent(index),
			"rest": _transform_state(node.get_bone_rest(index), "bone_parent"),
			"pose": _transform_state(node.get_bone_pose(index), "bone_parent"),
			"global_pose": _transform_state(global_pose, "skeleton"),
			"derived_world_pose": _transform_state(
				skeleton_global * global_pose, "world", "derived"
			),
			"enabled": node.is_bone_enabled(index),
			"source": "measured",
		})
	return {
		"node_path": String(node.get_path()),
		"global_transform": _transform_state(skeleton_global, "world"),
		"bone_count": bone_count,
		"bones": bones,
		"truncated": bone_count > MAX_OBSERVE_BONES,
		"source": "measured",
	}


func _child_skeletons(node: Node) -> Array:
	var skeletons: Array = []
	for child in node.get_children():
		if child is Skeleton3D:
			skeletons.append(_skeleton_state(child))
	return skeletons


func _property_values(node: Node, properties: Array) -> Dictionary:
	var values := {}
	var missing: Array = []
	for raw_property in properties:
		var property_name := String(raw_property)
		if _has_property(node, property_name):
			values[property_name] = _jsonable(node.get(property_name))
		else:
			missing.append(property_name)
	return {
		"values": values,
		"missing": missing,
		"source": "measured",
	}


func _observe_children(node: Node, depth: int, budget: Dictionary) -> Array:
	var children: Array = []
	if depth <= 0:
		return children
	for child in node.get_children():
		if int(budget["remaining"]) <= 0:
			break
		budget["remaining"] = int(budget["remaining"]) - 1
		var entry := _observe_base(child)
		if depth > 1:
			entry["children"] = _observe_children(child, depth - 1, budget)
		children.append(entry)
	return children


func _observe_events(since_tick: int) -> Dictionary:
	var game = _game()
	if game == null or not game.has_method("harness_events"):
		return {
			"available": false,
			"since_tick": since_tick,
			"count": 0,
			"items": [],
			"truncated": false,
			"source": "unavailable",
			"note": "The game does not implement harness_events(since_tick).",
		}
	var raw_events = game.harness_events(since_tick)
	if typeof(raw_events) != TYPE_ARRAY:
		return {
			"available": false,
			"since_tick": since_tick,
			"count": 0,
			"items": [],
			"truncated": false,
			"source": "invalid",
			"note": "harness_events(since_tick) did not return an array.",
		}
	var start := maxi(0, raw_events.size() - MAX_EVENTS)
	var items: Array = []
	for index in range(start, raw_events.size()):
		items.append(_jsonable(raw_events[index]))
	return {
		"available": true,
		"since_tick": since_tick,
		"count": raw_events.size(),
		"items": items,
		"truncated": start > 0,
		"source": "fixture_recorded",
	}


func _transform_state(value: Transform3D, space: String, source := "measured") -> Dictionary:
	var basis := value.basis
	var euler := basis.get_euler()
	var quaternion := basis.get_rotation_quaternion()
	var scale := basis.get_scale()
	return {
		"space": space,
		"origin": _vec3(value.origin),
		"rotation_degrees": [rad_to_deg(euler.x), rad_to_deg(euler.y), rad_to_deg(euler.z)],
		"quaternion": [quaternion.x, quaternion.y, quaternion.z, quaternion.w],
		"scale": _vec3(scale),
		"source": source,
	}


func _vec3(value: Vector3) -> Array:
	return [value.x, value.y, value.z]


func _valid_node_path(path: String) -> bool:
	if not path.begins_with("/root/") or path.contains(":"):
		return false
	for segment in path.trim_prefix("/").split("/"):
		if segment.is_empty() or segment == "." or segment == "..":
			return false
	return true


func _valid_property_name(value: String) -> bool:
	if value.is_empty():
		return false
	var first := value.substr(0, 1)
	if not (first == "_" or (first >= "a" and first <= "z") or (first >= "A" and first <= "Z")):
		return false
	for index in range(1, value.length()):
		var character := value.substr(index, 1)
		if not (
			character == "_"
			or (character >= "a" and character <= "z")
			or (character >= "A" and character <= "Z")
			or (character >= "0" and character <= "9")
		):
			return false
	return true


func _has_property(node: Node, property_name: String) -> bool:
	for entry in node.get_property_list():
		if String(entry.get("name", "")) == property_name:
			return true
	return false


func _tree_node(node: Node, depth: int) -> Dictionary:
	var children: Array = []
	if depth < MAX_TREE_DEPTH:
		var index := 0
		for child in node.get_children():
			if index >= MAX_TREE_CHILDREN:
				break
			children.append(_tree_node(child, depth + 1))
			index += 1
	return {
		"name": String(node.name),
		"class": node.get_class(),
		"path": String(node.get_path()),
		"children": children,
	}


func _jsonable(value):
	match typeof(value):
		TYPE_NIL, TYPE_BOOL, TYPE_INT, TYPE_FLOAT, TYPE_STRING:
			return value
		TYPE_VECTOR2:
			return [value.x, value.y]
		TYPE_VECTOR3:
			return [value.x, value.y, value.z]
		TYPE_VECTOR4:
			return [value.x, value.y, value.z, value.w]
		TYPE_COLOR:
			return [value.r, value.g, value.b, value.a]
		TYPE_NODE_PATH:
			return String(value)
		TYPE_OBJECT:
			if value == null:
				return null
			return String(value)
		TYPE_ARRAY:
			var result: Array = []
			for item in value:
				result.append(_jsonable(item))
			return result
		TYPE_DICTIONARY:
			var result: Dictionary = {}
			for key in value:
				result[String(key)] = _jsonable(value[key])
			return result
		_:
			return str(value)


func _game():
	return get_tree().get_first_node_in_group("harness_game")


func _reply(request_id: String, ok: bool, data: Dictionary) -> Dictionary:
	return {"id": request_id, "ok": ok, "data": data, "error": null}


func _fail(request_id: String, code: String, message: String) -> Dictionary:
	return {"id": request_id, "ok": false, "data": null, "error": {"code": code, "message": message}}


func _send(peer: StreamPeerTCP, payload: Dictionary) -> void:
	var bytes := (JSON.stringify(payload) + "\n").to_utf8_buffer()
	peer.put_data(bytes)


func _drop_client(peer: StreamPeerTCP) -> void:
	_clients.erase(peer)
	_buffers.erase(peer.get_instance_id())
	peer.disconnect_from_host()
	_event("client disconnected")


func _event(message: String) -> void:
	_events.append("%d %s" % [Time.get_ticks_msec() - _started_msec, message])
	if _events.size() > MAX_EVENTS:
		_events.pop_front()
