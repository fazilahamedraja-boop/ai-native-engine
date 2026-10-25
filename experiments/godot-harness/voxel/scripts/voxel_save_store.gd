class_name VoxelSaveStore
extends RefCounted

## Small JSON save store. The path must live under user:// so the game never
## writes into the repository or the exported PCK. Validation of the document
## itself remains the world-data module's job.

const DEFAULT_PATH := "user://voxel_save.json"

var path := DEFAULT_PATH


func _init(save_path: String = DEFAULT_PATH) -> void:
	set_path(save_path)


func set_path(save_path: String) -> bool:
	if not save_path.begins_with("user://"):
		return false
	if save_path.contains(".."):
		return false
	path = save_path
	return true


func save(document: Dictionary) -> Dictionary:
	var directory := path.get_base_dir()
	var make_error := DirAccess.make_dir_recursive_absolute(directory)
	if make_error != OK:
		return {
			"ok": false,
			"code": "DIRECTORY_ERROR",
			"message": "Could not create %s (error %d)." % [directory, make_error],
			"path": path,
		}
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return {
			"ok": false,
			"code": "WRITE_ERROR",
			"message": "Could not open %s for writing." % path,
			"path": path,
		}
	file.store_string(JSON.stringify(document, "\t"))
	file.flush()
	var length := file.get_length()
	file.close()
	return {
		"ok": true,
		"code": "SAVED",
		"message": "Saved %d bytes." % length,
		"path": path,
		"absolute_path": ProjectSettings.globalize_path(path),
		"bytes": length,
		"sha256": FileAccess.get_sha256(path) if FileAccess.file_exists(path) else "",
	}


func load_document() -> Dictionary:
	if not FileAccess.file_exists(path):
		return {
			"ok": false,
			"code": "MISSING",
			"message": "No save file at %s." % path,
			"path": path,
			"data": {},
		}
	var text := FileAccess.get_file_as_string(path)
	if text.is_empty():
		return {
			"ok": false,
			"code": "EMPTY",
			"message": "Save file is empty.",
			"path": path,
			"data": {},
		}
	var parsed = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		return {
			"ok": false,
			"code": "INVALID_JSON",
			"message": "Save file is not a JSON object.",
			"path": path,
			"data": {},
		}
	return {
		"ok": true,
		"code": "LOADED",
		"message": "Read %d bytes." % text.length(),
		"path": path,
		"data": parsed,
	}


func exists() -> bool:
	return FileAccess.file_exists(path)


func delete_save() -> bool:
	if not FileAccess.file_exists(path):
		return true
	return DirAccess.remove_absolute(path) == OK


func write_raw(text: String) -> bool:
	var file := FileAccess.open(path, FileAccess.WRITE)
	if file == null:
		return false
	file.store_string(text)
	file.close()
	return true


func absolute_path() -> String:
	return ProjectSettings.globalize_path(path)
