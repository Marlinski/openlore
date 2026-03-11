/**
 * Asset compiler — builds optimized, cache-friendly game assets from raw project data.
 *
 * Input:  data/game/game-data.json + source tileset PNGs in data/
 * Output: data/resources/
 *           atlas/atlas_<content_hash>.png   — one per source tileset, only used regions
 *           rooms/<room_name>.json           — placements remapped to atlas coords
 *           characters/base/<char_name>.json — animation strips remapped to atlas coords
 *           manifest.json                    — index of all compiled assets
 *
 * The compiler:
 * 1. Reads project data from disk
 * 2. Collects every unique tile region referenced by rooms, composites, and characters
 * 3. Groups regions by source tileset
 * 4. For each tileset: extracts used regions with sharp, packs into a minimal atlas PNG
 * 5. Content-hashes each atlas for cache-busting filenames
 * 6. Writes room/character JSONs with remapped coordinates pointing to atlas files
 * 7. Writes a manifest.json listing everything
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";

// ─── Types (inline to avoid import issues in Vite plugin context) ──

interface TilesetDefinition {
  id: string;
  label: string;
  path: string;
  tileWidth: number;
  tileHeight: number;
  cols: number;
  rows: number;
}

interface TilesetRegion {
  tilesetId: string;
  srcCol: number;
  srcRow: number;
  w: number;
  h: number;
}

interface CompositePart {
  region: TilesetRegion;
  offsetX: number;
  offsetY: number;
  zBias?: number;
}

interface CompositeObject {
  id: string;
  name: string;
  category: string;
  parts: CompositePart[];
  displaySize: { w: number; h: number };
}

interface TexturePlacement {
  gridX: number;
  gridY: number;
  layer: "floor" | "object";
  region?: TilesetRegion;
  compositeId?: string;
  zBias?: number;
}

interface DoorDefinition {
  id: string;
  col: number;
  row: number;
  target: string;
}

interface RoomDefinition {
  name: string;
  width: number;
  height: number;
  walkability: boolean[];
  doors: DoorDefinition[];
  placements: TexturePlacement[];
}

interface AnimationStrip {
  tilesetId: string;
  row: number;
  startFrame: number;
  frameCount: number;
}

interface CharacterAnimation {
  family: string;
  direction: string;
  variant: number;
  strip: AnimationStrip;
}

interface CharacterDefinition {
  id: string;
  name: string;
  sheetId: string;
  frameWidth: number;
  frameHeight: number;
  animations: CharacterAnimation[];
  familySpeeds: Record<string, number>;
  variantSequences: any[];
}

interface ProjectData {
  tilesets: TilesetDefinition[];
  composites: CompositeObject[];
  rooms: RoomDefinition[];
  characters: CharacterDefinition[];
}

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
  doors: DoorDefinition[];
  placements: CompiledPlacement[];
  /** Atlas files this room depends on */
  atlases: string[];
}

interface CompiledAnimationStrip {
  /** Frame width in pixels */
  frameWidth: number;
  /** Frame height in pixels */
  frameHeight: number;
  /**
   * Per-frame atlas coordinates.
   * Each entry is [atlas, x, y] — atlas filename + pixel position.
   * Frames may come from different atlases (if the source tileset changed)
   * and may not be contiguous (due to deduplication).
   */
  frames: { atlas: string; x: number; y: number }[];
}

interface CompiledCharacterAnimation {
  family: string;
  direction: string;
  variant: number;
  strip: CompiledAnimationStrip;
}

interface CompiledCharacter {
  id: string;
  name: string;
  frameWidth: number;
  frameHeight: number;
  animations: CompiledCharacterAnimation[];
  familySpeeds: Record<string, number>;
  variantSequences: any[];
  /** Atlas files this character depends on */
  atlases: string[];
}

interface CompiledManifest {
  /** ISO timestamp of compilation */
  compiledAt: string;
  /** All atlas files */
  atlases: { file: string; tilesetId: string; regions: number; sizeBytes: number }[];
  /** All compiled rooms */
  rooms: { name: string; file: string }[];
  /** All compiled characters */
  characters: { name: string; file: string }[];
}

// ─── Main compiler ─────────────────────────────────────────────────

export interface CompileResult {
  ok: boolean;
  message: string;
  atlasCount?: number;
  roomCount?: number;
  characterCount?: number;
}

