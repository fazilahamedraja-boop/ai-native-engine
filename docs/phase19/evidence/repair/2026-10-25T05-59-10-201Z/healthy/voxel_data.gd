class_name VoxelWorldData
extends RefCounted

## Pure data model for the 3D voxel sandbox.

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
	return x + width * (z + depth * y)


func is_inside(x: int, y: int, z: int) -> bool:
	return x >= 0 and x < width and y >= 0 and y < height and z >= 0 and z < depth


func get_block(x: int, y: int, z: int) -> int:
	if not is_inside(x, y, z):
		return AIR
	return int(blocks[index(x, y, z)])


func set_block(x: int, y: int, z: int, block_id: int) -> bool:
	if not is_inside(x, y, z):
		return false
	if block_id < AIR or block_id > LEAVES:
		return false
	blocks[index(x, y, z)] = block_id
	return true


func _terrain_height(x: int, z: int) -> int:
	var seed_phase := float((world_seed % 101) - 50) * 0.04
	var n := (
		sin(float(x) * 0.30 + seed_phase)
		+ cos(float(z) * 0.24 - seed_phase * 0.7)
		+ sin(float(x + z) * 0.13)
	)
	return clampi(5 + int(round(n * 1.65)), 2, 12)


func generate(seed_value: int) -> void:
	world_seed = seed_value
	blocks.fill(AIR)
	for z in range(depth):
		for x in range(width):
			var top := _terrain_height(x, z)
			for y in range(top + 1):
				var id := STONE
				if y == top:
					id = GRASS
				elif y >= top - 2:
					id = DIRT
				blocks[index(x, y, z)] = id
	_place_trees()
	base_blocks = blocks.duplicate()


func _place_trees() -> void:
	var rng := RandomNumberGenerator.new()
	rng.seed = world_seed + 991
	var placed: Array[Vector2i] = []
	var attempts := 0
	while placed.size() < 4 and attempts < 80:
		attempts += 1
		var x := rng.randi_range(3, width - 4)
		var z := rng.randi_range(3, depth - 4)
		var center_block := Vector2i(width / 2, depth / 2)
		if Vector2i(x, z).distance_to(center_block) < 6.0:
			continue
		var too_close := false
		for other in placed:
			if Vector2i(x, z).distance_to(other) < 5.0:
				too_close = true
				break
		if too_close:
			continue
		var base := highest_solid_y(x, z)
		if base < 1 or base + 5 >= height:
			continue
		for trunk_y in range(base + 1, base + 4):
			blocks[index(x, trunk_y, z)] = LOG
		for dy in range(2, 4):
			for dx in range(-1, 2):
				for dz in range(-1, 2):
					if absi(dx) + absi(dz) > 2:
						continue
					var lx := x + dx
					var ly := base + dy
					var lz := z + dz
					if is_inside(lx, ly, lz) and get_block(lx, ly, lz) == AIR:
						blocks[index(lx, ly, lz)] = LEAVES
		placed.append(Vector2i(x, z))


func highest_solid_y(x: int, z: int) -> int:
	if x < 0 or x >= width or z < 0 or z >= depth:
		return -1
	for y in range(height - 1, -1, -1):
		if get_block(x, y, z) != AIR:
			return y
	return -1


func spawn_point() -> Vector3:
	var center_x := width / 2
	var center_z := depth / 2
	for radius in range(0, 7):
		for x in range(center_x - radius, center_x + radius + 1):
			for z in range(center_z - radius, center_z + radius + 1):
				if not is_inside(x, 0, z):
					continue
				var top := highest_solid_y(x, z)
				if top < 0 or top + 3 >= height:
					continue
				if get_block(x, top + 1, z) != AIR or get_block(x, top + 2, z) != AIR:
					continue
				return Vector3(float(x) + 0.5, float(top + 1) + 0.02, float(z) + 0.5)
	return Vector3(0.5, 2.02, 0.5)


func counts() -> Dictionary:
	var result := {0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0}
	for raw in blocks:
		result[int(raw)] += 1
	var named := {}
	for id in BLOCK_NAMES:
		named[BLOCK_NAMES[id]] = result[id]
	return named


func changed_blocks() -> Array:
	var result: Array = []
	for y in range(height):
		for z in range(depth):
			for x in range(width):
				var i := index(x, y, z)
				if blocks[i] != base_blocks[i]:
					result.append({"x": x, "y": y, "z": z, "id": int(blocks[i])})
	return result


func to_save_dict() -> Dictionary:
	return {
		"version": SAVE_VERSION,
		"world": {
			"width": width,
			"height": height,
			"depth": depth,
			"seed": world_seed,
		},
		"changes": changed_blocks(),
	}


