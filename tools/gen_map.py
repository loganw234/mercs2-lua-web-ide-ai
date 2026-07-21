#!/usr/bin/env python3
"""gen_map.py -- build the IDE map tab's bundled data from the webmap tensor.

The full webmap (mercs2-webmap) is a 2.65 MB app plus ~1 MB of terrain data.
The IDE doesn't need terrain analysis -- it needs "where am I", "what are the
coordinates of that spot", and "what's the ground height there". So this bakes
the 500x500 height tensor down to:

  map-shade.png   hillshaded relief + water, 8-bit palette, for display
  map-heights.b64 coarse int16 height grid for tooltips / ground-snapped teleport

Both are inlined by build.py, keeping the IDE a single offline file.

Source: mercs2-webmap/dist/heightmap-data/{heights.bin,meta.json}
"""
import base64
import json
import pathlib
import sys

import numpy as np
from PIL import Image

WEBMAP = pathlib.Path(sys.argv[1] if len(sys.argv) > 1
                      else r"C:\Users\logan\source\repos\mercs2-webmap")
OUT = pathlib.Path(__file__).resolve().parent.parent / "src" / "data"

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

# meta says pixel row 0 = MINIMUM world z. Screen y grows downward, and we want
# north (+z) at the top, so flip vertically for display.
img = Image.fromarray(np.flipud(rgb), "RGB").convert("P", palette=Image.ADAPTIVE, colors=128)
shade_path = OUT / "map-shade.png"
img.save(shade_path, optimize=True)

# ---- coarse heights --------------------------------------------------------
# Half resolution (32 world units/cell) is plenty for a tooltip and a
# ground-snap, and quarters the payload.
step = 2
coarse = heights[::step, ::step]
cf = np.where(np.isnan(coarse), SENTINEL / 10.0, coarse)
b = (cf * 10.0).astype("<i2").tobytes()
b64_path = OUT / "map-heights.b64"
b64_path.write_text(base64.b64encode(b).decode("ascii"), encoding="utf-8")

info = {
    "cell": CELL, "width": W, "height": H,
    "originCellX": OX, "originCellZ": OZ,
    "seaLevel": SEA, "sentinel": SENTINEL,
    "coarseStep": step,
    "coarseW": coarse.shape[1], "coarseH": coarse.shape[0],
    "note": ("pixel row 0 of map-shade.png is MAX world z (north) because the "
             "source tensor is south-first and we flip for display; "
             "world +x increases with column"),
}
(OUT / "map-meta.json").write_text(json.dumps(info, indent=2), encoding="utf-8")

print("[map] shade  %s  %d KB" % (shade_path.name, shade_path.stat().st_size // 1024))
print("[map] heights %s %d KB (%dx%d @ %d units)"
      % (b64_path.name, b64_path.stat().st_size // 1024,
         coarse.shape[1], coarse.shape[0], CELL * step))
print("[map] scanned %.1f%%" % (100.0 * scanned.sum() / scanned.size))
