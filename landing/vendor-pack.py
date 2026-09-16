#!/usr/bin/env python3
"""
Vendor a compiled pack into landing/pack/ for the hero demo.

The landing page runs the real game client (see landing/demo/), so the pack it
loads must look exactly like what the game server's /api/channels/{ch}/game-data
endpoint returns — not like the files Studio writes to disk. Two differences
matter:

  * Enums. The server marshals with protojson UseEnumNumbers=true (see
    game/server/internal/api/middleware.go), so `layer` arrives as 1 or 2.
    Studio stores the protojson default, the string "PLACEMENT_LAYER_FLOOR".
    The client compares against the numeric TS enum, so strings render nothing.

  * Shape. The server returns one Pack object; Studio stores one file per
    entity. This script assembles them.

Usage:
    python3 landing/vendor-pack.py [source-pack-dir]

Defaults to data/game/packs/test-pack. Rewrites landing/pack/ in place.
"""

import json
import os
import shutil
import sys
import glob

# openlore.pack.v1.PlacementLayer — keep in sync with shared/proto/.
PLACEMENT_LAYER = {
    "PLACEMENT_LAYER_UNSPECIFIED": 0,
    "PLACEMENT_LAYER_FLOOR": 1,
    "PLACEMENT_LAYER_OBJECT": 2,
}

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "data/game/packs/test-pack")
OUT = os.path.join(ROOT, "landing/pack")

# Only the rooms the demo can actually show, to keep the payload small.
KEEP_ROOMS = ("main_office", "coffee_room")


def numeric_enums(node):
    """Replace protojson enum names with their numbers, as the server does."""
    if isinstance(node, dict):
        return {k: (PLACEMENT_LAYER[v] if k == "layer" and isinstance(v, str) and v in PLACEMENT_LAYER
                    else numeric_enums(v))
                for k, v in node.items()}
    if isinstance(node, list):
        return [numeric_enums(v) for v in node]
    return node


def load_all(sub):
    return [json.load(open(f)) for f in sorted(glob.glob(os.path.join(SRC, sub, "*.json")))]


def main():
    if not os.path.isdir(SRC):
        sys.exit(f"source pack not found: {SRC}")

    pack = {
        "manifest": json.load(open(os.path.join(SRC, "manifest.json"))),
        "tilesets": load_all("tilesets"),
        "composites": load_all("composites"),
        "rooms": [r for r in load_all("rooms") if r["name"] in KEEP_ROOMS],
        "resources": load_all("resources"),
        "masks": [],
    }
    pack = numeric_enums(pack)

    # Drop tilesets nothing references, so we ship only the atlases we need.
    used = set()
    for r in pack["rooms"]:
        for p in r.get("placements", []):
            if p.get("region"):
                used.add(p["region"]["tilesetId"])
    for c in pack["composites"]:
        for part in c.get("parts", []):
            if part.get("region"):
                used.add(part["region"]["tilesetId"])
    for res in pack["resources"]:
        for f in res.get("frames", []):
            used.add(f["tilesetId"])
    pack["tilesets"] = [t for t in pack["tilesets"] if t["id"] in used]

    shutil.rmtree(os.path.join(OUT, "atlas"), ignore_errors=True)
    os.makedirs(os.path.join(OUT, "atlas"), exist_ok=True)
    for t in pack["tilesets"]:
        shutil.copy(os.path.join(SRC, t["path"]), os.path.join(OUT, os.path.basename(t["path"]))
                    if False else os.path.join(OUT, "atlas", os.path.basename(t["path"])))

    with open(os.path.join(OUT, "pack.json"), "w") as fh:
        json.dump(pack, fh, separators=(",", ":"))

    layers = {p.get("layer") for r in pack["rooms"] for p in r.get("placements", [])}
    print(f"rooms      {[r['name'] for r in pack['rooms']]}")
    print(f"tilesets   {len(pack['tilesets'])}")
    print(f"resources  {len(pack['resources'])}")
    print(f"layers     {sorted(layers)}  (must be ints, not strings)")
    print(f"pack.json  {os.path.getsize(os.path.join(OUT, 'pack.json'))} bytes")


if __name__ == "__main__":
    main()
