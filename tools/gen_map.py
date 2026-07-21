#!/usr/bin/env python3
"""gen_map.py -- build the IDE map tab's bundled data from the webmap tensor.

The full webmap (mercs2-webmap) is a 2.65 MB app plus ~1 MB of terrain data.
The IDE doesn't need terrain analysis -- it needs "where am I", "what are the
coordinates of that spot", and "what's the ground height there". So this bakes:

  map-white.jpg   the retail cartographic map (mercs2-tools/map.jpg), downscaled
  map-color.png   hillshaded relief + water, for the "Color" backdrop toggle
  map-heights.b64 coarse int16 height grid for tooltips / ground-snapped teleport

All inlined by build.py, keeping the IDE a single offline file.

ORIENTATION. Both backdrops are drawn with the retail map's convention, which is
the calibrated, pixel-perfect one from mercs2-tools/missionforge.html:
game X is WEST-POSITIVE so +x is on the LEFT, and Z is north-up (+z at top). The
old map-shade.png had +x increasing to the RIGHT -- it rendered mirrored. Both
outputs here are flipped to match, and 84_map.js maps world<->image from each
backdrop's world-edge box so the two stay consistent.

Sources: mercs2-webmap/dist/heightmap-data/{heights.bin,meta.json},
         mercs2-tools/map.jpg (8204x8204, world 0,0 at centre, +/-4102)
"""
import base64
import json
import pathlib
import sys

import numpy as np
from PIL import Image

WEBMAP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                      else r"C:\Users\logan\source\repos\mercs2-webmap")
MTOOLS = WEBMAP.parent / "mercs2-tools"
OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "data"
WHITE_PX = 2048       # downscale target for the white cartographic map
WHITE_Q = 82         # JPEG quality -- line art on white stays crisp here

SRC = WEBMAP / "dist" / "heightmap-data"
meta = json.loads((SRC / "meta.json").read_text(encoding="utf-8"))
g = meta["grid"]
W, H = g["width_cells"], g["height_cells"]
CELL = g["cell_world_units"]
OX, OZ = g["origin_cell_x"], g["origin_cell_z"]
SEA = meta["world"]["sea_level"]
SENTINEL = meta["heights_bin"]["sentinel"]

raw = np.frombuffer((SRC / "heights.bin").read_bytes(), dtype="<i2").astype(np.float32)
if raw.size != W * H:
    raise SystemExit("heights.bin is %d values, expected %d" % (raw.size, W * H))

hm = raw.reshape(H, W)                     # row = z index, col = x index
scanned = hm != SENTINEL
heights = np.where(scanned, hm / 10.0, np.nan)   # meta: value/10 = world units

# ---- hillshade -------------------------------------------------------------
# Fill unscanned cells with sea level so the gradient doesn't blow up at holes.
filled = np.where(np.isnan(heights), SEA, heights)
gz, gx = np.gradient(filled)
# light from the north-west, fairly low
az, alt = np.deg2rad(315.0), np.deg2rad(45.0)
slope = np.arctan(np.hypot(gx, gz) / CELL * 4.0)
aspect = np.arctan2(-gz, gx)
shade = (np.sin(alt) * np.cos(slope) +
         np.cos(alt) * np.sin(slope) * np.cos(az - aspect))
shade = np.clip(shade, 0, 1)

land = filled > SEA
hi = float(np.nanmax(heights)) if np.isfinite(heights).any() else 1.0
elev = np.clip((filled - SEA) / max(1e-6, hi - SEA), 0, 1)

rgb = np.zeros((H, W, 3), dtype=np.uint8)
# water: deeper = darker blue
depth = np.clip((SEA - filled) / 130.0, 0, 1)
rgb[..., 0] = np.where(land, 0, (26 - 14 * depth)).astype(np.uint8)
rgb[..., 1] = np.where(land, 0, (58 - 30 * depth)).astype(np.uint8)
rgb[..., 2] = np.where(land, 0, (92 - 40 * depth)).astype(np.uint8)
# land: green->tan->grey ramp, modulated by hillshade
base_r = 70 + 150 * elev
base_g = 96 + 90 * elev
base_b = 62 + 80 * elev
s = 0.45 + 0.75 * shade
rgb[..., 0] = np.where(land, np.clip(base_r * s, 0, 255), rgb[..., 0]).astype(np.uint8)
rgb[..., 1] = np.where(land, np.clip(base_g * s, 0, 255), rgb[..., 1]).astype(np.uint8)
rgb[..., 2] = np.where(land, np.clip(base_b * s, 0, 255), rgb[..., 2]).astype(np.uint8)
# never-scanned: flat dark so it reads as "no data", not as terrain
rgb[~scanned] = (18, 18, 22)

