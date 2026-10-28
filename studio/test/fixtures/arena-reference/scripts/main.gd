extends Node3D

## Reference arena implementation.
##
## This file is NOT part of the template and is never visible to the Studio
## agent. The Studio test suite copies it over a fresh template copy to prove
## that `tests/run_arena_tests.gd` passes on a correct implementation, and that
## it fails on the untouched scaffold. If the suite ever disagrees with this
## file, the suite is wrong, not the game.

const START_HEALTH := 100.0
const PLAYER_SPEED := 5.0
const ENEMY_SPEED := 2.2
const ATTACK_RANGE := 3.0
const ATTACK_DAMAGE := 34.0
const CONTACT_RANGE := 1.6
const CONTACT_DPS := 20.0
const PLAYER_START := Vector3(0.0, 0.9, 5.0)
const ENEMY_START := Vector3(0.0, 0.9, -5.0)
const ARENA_HALF := 10.0
const CONTROLS_TEXT := "WASD move - Space attack - R restart"

var player_health := START_HEALTH
var enemy_health := START_HEALTH
var outcome := "playing"
var player_position := PLAYER_START
var enemy_position := ENEMY_START

var _input: Dictionary = {}
var _attack_down := false
var _restart_down := false
var _player: Node3D
var _enemy: Node3D
var _hint: Node


func _ready() -> void:
	add_to_group("arena")
	_build_actors()
	var hint := find_child("Hint", true, false)
	if hint is Label or hint is RichTextLabel:
		_hint = hint
		_set_hint_text(CONTROLS_TEXT)
	reset()


func _set_hint_text(value: String) -> void:
	if _hint is Label:
		_hint.text = value
	elif _hint is RichTextLabel:
		_hint.text = value


func reset() -> void:
	player_health = START_HEALTH
	enemy_health = START_HEALTH
	outcome = "playing"
	player_position = PLAYER_START
	enemy_position = ENEMY_START
	_input = {}
	_attack_down = false
	_restart_down = false
	if _enemy != null:
		_enemy.visible = true
	_apply_transforms()


func set_input(values: Dictionary) -> void:
	_input = values.duplicate(true)


func tick(delta: float) -> void:
	if delta <= 0.0:
		return
	var restart_down := _flag("restart")
	if restart_down and not _restart_down:
		reset()
		_restart_down = true
		return
	_restart_down = restart_down

	var attack_down := _flag("attack")
	if outcome != "playing":
		_attack_down = attack_down
		_apply_transforms()
		return

	var move := Vector3.ZERO
	if _flag("move_forward"):
		move.z -= 1.0
	if _flag("move_back"):
		move.z += 1.0
	if _flag("move_left"):
		move.x -= 1.0
	if _flag("move_right"):
		move.x += 1.0
	if move.length() > 0.0:
		player_position += move.normalized() * PLAYER_SPEED * delta
	player_position.x = clampf(player_position.x, -ARENA_HALF, ARENA_HALF)
	player_position.z = clampf(player_position.z, -ARENA_HALF, ARENA_HALF)
	player_position.y = PLAYER_START.y

	var to_player := player_position - enemy_position
	to_player.y = 0.0
	if to_player.length() > CONTACT_RANGE:
		enemy_position += to_player.normalized() * ENEMY_SPEED * delta
		enemy_position.y = ENEMY_START.y

	if _flat_distance(player_position, enemy_position) <= CONTACT_RANGE:
		player_health = maxf(0.0, player_health - CONTACT_DPS * delta)

	if attack_down and not _attack_down:
		if _flat_distance(player_position, enemy_position) <= ATTACK_RANGE:
			enemy_health = maxf(0.0, enemy_health - ATTACK_DAMAGE)
	_attack_down = attack_down

	if enemy_health <= 0.0:
		outcome = "won"
		if _enemy != null:
			_enemy.visible = false
	elif player_health <= 0.0:
		outcome = "lost"

	_apply_transforms()


func get_state() -> Dictionary:
	return {
		"implemented": true,
		"player_health": player_health,
		"enemy_health": enemy_health,
		"outcome": outcome,
		"player_position": [player_position.x, player_position.y, player_position.z],
		"enemy_position": [enemy_position.x, enemy_position.y, enemy_position.z],
		"controls_text": CONTROLS_TEXT,
		"enemy_visible": _enemy != null and _enemy.visible,
	}


func _flag(name: String) -> bool:
	var value = _input.get(name, false)
	if value is bool:
		return value
	if value is float or value is int:
		return float(value) != 0.0
	return false


func _flat_distance(a: Vector3, b: Vector3) -> float:
	return Vector2(a.x - b.x, a.z - b.z).length()


func _apply_transforms() -> void:
	if _player != null:
		_player.position = player_position
	if _enemy != null:
		_enemy.position = enemy_position


func _build_actors() -> void:
	_player = _actor("Player", "player", Color(0.25, 0.55, 1.0), _capsule_mesh(0.45, 1.8))
	_enemy = _actor("Enemy", "enemy", Color(1.0, 0.32, 0.28), _capsule_mesh(0.5, 1.6))
	_apply_transforms()


func _actor(node_name: String, group: String, color: Color, mesh: Mesh) -> Node3D:
	var node := Node3D.new()
	node.name = node_name
	node.add_to_group(group)
	var visual := MeshInstance3D.new()
	visual.name = "Body"
	visual.mesh = mesh
	var material := StandardMaterial3D.new()
	material.albedo_color = color
	visual.material_override = material
	node.add_child(visual)
	add_child(node)
	return node


func _capsule_mesh(radius: float, height: float) -> CapsuleMesh:
	var mesh := CapsuleMesh.new()
	mesh.radius = radius
	mesh.height = height
	return mesh
