extends Node3D

## Procedural animation for the placeholder humanoid.
##
## The GLB is a rigid hierarchy: arm/leg meshes have their origins at the
## shoulder/hip pivots and there is no skin or animation data. Rotating those
## nodes therefore animates the character without an AnimationPlayer, a
## skeleton, or any new asset pipeline. The sword is built from primitive
## meshes and parented to the right arm at the hand offset, because the
## exported `hand_r` node is a sibling of the arm rather than its child.

const GLB_PATH := "res://assets/placeholder-character.glb"

const WINDUP_ARM := -2.55
const SWING_ARM := -0.30
const PARRY_ARM := -1.50

var model: Node3D
var body: Node3D
var head: Node3D
var arm_l: Node3D
var arm_r: Node3D
var leg_l: Node3D
var leg_r: Node3D
var weapon: Node3D
var blade_material: StandardMaterial3D
var material: StandardMaterial3D

var _flash_ticks := 0
var _flash_color := Color.WHITE
var _telegraph := false
var _telegraph_color := Color("#ff4b34")


func build(tint: Color, accent: Color, sword_color: Color) -> void:
	var scene := load(GLB_PATH) as PackedScene
	model = scene.instantiate()
	model.name = "Model"
	add_child(model)

	body = _find("body")
	head = _find("head")
	arm_l = _find("arm_l")
	arm_r = _find("arm_r")
	leg_l = _find("leg_l")
	leg_r = _find("leg_r")

	material = StandardMaterial3D.new()
	material.albedo_color = tint
	material.roughness = 0.62
	material.metallic = 0.05
	_apply_material(model, material)

	var accent_material := StandardMaterial3D.new()
	accent_material.albedo_color = accent
	accent_material.roughness = 0.4
	accent_material.emission_enabled = true
	accent_material.emission = accent
	accent_material.emission_energy_multiplier = 0.25

	# A visor gives the box character a readable forward direction. The rig
	# faces -Z, matching the project's spawn orientation.
	var visor := MeshInstance3D.new()
	visor.name = "Visor"
	var visor_mesh := BoxMesh.new()
	visor_mesh.size = Vector3(0.17, 0.055, 0.05)
	visor.mesh = visor_mesh
	visor.position = Vector3(0.0, 0.01, -0.105)
	visor.material_override = accent_material
	if head != null:
		head.add_child(visor)

	_build_sword(sword_color, accent_material)


func _build_sword(sword_color: Color, grip_material: Material) -> void:
	weapon = Node3D.new()
	weapon.name = "Weapon"
	# The arm mesh runs from +0.275 (shoulder) to -0.275 (hand), so the hand
	# sits at local y=-0.275. Rotating the pivot -90 degrees about X turns the
	# blade's local +Y into the rig's forward (-Z).
	weapon.position = Vector3(0.0, -0.275, 0.0)
	weapon.rotation_degrees = Vector3(-90.0, 0.0, 0.0)
	arm_r.add_child(weapon)

	blade_material = StandardMaterial3D.new()
	blade_material.albedo_color = sword_color
	blade_material.metallic = 0.75
	blade_material.roughness = 0.28

	var blade := MeshInstance3D.new()
	blade.name = "Blade"
	var blade_mesh := BoxMesh.new()
	blade_mesh.size = Vector3(0.07, 1.00, 0.15)
	blade.mesh = blade_mesh
	blade.position = Vector3(0.0, 0.55, 0.0)
	blade.material_override = blade_material
	weapon.add_child(blade)

	var guard := MeshInstance3D.new()
	guard.name = "Guard"
	var guard_mesh := BoxMesh.new()
	guard_mesh.size = Vector3(0.30, 0.05, 0.17)
	guard.mesh = guard_mesh
	guard.position = Vector3(0.0, 0.03, 0.0)
	guard.material_override = grip_material
	weapon.add_child(guard)

	var grip := MeshInstance3D.new()
	grip.name = "Grip"
	var grip_mesh := BoxMesh.new()
	grip_mesh.size = Vector3(0.05, 0.20, 0.05)
	grip.mesh = grip_mesh
	grip.position = Vector3(0.0, -0.08, 0.0)
	grip.material_override = grip_material
	weapon.add_child(grip)


func _find(node_name: String) -> Node3D:
	var found := model.find_child(node_name, true, false)
	if found is Node3D:
		return found
	return null


func _apply_material(node: Node, target: Material) -> void:
	for child in node.get_children():
		if child is MeshInstance3D:
			(child as MeshInstance3D).material_override = target
		_apply_material(child, target)


func reset_pose() -> void:
	_flash_ticks = 0
	_telegraph = false
	model.position = Vector3.ZERO
	model.rotation = Vector3.ZERO
	for limb in [arm_l, arm_r, leg_l, leg_r]:
		if limb != null:
			limb.rotation = Vector3.ZERO
	_set_blade_emission(false)


func flash(color: Color, ticks: int = 6) -> void:
	_flash_color = color
	_flash_ticks = ticks


func set_telegraph(on: bool) -> void:
	_telegraph = on


