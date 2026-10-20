extends CharacterBody3D

## Real CharacterBody3D controller for Stage E.
##
## Main calls step_physics() from _physics_process. The movement and collision
## response therefore happen inside the engine's fixed physics tick and use
## move_and_slide(), not a manual position update or a paused manual step.

const SPEED := 4.0
const JUMP_VELOCITY := 5.0
const GRAVITY := 14.0
const RADIUS := 0.4
const HEIGHT := 1.7

var grounded := true
var wall_contact := false


func _ready() -> void:
	_build_body()


func _build_body() -> void:
	var collision := CollisionShape3D.new()
	collision.name = "Collision"
	var capsule := CapsuleShape3D.new()
	capsule.radius = RADIUS
	capsule.height = HEIGHT
	collision.shape = capsule
	add_child(collision)

	var body := MeshInstance3D.new()
	body.name = "Body"
	var body_mesh := CapsuleMesh.new()
	body_mesh.radius = RADIUS
	body_mesh.height = HEIGHT
	body.mesh = body_mesh
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#2f6f9f")
	material.roughness = 0.55
	body.material_override = material
	add_child(body)


func step_physics(delta: float, frame_input: Dictionary) -> void:
	var forward := clampf(float(frame_input.get("forward", 0.0)), -1.0, 1.0)
	var strafe := clampf(float(frame_input.get("strafe", 0.0)), -1.0, 1.0)
	var direction := Vector3(strafe, 0.0, -forward)
	if direction.length_squared() > 1.0:
		direction = direction.normalized()

	velocity.x = direction.x * SPEED
	velocity.z = direction.z * SPEED

	if is_on_floor():
		if velocity.y < 0.0:
			velocity.y = 0.0
	else:
		velocity.y -= GRAVITY * delta

	if bool(frame_input.get("jump", false)) and is_on_floor():
		velocity.y = JUMP_VELOCITY

	if direction.length_squared() > 0.001:
		rotation.y = atan2(-direction.x, -direction.z)

	move_and_slide()
	grounded = is_on_floor()
	wall_contact = is_on_wall()


func reset_to(position: Vector3) -> void:
	global_position = position
	velocity = Vector3.ZERO
	rotation = Vector3.ZERO
	grounded = true
	wall_contact = false
