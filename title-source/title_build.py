"""
KILLER HOUSE — bakes the intro screen's dripping-blood title to a PNG.

    blender --background --python title-source/title_build.py -- --out assets/scene/Textures/title_killer_house.png

WHY BAKE IT. Decentraland's react-ecs UI can only draw text in three fonts —
'serif', 'sans-serif' and 'monospace' (see FONT_DISPLAY/BODY/DATA in
src/uiTheme.ts). There is no custom-font path and no way to author a shader at
runtime, so a horror title with blood running off it has to arrive as an image.
Same pipeline as the lightning flipbook: render it offline in Blender, ship the
PNG, point a uiBackground at it.

The letterforms are Chiller (a stock Windows face, C:/Windows/Fonts/CHILLER.TTF)
— already jagged and clotted, which is most of the look. The drips are the part
that has to be generated, because they must hang from the actual glyph outlines:
a drip that starts in mid-air, or half off the edge of a stroke, instantly reads
as a sticker laid over the text rather than as blood running off it.

HOW THE DRIPS FIND THE LETTERS. The text is converted to a mesh and the bottom
edge of the filled outline is sampled directly (bottom_at() walks every triangle
and asks "how low does the ink go at this x"). Anchors are the lowest point in
each of DRIP_SLOTS columns, rejected unless the ink is ALSO present a drip-width
either side — that width test is what keeps a drip from hanging off the corner
of a serif.

Each drip is a tapered quad strip plus a bulb at the tip, built as ONE convex
run per segment. That is the same lesson the lightning bolt cost four bakes to
learn: offsetting a centreline collapses at sharp turns and the triangulation
fills the self-intersection into a blob. Per-segment convex quads cannot
self-intersect by construction.

Colour is a vertical ramp mapped over the TEXT's bbox only, so anything below
the letters — i.e. every drip — clamps to the darkest stop. Blood going darker
as it runs is free realism and it also stops the drips competing with the word.
"""

import argparse
import math
import os
import random
import sys

import bpy

# ── Tunables ───────────────────────────────────────────────────────────────

TEXT = "KILLER HOUSE"
FONT_PATH = r"C:\Windows\Fonts\CHILLER.TTF"

DRIP_SLOTS = 22        # columns the width is divided into; at most one drip each
DRIP_SKIP_CHANCE = 0.07  # fraction of slots left dry, so the run isn't a fringe
DRIP_TOP_HALF = 0.020  # half-width where a drip leaves the letter (text size = 1.0)
DRIP_MIN_LEN = 0.045
DRIP_MAX_LEN = 0.290
DRIP_SEGMENTS = 9
DRIP_WOBBLE = 0.012    # lateral drift over the length of a run
BULB_SIDES = 14
DROPLET_CHANCE = 0.34  # a detached drop below the longest runs
SEED = 20260815

# sRGB stops, bottom of the letters -> top. Drips sit below the mapped range and
# clamp to the first stop.
RAMP = [
    (0.00, "#5C0806"),
    (0.42, "#8E100B"),
    (0.76, "#C61F18"),
    (1.00, "#E63A2E"),
]

RES_X = 1024
# Fraction of the framed WIDTH kept clear on every side. Small on purpose: the
# title is roughly 4:1, so a pad quoted against the width costs four times as
# much vertically, and at 0.06 the PNG carried a quarter of its own height in
# transparent space top and bottom. That padding is invisible in isolation and
# very visible in the layout — it pushed the intro copy a long way down the
# screen and read as a gap nobody put there. Spacing belongs to the HUD (see
# `band` in killerHouseTitle), not baked into the artwork.
MARGIN = 0.018
SAMPLES = 96


# ── Colour ─────────────────────────────────────────────────────────────────

def s2l(c: float) -> float:
    """sRGB channel -> linear. Blender's Python API takes linear values."""
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def hexcol(h: str):
    h = h.lstrip("#")
    return tuple(s2l(int(h[i:i + 2], 16) / 255.0) for i in (0, 2, 4)) + (1.0,)


# ── Scene setup ────────────────────────────────────────────────────────────

def wipe_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def make_text():
    if not os.path.exists(FONT_PATH):
        sys.exit(f"font not found: {FONT_PATH}")
    font = bpy.data.fonts.load(FONT_PATH)
    curve = bpy.data.curves.new(name="title", type="FONT")
    curve.body = TEXT
    curve.font = font
    curve.align_x = "CENTER"
    curve.align_y = "CENTER"
    curve.size = 1.0
    obj = bpy.data.objects.new("Title", curve)
    bpy.context.collection.objects.link(obj)

    bpy.context.view_layer.objects.active = obj
    obj.select_set(True)
    bpy.ops.object.convert(target="MESH")
    return bpy.context.view_layer.objects.active


# ── Reading the glyph outlines ─────────────────────────────────────────────