func tick_visual() -> void:
	if _flash_ticks > 0:
		_flash_ticks -= 1
		material.emission_enabled = true
		material.emission = _flash_color
		material.emission_energy_multiplier = 0.9
	else:
		material.emission_enabled = false
	_set_blade_emission(_telegraph)


func _set_blade_emission(on: bool) -> void:
	if blade_material == null:
		return
	blade_material.emission_enabled = on
	blade_material.emission = _telegraph_color
	blade_material.emission_energy_multiplier = 1.4


## One animation update. The dictionary is intentionally small:
##   speed01          locomotion blend 0..1
##   time             seconds, for the walk cycle and idle breathing
##   mode             locomotion | attack | parry | dodge | stagger | defeated
##   attack_progress  0..1 across windup+active+recover
##   parry_progress   0..1 across the parry window
##   dodge_progress   0..1 across active+recovery
##   stagger_progress 0..1 across the stagger
func animate(state: Dictionary) -> void:
	if model == null or arm_r == null:
		return

	var speed01 := clampf(float(state.get("speed01", 0.0)), 0.0, 1.0)
	var time := float(state.get("time", 0.0))
	model.position = Vector3.ZERO
	model.rotation = Vector3.ZERO
	arm_l.rotation = Vector3.ZERO
	arm_r.rotation = Vector3.ZERO
	leg_l.rotation = Vector3.ZERO
	leg_r.rotation = Vector3.ZERO

	var cycle := time * 9.0
	var swing := sin(cycle) * 0.62 * speed01
	leg_l.rotation.x = swing
	leg_r.rotation.x = -swing
	arm_l.rotation.x = -swing * 0.65
	arm_r.rotation.x = swing * 0.30
	model.position.y = absf(sin(cycle)) * 0.035 * speed01
	if speed01 < 0.05:
		# Idle breathing is subtle but keeps the model from looking frozen.
		model.position.y = sin(time * 2.2) * 0.012
		arm_l.rotation.x = sin(time * 2.2) * 0.04
		arm_r.rotation.x = sin(time * 2.2) * 0.03

	match String(state.get("mode", "locomotion")):
		"attack":
			_pose_attack(float(state.get("attack_progress", 0.0)))
		"parry":
			_pose_parry(float(state.get("parry_progress", 0.0)))
		"dodge":
			_pose_dodge(float(state.get("dodge_progress", 0.0)))
		"stagger":
			_pose_stagger(float(state.get("stagger_progress", 0.0)))
		"defeated":
			model.rotation.x = 1.48
			model.position.y = 0.04
			arm_l.rotation.x = 0.9
			arm_r.rotation.x = 0.9


func _pose_attack(progress: float) -> void:
	var p := clampf(progress, 0.0, 1.0)
	if p < 0.22:
		var t := smoothstep(0.0, 0.22, p)
		arm_r.rotation.x = lerpf(0.0, WINDUP_ARM, t)
		arm_r.rotation.z = lerpf(0.0, -0.35, t)
	elif p < 0.52:
		var t := smoothstep(0.22, 0.52, p)
		arm_r.rotation.x = lerpf(WINDUP_ARM, SWING_ARM, t)
		arm_r.rotation.z = lerpf(-0.35, 0.18, t)
		model.rotation.x = -0.06 * sin(t * PI)
	else:
		var t := smoothstep(0.52, 1.0, p)
		arm_r.rotation.x = lerpf(SWING_ARM, 0.0, t)
		arm_r.rotation.z = lerpf(0.18, 0.0, t)


func _pose_parry(progress: float) -> void:
	# The blade snaps up and across the body, then settles.
	var t := clampf(progress * 6.0, 0.0, 1.0)
	arm_r.rotation.x = lerpf(0.0, PARRY_ARM, smoothstep(0.0, 1.0, t))
	arm_r.rotation.z = lerpf(0.0, 0.95, smoothstep(0.0, 1.0, t))
	model.rotation.x = -0.04 * t


## A low forward shoulder roll. The whole model tucks, spins a full turn about
## its X axis, and rises again, so it cannot be confused with the walk cycle,
## the sword swing, the parry guard, or the flat defeat pose. The spin is taken
## around the body centre (not the feet) so the character does not sink through
## the floor mid-roll.
func _pose_dodge(progress: float) -> void:
	var p := clampf(progress, 0.0, 1.0)
	var tuck := sin(p * PI)
	var angle := -TAU * p
	var pivot := Vector3(0.0, 0.85, 0.0)
	var spin := Basis(Vector3.RIGHT, angle)
	model.rotation.x = angle
	model.position = pivot - spin * pivot
	arm_l.rotation.x = 1.20 + 0.30 * tuck
	arm_r.rotation.x = 1.20 + 0.30 * tuck
	arm_l.rotation.z = -0.40 * tuck
	arm_r.rotation.z = 0.40 * tuck
	leg_l.rotation.x = -1.10
	leg_r.rotation.x = -1.10


func _pose_stagger(progress: float) -> void:
	var p := clampf(progress, 0.0, 1.0)
	model.rotation.x = 0.38 * sin(minf(p * 1.4, 1.0) * PI * 0.5)
	arm_l.rotation.x = 0.55
	arm_r.rotation.x = 0.65
	leg_l.rotation.x = -0.18
	leg_r.rotation.x = 0.18
