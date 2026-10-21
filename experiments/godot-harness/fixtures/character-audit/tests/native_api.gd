extends SceneTree

## Phase 11 Stage A API probe.
##
## ClassDB proves that an API name exists in this Godot build. It does not
## prove runtime behavior; the Stage A/B/C runtime paths provide that evidence.

const CLASSES := {
	"Node": ["get_path", "get_class", "get_property_list", "find_children", "get_children"],
	"Node3D": ["get_global_transform", "global_transform", "global_position"],
	"SceneTree": ["get_nodes_in_group", "get_first_node_in_group", "physics_frame", "process_frame"],
	"Skeleton3D": [
		"get_bone_count", "get_bone_name", "get_bone_parent", "get_bone_rest",
		"get_bone_pose", "get_bone_global_pose", "get_bone_pose_position",
		"get_bone_pose_rotation", "get_bone_pose_scale", "get_bone_global_pose_no_override",
		"set_bone_pose", "set_bone_global_pose", "reset_bone_pose", "reset_bone_poses",
	],
	"AnimationPlayer": [
		"get_current_animation", "is_playing", "get_animation_list", "seek",
		"play", "stop", "get_playing_speed", "get_current_animation_position",
	],
	"AnimationTree": ["get_tree_root", "set_tree_root", "get_process_callback"],
	"CharacterBody3D": ["get_slide_collision_count", "get_slide_collision", "is_on_floor", "is_on_wall"],
	"RigidBody3D": ["get_contact_count", "get_contact_local_position", "get_contact_collider"],
	"Area3D": ["get_overlapping_bodies", "get_overlapping_areas"],
	"PhysicsDirectSpaceState3D": ["intersect_shape", "intersect_ray", "intersect_point"],
	"Viewport": ["get_texture"],
	"Image": ["save_png", "get_width", "get_height", "is_empty"],
	"Input": ["parse_input_event", "is_action_pressed"],
	"MovieWriter": ["get_audio_mix_rate", "get_audio_speaker_mode", "get_movie_path"],
}

const PROPERTY_CLASSES := {
	"SceneTree": ["debug_collisions_hint", "debug_navigation_hint", "paused"],
	"AnimationPlayer": ["current_animation", "assigned_animation", "speed_scale"],
	"Skeleton3D": ["bones"],
}

const SIGNAL_CLASSES := {
	"Area3D": ["body_entered", "body_exited"],
	"RigidBody3D": ["body_entered", "body_exited"],
	"AnimationPlayer": ["animation_finished", "animation_changed"],
}


func _initialize() -> void:
	_run()


func _run() -> void:
	var report := {
		"godot": String(Engine.get_version_info().get("string", "")),
		"classes": {},
		"properties": {},
		"signals": {},
		"note": "ClassDB presence is an API inventory result, not proof of runtime behavior.",
	}
	for class_id in CLASSES:
		var methods: Array = []
		for method_name in CLASSES[class_id]:
			methods.append({
				"name": method_name,
				"exists": ClassDB.class_has_method(class_id, method_name),
			})
		report["classes"][class_id] = {
			"exists": ClassDB.class_exists(class_id),
			"methods": methods,
		}
	for class_id in PROPERTY_CLASSES:
		var properties: Array = []
		var property_list := ClassDB.class_get_property_list(class_id)
		var names: Array[String] = []
		for property in property_list:
			names.append(String(property.get("name", "")))
		for property_name in PROPERTY_CLASSES[class_id]:
			properties.append({
				"name": property_name,
				"exists": property_name in names,
			})
		report["properties"][class_id] = properties
	for class_id in SIGNAL_CLASSES:
		var signals: Array = []
		for signal_name in SIGNAL_CLASSES[class_id]:
			signals.append({
				"name": signal_name,
				"exists": ClassDB.class_has_signal(class_id, signal_name),
			})
		report["signals"][class_id] = signals
	print("NATIVE_API " + JSON.stringify(report))
	quit(0)

