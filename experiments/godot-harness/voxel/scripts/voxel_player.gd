class_name VoxelPlayer
extends CharacterBody3D

## First-person movement and camera look. World-level targeting, mining,
## placement, HUD, and persistence live in voxel_world.gd so the controller can
## be tested with the same physics loop used by normal play.

const WALK_SPEED := 5.2
const GROUND_ACCEL := 26.0
const AIR_ACCEL := 7.0
const GRAVITY := 20.0
const JUMP_VELOCITY := 6.9
const EYE_HEIGHT := 1.62
const PITCH_LIMIT_DEG := 85.0

var yaw := 0.0
var pitch := deg_to_rad(-14.0)
var camera: Camera3D
var harness_mode := false
var harness_forward := 0.0
var harness_strafe := 0.0
var harness_jump := false
var previous_jump := false


func _ready() -> void:
	name = "Player"
	add_to_group("voxel_player")
	collision_layer = 2
	collision_mask = 1
	up_direction = Vector3.UP
	floor_snap_length = 0.12
	floor_max_angle = deg_to_rad(46.0)
	safe_margin = 0.001

	var capsule := CapsuleShape3D.new()
	capsule.radius = 0.32
	capsule.height = 1.75
	var shape := CollisionShape3D.new()
	shape.name = "PlayerCapsule"
	shape.shape = capsule
	shape.position = Vector3(0.0, 0.875, 0.0)
	add_child(shape)

	camera = Camera3D.new()
	camera.name = "FirstPersonCamera"
	camera.position = Vector3(0.0, EYE_HEIGHT, 0.0)
	camera.fov = 74.0
	camera.near = 0.05
	camera.far = 90.0
	camera.current = true
	add_child(camera)
	_apply_look()


func reset_at(feet_position: Vector3, yaw_degrees: float = 0.0, pitch_degrees: float = -14.0) -> void:
	global_position = feet_position
	velocity = Vector3.ZERO
	yaw = deg_to_rad(yaw_degrees)
	pitch = deg_to_rad(clampf(pitch_degrees, -PITCH_LIMIT_DEG, PITCH_LIMIT_DEG))
	_apply_look()
	reset_physics_interpolation()


func set_look(yaw_degrees: float, pitch_degrees: float) -> void:
	yaw = deg_to_rad(yaw_degrees)
	pitch = deg_to_rad(clampf(pitch_degrees, -PITCH_LIMIT_DEG, PITCH_LIMIT_DEG))
	_apply_look()


func add_look(yaw_delta: float, pitch_delta: float) -> void:
	yaw += yaw_delta
	pitch = clampf(pitch + pitch_delta, deg_to_rad(-PITCH_LIMIT_DEG), deg_to_rad(PITCH_LIMIT_DEG))
	_apply_look()


func look_direction() -> Vector3:
	return -camera.global_transform.basis.z


func camera_position() -> Vector3:
	return camera.global_position


func step_movement(delta: float, forward: float, strafe: float, jump_pressed: bool) -> void:
	var input_vector := Vector2(strafe, forward)
	if input_vector.length() > 1.0:
		input_vector = input_vector.normalized()
	var wish := Vector3(input_vector.x, 0.0, -input_vector.y).rotated(Vector3.UP, yaw)
	var target_velocity := wish * WALK_SPEED
	var accel := GROUND_ACCEL if is_on_floor() else AIR_ACCEL
	velocity.x = move_toward(velocity.x, target_velocity.x, accel * delta)
	velocity.z = move_toward(velocity.z, target_velocity.z, accel * delta)

	if not is_on_floor():
		velocity.y -= GRAVITY * delta
	elif jump_pressed:
		velocity.y = JUMP_VELOCITY
	else:
		velocity.y = -0.1
	if jump_pressed and is_on_floor():
		velocity.y = JUMP_VELOCITY

	move_and_slide()


func _apply_look() -> void:
	rotation.y = yaw
	if camera != null:
		camera.rotation.x = pitch
