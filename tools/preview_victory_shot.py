"""Render the victory cinematic in Blender, headless, purely to LOOK at it.

THE COMPANION TO verify_victory_shot.py, and the reason that file's numbers can
be trusted. The verifier proves the board is inside the frame and the avatar is
a given fraction of its height; it cannot tell you the heap looks like scattered
debris, or that every skull is facing the wrong way. Both of those were real,
and both were found here:

  * 54 skulls over a 2.2m radius covered 39% of the mound and read as litter.
    That is why VICTORY_PILE_RADIUS is 1.5.
  * The first outward-facing yaw assumed these models look down their own -Z.
    They look down +Z, so every skull was turned to face INTO the heap.

It rebuilds the shot from the same sources the game and the verifier use - the
board out of main.crdt, the pile out of verify_victory_shot.py's build_pile(),
the camera out of VICTORY_SHOT - so what it renders is what ships, modulo an
untextured avatar stand-in and clay materials.

TWO CONVERSIONS IN HERE ARE EASY TO GET WRONG and are written out where they
happen: the DCL-to-Blender axis map (see B), and the fact that DCL composes
eulers yaw-pitch-roll while Blender defaults to XYZ, which is why rotations
travel as quaternions rather than as three numbers.

Nothing here ships and nothing here is imported by the scene.

    blender --background --factory-startup --python tools/preview_victory_shot.py

Writes shot_t000/030/066/100.png and pile_detail.png next to the scene folder's
temp output (see OUT).
"""
import bpy, math, os, sys, importlib.util, mathutils

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(bpy.data.filepath or __file__)))
if not os.path.isdir(os.path.join(ROOT, 'src')):
    # --background --python leaves __file__ pointing at this script, which is
    # what we want; the fallback covers being run from the text editor.
    ROOT = os.path.dirname(os.path.dirname(os.path.abspath(sys.argv[-1])))
# Renders land in a scratch folder beside the project, never inside it - these
# are throwaway frames, not scene assets, and the deploy payload is watched
# closely enough (.dclignore) that stray PNGs are not worth the risk.
OUT = os.path.join(os.path.dirname(ROOT), '_victory_shot_preview')
os.makedirs(OUT, exist_ok=True)

# ── pull the real numbers out of the verifier, so this cannot drift ─────────
spec = importlib.util.spec_from_file_location('vv', os.path.join(ROOT, 'tools', 'verify_victory_shot.py'))
vv = importlib.util.module_from_spec(spec)
sys.argv = ['blockout']
try:
    spec.loader.exec_module(vv)
except SystemExit:
    pass

STAGE, STAND, SHOT = vv.STAGE, vv.STAND, vv.SHOT
CORNERS = vv.CORNERS
PILE = vv.build_pile()
MODELS = vv.MODELS
AVATAR_H = vv.AVATAR_HEIGHT


def B(p):
    """DCL world -> Blender world.

    DCL's quaternion and cross-product maths follow the glTF/right-handed
    convention, which is checkable rather than assumed: leadboard.glb is yawed
    -89.7 degrees and its face (local -Z) is confirmed IN WORLD to look down
    +X, and only the right-handed Y-rotation matrix sends -Z there. The board's
    sideways nudge agrees independently - negative BOARD_SHIFT_METRES moves it
    toward the pillar at z=1.0, which is the reader's right. So this is the
    plain glTF axis map, and NOT the (x, z, y) Unity one, which put the board
    on the wrong side of the frame in the first pass of these renders."""
    return (p[0], -p[2], p[1])


# ── clean slate ────────────────────────────────────────────────────────────
bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete()

# ground
bpy.ops.mesh.primitive_plane_add(size=120, location=(16, 8, 0))
bpy.context.object.name = 'ground'
gm = bpy.data.materials.new('gm'); gm.use_nodes = True
gm.node_tree.nodes['Principled BSDF'].inputs[0].default_value = (0.06, 0.07, 0.05, 1)
bpy.context.object.data.materials.append(gm)

# the leaderboard face, straight from its four world corners
mesh = bpy.data.meshes.new('board')
mesh.from_pydata([B(c) for c in (CORNERS[0], CORNERS[1], CORNERS[3], CORNERS[2])], [], [[0, 1, 2, 3]])
mesh.update()
board = bpy.data.objects.new('board', mesh)
bpy.context.collection.objects.link(board)
bm = bpy.data.materials.new('bm'); bm.use_nodes = True
n = bm.node_tree.nodes['Principled BSDF']
n.inputs[0].default_value = (0.10, 0.08, 0.06, 1)
n.inputs['Emission Color'].default_value = (0.85, 0.55, 0.15, 1)
n.inputs['Emission Strength'].default_value = 0.55
mesh.materials.append(bm)

# the skulls
# NORMALISED ON IMPORT. A glTF's mesh data is in whatever units the authoring
# tool used and the node graph carries the correction, so taking the MESH object
# alone and overwriting its scale throws that away - the first run of this put
# forty-metre skulls in the yard. So: bake every transform down into the mesh,
# measure what is left, and rescale to the height glbkit measured off the file.
cache = {}
for src in set(MODELS):
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=os.path.join(ROOT, src.replace('/', os.sep)))
    imported = [o for o in set(bpy.data.objects) - before]
    bpy.ops.object.select_all(action='DESELECT')
    # DROP THE _collider MESHES. Every one of these asset-pack GLBs ships a
    # box-shaped collision hull next to the art, and DCL never draws it (the
    # scene also strips it outright - see the CL_NONE masks on the pile's
    # GltfContainers). Rendering it here put a heap of white cubes in the shot
    # and made the skulls look like packing crates.
    meshes = [o for o in imported if o.type == 'MESH' and '_collider' not in o.name]
    for o in imported:
        if o.type == 'MESH' and '_collider' in o.name:
            bpy.data.objects.remove(o, do_unlink=True)
    for o in meshes:
        o.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    lo = [1e9] * 3
    hi = [-1e9] * 3
    for o in meshes:
        for v in o.bound_box:
            for i in range(3):
                lo[i] = min(lo[i], v[i]); hi[i] = max(hi[i], v[i])
    name = src.split('/')[-1]
    unit = vv.SKULL_H[name] / max(1e-6, hi[2] - lo[2])
    for o in meshes:
        o.hide_render = True
    cache[name] = (meshes, unit, lo[2])
    print('%-22s raw %.3f x %.3f x %.3f  -> unit scale %.4f' % (
        name, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], unit))