export async function compile(dataDir: string): Promise<CompileResult> {
  const projectPath = path.join(dataDir, "game", "game-data.json");
  const compiledDir = path.join(dataDir, "resources");

  // 1. Read project data
  if (!fs.existsSync(projectPath)) {
    return { ok: false, message: "No game-data.json found" };
  }

  const project: ProjectData = JSON.parse(fs.readFileSync(projectPath, "utf-8"));
  console.log(
    `[Compile] Project: ${project.tilesets.length} tilesets, ` +
    `${project.composites.length} composites, ${project.rooms.length} rooms, ` +
    `${project.characters.length} characters`
  );

  // 2. Build composite lookup
  const compositeMap = new Map<string, CompositeObject>();
  for (const comp of project.composites) {
    compositeMap.set(comp.id, comp);
  }

  // Build tileset lookup
  const tilesetMap = new Map<string, TilesetDefinition>();
  for (const ts of project.tilesets) {
    tilesetMap.set(ts.id, ts);
  }

  // 3. Collect all used regions, grouped by tilesetId
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

  function addTilesetRegion(region: TilesetRegion): void {
    const ts = tilesetMap.get(region.tilesetId);
    if (!ts) {
      console.warn(`[Compile] Unknown tileset: ${region.tilesetId}`);
      return;
    }
    const x = region.srcCol * ts.tileWidth;
    const y = region.srcRow * ts.tileHeight;
    const w = region.w * ts.tileWidth;
    const h = region.h * ts.tileHeight;
    addRegion(region.tilesetId, x, y, w, h);
  }

  // 3a. Collect from rooms
  for (const room of project.rooms) {
    for (const p of room.placements) {
      if (p.region) {
        addTilesetRegion(p.region);
      }
      if (p.compositeId) {
        const comp = compositeMap.get(p.compositeId);
        if (comp) {
          for (const part of comp.parts) {
            addTilesetRegion(part.region);
          }
        }
      }
    }
  }

  // 3b. Collect from characters
  for (const char of project.characters) {
    for (const anim of char.animations) {
      const strip = anim.strip;
      const ts = tilesetMap.get(strip.tilesetId);
      const fw = char.frameWidth;
      const fh = char.frameHeight;
      // Each frame is a separate region in the atlas
      for (let f = 0; f < strip.frameCount; f++) {
        const x = (strip.startFrame + f) * fw;
        const y = strip.row * fh;
        addRegion(strip.tilesetId, x, y, fw, fh);
      }
    }
  }

  console.log(`[Compile] Collected ${allRegions.size} unique regions from ${regionsByTileset.size} tilesets`);

  // 4. Clean compiled directory
  if (fs.existsSync(compiledDir)) {
    fs.rmSync(compiledDir, { recursive: true });
  }
  fs.mkdirSync(path.join(compiledDir, "atlas"), { recursive: true });
  fs.mkdirSync(path.join(compiledDir, "rooms"), { recursive: true });
  fs.mkdirSync(path.join(compiledDir, "characters", "base"), { recursive: true });

  // 5. Build atlas for each tileset
  //    regionKey → AtlasEntry (populated as we build atlases)
  const atlasLookup = new Map<string, AtlasEntry>();
  const manifestAtlases: CompiledManifest["atlases"] = [];

  for (const [tilesetId, regionKeys] of regionsByTileset) {
    const ts = tilesetMap.get(tilesetId);
    if (!ts) continue;

    // Resolve source image path
    // ts.path is like "/data/sprites/foo.png" — strip the "/data/" prefix
    const imgRelPath = ts.path.startsWith("/data/") ? ts.path.slice("/data/".length) : ts.path;
    const imgPath = path.join(dataDir, imgRelPath);

    if (!fs.existsSync(imgPath)) {
      console.warn(`[Compile] Source image not found: ${imgPath} (tileset ${tilesetId})`);
      continue;
    }

    // Gather regions for this tileset, sorted for determinism
    const regions = [...regionKeys]
      .map((k) => allRegions.get(k)!)
      .sort((a, b) => a.y - b.y || a.x - b.x || a.w - b.w || a.h - b.h);

    // Pack regions into rows using a simple shelf packer
    // Since tiles are mostly uniform size, this works well
    const MAX_ATLAS_WIDTH = 4096;
    let atlasWidth = 0;
    let atlasHeight = 0;

    // First pass: compute layout
    interface PackedSlot { region: PixelRegion; ax: number; ay: number }
    const slots: PackedSlot[] = [];
    let curX = 0;
    let curY = 0;
    let rowHeight = 0;

    for (const region of regions) {
      if (curX + region.w > MAX_ATLAS_WIDTH && curX > 0) {
        // New row
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

    // Second pass: extract regions and composite into atlas
    const sourceImage = sharp(imgPath);
    const sourceMetadata = await sourceImage.metadata();

    // Create atlas by compositing extracted regions
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
    const atlasPath = path.join(compiledDir, "atlas", atlasFile);
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

  // 6. Helper: resolve a TilesetRegion to a CompiledRegionRef
  function resolveRegion(region: TilesetRegion): CompiledRegionRef | null {
    const ts = tilesetMap.get(region.tilesetId);
    if (!ts) return null;
    const x = region.srcCol * ts.tileWidth;
    const y = region.srcRow * ts.tileHeight;
    const w = region.w * ts.tileWidth;
    const h = region.h * ts.tileHeight;
    const key = regionKey(region.tilesetId, x, y, w, h);
    const entry = atlasLookup.get(key);
    if (!entry) return null;
    return { atlas: entry.atlasFile, x: entry.x, y: entry.y, w: entry.w, h: entry.h };
  }

  // 7. Write compiled room JSONs
  const manifestRooms: CompiledManifest["rooms"] = [];

  for (const room of project.rooms) {
    const atlasesUsed = new Set<string>();
    const compiledPlacements: CompiledPlacement[] = [];

    for (const p of room.placements) {
      if (p.region) {
        const ref = resolveRegion(p.region);
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
            const ref = resolveRegion(part.region);
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

    const roomPath = path.join(compiledDir, "rooms", `${room.name}.json`);
    fs.writeFileSync(roomPath, JSON.stringify(compiledRoom, null, 2));
    manifestRooms.push({ name: room.name, file: `${room.name}.json` });
  }

  // 8. Write compiled character JSONs
  const manifestCharacters: CompiledManifest["characters"] = [];

  for (const char of project.characters) {
    const atlasesUsed = new Set<string>();
    const compiledAnimations: CompiledCharacterAnimation[] = [];

    for (const anim of char.animations) {
      const strip = anim.strip;
      const fw = char.frameWidth;
      const fh = char.frameHeight;

      // Resolve each frame individually — frames may not be contiguous in the atlas
      const frames: { atlas: string; x: number; y: number }[] = [];
      let allResolved = true;

      for (let f = 0; f < strip.frameCount; f++) {
        const frameX = (strip.startFrame + f) * fw;
        const frameY = strip.row * fh;
        const key = regionKey(strip.tilesetId, frameX, frameY, fw, fh);
        const entry = atlasLookup.get(key);
        if (entry) {
          atlasesUsed.add(entry.atlasFile);
          frames.push({ atlas: entry.atlasFile, x: entry.x, y: entry.y });
        } else {
          allResolved = false;
          console.warn(`[Compile] Missing frame ${f} for ${char.name}/${anim.family}/${anim.direction}`);
        }
      }

      if (frames.length > 0) {
        compiledAnimations.push({
          family: anim.family,
          direction: anim.direction,
          variant: anim.variant,
          strip: {
            frameWidth: fw,
            frameHeight: fh,
            frames,
          },
        });
      }
    }

    const compiledChar: CompiledCharacter = {
      id: char.id,
      name: char.name,
      frameWidth: char.frameWidth,
      frameHeight: char.frameHeight,
      animations: compiledAnimations,
      familySpeeds: char.familySpeeds,
      variantSequences: char.variantSequences,
      atlases: [...atlasesUsed],
    };

    const charPath = path.join(compiledDir, "characters", "base", `${char.name.toLowerCase()}.json`);
    fs.writeFileSync(charPath, JSON.stringify(compiledChar, null, 2));
    manifestCharacters.push({ name: char.name, file: `base/${char.name.toLowerCase()}.json` });
  }

  // 9. Write manifest
  const manifest: CompiledManifest = {
    compiledAt: new Date().toISOString(),
    atlases: manifestAtlases,
    rooms: manifestRooms,
    characters: manifestCharacters,
  };

  fs.writeFileSync(path.join(compiledDir, "manifest.json"), JSON.stringify(manifest, null, 2));

  const totalAtlasKB = manifestAtlases.reduce((sum, a) => sum + a.sizeBytes, 0) / 1024;
  const message =
    `Compiled: ${manifestAtlases.length} atlases (${totalAtlasKB.toFixed(0)} KB), ` +
    `${manifestRooms.length} rooms, ${manifestCharacters.length} characters`;
  console.log(`[Compile] ${message}`);

  return {
    ok: true,
    message,
    atlasCount: manifestAtlases.length,
    roomCount: manifestRooms.length,
    characterCount: manifestCharacters.length,
  };
}
