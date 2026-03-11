/**
 * Asset compiler — builds optimized, cache-friendly game assets from raw project data.
 *
 * Input:
 *   data/game/resources/*.json  — individual Resource files
 *   data/game/composites/*.json — individual CompositeObject files
 *   data/game/rooms/*.json      — individual RoomDefinition files
 *   data/tilesets/**\/*.png      — source tileset images (scanned)
 *
 * Output: data/pack/
 *   atlas/atlas_<content_hash>.png  — one per source tileset that has used regions
 *   rooms/<room_name>.json          — one per room (placements remapped to atlas coords)
 *   resources/<resource_id>.json    — one compiled resource per source resource
 *   manifest.json                   — index of all compiled assets
 *
 * The compiler:
 * 1. Scans tileset PNGs from data/tilesets/ to build tileset definitions
 * 2. Reads resources, composites, and rooms from per-file JSON
 * 3. Collects every unique pixel region referenced by resources, rooms, and composites
 * 4. Groups regions by source tileset
 * 5. For each tileset: extracts used regions with sharp, packs into a minimal atlas PNG
 * 6. Content-hashes each atlas for cache-busting filenames
 * 7. Writes resource/room JSONs with remapped coordinates pointing to atlas files
 * 8. Writes a manifest.json listing everything
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

import type {
  TilesetDefinition,
  CompositeObject,
  RoomDefinition,
  Resource,
  ResourceFrame,
  TexturePlacement,
} from "@offisims/shared";

// ─── Region key (for deduplication) ────────────────────────────────

/** Canonical string key for a pixel-level region within a tileset */
function regionKey(tilesetId: string, x: number, y: number, w: number, h: number): string {
  return `${tilesetId}:${x},${y},${w},${h}`;
}

/** A collected region in pixel coordinates */
interface PixelRegion {
  tilesetId: string;
  /** Pixel X in the source tileset image */
  x: number;
  /** Pixel Y in the source tileset image */
  y: number;
  /** Pixel width */
  w: number;
  /** Pixel height */
  h: number;
  /** Dedup key */
  key: string;
}

// ─── Atlas mapping (source region → atlas position) ────────────────

interface AtlasEntry {
  /** Atlas filename (e.g. "atlas_a1b2c3d4e5.png") */
  atlasFile: string;
  /** Pixel X in the atlas */
  x: number;
  /** Pixel Y in the atlas */
  y: number;
  /** Pixel width */
  w: number;
  /** Pixel height */
  h: number;
}

// ─── Compiled output types ─────────────────────────────────────────

