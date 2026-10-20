"""Build the placeholder character fixture and export it as GLB.

This is a fixture for the import pipeline, not a shipped asset and not a
character generator: six boxes, no armature, no animation, feet on z = 0, and
empty nodes named `head`, `hand_l` and `hand_r` for the sockets the character
kind requires.

Run from the repository root:

    "C:/Program Files/Blender Foundation/Blender 5.2/blender.exe" \
        --background --factory-startup --python scripts/make-character.py

The head is a box rather than a UV sphere on purpose: Blender's exporter reorders
the sphere's index buffer between runs, so the fixture would not be byte-stable.
With six boxes, three consecutive exports produced the same sha256.
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
    / "placeholder-character.glb"
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

# Metres: feet on z = 0, roughly 1.63 m tall, centred in x and y.
parts = [
    cube("body", (0, 0, 1.125), (0.36, 0.20, 0.55)),
    cube("head", (0, 0, 1.515), (0.23, 0.23, 0.23)),
    cube("arm_l", (-0.215, 0, 1.12), (0.07, 0.07, 0.55)),
    cube("arm_r", (0.215, 0, 1.12), (0.07, 0.07, 0.55)),
    cube("leg_l", (-0.09, 0, 0.425), (0.08, 0.10, 0.85)),
    cube("leg_r", (0.09, 0, 0.425), (0.08, 0.10, 0.85)),
]

# Sockets are points, not geometry: empties at the wrist and head centre.
hands = [
    empty("hand_l", (-0.215, 0, 0.845)),
    empty("hand_r", (0.215, 0, 0.845)),
]

for obj in parts + hands:
    obj.parent = root

bpy.ops.object.select_all(action="SELECT")
bpy.context.view_layer.objects.active = parts[0]
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)

material = bpy.data.materials.new("placeholder_grey")
if material.node_tree is None:
    material.use_nodes = True
bsdf = next(node for node in material.node_tree.nodes if node.type == "BSDF_PRINCIPLED")
bsdf.inputs["Base Color"].default_value = (0.55, 0.57, 0.60, 1.0)
bsdf.inputs["Roughness"].default_value = 0.7
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
