extends SceneTree

## Stage C diagnostic (not an acceptance test).
##
## Reproduces the setup finding documented in docs/phase11/stage-c-diagnosis.md
## section 2.1: with `Area3D.monitorable = false` an area reports an EMPTY
## `get_overlapping_bodies()` list even when it is positioned exactly on a
## colliding body, while a freshly built area at the same transform reports the
## body. Flipping `monitorable` back to `true` restores the overlap.
##
## Run:
##   godot --headless --path fixtures/combat -s res://tests/probe_collision.gd

const TARGET_CENTER := Vector3(0.0, 0.75, 1.2)


func _initialize() -> void:
	_run()


func _run() -> void:
	var world = load("res://main.tscn").instantiate()
	root.add_child(world)
	for _i in range(4):
		await physics_frame

	var hitbox = world.hitbox
	var target = world.target
	print("target global=", target.global_transform)
	print("target shape global=", target.get_child(0).global_transform,
		" disabled=", target.get_child(0).disabled)
	print("target layer=", target.collision_layer, " mask=", target.collision_mask)
	print("hitbox parent=", hitbox.get_parent().get_path())
	print("hitbox layer=", hitbox.collision_layer, " mask=", hitbox.collision_mask,
		" monitoring=", hitbox.monitoring, " monitorable=", hitbox.monitorable)

	# 1. Fixture area with the pre-fix flag restored, parked on the target.
	hitbox.monitorable = false
	hitbox.global_position = TARGET_CENTER
	for _i in range(4):
		await physics_frame
	print("A fixture area, monitorable=false -> ", hitbox.get_overlapping_bodies())

	# 2. A freshly built area at the very same transform.
	var probe := Area3D.new()
	probe.collision_layer = 0
	probe.collision_mask = 3
	world.add_child(probe)
	var collision := CollisionShape3D.new()
	var box := BoxShape3D.new()
	box.size = Vector3(1.0, 1.0, 1.0)
	collision.shape = box
	probe.add_child(collision)
	probe.global_position = TARGET_CENTER
	for _i in range(4):
		await physics_frame
	print("B freshly built area, same spot  -> ", probe.get_overlapping_bodies())

	# 3. The fixture area again, with monitorable restored.
	hitbox.monitorable = true
	for _i in range(4):
		await physics_frame
	print("C fixture area, monitorable=true  -> ", hitbox.get_overlapping_bodies())

	# 4. Ground truth from the physics space itself.
	var query := PhysicsShapeQueryParameters3D.new()
	query.shape = box
	query.transform = Transform3D(Basis(), TARGET_CENTER)
	query.collision_mask = 3
	var hits: Array = world.get_world_3d().direct_space_state.intersect_shape(query, 8)
	print("D direct space-state query        -> ", hits.size(), " hit(s)")
	for hit in hits:
		print("   collider=", hit.get("collider"), " shape=", hit.get("shape"))

	world.queue_free()
	quit(0)