interface CompiledRegionRef {
  atlas: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CompiledPlacement {
  gridX: number;
  gridY: number;
  layer: "floor" | "object";
  region?: CompiledRegionRef;
  /** For composites: expanded inline as parts with offsets */
  parts?: { region: CompiledRegionRef; offsetX: number; offsetY: number; zBias?: number }[];
  zBias?: number;
}

interface CompiledRoom {
  name: string;
  width: number;
  height: number;
  walkability: boolean[];
  doors: { id: string; col: number; row: number; target: string }[];
  placements: CompiledPlacement[];
  /** Atlas files this room depends on */
  atlases: string[];
}

interface CompiledResource {
  id: string;
  name: string;
  tags: string[];
  frames: { atlas: string; x: number; y: number; w: number; h: number }[];
}

interface CompiledManifest {
  /** ISO timestamp of compilation */
  compiledAt: string;
  /** All atlas files */
  atlases: { file: string; tilesetId: string; regions: number; sizeBytes: number }[];
  /** All compiled rooms */
  rooms: { name: string; file: string }[];
  /** All compiled resources */
  resources: { id: string; name: string; tags: string[]; file: string }[];
}

// ─── Helpers: read per-file directories ────────────────────────────

/** Read all .json files from a directory, returning parsed objects. Returns [] if dir missing. */
function readJsonDir<T>(dirPath: string): T[] {
  if (!fs.existsSync(dirPath)) return [];
  const items: T[] = [];
  for (const entry of fs.readdirSync(dirPath)) {
    if (!entry.endsWith(".json")) continue;
    try {
      const content = fs.readFileSync(path.join(dirPath, entry), "utf-8");
      items.push(JSON.parse(content) as T);
    } catch (err) {
      console.warn(`[Compile] Failed to read ${path.join(dirPath, entry)}:`, err);
    }
  }
  return items;
}

// ─── Helpers: scan tilesets from filesystem ─────────────────────────

/** Tileset info derived from scanning data/tilesets/ */
interface ScannedTileset {
  /** ID: relative path without .png (e.g. "tilesets/3_office/Room_Builder_48x48") */
  id: string;
  /** Full filesystem path to the PNG */
  fsPath: string;
  /** Tile width parsed from filename or default 48 */
  tileWidth: number;
  /** Tile height parsed from filename or default 48 */
  tileHeight: number;
  /** SHA-256 content hash of the PNG file (hex, first 16 chars) */
  contentHash: string;
}

const TILESET_SIZE_RE = /_(\d+)x(\d+)\.png$/i;

/** Recursively scan a directory for PNG files */
function scanPngFiles(dir: string, dataDir: string): ScannedTileset[] {
  if (!fs.existsSync(dir)) return [];
  const results: ScannedTileset[] = [];

  function walk(current: string): void {
    const items = fs.readdirSync(current, { withFileTypes: true });
    for (const item of items) {
      if (item.name.startsWith(".")) continue;
      const full = path.join(current, item.name);
      if (item.isDirectory()) {
        walk(full);
      } else if (item.isFile() && item.name.toLowerCase().endsWith(".png")) {
        const relPath = path.relative(dataDir, full);
        const id = relPath.replace(/\.png$/i, "");
        const match = item.name.match(TILESET_SIZE_RE);
        let tileWidth = 48;
        let tileHeight = 48;
        if (match) {
          tileWidth = parseInt(match[1], 10);
          tileHeight = parseInt(match[2], 10);
        }
        const fileBuffer = fs.readFileSync(full);
        const contentHash = crypto.createHash("sha256").update(fileBuffer).digest("hex");
        results.push({ id, fsPath: full, tileWidth, tileHeight, contentHash });
      }
    }
  }

  walk(dir);
  return results;
}

// ─── Main compiler ─────────────────────────────────────────────────

export interface CompileResult {
  ok: boolean;
  message: string;
  atlasCount?: number;
  roomCount?: number;
  resourceCount?: number;
}

export async function compile(dataDir: string): Promise<CompileResult> {
  const outDir = path.join(dataDir, "pack");

  // 1. Scan tilesets from data/tilesets/**/*.png
  const tilesetsDir = path.join(dataDir, "tilesets");
  const scannedTilesets = scanPngFiles(tilesetsDir, dataDir);

  // Build tileset lookup: ID → TilesetDefinition
  // We populate cols/rows lazily (set to 0), resolved on demand when building atlases
  const tilesetMap = new Map<string, TilesetDefinition & { fsPath: string }>();
  for (const s of scannedTilesets) {
    const entry = {
      id: s.contentHash,
      label: path.basename(s.fsPath, ".png"),
      path: `/data/${s.id}.png`,
      tileWidth: s.tileWidth,
      tileHeight: s.tileHeight,
      cols: 0,
      rows: 0,
      fsPath: s.fsPath,
    };
    // Key by content hash (new tilesetId format used in JSON data)
    tilesetMap.set(s.contentHash, entry);
    // Also key by old path-based ID for backward compat during transition
    tilesetMap.set(s.id, entry);
  }

  // 2. Read per-file data
  const resources = readJsonDir<Resource>(path.join(dataDir, "game", "resources"));
  const composites = readJsonDir<CompositeObject>(path.join(dataDir, "game", "composites"));
  const rooms = readJsonDir<RoomDefinition>(path.join(dataDir, "game", "rooms"));

  console.log(
    `[Compile] Scanned ${tilesetMap.size} tilesets, ` +
    `${resources.length} resources, ${composites.length} composites, ${rooms.length} rooms`
  );

  // 3. Build composite lookup
  const compositeMap = new Map<string, CompositeObject>();
  for (const comp of composites) {
    compositeMap.set(comp.id, comp);
  }

  // 4. Collect all used regions, grouped by tilesetId
  //    Key: regionKey → PixelRegion
  const allRegions = new Map<string, PixelRegion>();
  //    tilesetId → Set<regionKey>
  const regionsByTileset = new Map<string, Set<string>>();

  function addRegion(tilesetId: string, x: number, y: number, w: number, h: number): void {
    const key = regionKey(tilesetId, x, y, w, h);
    if (!allRegions.has(key)) {
      allRegions.set(key, { tilesetId, x, y, w, h, key });
      if (!regionsByTileset.has(tilesetId)) {
        regionsByTileset.set(tilesetId, new Set());
      }
      regionsByTileset.get(tilesetId)!.add(key);
    }
  }

  /** Convert a tile-coordinate region to pixel coords and register it */
  function addTileRegion(tilesetId: string, srcCol: number, srcRow: number, w: number, h: number): void {
    const ts = tilesetMap.get(tilesetId);
    if (!ts) {
      console.warn(`[Compile] Unknown tileset: ${tilesetId}`);
      return;
    }
    const px = srcCol * ts.tileWidth;
    const py = srcRow * ts.tileHeight;
    const pw = w * ts.tileWidth;
    const ph = h * ts.tileHeight;
    addRegion(tilesetId, px, py, pw, ph);
  }

  // 4a. Collect from resources
  for (const res of resources) {
    for (const frame of res.frames) {
      addTileRegion(frame.tilesetId, frame.srcCol, frame.srcRow, frame.w, frame.h);
    }
  }

  // 4b. Collect from rooms (direct regions and composites)
  for (const room of rooms) {
    for (const p of room.placements) {
      if (p.region) {
        addTileRegion(p.region.tilesetId, p.region.srcCol, p.region.srcRow, p.region.w, p.region.h);
      }
      if (p.compositeId) {
        const comp = compositeMap.get(p.compositeId);
        if (comp) {
          for (const part of comp.parts) {
            addTileRegion(
              part.region.tilesetId,
              part.region.srcCol,
              part.region.srcRow,
              part.region.w,
              part.region.h,
            );
          }
        }
      }
    }
  }

  console.log(`[Compile] Collected ${allRegions.size} unique regions from ${regionsByTileset.size} tilesets`);

  // 5. Clean and create output directory
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(outDir, "atlas"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "rooms"), { recursive: true });
  fs.mkdirSync(path.join(outDir, "resources"), { recursive: true });

