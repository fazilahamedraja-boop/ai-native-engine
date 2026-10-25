class_name VoxelWorldData
extends RefCounted

## Pure block storage, deterministic generation, voxel raycasting, and the
## save-document representation. This module deliberately has no scene, input,
## or rendering dependency so it can be tested in a headless process.
##
## The external implementation agent receives this interface and the behavior
## in its task file, but not the acceptance tests.

const WIDTH := 32
const HEIGHT := 16
const DEPTH := 32
const MAX_DIMENSION := 64
const AIR := 0
const GRASS := 1
const DIRT := 2
const STONE := 3
const LOG := 4
const LEAVES := 5
const SAVE_VERSION := 1
const BLOCK_NAMES := {
	0: "air",
	1: "grass",
	2: "dirt",
	3: "stone",
	4: "log",
	5: "leaves",
}

var width: int = WIDTH
var height: int = HEIGHT
var depth: int = DEPTH
var world_seed: int = 0
var blocks := PackedByteArray()
var base_blocks := PackedByteArray()


func _init(size_x: int = WIDTH, size_y: int = HEIGHT, size_z: int = DEPTH) -> void:
	width = clampi(size_x, 1, MAX_DIMENSION)
	height = clampi(size_y, 1, MAX_DIMENSION)
	depth = clampi(size_z, 1, MAX_DIMENSION)
	blocks.resize(width * height * depth)
	base_blocks.resize(width * height * depth)


func index(x: int, y: int, z: int) -> int:
	return 0


func is_inside(x: int, y: int, z: int) -> bool:
	return false


func get_block(x: int, y: int, z: int) -> int:
	return AIR


func set_block(x: int, y: int, z: int, block_id: int) -> bool:
	return false


## Replace the generated terrain. Must be deterministic for a given seed and
## must include grass, dirt, stone, at least one log column, and height
## variation across the 32 x 32 surface.
func generate(seed_value: int) -> void:
	world_seed = seed_value


func highest_solid_y(x: int, z: int) -> int:
	return -1


## Feet position in world space. The block below must be solid and the player
## capsule must have two empty cells above it.
func spawn_point() -> Vector3:
	return Vector3.ZERO


func counts() -> Dictionary:
	return {}


## Changes relative to the generated baseline, in deterministic y/z/x order.
## Removed baseline blocks appear with id 0.
func changed_blocks() -> Array:
	return []


func to_save_dict() -> Dictionary:
	return {}


## Validate and apply a save document atomically. Invalid input returns false
## and leaves the current world untouched.
func apply_save(data: Dictionary) -> bool:
	return false


## Amanatides-Woo style grid traversal. Returns:
##   hit: bool
##   block: [x, y, z] (empty when no hit)
##   previous: [x, y, z] (empty when no hit)
##   normal: [x, y, z] (axis from previous to block)
##   distance: float
##   block_id: int
func raycast(origin: Vector3, direction: Vector3, max_distance: float = 6.0) -> Dictionary:
	return {
		"hit": false,
		"block": [],
		"previous": [],
		"normal": [],
		"distance": max_distance,
		"block_id": AIR,
	}


func hash() -> String:
	return ""