for s in PILE:
    protos, unit, base = cache[s['model']]
    # The euler the SCENE will use, carried out of build_pile(). Blender is
    # Z-up, so the DCL pitch/yaw/roll about (X, Y, Z) becomes (X, Z, Y) here.
    # THE REAL QUATERNION, not three euler numbers re-composed in Blender's
    # order. DCL builds rotations yaw-pitch-roll (see dcl_quat in the verifier)
    # and Blender defaults to XYZ; handing the eulers over directly produced a
    # heap of skulls all looking at the floor, which is not what ships.
    # Axis map: DCL x -> x, DCL y -> z, DCL z -> -y.
    qx, qy, qz, qw = s['quat']
    for proto in protos:
        o = proto.copy()
        o.data = proto.data
        o.hide_render = False
        bpy.context.collection.objects.link(o)
        o.location = B((s['x'], s['y'] - base * unit * s['scale'], s['z']))
        o.rotation_mode = 'QUATERNION'
        o.rotation_quaternion = (qw, qx, -qz, qy)
        o.scale = (unit * s['scale'],) * 3

# the hero: a 1.85m body + head, feet on VICTORY_STAND_HEIGHT
hm = bpy.data.materials.new('hm'); hm.use_nodes = True
hn = hm.node_tree.nodes['Principled BSDF']
hn.inputs[0].default_value = (0.55, 0.16, 0.16, 1)
bpy.ops.mesh.primitive_cylinder_add(radius=0.24, depth=AVATAR_H * 0.72,
                                    location=B((STAGE[0], STAND + AVATAR_H * 0.36, STAGE[2])))
bpy.context.object.data.materials.append(hm)
bpy.ops.mesh.primitive_uv_sphere_add(radius=0.16,
                                     location=B((STAGE[0], STAND + AVATAR_H * 0.86, STAGE[2])))
bpy.context.object.data.materials.append(hm)
# arms up, because the emote is the point
for side in (-1, 1):
    bpy.ops.mesh.primitive_cylinder_add(radius=0.07, depth=0.8,
                                        location=B((STAGE[0] + 0.02, STAND + AVATAR_H * 0.72, STAGE[2] + side * 0.34)))
    bpy.context.object.rotation_euler = (math.radians(side * 32), 0, 0)
    bpy.context.object.data.materials.append(hm)

# lights: a low key light out where the camera is, plus a cold fill
bpy.ops.object.light_add(type='AREA', location=B((17.0, 6.0, 4.0)))
L = bpy.context.object.data
L.energy = 9000
L.size = 8
L.color = (1.0, 0.78, 0.45)
bpy.ops.object.light_add(type='SUN', rotation=(math.radians(58), 0, math.radians(200)))
bpy.context.object.data.energy = 0.6
bpy.context.object.data.color = (0.45, 0.55, 0.9)
w = bpy.data.worlds['World'].node_tree.nodes['Background']
w.inputs[0].default_value = (0.02, 0.025, 0.05, 1)

# ── render every keyframe ──────────────────────────────────────────────────
sc = bpy.context.scene
sc.render.engine = 'BLENDER_EEVEE_NEXT' if 'BLENDER_EEVEE_NEXT' in [
    i.identifier for i in bpy.types.RenderSettings.bl_rna.properties['engine'].enum_items] else 'BLENDER_EEVEE'
sc.render.resolution_x, sc.render.resolution_y = 1280, 720
sc.render.film_transparent = False
sc.eevee.taa_render_samples = 24

camdata = bpy.data.cameras.new('shot')
camdata.sensor_fit = 'VERTICAL'
cam = bpy.data.objects.new('shot', camdata)
bpy.context.collection.objects.link(cam)
sc.camera = cam

for k in SHOT:
    phi = math.radians(k['phi'])
    p = (STAGE[0] + math.cos(phi) * k['dist'], k['camY'], STAGE[2] + math.sin(phi) * k['dist'])
    aim = (STAGE[0], k['aimY'], STAGE[2])
    cam.location = B(p)
    d = mathutils.Vector(B(aim)) - mathutils.Vector(B(p))
    cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
    camdata.angle_y = math.radians(k['fov'])
    sc.render.filepath = os.path.join(OUT, 'shot_t%03d.png' % int(k['t'] * 100))
    bpy.ops.render.render(write_still=True)
    print('rendered', sc.render.filepath)

# ── one detail pass, close in on the heap itself ───────────────────────────
# The wide keyframes cannot settle whether the skulls read AS SKULLS, which is
# what VICTORY_SKULL_FACE_JITTER exists to control. This shot can.
cam.location = B((STAGE[0] + 3.0, 1.35, STAGE[2] - 0.6))
d = mathutils.Vector(B((STAGE[0], 1.05, STAGE[2]))) - mathutils.Vector(cam.location)
cam.rotation_euler = d.to_track_quat('-Z', 'Y').to_euler()
camdata.angle_y = math.radians(40)
sc.render.filepath = os.path.join(OUT, 'pile_detail.png')
bpy.ops.render.render(write_still=True)
print('rendered', sc.render.filepath)
