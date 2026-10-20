extends CharacterBody3D

## Player movement is stepped by Main so the fixed-tick order is explicit:
## move, then evaluate sentry sight, then update the HUD.

const SPEED := 4.5
const JUMP_VELOCITY := 5.0
const GRAVITY := 14.0


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


func step_movement(delta: float) -> void:
	var input_dir := Input.get_vector("move_left", "move_right", "move_forward", "move_back")
	var direction := Vector3(input_dir.x, 0.0, input_dir.y)
	if direction.length_squared() > 1.0:
		direction = direction.normalized()

	velocity.x = direction.x * SPEED
	velocity.z = direction.z * SPEED

	if not is_on_floor():
		velocity.y -= GRAVITY * delta
	elif velocity.y < 0.0:
		velocity.y = 0.0

	if Input.is_action_just_pressed("jump") and is_on_floor():
		velocity.y = JUMP_VELOCITY

	if direction.length_squared() > 0.001:
		rotation.y = atan2(-direction.x, -direction.z)

	move_and_slide()


func reset_to(position: Vector3) -> void:
	global_position = position
	velocity = Vector3.ZERO
	rotation = Vector3.ZERO