# Orient to the retail map convention: row 0 = MAX z (north, flipud), col 0 =
# MAX x (west/+x, fliplr). The tensor is south-first (row0=min z) and east-first
# (col0=min x, since +x is west), so both axes flip.
oriented = np.flipud(np.fliplr(rgb))
img = Image.fromarray(oriented, "RGB").convert("P", palette=Image.ADAPTIVE, colors=128)
color_path = OUT / "map-color.png"
img.save(color_path, optimize=True)

# ---- white cartographic map -------------------------------------------------
# The retail map.jpg IS the orientation reference (west-left, north-up already),
# so it only needs downscaling for bundle size. Full 8204x8204 is 5 MB; a 2048
# JPEG of line-art on white stays crisp and inlines at a sane weight.
white_path = OUT / "map-white.jpg"
src_map = MTOOLS / "map.jpg"
if src_map.exists():
    wm = Image.open(src_map).convert("RGB")
    wm = wm.resize((WHITE_PX, WHITE_PX), Image.LANCZOS)
    wm.save(white_path, "JPEG", quality=WHITE_Q, optimize=True)
else:
    print("[map] WARNING: %s not found -- white map not regenerated" % src_map)

# ---- coarse heights --------------------------------------------------------
# Half resolution (32 world units/cell) is plenty for a tooltip and a
# ground-snap, and quarters the payload.
step = 2
coarse = heights[::step, ::step]
cf = np.where(np.isnan(coarse), SENTINEL / 10.0, coarse)
b = (cf * 10.0).astype("<i2").tobytes()
b64_path = OUT / "map-heights.b64"
b64_path.write_text(base64.b64encode(b).decode("ascii"), encoding="utf-8")

# World-edge boxes let 84_map.js map world<->image for either backdrop with one
# transform. Edge = world coord at that image edge (west-positive x on the left).
# white: retail map.jpg span +/-4102 about centre, shifted by the confirmed
#   missionforge offset of -50 -> left edge world x = 4052.
# color: the tensor's own extent, cell edges at +/- W/2*CELL = +/-4000.
half_color = (W / 2.0) * CELL
info = {
    "cell": CELL, "width": W, "height": H,
    "originCellX": OX, "originCellZ": OZ,
    "seaLevel": SEA, "sentinel": SENTINEL,
    "coarseStep": step,
    "coarseW": coarse.shape[1], "coarseH": coarse.shape[0],
    "backdrops": {
        "white": {"leftX": 4052.0, "rightX": -4152.0, "topZ": 4052.0, "botZ": -4152.0},
        "color": {"leftX": half_color, "rightX": -half_color,
                  "topZ": half_color, "botZ": -half_color},
    },
    "note": ("both backdrops are west-positive-left, north-up. world<->image is "
             "driven by backdrops.<key> edges, not by pixel indexing."),
}
(OUT / "map-meta.json").write_text(json.dumps(info, indent=2), encoding="utf-8")

print("[map] color  %s  %d KB" % (color_path.name, color_path.stat().st_size // 1024))
if white_path.exists():
    print("[map] white  %s  %d KB (%dpx q%d)"
          % (white_path.name, white_path.stat().st_size // 1024, WHITE_PX, WHITE_Q))
print("[map] heights %s %d KB (%dx%d @ %d units)"
      % (b64_path.name, b64_path.stat().st_size // 1024,
         coarse.shape[1], coarse.shape[0], CELL * step))
print("[map] scanned %.1f%%" % (100.0 * scanned.sum() / scanned.size))
