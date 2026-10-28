extends Node

## Read-only harness host for arena projects.
##
## This is the only node in the `harness_game` group, so the Studio bridge, the
## native smoke run and the operations panel talk to this adapter instead of
## talking to agent-written code directly. The adapter forwards to the arena
## node (group `arena`) through the documented `set_input` / `tick` /
## `get_state` / `reset` API.
##
## The host also owns the frame loop: it turns the keyboard into one input frame
## per frame and advances the arena with `tick(delta)`. That keeps real play and
## the paused, deterministic harness stepping on exactly the same code path, and
## it means the game script never has to touch `Input` or `_process`.
##
## The Studio's file policy keeps this file and `harness/bridge.gd` read-only.

const ACTIONS := {
	"move_forward": [KEY_W, KEY_UP],
	"move_back": [KEY_S, KEY_DOWN],
	"move_left": [KEY_A, KEY_LEFT],
	"move_right": [KEY_D, KEY_RIGHT],
	"attack": [KEY_SPACE, KEY_ENTER, KEY_J],
	"restart": [KEY_R],
}

func _ready() -> void:
	add_to_group("harness_game")
	for action in ACTIONS:
		if InputMap.has_action(action):
			continue
		InputMap.add_action(action)
		for key in ACTIONS[action]:
			var event := InputEventKey.new()
			event.physical_keycode = key
			InputMap.action_add_event(action, event)


func _process(delta: float) -> void:
	# The bridge pauses the tree whenever it drives the game itself, so this
	# loop only runs during normal play. It never double-steps a harness run.
	if get_tree().paused:
		return
	var arena := _arena()
	if arena == null:
		return
	arena.set_input(_keyboard_input())
	arena.tick(delta)


func snapshot() -> Dictionary:
	var arena := _arena()
	if arena == null:
		return {"game_ready": false, "outcome": "playing", "implemented": false}
	var state: Dictionary = arena.get_state()
	state["game_ready"] = true
	state["player_position"] = _vec(state.get("player_position", [0.0, 0.0, 0.0]))
	state["enemy_position"] = _vec(state.get("enemy_position", [0.0, 0.0, 0.0]))
	return state


func set_harness_input(values: Dictionary) -> Dictionary:
	var arena := _arena()
	if arena != null:
		arena.set_input(_translate_input(values))
	return snapshot()


## The shared harness vocabulary is forward/strafe/jump/restart/actions, while
## the arena speaks its own action names. Translating in the host keeps both
## contracts intact, so injected input and a real keyboard reach the game
## through the same `set_input()` call.
func _translate_input(values: Dictionary) -> Dictionary:
	var forward := float(values.get("forward", 0.0))
	var strafe := float(values.get("strafe", 0.0))
	var actions: Dictionary = values.get("actions", {})
	return {
		"move_forward": forward > 0.0 or bool(actions.get("move_forward", false)),
		"move_back": forward < 0.0 or bool(actions.get("move_back", false)),
		"move_right": strafe > 0.0 or bool(actions.get("move_right", false)),
		"move_left": strafe < 0.0 or bool(actions.get("move_left", false)),
		"attack": bool(actions.get("attack", false)),
		"restart": bool(values.get("restart", false)) or bool(actions.get("restart", false)),
	}


func harness_step(delta: float = 1.0 / 60.0) -> Dictionary:
	var arena := _arena()
	if arena != null:
		arena.tick(delta)
	return snapshot()


func harness_reset() -> Dictionary:
	var arena := _arena()
	if arena != null:
		arena.reset()
	return snapshot()


func _keyboard_input() -> Dictionary:
	return {
		"move_forward": Input.is_action_pressed("move_forward"),
		"move_back": Input.is_action_pressed("move_back"),
		"move_left": Input.is_action_pressed("move_left"),
		"move_right": Input.is_action_pressed("move_right"),
		"attack": Input.is_action_pressed("attack"),
		"restart": Input.is_action_pressed("restart"),
	}


func _arena() -> Node:
	if not is_inside_tree():
		return null
	return get_tree().get_first_node_in_group("arena")


func _vec(value) -> Array:
	if value is Vector3:
		return [value.x, value.y, value.z]
	if value is Array and value.size() >= 3:
		return [float(value[0]), float(value[1]), float(value[2])]
	return [0.0, 0.0, 0.0]
