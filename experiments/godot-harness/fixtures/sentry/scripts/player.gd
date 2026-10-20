extends CharacterBody3D

## Player movement is stepped by Main so the fixed-tick order is explicit:
## move, then evaluate sentry sight, then update the HUD.

const SPEED := 4.5
const JUMP_VELOCITY := 5.0
const GRAVITY := 14.0
const GROUND_PROBE := 0.05

var grounded := false


func _ready() -> void:
	_build_body()


func _build_body() -> void:
	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.4
	capsule.height = 1.7
	collision.shape = capsule
	add_child(collision)

	var body := MeshInstance3D.new()
	body.name = "Body"
	var body_mesh := CapsuleMesh.new()
	body_mesh.radius = 0.4
	body_mesh.height = 1.7
	body.mesh = body_mesh
	var body_material := StandardMaterial3D.new()
	body_material.albedo_color = Color("#2f6f9f")
	body_material.roughness = 0.55
	body.material_override = body_material
	add_child(body)

	# The visor faces -Z, the direction of travel. The follow camera sees the
	# player's back, as in the reference third-person view.
	var visor := MeshInstance3D.new()
	visor.name = "Visor"
	var visor_mesh := SphereMesh.new()
	visor_mesh.radius = 0.12
	visor_mesh.height = 0.24
	visor.mesh = visor_mesh
	var visor_material := StandardMaterial3D.new()
	visor_material.albedo_color = Color("#f4e6a8")
	visor.material_override = visor_material
	visor.position = Vector3(0.0, 0.55, -0.34)
	add_child(visor)


func step_movement(delta: float, forward := 0.0, strafe := 0.0, jump := false) -> void:
	# Use explicit motion instead of CharacterBody3D.move_and_slide(). The
	# harness calls this while the SceneTree is paused; move_and_slide() reads
	# frame timing internally and produced different distances per call in that
	# context. move_and_collide(motion) takes the step delta explicitly, so the
	# same sequence is repeatable. The fixture has flat ground and no wall
	# colliders, so splitting horizontal and vertical motion is sufficient.
	var direction := Vector3(strafe, 0.0, -forward)
	if direction.length_squared() > 1.0:
		direction = direction.normalized()

	velocity.x = direction.x * SPEED
	velocity.z = direction.z * SPEED

	if not grounded:
		velocity.y -= GRAVITY * delta
	elif velocity.y < 0.0:
		velocity.y = 0.0

	if jump and grounded:
		velocity.y = JUMP_VELOCITY

	if direction.length_squared() > 0.001:
		rotation.y = atan2(-direction.x, -direction.z)

	var horizontal := Vector3(velocity.x, 0.0, velocity.z) * delta
	if horizontal.length_squared() > 0.0:
		var horizontal_collision := move_and_collide(horizontal)
		if horizontal_collision != null:
			velocity.x = 0.0
			velocity.z = 0.0

	var vertical := Vector3(0.0, velocity.y * delta, 0.0)
	grounded = false
	if vertical.length_squared() > 0.0:
		var vertical_collision := move_and_collide(vertical)
		if vertical_collision != null:
			grounded = velocity.y <= 0.0
			velocity.y = 0.0

	if not grounded:
		grounded = test_move(global_transform, Vector3(0.0, -GROUND_PROBE, 0.0))


func reset_to(position: Vector3) -> void:
	global_position = position
	velocity = Vector3.ZERO
	rotation = Vector3.ZERO
	grounded = true
