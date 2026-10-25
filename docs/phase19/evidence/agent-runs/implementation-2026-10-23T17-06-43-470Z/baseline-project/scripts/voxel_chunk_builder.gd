class_name VoxelChunkBuilder
extends RefCounted

## Builds one chunk mesh and its matching triangle mesh from the pure world
## data. A visible face is emitted only when its neighbor is air or outside the
## world, so the cost scales with exposed surfaces rather than block count.

const FACE_DIRECTIONS := [
	Vector3i(1, 0, 0),
	Vector3i(-1, 0, 0),
	Vector3i(0, 1, 0),
	Vector3i(0, -1, 0),
	Vector3i(0, 0, 1),
	Vector3i(0, 0, -1),
]

const FACE_CORNERS := [
	[Vector3(1, 0, 0), Vector3(1, 1, 0), Vector3(1, 1, 1), Vector3(1, 0, 1)],
	[Vector3(0, 0, 1), Vector3(0, 1, 1), Vector3(0, 1, 0), Vector3(0, 0, 0)],
	[Vector3(0, 1, 0), Vector3(0, 1, 1), Vector3(1, 1, 1), Vector3(1, 1, 0)],
	[Vector3(0, 0, 0), Vector3(1, 0, 0), Vector3(1, 0, 1), Vector3(0, 0, 1)],
	[Vector3(0, 0, 1), Vector3(1, 0, 1), Vector3(1, 1, 1), Vector3(0, 1, 1)],
	[Vector3(1, 0, 0), Vector3(0, 0, 0), Vector3(0, 1, 0), Vector3(1, 1, 0)],
]

const FACE_NORMALS := [
	Vector3(1, 0, 0),
	Vector3(-1, 0, 0),
	Vector3(0, 1, 0),
	Vector3(0, -1, 0),
	Vector3(0, 0, 1),
	Vector3(0, 0, -1),
]


static func block_color(block_id: int, face_index: int, x: int, y: int, z: int) -> Color:
	var color := Color(0.7, 0.7, 0.7)
	match block_id:
		VoxelWorldData.GRASS:
			if face_index == 2:
				color = Color(0.32, 0.67, 0.29)
			elif face_index == 3:
				color = Color(0.42, 0.29, 0.18)
			else:
				# Grass sides show a green lip above a dirt band.
				color = Color(0.50, 0.38, 0.23) if y > 0 else Color(0.48, 0.34, 0.20)
		VoxelWorldData.DIRT:
			color = Color(0.48, 0.33, 0.20)
		VoxelWorldData.STONE:
			color = Color(0.52, 0.54, 0.57)
		VoxelWorldData.LOG:
			if face_index == 2:
				color = Color(0.62, 0.46, 0.25)
			elif face_index == 3:
				color = Color(0.37, 0.24, 0.11)
			else:
				color = Color(0.43, 0.28, 0.13)
		VoxelWorldData.LEAVES:
			color = Color(0.20, 0.47, 0.20)
		_:
			color = Color(0.70, 0.70, 0.70)

	var shade := 1.0
	if face_index == 3:
		shade = 0.60
	elif face_index == 1 or face_index == 5:
		shade = 0.78
	elif face_index == 0 or face_index == 4:
		shade = 0.88
	var jitter := float((x * 17 + y * 31 + z * 13) % 9) / 100.0 - 0.04
	return Color(
		clampf(color.r * shade + jitter, 0.0, 1.0),
		clampf(color.g * shade + jitter, 0.0, 1.0),
		clampf(color.b * shade + jitter, 0.0, 1.0),
		1.0
	)


static func build(data: VoxelWorldData, origin_x: int, origin_z: int, size_x: int, size_z: int) -> Dictionary:
	var surface := SurfaceTool.new()
	surface.begin(Mesh.PRIMITIVE_TRIANGLES)
	var collision_faces := PackedVector3Array()
	var visible_faces := 0

	var max_x: int = mini(origin_x + size_x, data.width)
	var max_z: int = mini(origin_z + size_z, data.depth)
	for y in range(data.height):
		for z in range(origin_z, max_z):
			for x in range(origin_x, max_x):
				var block_id := data.get_block(x, y, z)
				if block_id == VoxelWorldData.AIR:
					continue
				for face_index in range(6):
					var direction: Vector3i = FACE_DIRECTIONS[face_index]
					var neighbor: int = data.get_block(x + direction.x, y + direction.y, z + direction.z)
					if neighbor != VoxelWorldData.AIR:
						continue
					var normal: Vector3 = FACE_NORMALS[face_index]
					var color := block_color(block_id, face_index, x, y, z)
					var corners: Array = FACE_CORNERS[face_index]
					var base := Vector3(float(x), float(y), float(z))
					var v0: Vector3 = base + corners[0]
					var v1: Vector3 = base + corners[1]
					var v2: Vector3 = base + corners[2]
					var v3: Vector3 = base + corners[3]

					for vertex in [v0, v1, v2, v0, v2, v3]:
						surface.set_normal(normal)
						surface.set_color(color)
						surface.add_vertex(vertex)
					collision_faces.append_array(PackedVector3Array([v0, v1, v2, v0, v2, v3]))
					visible_faces += 1

	var mesh: ArrayMesh = surface.commit()
	return {
		"mesh": mesh,
		"collision_faces": collision_faces,
		"visible_faces": visible_faces,
		"vertex_count": visible_faces * 6,
	}
