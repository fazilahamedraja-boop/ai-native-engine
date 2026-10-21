extends CharacterBody3D

## Real CharacterBody3D controller for the Phase 10 observation fixture.
##
## Movement and collision response happen inside the normal fixed physics tick
## through move_and_slide(). The harness advances real physics frames; it does
## not use a paused manual step.

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
	material.albedo_color = Color("#5cc8ff")
	material.roughness = 0.45
	body.material_override = material
	add_child(body)

	var visor := MeshInstance3D.new()
	visor.name = "Visor"
	var visor_mesh := BoxMesh.new()
	visor_mesh.size = Vector3(0.34, 0.12, 0.08)
	visor.mesh = visor_mesh
	visor.position = Vector3(0.0, 0.48, -0.37)
	var visor_material := StandardMaterial3D.new()
	visor_material.albedo_color = Color("#15212b")
	visor_material.emission_enabled = true
	visor_material.emission = Color("#a9f7ff")
	visor_material.emission_energy_multiplier = 0.8
	visor.material_override = visor_material
	add_child(visor)


func reset_to(position: Vector3) -> void:
	global_position = position
	velocity = Vector3.ZERO
	grounded = true
	wall_contact = false


func step_physics(delta: float, input: Dictionary) -> void:
	var forward := float(input.get("forward", 0.0))
	var strafe := float(input.get("strafe", 0.0))
	var direction := Vector3(strafe, 0.0, -forward)
	if direction.length() > 1.0:
		direction = direction.normalized()
	velocity.x = direction.x * SPEED
	velocity.z = direction.z * SPEED

	if not is_on_floor():
		velocity.y -= GRAVITY * delta
	if bool(input.get("jump", false)) and is_on_floor():
		velocity.y = JUMP_VELOCITY

	move_and_slide()
	grounded = is_on_floor()
	wall_contact = is_on_wall()
