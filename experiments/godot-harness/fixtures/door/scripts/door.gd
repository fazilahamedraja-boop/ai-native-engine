extends StaticBody3D

## Locked door with a key requirement.
##
## The node origin is the hinge. The collision shape and visible panel are
## offset to the right of the hinge, so opening rotates the panel away from the
## player. The harness only reads and writes generic properties; all door
## behavior is project code.

const INTERACT_RANGE := 2.2
const DOOR_WIDTH := 1.6
const DOOR_HEIGHT := 2.2
const DOOR_THICKNESS := 0.2
const OPEN_ANGLE_DEGREES := 100.0

var locked := true
var open := false
var collision_enabled := true
var locked_attempts := 0
var open_count := 0
var feedback := "LOCKED - FIND THE KEY"

var _collision: CollisionShape3D


func _ready() -> void:
	_build_door()


func _build_door() -> void:
	_collision = CollisionShape3D.new()
	_collision.name = "Collision"
	var shape := BoxShape3D.new()
	shape.size = Vector3(DOOR_WIDTH, DOOR_HEIGHT, DOOR_THICKNESS)
	_collision.shape = shape
	_collision.position = Vector3(DOOR_WIDTH * 0.5, DOOR_HEIGHT * 0.5, 0.0)
	add_child(_collision)

	var panel := MeshInstance3D.new()
	panel.name = "Panel"
	var box := BoxMesh.new()
	box.size = Vector3(DOOR_WIDTH, DOOR_HEIGHT, DOOR_THICKNESS)
	panel.mesh = box
	panel.position = _collision.position
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#8f3f31")
	material.roughness = 0.72
	panel.material_override = material
	add_child(panel)

	var handle := MeshInstance3D.new()
	handle.name = "Handle"
	var handle_mesh := SphereMesh.new()
	handle_mesh.radius = 0.07
	handle_mesh.height = 0.14
	handle.mesh = handle_mesh
	handle.position = Vector3(DOOR_WIDTH - 0.18, 1.05, 0.13)
	var handle_material := StandardMaterial3D.new()
	handle_material.albedo_color = Color("#e7c65a")
	handle_material.metallic = 0.7
	handle.material_override = handle_material
	add_child(handle)


func try_interact(player_has_key: bool, distance: float) -> String:
	if distance > INTERACT_RANGE:
		feedback = "TOO FAR"
		return feedback
	if open:
		feedback = "DOOR ALREADY OPEN"
		return feedback
	if locked:
		if player_has_key:
			locked = false
			feedback = "UNLOCKED - DOOR OPEN"
			_open()
		else:
			locked_attempts += 1
			feedback = "LOCKED - KEY REQUIRED"
		return feedback
	feedback = "DOOR OPEN"
	_open()
	return feedback


func _open() -> void:
	if open:
		return
	open = true
	open_count += 1
	collision_enabled = false
	_collision.set_deferred("disabled", true)
	rotation.y = deg_to_rad(OPEN_ANGLE_DEGREES)


func reset_door() -> void:
	locked = true
	open = false
	collision_enabled = true
	locked_attempts = 0
	open_count = 0
	feedback = "LOCKED - FIND THE KEY"
	rotation.y = 0.0
	_collision.set_deferred("disabled", false)
