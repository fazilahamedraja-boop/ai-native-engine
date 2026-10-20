extends Node

## Project-local control bridge for the Phase 8 harness.
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

var _server: TCPServer
var _clients: Array[StreamPeerTCP] = []
var _buffers: Dictionary = {}
var _port := 0
var _events: Array[String] = []
var _started_msec := 0


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
		"scene_tree":
			_send(peer, _reply(request_id, true, {"tree": _tree_node(get_tree().root, 0)}))
		"property":
			_send(peer, _property_reply(request_id, args))
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