def flatten_tris(obj):
    """Every polygon fan-triangulated into plain float tuples.

    Plain tuples rather than mathutils vectors on purpose: bottom_at() runs this
    list once per sample and the attribute lookups dominate at that volume.
    """
    mw = obj.matrix_world
    mesh = obj.data
    verts = [mw @ v.co for v in mesh.vertices]
    tris = []
    for poly in mesh.polygons:
        idx = list(poly.vertices)
        for k in range(1, len(idx) - 1):
            a, b, c = verts[idx[0]], verts[idx[k]], verts[idx[k + 1]]
            xs = (a.x, b.x, c.x)
            tris.append((a.x, a.y, b.x, b.y, c.x, c.y, min(xs), max(xs)))
    return tris


def bottom_at(tris, x):
    """Lowest y of the filled outline at this x, or None if there's no ink here."""
    best = None
    for ax, ay, bx, by, cx, cy, lo, hi in tris:
        if x < lo or x > hi:
            continue
        for px, py, qx, qy in ((ax, ay, bx, by), (bx, by, cx, cy), (cx, cy, ax, ay)):
            if (px <= x <= qx) or (qx <= x <= px):
                if abs(qx - px) < 1e-9:
                    y = min(py, qy)
                else:
                    y = py + (x - px) / (qx - px) * (qy - py)
                if best is None or y < best:
                    best = y
    return best


# ── Drip geometry ──────────────────────────────────────────────────────────

def add_run(verts, faces, x0, y0, length, top_half, wobble, rng):
    """One tapered run of blood, built as one convex quad per segment.

    Never offsets a centreline — see the module docstring. Each segment is its
    own quad between two cross-sections, so no amount of wobble can make the
    outline cross itself.
    """
    prev = None
    for i in range(DRIP_SEGMENTS + 1):
        t = i / DRIP_SEGMENTS
        # ease-out taper: holds its width near the letter, thins as it falls
        half = top_half * (1.0 - 0.62 * (t ** 0.7))
        x = x0 + wobble * (t ** 1.6)
        y = y0 - length * t
        li = len(verts)
        verts.append((x - half, y, 0.0))
        verts.append((x + half, y, 0.0))
        if prev is not None:
            faces.append((prev, prev + 1, li + 1, li))
        prev = li
    return x0 + wobble, y0 - length, top_half * 0.38


def add_bulb(verts, faces, cx, cy, r):
    """The hanging drop at the end of a run — a fan, so it stays convex."""
    center = len(verts)
    verts.append((cx, cy, 0.0))
    ring = []
    for i in range(BULB_SIDES):
        a = (i / BULB_SIDES) * math.tau
        # taller than wide: a drop pulled down by its own weight
        ring.append(len(verts))
        verts.append((cx + math.cos(a) * r, cy + math.sin(a) * r * 1.35, 0.0))
    for i in range(BULB_SIDES):
        faces.append((center, ring[i], ring[(i + 1) % BULB_SIDES]))


def build_drips(tris, x_lo, x_hi, rng):
    verts, faces = [], []
    span = x_hi - x_lo
    slot = span / DRIP_SLOTS
    made = 0

    for s in range(DRIP_SLOTS):
        if rng.random() < DRIP_SKIP_CHANCE:
            continue
        sx0 = x_lo + s * slot
        # Lowest point of the letterform inside this column — blood collects
        # where the glyph hangs lowest, so that is where a run starts.
        best_x, best_y = None, None
        steps = 26
        for k in range(steps + 1):
            x = sx0 + slot * (k / steps)
            y = bottom_at(tris, x)
            if y is None:
                continue
            if best_y is None or y < best_y:
                best_x, best_y = x, y

        if best_x is None:
            continue

        # Reject anchors where the stroke isn't wide enough to carry the drip:
        # both shoulders must still be on ink, or the run hangs off a corner.
        w = DRIP_TOP_HALF
        if bottom_at(tris, best_x - w) is None or bottom_at(tris, best_x + w) is None:
            continue

        # Exponent biases toward SHORT runs — a fringe of equal-length drips
        # reads as a decorative border rather than as blood. Kept mild enough
        # that a few full-length runs still make it through each bake.
        length = DRIP_MIN_LEN + (DRIP_MAX_LEN - DRIP_MIN_LEN) * (rng.random() ** 1.3)
        top_half = w * (0.75 + 0.5 * rng.random())
        wobble = (rng.random() - 0.5) * 2 * DRIP_WOBBLE

        # Start slightly INSIDE the letter so the join is never a visible seam.
        tip_x, tip_y, tip_half = add_run(
            verts, faces, best_x, best_y + top_half * 0.9, length, top_half, wobble, rng
        )
        add_bulb(verts, faces, tip_x, tip_y, max(tip_half, top_half * (0.55 + 0.55 * (length / DRIP_MAX_LEN))))
        made += 1

        # A drop that has already let go, hanging in the air below a long run.
        if length > DRIP_MAX_LEN * 0.55 and rng.random() < DROPLET_CHANCE:
            gap = length * (0.25 + 0.4 * rng.random())
            add_bulb(verts, faces, tip_x + wobble * 0.5, tip_y - gap, top_half * 0.5)

    mesh = bpy.data.meshes.new("Drips")
    mesh.from_pydata(verts, [], faces)
    mesh.update()
    obj = bpy.data.objects.new("Drips", mesh)
    bpy.context.collection.objects.link(obj)
    print(f"[title] {made} drips on {DRIP_SLOTS} slots")
    return obj