  // 6. Build atlas for each tileset
  //    regionKey → AtlasEntry (populated as we build atlases)
  const atlasLookup = new Map<string, AtlasEntry>();
  const manifestAtlases: CompiledManifest["atlases"] = [];

  for (const [tilesetId, regKeys] of regionsByTileset) {
    const ts = tilesetMap.get(tilesetId);
    if (!ts) continue;

    const imgPath = ts.fsPath;
    if (!fs.existsSync(imgPath)) {
      console.warn(`[Compile] Source image not found: ${imgPath} (tileset ${tilesetId})`);
      continue;
    }

    // Gather regions for this tileset, sorted for determinism
    const regions = [...regKeys]
      .map((k) => allRegions.get(k)!)
      .sort((a, b) => a.y - b.y || a.x - b.x || a.w - b.w || a.h - b.h);

    // Pack regions into rows using a simple shelf packer
    const MAX_ATLAS_WIDTH = 4096;
    let atlasWidth = 0;
    let atlasHeight = 0;

    interface PackedSlot { region: PixelRegion; ax: number; ay: number }
    const slots: PackedSlot[] = [];
    let curX = 0;
    let curY = 0;
    let rowHeight = 0;

    for (const region of regions) {
      if (curX + region.w > MAX_ATLAS_WIDTH && curX > 0) {
        curY += rowHeight;
        curX = 0;
        rowHeight = 0;
      }
      slots.push({ region, ax: curX, ay: curY });
      curX += region.w;
      rowHeight = Math.max(rowHeight, region.h);
      atlasWidth = Math.max(atlasWidth, curX);
    }
    atlasHeight = curY + rowHeight;

    if (atlasWidth === 0 || atlasHeight === 0) continue;

    // Extract regions and composite into atlas
    const sourceMetadata = await sharp(imgPath).metadata();

    const compositeOps: sharp.OverlayOptions[] = [];
    for (const slot of slots) {
      const { region, ax, ay } = slot;
      // Clamp extraction to source image bounds
      const extractW = Math.min(region.w, (sourceMetadata.width || 0) - region.x);
      const extractH = Math.min(region.h, (sourceMetadata.height || 0) - region.y);
      if (extractW <= 0 || extractH <= 0) continue;

      const extracted = await sharp(imgPath)
        .extract({ left: region.x, top: region.y, width: extractW, height: extractH })
        .toBuffer();

      compositeOps.push({ input: extracted, left: ax, top: ay });
    }

    // Create the atlas PNG
    const atlasBuffer = await sharp({
      create: {
        width: atlasWidth,
        height: atlasHeight,
        channels: 4,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      },
    })
      .composite(compositeOps)
      .png()
      .toBuffer();

    // Content hash for filename
    const hash = crypto.createHash("sha256").update(atlasBuffer).digest("hex").slice(0, 10);
    const atlasFile = `atlas_${hash}.png`;
    const atlasPath = path.join(outDir, "atlas", atlasFile);
    fs.writeFileSync(atlasPath, atlasBuffer);

    console.log(
      `[Compile] Atlas for "${tilesetId}": ${atlasWidth}x${atlasHeight}px, ` +
      `${regions.length} regions, ${(atlasBuffer.length / 1024).toFixed(1)} KB → ${atlasFile}`
    );

    // Record atlas entries in lookup
    for (const slot of slots) {
      atlasLookup.set(slot.region.key, {
        atlasFile,
        x: slot.ax,
        y: slot.ay,
        w: slot.region.w,
        h: slot.region.h,
      });
    }

    manifestAtlases.push({
      file: atlasFile,
      tilesetId,
      regions: regions.length,
      sizeBytes: atlasBuffer.length,
    });
  }