func apply_save(data: Dictionary) -> bool:
	if typeof(data) != TYPE_DICTIONARY:
		return false
	if int(data.get("version", -1)) != SAVE_VERSION:
		return false
	var world_doc = data.get("world", null)
	if typeof(world_doc) != TYPE_DICTIONARY:
		return false
	if int(world_doc.get("width", -1)) != width:
		return false
	if int(world_doc.get("height", -1)) != height:
		return false
	if int(world_doc.get("depth", -1)) != depth:
		return false
	if not world_doc.has("seed"):
		return false
	var seed_value := int(world_doc.get("seed", 0))
	var changes = data.get("changes", null)
	if typeof(changes) != TYPE_ARRAY:
		return false
	if changes.size() > width * height * depth:
		return false

	var baseline = get_script().new(width, height, depth)
	baseline.generate(seed_value)
	var candidate: PackedByteArray = baseline.blocks.duplicate()
	for entry in changes:
		if typeof(entry) != TYPE_DICTIONARY:
			return false
		if not entry.has("x") or not entry.has("y") or not entry.has("z") or not entry.has("id"):
			return false
		var x := int(entry["x"])
		var y := int(entry["y"])
		var z := int(entry["z"])
		var id := int(entry["id"])
		if not is_inside(x, y, z) or id < AIR or id > LEAVES:
			return false
		candidate[index(x, y, z)] = id

	world_seed = seed_value
	blocks = candidate
	base_blocks = baseline.blocks.duplicate()
	return true


func raycast(origin: Vector3, direction: Vector3, max_distance: float = 6.0) -> Dictionary:
	var miss := {
		"hit": false,
		"block": [],
		"previous": [],
		"normal": [],
		"distance": max_distance,
		"block_id": AIR,
	}
	if direction.length_squared() < 0.0000001 or max_distance <= 0.0:
		return miss
	var dir := direction.normalized()
	var cell := Vector3i(floori(origin.x), floori(origin.y), floori(origin.z))
	if is_inside(cell.x, cell.y, cell.z) and get_block(cell.x, cell.y, cell.z) != AIR:
		return {
			"hit": true,
			"block": [cell.x, cell.y, cell.z],
			"previous": [cell.x, cell.y, cell.z],
			"normal": [0, 1, 0],
			"distance": 0.0,
			"block_id": get_block(cell.x, cell.y, cell.z),
		}

	var step := Vector3i(int(signf(dir.x)), int(signf(dir.y)), int(signf(dir.z)))
	var t_delta := Vector3(INF, INF, INF)
	var t_max := Vector3(INF, INF, INF)
	if dir.x > 0.0:
		t_delta.x = 1.0 / dir.x
		t_max.x = (float(cell.x + 1) - origin.x) / dir.x
	elif dir.x < 0.0:
		t_delta.x = -1.0 / dir.x
		t_max.x = (float(cell.x) - origin.x) / dir.x
	if dir.y > 0.0:
		t_delta.y = 1.0 / dir.y
		t_max.y = (float(cell.y + 1) - origin.y) / dir.y
	elif dir.y < 0.0:
		t_delta.y = -1.0 / dir.y
		t_max.y = (float(cell.y) - origin.y) / dir.y
	if dir.z > 0.0:
		t_delta.z = 1.0 / dir.z
		t_max.z = (float(cell.z + 1) - origin.z) / dir.z
	elif dir.z < 0.0:
		t_delta.z = -1.0 / dir.z
		t_max.z = (float(cell.z) - origin.z) / dir.z

	var previous := cell
	var normal := Vector3i.ZERO
	var travelled := 0.0
	for _index in range(256):
		if travelled > max_distance:
			break
		if is_inside(cell.x, cell.y, cell.z):
			var id := get_block(cell.x, cell.y, cell.z)
			if id != AIR:
				return {
					"hit": true,
					"block": [cell.x, cell.y, cell.z],
					"previous": [previous.x, previous.y, previous.z],
					"normal": [normal.x, normal.y, normal.z],
					"distance": travelled,
					"block_id": id,
				}
		previous = cell
		if t_max.x <= t_max.y and t_max.x <= t_max.z:
			cell.x += step.x
			normal = Vector3i(-step.x, 0, 0)
			travelled = t_max.x
			t_max.x += t_delta.x
		elif t_max.y <= t_max.z:
			cell.y += step.y
			normal = Vector3i(0, -step.y, 0)
			travelled = t_max.y
			t_max.y += t_delta.y
		else:
			cell.z += step.z
			normal = Vector3i(0, 0, -step.z)
			travelled = t_max.z
			t_max.z += t_delta.z
	return miss


func hash() -> String:
	var payload := "%d:%d:%d:%d:%s" % [width, height, depth, world_seed, blocks.hex_encode()]
	return payload.sha256_text()
