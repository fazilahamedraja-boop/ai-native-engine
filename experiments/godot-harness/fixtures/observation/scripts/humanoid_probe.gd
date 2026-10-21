extends Node3D

## One existing rigid-part humanoid asset plus a small bone-inspection probe.
##
## The GLB is loaded at runtime through GLTFDocument so the fixture does not
## depend on generated .godot import state. It has 22 named mesh parts but no
## skin or bone hierarchy. ProbeSkeleton is a separate four-bone interface
## probe, not a generated character skeleton.

const MODEL_PATH := "res://assets/humanoid-01.glb"

var model: Node3D
var skeleton: Skeleton3D
var part_names: Array[String] = []
var mesh_count := 0


func _ready() -> void:
	_build_model()
	_build_probe_skeleton()
	_build_label()


func _build_model() -> void:
	var document := GLTFDocument.new()
	var state := GLTFState.new()
	var error := document.append_from_file(MODEL_PATH, state)
	if error != OK:
		push_error("Could not load humanoid probe model: %s" % error_string(error))
		return
	var scene := document.generate_scene(state)
	if scene == null:
		push_error("GLTFDocument produced no scene for %s" % MODEL_PATH)
		return
	model = scene as Node3D
	if model == null:
		push_error("Humanoid probe root is not a Node3D.")
		return
	model.name = "Model"
	add_child(model)
	_collect_parts(model)


func _collect_parts(node: Node) -> void:
	for child in node.get_children():
		if child is MeshInstance3D:
			mesh_count += 1
			part_names.append(String(child.name))
		_collect_parts(child)


func _build_probe_skeleton() -> void:
	skeleton = Skeleton3D.new()
	skeleton.name = "ProbeSkeleton"
	skeleton.position = Vector3(-6.4, 0.0, 0.0)
	add_child(skeleton)

	var bones := [
		{"name": "root", "parent": -1, "position": Vector3(0.0, 0.0, 0.0)},
		{"name": "spine", "parent": 0, "position": Vector3(0.0, 0.45, 0.0)},
		{"name": "chest", "parent": 1, "position": Vector3(0.0, 0.35, 0.0)},
		{"name": "head", "parent": 2, "position": Vector3(0.0, 0.30, 0.0)},
	]
	for index in range(bones.size()):
		var bone: Dictionary = bones[index]
		var bone_position: Vector3 = bone["position"]
		skeleton.add_bone(String(bone["name"]))
		if int(bone["parent"]) >= 0:
			skeleton.set_bone_parent(index, int(bone["parent"]))
		var rest := Transform3D(Basis.IDENTITY, bone_position)
		skeleton.set_bone_rest(index, rest)
		skeleton.set_bone_pose_position(index, bone_position)
		skeleton.set_bone_pose_rotation(index, Quaternion.IDENTITY)
		skeleton.set_bone_pose_scale(index, Vector3.ONE)

	var attachment := BoneAttachment3D.new()
	attachment.name = "HeadMarker"
	attachment.bone_name = "head"
	skeleton.add_child(attachment)

	var marker := MeshInstance3D.new()
	marker.name = "Marker"
	var sphere := SphereMesh.new()
	sphere.radius = 0.12
	sphere.height = 0.24
	marker.mesh = sphere
	var material := StandardMaterial3D.new()
	material.albedo_color = Color("#9cff8f")
	material.emission_enabled = true
	material.emission = Color("#4eff6a")
	material.emission_energy_multiplier = 1.2
	marker.material_override = material
	attachment.add_child(marker)


func _build_label() -> void:
	var label := Label3D.new()
	label.name = "ProbeLabel"
	label.text = "HUMANOID + PROBE"
	label.font_size = 48
	label.modulate = Color("#d9ecff")
	label.position = Vector3(0.0, 2.15, 0.0)
	label.billboard = BaseMaterial3D.BILLBOARD_ENABLED
	label.no_depth_test = true
	add_child(label)


func harness_part_names() -> Array:
	return part_names.duplicate()


func harness_mesh_count() -> int:
	return mesh_count


func harness_bone_names() -> Array:
	var names: Array = []
	if skeleton == null:
		return names
	for index in range(skeleton.get_bone_count()):
		names.append(String(skeleton.get_bone_name(index)))
	return names