# ── Material ───────────────────────────────────────────────────────────────

def make_material(y_lo, y_hi):
    """Flat emission through a vertical ramp — no lights, no tonemapping.

    Emission + view_transform 'Standard' means the rendered pixel IS the authored
    colour, which is the only way to know what the title will actually look like
    without a device to check it on.
    """
    mat = bpy.data.materials.new("Blood")
    mat.use_nodes = True
    nt = mat.node_tree
    nt.nodes.clear()

    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    ramp = nt.nodes.new("ShaderNodeValToRGB")
    mapr = nt.nodes.new("ShaderNodeMapRange")
    sep = nt.nodes.new("ShaderNodeSeparateXYZ")
    geo = nt.nodes.new("ShaderNodeNewGeometry")

    # Mapped over the TEXT bbox, not the whole frame: everything below the
    # letters (i.e. every drip) clamps to the darkest stop.
    mapr.inputs["From Min"].default_value = y_lo
    mapr.inputs["From Max"].default_value = y_hi
    mapr.inputs["To Min"].default_value = 0.0
    mapr.inputs["To Max"].default_value = 1.0
    mapr.clamp = True

    els = ramp.color_ramp.elements
    while len(els) > 1:
        els.remove(els[-1])
    els[0].position = RAMP[0][0]
    els[0].color = hexcol(RAMP[0][1])
    for pos, col in RAMP[1:]:
        e = els.new(pos)
        e.color = hexcol(col)

    nt.links.new(geo.outputs["Position"], sep.inputs["Vector"])
    nt.links.new(sep.outputs["Y"], mapr.inputs["Value"])
    nt.links.new(mapr.outputs["Result"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    nt.links.new(emit.outputs["Emission"], out.inputs["Surface"])
    return mat


# ── Render ─────────────────────────────────────────────────────────────────

def render(objs, out_path):
    lo_x = min(min(v.co.x for v in o.data.vertices) for o in objs)
    hi_x = max(max(v.co.x for v in o.data.vertices) for o in objs)
    lo_y = min(min(v.co.y for v in o.data.vertices) for o in objs)
    hi_y = max(max(v.co.y for v in o.data.vertices) for o in objs)

    pad = (hi_x - lo_x) * MARGIN
    lo_x -= pad; hi_x += pad; lo_y -= pad; hi_y += pad
    w = hi_x - lo_x
    h = hi_y - lo_y

    cam_data = bpy.data.cameras.new("Cam")
    cam_data.type = "ORTHO"
    # ortho_scale spans the LARGER render dimension, which is x here.
    cam_data.ortho_scale = w
    cam = bpy.data.objects.new("Cam", cam_data)
    cam.location = ((lo_x + hi_x) / 2, (lo_y + hi_y) / 2, 10.0)
    cam.rotation_euler = (0.0, 0.0, 0.0)
    bpy.context.collection.objects.link(cam)

    sc = bpy.context.scene
    sc.camera = cam
    sc.render.engine = "CYCLES"
    sc.cycles.samples = SAMPLES
    sc.cycles.use_denoising = False
    sc.render.resolution_x = RES_X
    sc.render.resolution_y = max(2, int(round(RES_X * h / w)))
    sc.render.resolution_percentage = 100
    sc.render.film_transparent = True
    sc.render.image_settings.file_format = "PNG"
    sc.render.image_settings.color_mode = "RGBA"
    sc.render.image_settings.color_depth = "8"
    sc.view_settings.view_transform = "Standard"
    sc.view_settings.look = "None"
    sc.render.filepath = out_path

    print(f"[title] {sc.render.resolution_x}x{sc.render.resolution_y}  aspect {w / h:.4f}")
    bpy.ops.render.render(write_still=True)
    return sc.render.resolution_x, sc.render.resolution_y


def main():
    argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    args = ap.parse_args(argv)

    rng = random.Random(SEED)
    wipe_scene()

    text_obj = make_text()
    tris = flatten_tris(text_obj)
    xs = [v.co.x for v in text_obj.data.vertices]
    ys = [v.co.y for v in text_obj.data.vertices]
    print(f"[title] text bbox x {min(xs):.3f}..{max(xs):.3f}  y {min(ys):.3f}..{max(ys):.3f}  tris {len(tris)}")

    drips = build_drips(tris, min(xs), max(xs), rng)

    mat = make_material(min(ys), max(ys))
    for o in (text_obj, drips):
        o.data.materials.append(mat)

    out = os.path.abspath(args.out)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    rx, ry = render([text_obj, drips], out)
    print(f"[title] wrote {out}  ({rx}x{ry})")


main()
