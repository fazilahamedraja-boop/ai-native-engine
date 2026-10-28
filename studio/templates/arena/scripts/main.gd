extends Node3D

## Arena game scaffold.
##
## This is the only gameplay file. Replace the stub with a real arena game.
## The exact contract is in ARENA_SPEC.md and is enforced by
## tests/run_arena_tests.gd (read-only), so read both before editing.
##
## The read-only host (scripts/arena_host.gd, autoload "ArenaHost") owns the
## frame loop: it turns keyboard input into `set_input()` calls and advances the
## simulation with `tick(delta)`. Do not add a `_process()` here that also calls
## `tick()`; that would double-step the simulation during normal play.

const START_HEALTH := 100.0


func _ready() -> void:
	add_to_group("arena")


## Restore the initial state. Called before every automated run.
func reset() -> void:
	pass


## Store one complete input frame. Omitted keys are released.
## Keys: move_forward, move_back, move_left, move_right, attack, restart.
func set_input(_values: Dictionary) -> void:
	pass


## Advance the simulation by `delta` seconds. Movement must be applied to the
## player position directly here (not only through physics bodies) so a paused
## tree can be stepped deterministically.
func tick(_delta: float) -> void:
	pass


## Return the observable state described in ARENA_SPEC.md.
func get_state() -> Dictionary:
	return {
		"implemented": false,
		"player_health": 0.0,
		"enemy_health": 0.0,
		"outcome": "playing",
		"player_position": [0.0, 0.0, 0.0],
		"enemy_position": [0.0, 0.0, 0.0],
		"controls_text": "",
		"enemy_visible": false,
	}
