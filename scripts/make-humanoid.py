"""Build the first generated character and export it as GLB.

This is a static, unrigged humanoid assembled from boxes: feet, shins, thighs,
pelvis, belt, abdomen, chest, shoulders, neck, head, nose, ears, upper arms,
forearms and hands. It exists to exercise the real import path with a
character-shaped asset, not to be a character generator.

Blender is Z-up and glTF is Y-up, so `export_yup=True` maps Blender Z to glTF Y.
The character faces Blender -Y, which becomes glTF +Z, matching the engine's
forward convention. Feet sit on Blender z = 0 and therefore glTF y = 0.

Run from the repository root:

    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
        --background --factory-startup --python scripts/make-humanoid.py

Every part is a box on purpose: Blender's exporter can reorder other primitives
between runs, and this file is pinned by sha256 in the manifest.
"""

import hashlib
import os
from pathlib import Path

import bpy

OUT = (
    Path(__file__).resolve().parents[1]
    / "content"
    / "assets"
    / "character"
    / "humanoid-01.glb"
)


def clear_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for block in (bpy.data.meshes, bpy.data.materials):
        for item in list(block):
            if item.users == 0:
                block.remove(item)


clear_scene()


def cube(name, location, scale):
    bpy.ops.mesh.primitive_cube_add(size=1.0, location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.scale = scale
    return obj


def empty(name, location):
    bpy.ops.object.empty_add(type="PLAIN_AXES", location=location)
    obj = bpy.context.active_object
    obj.name = name
    obj.empty_display_size = 0.05
    return obj


root = empty("character_root", (0, 0, 0))

# Metres. X is left/right, Y is front/back (front is -Y), Z is up.
parts = [
    # Feet and legs.
    cube("foot_l", (-0.105, -0.045, 0.04), (0.13, 0.26, 0.08)),
    cube("foot_r", (0.105, -0.045, 0.04), (0.13, 0.26, 0.08)),
    cube("shin_l", (-0.10, 0, 0.31), (0.11, 0.12, 0.46)),
    cube("shin_r", (0.10, 0, 0.31), (0.11, 0.12, 0.46)),
    cube("thigh_l", (-0.10, 0, 0.67), (0.14, 0.15, 0.34)),
    cube("thigh_r", (0.10, 0, 0.67), (0.14, 0.15, 0.34)),
    # Pelvis and torso.
    cube("pelvis", (0, 0, 0.90), (0.32, 0.20, 0.16)),
    cube("belt", (0, 0, 1.00), (0.34, 0.21, 0.05)),
    cube("abdomen", (0, 0, 1.14), (0.32, 0.20, 0.24)),
    cube("chest", (0, 0, 1.38), (0.42, 0.24, 0.24)),
    cube("shoulders", (0, 0, 1.47), (0.50, 0.24, 0.10)),
    # Head and neck.
    cube("neck", (0, 0, 1.54), (0.10, 0.10, 0.08)),
    cube("head_geom", (0, -0.01, 1.70), (0.22, 0.24, 0.24)),
    cube("nose", (0, -0.14, 1.69), (0.05, 0.06, 0.06)),
    cube("ear_l", (-0.12, 0, 1.70), (0.03, 0.08, 0.10)),
    cube("ear_r", (0.12, 0, 1.70), (0.03, 0.08, 0.10)),
    # Arms.
    cube("upper_arm_l", (-0.28, 0, 1.31), (0.10, 0.11, 0.28)),
    cube("upper_arm_r", (0.28, 0, 1.31), (0.10, 0.11, 0.28)),
    cube("forearm_l", (-0.29, 0, 1.02), (0.09, 0.10, 0.26)),
    cube("forearm_r", (0.29, 0, 1.02), (0.09, 0.10, 0.26)),
    cube("hand_geom_l", (-0.295, -0.01, 0.81), (0.09, 0.11, 0.12)),
    cube("hand_geom_r", (0.295, -0.01, 0.81), (0.09, 0.11, 0.12)),
]

# Sockets are points, not geometry: head centre and both wrists.
sockets = [
    empty("head", (0, 0, 1.70)),
    empty("hand_l", (-0.295, 0, 0.88)),
    empty("hand_r", (0.295, 0, 0.88)),
]

for obj in parts + sockets:
    obj.parent = root

bpy.ops.object.select_all(action="DESELECT")
for obj in parts:
    obj.select_set(True)
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

material = bpy.data.materials.new("humanoid_clay")
if material.node_tree is None:
    material.use_nodes = True
bsdf = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = (0.36, 0.22, 0.15, 1.0)
bsdf.inputs["Roughness"].default_value = 0.62
# Closed boxes: keep the imported asset single-sided and exercise that path.
material.use_backface_culling = True
for obj in parts:
    obj.data.materials.append(material)

os.makedirs(OUT.parent, exist_ok=True)

desired = dict(
    filepath=str(OUT),
    export_format="GLB",
    use_selection=False,
    use_visible=True,
    export_yup=True,
    export_apply=True,
    export_cameras=False,
    export_lights=False,
    export_animations=False,
    export_skins=False,
    export_extras=False,
    export_materials="EXPORT",
)

# Blender renames exporter options between releases; keep the ones this build has.
valid = {
    prop.identifier for prop in bpy.ops.export_scene.gltf.get_rna_type().properties
}
kwargs = {key: value for key, value in desired.items() if key in valid}
dropped = sorted(set(desired) - set(kwargs))
print("EXPORT_DROPPED", dropped)
bpy.ops.export_scene.gltf(**kwargs)

size = OUT.stat().st_size
digest = hashlib.sha256(OUT.read_bytes()).hexdigest()
print("EXPORTED", OUT, size, digest)
