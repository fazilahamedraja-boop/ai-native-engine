extends SceneTree

## Phase 11 Stage B character-audit acceptance suite.
##
## This suite loads the existing rigid humanoid and the existing skinned
## CesiumMan sample through the same runtime path used by the harness. It
## checks actual Skeleton3D state, parent relationships, animation playback,
## and pose changes; it does not synthesize a skeleton.

var passed := 0
var failed := 0
var cases: Array = []
var trace: Dictionary = {}


func _initialize() -> void:
	_run()


func _run() -> void:
	var world = load("res://main.tscn").instantiate()
	root.add_child(world)
	await _advance(world, 3)
	trace["initial"] = world.snapshot()

	_test_rigid_humanoid(world)
	await _test_skinned_skeleton(world)
	await _test_animation_advances(world)
	_test_spaces_and_hierarchy(world)

	var summary := {
		"fixture": "character-audit",
		"godot": String(Engine.get_version_info().get("string", "")),
		"cases": cases,
		"trace": trace,
	}
	print("CHARACTER_AUDIT_SUMMARY " + JSON.stringify(summary))
	print("RESULT passed=%d failed=%d" % [passed, failed])
	world.queue_free()
	quit(0 if failed == 0 else 1)


func _test_rigid_humanoid(world) -> void:
	var snap: Dictionary = world.snapshot()
	var mesh_count := int(snap["humanoid_mesh_count"])
	var ok: bool = (
		mesh_count == 22
		and world.humanoid_root != null
		and world.humanoid_skeleton == null
		and world.humanoid_animation == null
	)
	trace["rigid_humanoid"] = {
		"mesh_count": mesh_count,
		"root": snap["humanoid_root"],
		"skeleton": snap["humanoid_skeleton"],
		"animation": snap["humanoid_animation"],
	}
	_check("character-rigid-humanoid", ok, "meshes=%d root=%s skeleton=%s animation=%s" % [
		mesh_count,
		str(snap["humanoid_root"]),
		str(snap["humanoid_skeleton"]),
		str(snap["humanoid_animation"]),
	])


func _test_skinned_skeleton(world) -> void:
	var snap: Dictionary = world.snapshot()
	var skeleton: Skeleton3D = world.cesium_skeleton
	var animation: AnimationPlayer = world.cesium_animation
	var names: Array = snap["cesium_bones"]
	var parent_ok := true
	if skeleton != null:
		for index in range(skeleton.get_bone_count()):
			var parent := skeleton.get_bone_parent(index)
			if parent < -1 or parent >= skeleton.get_bone_count():
				parent_ok = false
			if index == 0 and parent != -1:
				parent_ok = false
	var ok: bool = (
		skeleton != null
		and int(snap["cesium_bone_count"]) == 19
		and names.size() == 19
		and "Skeleton_torso_joint_1" in names
		and "Skeleton_neck_joint_2" in names
		and animation != null
		and animation.get_animation_list().size() == 1
		and String(snap["cesium_animation_name"]) == "Animation"
		and bool(snap["cesium_animation_playing"])
		and parent_ok
	)
	trace["skinned_skeleton"] = {
		"path": snap["cesium_skeleton"],
		"bone_count": snap["cesium_bone_count"],
		"bone_names": names,
		"animation_path": snap["cesium_animation"],
		"animation_name": snap["cesium_animation_name"],
		"animation_playing": snap["cesium_animation_playing"],
		"parent_indices_valid": parent_ok,
	}
	_check("character-skinned-skeleton", ok, "bones=%d names=%s parent_indices_valid=%s animation=%s playing=%s" % [
		int(snap["cesium_bone_count"]),
		str(names.slice(0, 4)),
		str(parent_ok),
		str(snap["cesium_animation_name"]),
		str(snap["cesium_animation_playing"]),
	])


func _test_animation_advances(world) -> void:
	world.harness_reset()
	await _advance(world, 2)
	var before := _bone_pose_signature(world.cesium_skeleton)
	var before_position := float(world.snapshot()["cesium_animation_position"])
	await _advance(world, 24)
	var after := _bone_pose_signature(world.cesium_skeleton)
	var after_position := float(world.snapshot()["cesium_animation_position"])
	var changed := before != after
	var ok: bool = (
		before_position >= 0.0
		and after_position > before_position
		and changed
		and world.cesium_animation.is_playing()
	)
	trace["animation_advance"] = {
		"before_position": before_position,
		"after_position": after_position,
		"before_signature": before,
		"after_signature": after,
		"changed": changed,
	}
	_check("character-animation-advances", ok, "position=%.6f->%.6f changed=%s playing=%s" % [
		before_position,
		after_position,
		str(changed),
		str(world.cesium_animation.is_playing()),
	])


func _test_spaces_and_hierarchy(world) -> void:
	var skeleton: Skeleton3D = world.cesium_skeleton
	var ok := false
	var head_global: Transform3D
	var head_world: Transform3D
	var head_rest: Transform3D
	if skeleton != null and skeleton.get_bone_count() > 17:
		var head_index := 17
		head_rest = skeleton.get_bone_rest(head_index)
		head_global = skeleton.get_bone_global_pose(head_index)
		head_world = skeleton.global_transform * head_global
		var root_world := skeleton.global_transform.origin
		var world_origin := head_world.origin
		ok = (
			skeleton.get_bone_name(17) == "Skeleton_neck_joint_1"
			and absf(world_origin.y - root_world.y) > 0.1
			and head_global.origin != head_rest.origin
		)
		trace["spaces"] = {
			"rest_space": "bone_parent",
			"pose_space": "bone_parent",
			"global_pose_space": "skeleton",
			"derived_world_source": "skeleton.global_transform * get_bone_global_pose(index)",
			"skeleton_global_origin": _vec(root_world),
			"head_rest_origin": _vec(head_rest.origin),
			"head_global_origin": _vec(head_global.origin),
			"head_world_origin": _vec(world_origin),
		}
	_check("character-bone-spaces", ok, "head_rest=%s head_global=%s head_world=%s" % [
		str(_vec(head_rest.origin)),
		str(_vec(head_global.origin)),
		str(_vec(head_world.origin)),
	])


func _bone_pose_signature(skeleton: Skeleton3D) -> String:
	if skeleton == null:
		return ""
	var parts: Array[String] = []
	for index in range(skeleton.get_bone_count()):
		var pose := skeleton.get_bone_pose(index)
		parts.append("%d:%.6f,%.6f,%.6f,%.6f" % [
			index,
			pose.origin.x,
			pose.origin.y,
			pose.origin.z,
			pose.basis.get_rotation_quaternion().w,
		])
	return "|".join(parts).sha256_text()


func _advance(world, frames: int) -> void:
	for _index in range(frames):
		await physics_frame
	if frames > 0:
		await process_frame


func _vec(value: Vector3) -> Array:
	return [value.x, value.y, value.z]


func _check(name: String, condition: bool, detail: String) -> void:
	var ok: bool = bool(condition)
	if ok:
		passed += 1
		print("PASS %s %s" % [name, detail])
	else:
		failed += 1
		print("FAIL %s %s" % [name, detail])
	cases.append({"name": name, "ok": ok, "detail": detail})