  // 7. Helper: resolve a tile-coordinate region to a CompiledRegionRef
  function resolveRegion(tilesetId: string, srcCol: number, srcRow: number, w: number, h: number): CompiledRegionRef | null {
    const ts = tilesetMap.get(tilesetId);
    if (!ts) return null;
    const px = srcCol * ts.tileWidth;
    const py = srcRow * ts.tileHeight;
    const pw = w * ts.tileWidth;
    const ph = h * ts.tileHeight;
    const key = regionKey(tilesetId, px, py, pw, ph);
    const entry = atlasLookup.get(key);
    if (!entry) return null;
    return { atlas: entry.atlasFile, x: entry.x, y: entry.y, w: entry.w, h: entry.h };
  }

  // 8. Write compiled resource JSONs
  const manifestResources: CompiledManifest["resources"] = [];

  for (const res of resources) {
    const compiledFrames: CompiledResource["frames"] = [];

    for (const frame of res.frames) {
      const ref = resolveRegion(frame.tilesetId, frame.srcCol, frame.srcRow, frame.w, frame.h);
      if (ref) {
        compiledFrames.push({
          atlas: ref.atlas,
          x: ref.x,
          y: ref.y,
          w: ref.w,
          h: ref.h,
        });
      } else {
        console.warn(`[Compile] Missing frame for resource ${res.id} (${res.name}): tileset=${frame.tilesetId}`);
      }
    }

    const compiled: CompiledResource = {
      id: res.id,
      name: res.name,
      tags: res.tags,
      frames: compiledFrames,
    };

    const resPath = path.join(outDir, "resources", `${res.id}.json`);
    fs.writeFileSync(resPath, JSON.stringify(compiled, null, 2));
    manifestResources.push({
      id: res.id,
      name: res.name,
      tags: res.tags,
      file: `${res.id}.json`,
    });
  }

  // 9. Write compiled room JSONs
  const manifestRooms: CompiledManifest["rooms"] = [];

  for (const room of rooms) {
    const atlasesUsed = new Set<string>();
    const compiledPlacements: CompiledPlacement[] = [];

    for (const p of room.placements) {
      if (p.region) {
        const ref = resolveRegion(p.region.tilesetId, p.region.srcCol, p.region.srcRow, p.region.w, p.region.h);
        if (ref) {
          atlasesUsed.add(ref.atlas);
          compiledPlacements.push({
            gridX: p.gridX,
            gridY: p.gridY,
            layer: p.layer,
            region: ref,
            zBias: p.zBias,
          });
        }
      } else if (p.compositeId) {
        const comp = compositeMap.get(p.compositeId);
        if (comp) {
          const compiledParts: CompiledPlacement["parts"] = [];
          for (const part of comp.parts) {
            const ref = resolveRegion(
              part.region.tilesetId,
              part.region.srcCol,
              part.region.srcRow,
              part.region.w,
              part.region.h,
            );
            if (ref) {
              atlasesUsed.add(ref.atlas);
              compiledParts.push({
                region: ref,
                offsetX: part.offsetX,
                offsetY: part.offsetY,
                zBias: part.zBias,
              });
            }
          }
          if (compiledParts.length > 0) {
            compiledPlacements.push({
              gridX: p.gridX,
              gridY: p.gridY,
              layer: p.layer,
              parts: compiledParts,
              zBias: p.zBias,
            });
          }
        }
      }
    }

    const compiledRoom: CompiledRoom = {
      name: room.name,
      width: room.width,
      height: room.height,
      walkability: room.walkability,
      doors: room.doors,
      placements: compiledPlacements,
      atlases: [...atlasesUsed],
    };

    const roomPath = path.join(outDir, "rooms", `${room.name}.json`);
    fs.writeFileSync(roomPath, JSON.stringify(compiledRoom, null, 2));
    manifestRooms.push({ name: room.name, file: `${room.name}.json` });
  }

  // 10. Write manifest
  const manifest: CompiledManifest = {
    compiledAt: new Date().toISOString(),
    atlases: manifestAtlases,
    rooms: manifestRooms,
    resources: manifestResources,
  };

  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const totalAtlasKB = manifestAtlases.reduce((sum, a) => sum + a.sizeBytes, 0) / 1024;
  const message =
    `Compiled: ${manifestAtlases.length} atlases (${totalAtlasKB.toFixed(0)} KB), ` +
    `${manifestRooms.length} rooms, ${manifestResources.length} resources`;
  console.log(`[Compile] ${message}`);

  return {
    ok: true,
    message,
    atlasCount: manifestAtlases.length,
    roomCount: manifestRooms.length,
    resourceCount: manifestResources.length,
  };
}
