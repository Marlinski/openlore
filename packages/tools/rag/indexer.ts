/**
 * RAG Indexer — scans the filesystem for tilesets, resources, composites, and rooms,
 * computes content hashes, generates CLIP embeddings, and stores everything in the RAG database.
 *
 * Designed for server-side Node.js. Process tilesets sequentially (memory-safe),
 * resources in batches of 20.
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { embedImage, embedImageBuffer, embedText, getModelId } from "./clip.js";
import type { RagDb } from "./db.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface IndexResult {
  indexed: number;
  skipped: number;
  deleted: number;
  errors: number;
  elapsed: number;
}

interface ResourceJson {
  id: string;
  name: string;
  tags: string[];
  frames: {
    tilesetId: string;
    srcCol: number;
    srcRow: number;
    w: number;
    h: number;
  }[];
}

interface CompositeJson {
  id: string;
  name: string;
  category: string;
  parts: {
    region: {
      tilesetId: string;
      srcCol: number;
      srcRow: number;
      w: number;
      h: number;
    };
    offsetX: number;
    offsetY: number;
    zBias?: number;
  }[];
  displaySize: { w: number; h: number };
}

interface RoomJson {
  name: string;
  width: number;
  height: number;
  walkability: boolean[];
  doors: { id: string; col: number; row: number; target: string }[];
  placements: {
    gridX: number;
    gridY: number;
    layer: string;
    region: {
      tilesetId: string;
      srcCol: number;
      srcRow: number;
      w: number;
      h: number;
    };
    zBias?: number;
  }[];
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_TILE_SIZE = 48;
const RESOURCE_BATCH_SIZE = 20;
const TILESET_LOG_INTERVAL = 100;

const KIND_TILESET = "tileset";
const KIND_RESOURCE = "resource";
const KIND_RESOURCE_SPRITE = "resource_sprite";
const KIND_COMPOSITE = "composite";
const KIND_ROOM = "room";

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(...args: unknown[]): void {
  console.log("[indexer]", ...args);
}

function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Parse tile dimensions from a tileset filename.
 * Looks for patterns like `_48x48.png` or `_32x32.png`.
 * Returns [tileWidth, tileHeight] or the default [48, 48].
 */
function parseTileSize(filename: string): [number, number] {
  const match = filename.match(/(\d+)x(\d+)\.png$/i);
  if (match) {
    return [parseInt(match[1], 10), parseInt(match[2], 10)];
  }
  return [DEFAULT_TILE_SIZE, DEFAULT_TILE_SIZE];
}

/**
 * Recursively collect all files matching a glob pattern under a directory.
 */
function walkDir(dir: string, ext: string): string[] {
  const results: string[] = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...walkDir(fullPath, ext));
    } else if (entry.name.endsWith(ext)) {
      results.push(fullPath);
    }
  }
  return results;
}

/**
 * Crop a sprite frame from a tileset PNG.
 * Returns a PNG buffer of the cropped region.
 */
async function cropSpriteFrame(
  tilesetPath: string,
  srcCol: number,
  srcRow: number,
  w: number,
  h: number,
  tileWidth: number,
  tileHeight: number,
): Promise<Buffer> {
  const left = srcCol * tileWidth;
  const top = srcRow * tileHeight;
  const width = w * tileWidth;
  const height = h * tileHeight;

  return sharp(tilesetPath)
    .extract({ left, top, width, height })
    .png()
    .toBuffer();
}

/**
 * Resolve a tilesetId to an absolute filesystem path.
 * Handles both legacy path-based IDs ("tilesets/foo/bar_48x48") and
 * hash-based IDs (SHA-256 content hashes). For hashes, uses the provided
 * hashToPath map (built during tileset indexing) or falls back to a DB lookup.
 */
function resolveTilesetPath(
  dataDir: string,
  tilesetId: string,
  hashToPath?: Map<string, string>,
  db?: RagDb,
): string | null {
  // Check if this looks like a SHA-256 hex hash (64 hex chars)
  if (/^[0-9a-f]{64}$/i.test(tilesetId)) {
    // Try in-memory hash map first (available during full index)
    if (hashToPath) {
      const resolved = hashToPath.get(tilesetId);
      if (resolved) return resolved;
    }
    // Fall back to DB lookup (used during single-file indexing)
    if (db) {
      const meta = db.getItemMetadata(KIND_TILESET, tilesetId);
      if (meta?.relPath) {
        const absPath = path.join(dataDir, meta.relPath as string);
        if (fs.existsSync(absPath)) return absPath;
      }
    }
    return null; // hash could not be resolved
  }

  // Legacy path-based resolution
  const base = path.join(dataDir, tilesetId);
  if (fs.existsSync(base)) return base;
  const withPng = base + ".png";
  if (fs.existsSync(withPng)) return withPng;
  return null;
}

/**
 * Derive the `data/` directory from an absolute file path by looking for known
 * path segments. Returns the absolute path to the `data/` parent directory.
 */
function deriveDataDir(filePath: string): string {
  const normalized = filePath.replace(/\\/g, "/");
  const markers = ["/data/tilesets/", "/data/game/resources/", "/data/game/composites/", "/data/game/rooms/"];
  for (const marker of markers) {
    const idx = normalized.indexOf(marker);
    if (idx !== -1) {
      return normalized.slice(0, idx + "/data".length);
    }
  }
  // Fallback: walk up until we find a "data" directory
  let dir = path.dirname(filePath);
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === "data") return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`[indexer] Cannot derive dataDir from path: ${filePath}`);
}

/**
 * Process items in batches of a given size, with async processing per item.
 */
async function processBatch<T>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.all(batch.map(fn));
  }
}

// ─── Tileset indexing ────────────────────────────────────────────────────────

async function indexTilesets(
  dataDir: string,
  db: RagDb,
  counters: { indexed: number; skipped: number; errors: number },
): Promise<{ scannedIds: Set<string>; hashToPath: Map<string, string> }> {
  const tilesetsDir = path.join(dataDir, "tilesets");
  const pngFiles = walkDir(tilesetsDir, ".png");
  const scannedIds = new Set<string>();
  const hashToPath = new Map<string, string>();

  log(`Tilesets: found ${pngFiles.length} PNG files`);

  for (let i = 0; i < pngFiles.length; i++) {
    const filePath = pngFiles[i];
    const relPath = path.relative(dataDir, filePath);

    try {
      const fileBuffer = fs.readFileSync(filePath);
      const hash = sha256(fileBuffer);
      const externalId = hash;
      scannedIds.add(externalId);
      hashToPath.set(hash, filePath);

      // Check if this content hash is already indexed
      const existingMeta = db.getItemMetadata(KIND_TILESET, hash);
      if (existingMeta) {
        if (existingMeta.relPath === relPath) {
          // Same content, same path — skip entirely
          counters.skipped++;
          if ((i + 1) % TILESET_LOG_INTERVAL === 0) {
            log(`Tilesets: ${i + 1}/${pngFiles.length} processed (${counters.indexed} indexed, ${counters.skipped} skipped)`);
          }
          continue;
        }

        // Same content, different path — re-embed text, recompute image (can't read back from vec0)
        log(`Tileset [${i + 1}/${pngFiles.length}] path changed: ${existingMeta.relPath} → ${relPath}`);

        const [tileWidth, tileHeight] = parseTileSize(path.basename(filePath));
        const imgMeta = await sharp(fileBuffer).metadata();
        const imgWidth = imgMeta.width ?? 0;
        const imgHeight = imgMeta.height ?? 0;
        const cols = tileWidth > 0 ? Math.floor(imgWidth / tileWidth) : 0;
        const rows = tileHeight > 0 ? Math.floor(imgHeight / tileHeight) : 0;

        const textLabel = relPath
          .replace(/^tilesets\//, "")
          .replace(/\.png$/i, "")
          .replace(/[_/\\]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const textEmbedding = await embedText(textLabel);

        const imageEmbedding = await embedImage(filePath);
        db.updateMetadataAndReplaceEmbeddings(
          KIND_TILESET,
          externalId,
          { tileWidth, tileHeight, relPath, width: imgWidth, height: imgHeight, cols, rows },
          [imageEmbedding, textEmbedding],
        );

        counters.indexed++;
        if ((i + 1) % TILESET_LOG_INTERVAL === 0) {
          log(`Tilesets: ${i + 1}/${pngFiles.length} processed (${counters.indexed} indexed, ${counters.skipped} skipped)`);
        }
        continue;
      }

      // New tileset — full index
      const [tileWidth, tileHeight] = parseTileSize(path.basename(filePath));
      const embedding = await embedImage(filePath);

      const textLabel = relPath
        .replace(/^tilesets\//, "")
        .replace(/\.png$/i, "")
        .replace(/[_/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const textEmbedding = await embedText(textLabel);

      const imgMeta = await sharp(fileBuffer).metadata();
      const imgWidth = imgMeta.width ?? 0;
      const imgHeight = imgMeta.height ?? 0;
      const cols = tileWidth > 0 ? Math.floor(imgWidth / tileWidth) : 0;
      const rows = tileHeight > 0 ? Math.floor(imgHeight / tileHeight) : 0;

      db.upsertItem(
        KIND_TILESET,
        externalId,
        hash,
        { tileWidth, tileHeight, relPath, width: imgWidth, height: imgHeight, cols, rows },
        [],
        [embedding, textEmbedding],
        undefined,
        { width: imgWidth, height: imgHeight, fileSize: fileBuffer.length },
      );

      counters.indexed++;
      log(`Tileset [${i + 1}/${pngFiles.length}] indexed: ${relPath} (hash=${hash.slice(0, 8)})`);
    } catch (err) {
      counters.errors++;
      log(`Tilesets: error processing ${relPath}:`, err);
    }

    if ((i + 1) % TILESET_LOG_INTERVAL === 0) {
      log(`Tilesets: ${i + 1}/${pngFiles.length} processed (${counters.indexed} indexed, ${counters.skipped} skipped)`);
    }
  }

  log(`Tilesets: done. ${counters.indexed} indexed, ${counters.skipped} skipped, ${counters.errors} errors`);
  return { scannedIds, hashToPath };
}

// ─── Resource indexing ───────────────────────────────────────────────────────

async function indexResources(
  dataDir: string,
  db: RagDb,
  counters: { indexed: number; skipped: number; errors: number },
  hashToPath: Map<string, string>,
): Promise<Set<string>> {
  const resourcesDir = path.join(dataDir, "game", "resources");
  const jsonFiles = walkDir(resourcesDir, ".json");
  const existingHashes = db.getAllHashes(KIND_RESOURCE);
  const scannedIds = new Set<string>();

  log(`Resources: found ${jsonFiles.length} JSON files`);

  await processBatch(jsonFiles, RESOURCE_BATCH_SIZE, async (filePath) => {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const resource = JSON.parse(content) as ResourceJson;
      const externalId = resource.id;
      scannedIds.add(externalId);

      const hash = sha256(content);
      const storedHash = existingHashes.get(externalId);

      if (storedHash === hash) {
        counters.skipped++;
        return;
      }

      // Build text description from name + tags
      // e.g. "state:walk_dir:left entity:character name:seb state:walk dir:left"
      const tagValues = resource.tags.map((t) => t.replace(/:/g, " ")).join(" ");
      const description = `${resource.name.replace(/:/g, " ")} ${tagValues}`.trim();

      const textEmbedding = await embedText(description);

      const metadata: Record<string, unknown> = {
        name: resource.name,
        tags: resource.tags,
        frameCount: resource.frames.length,
      };

      if (resource.frames.length > 0) {
        metadata.tilesetId = resource.frames[0].tilesetId;
      }

      db.upsertItem(
        KIND_RESOURCE,
        externalId,
        hash,
        metadata,
        resource.tags,
        [textEmbedding],
      );

      counters.indexed++;
      log(`Resource indexed: ${externalId} "${resource.name}" [${resource.tags.join(', ')}] (hash=${hash.slice(0, 8)})`);
      if (resource.frames.length > 0) {
        const frame = resource.frames[0];
        try {
          const tilesetPath = resolveTilesetPath(dataDir, frame.tilesetId, hashToPath);
          if (!tilesetPath) {
            log(`Resources: cannot resolve tileset for ${externalId} (tilesetId=${frame.tilesetId.slice(0, 12)}…)`);
          } else {
            const [tileWidth, tileHeight] = parseTileSize(path.basename(tilesetPath));

            const spriteBuffer = await cropSpriteFrame(
              tilesetPath,
              frame.srcCol,
              frame.srcRow,
              frame.w,
              frame.h,
              tileWidth,
              tileHeight,
            );

            const imageEmbedding = await embedImageBuffer(spriteBuffer);

            db.upsertItem(
              KIND_RESOURCE_SPRITE,
              externalId,
              hash,
              metadata,
              resource.tags,
              [imageEmbedding],
            );
          }
        } catch (spriteErr) {
          // Non-fatal: text embedding was already stored
          log(`Resources: sprite embedding failed for ${externalId}:`, spriteErr);
        }
      }
    } catch (err) {
      counters.errors++;
      log(`Resources: error processing ${path.basename(filePath)}:`, err);
    }
  });

  log(`Resources: done. ${counters.indexed} indexed, ${counters.skipped} skipped, ${counters.errors} errors`);
  return scannedIds;
}

// ─── Composite indexing ──────────────────────────────────────────────────────

async function indexComposites(
  dataDir: string,
  db: RagDb,
  counters: { indexed: number; skipped: number; errors: number },
): Promise<Set<string>> {
  const compositesDir = path.join(dataDir, "game", "composites");
  const jsonFiles = walkDir(compositesDir, ".json");
  const existingHashes = db.getAllHashes(KIND_COMPOSITE);
  const scannedIds = new Set<string>();

  log(`Composites: found ${jsonFiles.length} JSON files`);

  for (const filePath of jsonFiles) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const composite = JSON.parse(content) as CompositeJson;
      const externalId = composite.id;
      scannedIds.add(externalId);

      const hash = sha256(content);
      const storedHash = existingHashes.get(externalId);

      if (storedHash === hash) {
        counters.skipped++;
        continue;
      }

      const description = `${composite.name} ${composite.category} composite with ${composite.parts.length} parts`;
      const textEmbedding = await embedText(description);

      const tags = [`category:${composite.category}`];

      const metadata: Record<string, unknown> = {
        name: composite.name,
        category: composite.category,
        partCount: composite.parts.length,
        displaySize: composite.displaySize,
      };

      db.upsertItem(
        KIND_COMPOSITE,
        externalId,
        hash,
        metadata,
        tags,
        [textEmbedding],
      );

      counters.indexed++;
      log(`Composite indexed: ${externalId} "${composite.name}" cat=${composite.category} (hash=${hash.slice(0, 8)})`);
    } catch (err) {
      counters.errors++;
      log(`Composites: error processing ${path.basename(filePath)}:`, err);
    }
  }

  log(`Composites: done. ${counters.indexed} indexed, ${counters.skipped} skipped, ${counters.errors} errors`);
  return scannedIds;
}

// ─── Room indexing ───────────────────────────────────────────────────────────

async function indexRooms(
  dataDir: string,
  db: RagDb,
  counters: { indexed: number; skipped: number; errors: number },
): Promise<Set<string>> {
  const roomsDir = path.join(dataDir, "game", "rooms");
  const jsonFiles = walkDir(roomsDir, ".json");
  const existingHashes = db.getAllHashes(KIND_ROOM);
  const scannedIds = new Set<string>();

  log(`Rooms: found ${jsonFiles.length} JSON files`);

  for (const filePath of jsonFiles) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const room = JSON.parse(content) as RoomJson;
      const externalId = room.name;
      scannedIds.add(externalId);

      const hash = sha256(content);
      const storedHash = existingHashes.get(externalId);

      if (storedHash === hash) {
        counters.skipped++;
        continue;
      }

      const description = `room ${room.name} ${room.width}x${room.height} with ${room.doors.length} doors and ${room.placements.length} placements`;
      const textEmbedding = await embedText(description);

      const metadata: Record<string, unknown> = {
        name: room.name,
        width: room.width,
        height: room.height,
        doorCount: room.doors.length,
        placementCount: room.placements.length,
      };

      db.upsertItem(
        KIND_ROOM,
        externalId,
        hash,
        metadata,
        [],
        [textEmbedding],
      );

      counters.indexed++;
      log(`Room indexed: ${externalId} "${room.name}" ${room.width}x${room.height} (hash=${hash.slice(0, 8)})`);
    } catch (err) {
      counters.errors++;
      log(`Rooms: error processing ${path.basename(filePath)}:`, err);
    }
  }

  log(`Rooms: done. ${counters.indexed} indexed, ${counters.skipped} skipped, ${counters.errors} errors`);
  return scannedIds;
}

// ─── Deletion detection ──────────────────────────────────────────────────────

function detectDeletions(
  db: RagDb,
  kind: string,
  scannedIds: Set<string>,
): number {
  const existingHashes = db.getAllHashes(kind);
  let deleted = 0;

  for (const [externalId] of existingHashes) {
    if (!scannedIds.has(externalId)) {
      db.deleteItem(kind, externalId);
      deleted++;
    }
  }

  if (deleted > 0) {
    log(`${kind}: deleted ${deleted} stale entries`);
  }
  return deleted;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Perform a full index of all tilesets, resources, composites, and rooms.
 * Skips items whose content hash hasn't changed since last index.
 */
export async function runFullIndex(dataDir: string, db: RagDb): Promise<IndexResult> {
  const t0 = performance.now();

  log("Starting full index...");
  log(`Data directory: ${dataDir}`);
  log(`Model: ${getModelId()}`);

  let totalIndexed = 0;
  let totalSkipped = 0;
  let totalDeleted = 0;
  let totalErrors = 0;

  // 1. Tilesets (sequential for memory safety)
  const tilesetCounters = { indexed: 0, skipped: 0, errors: 0 };
  const { scannedIds: scannedTilesets, hashToPath } = await indexTilesets(dataDir, db, tilesetCounters);
  totalIndexed += tilesetCounters.indexed;
  totalSkipped += tilesetCounters.skipped;
  totalErrors += tilesetCounters.errors;

  // 2. Resources (batched)
  const resourceCounters = { indexed: 0, skipped: 0, errors: 0 };
  const scannedResources = await indexResources(dataDir, db, resourceCounters, hashToPath);
  totalIndexed += resourceCounters.indexed;
  totalSkipped += resourceCounters.skipped;
  totalErrors += resourceCounters.errors;

  // 3. Composites
  const compositeCounters = { indexed: 0, skipped: 0, errors: 0 };
  const scannedComposites = await indexComposites(dataDir, db, compositeCounters);
  totalIndexed += compositeCounters.indexed;
  totalSkipped += compositeCounters.skipped;
  totalErrors += compositeCounters.errors;

  // 4. Rooms
  const roomCounters = { indexed: 0, skipped: 0, errors: 0 };
  const scannedRooms = await indexRooms(dataDir, db, roomCounters);
  totalIndexed += roomCounters.indexed;
  totalSkipped += roomCounters.skipped;
  totalErrors += roomCounters.errors;

  // 5. Detect deletions
  totalDeleted += detectDeletions(db, KIND_TILESET, scannedTilesets);
  totalDeleted += detectDeletions(db, KIND_RESOURCE, scannedResources);
  totalDeleted += detectDeletions(db, KIND_RESOURCE_SPRITE, scannedResources); // sprite IDs mirror resource IDs
  totalDeleted += detectDeletions(db, KIND_COMPOSITE, scannedComposites);
  totalDeleted += detectDeletions(db, KIND_ROOM, scannedRooms);

  const elapsed = performance.now() - t0;

  log(`Full index complete in ${(elapsed / 1000).toFixed(1)}s`);
  log(`  indexed: ${totalIndexed}, skipped: ${totalSkipped}, deleted: ${totalDeleted}, errors: ${totalErrors}`);

  const stats = db.getStats();
  log(`  DB totals: ${stats.total} items (${Object.entries(stats.byKind).map(([k, v]) => `${k}=${v}`).join(", ")})`);

  return {
    indexed: totalIndexed,
    skipped: totalSkipped,
    deleted: totalDeleted,
    errors: totalErrors,
    elapsed,
  };
}

/**
 * Index a single file (for the filesystem watcher).
 * Determines the kind from the file path and processes just that file.
 */
export async function indexSingleFile(
  filePath: string,
  db: RagDb,
): Promise<void> {
  const dataDir = deriveDataDir(filePath);
  const relPath = path.relative(dataDir, filePath);

  // Tileset PNG
  if (relPath.startsWith("tilesets/") && relPath.endsWith(".png")) {
    try {
      const fileBuffer = fs.readFileSync(filePath);
      const hash = sha256(fileBuffer);
      const externalId = hash;

      const existingMeta = db.getItemMetadata(KIND_TILESET, hash);
      if (existingMeta) {
        if (existingMeta.relPath === relPath) {
          log(`Single file: ${relPath} unchanged, skipping`);
          return;
        }

        // Path changed — update metadata + re-embed
        log(`Single file: tileset path changed: ${existingMeta.relPath} → ${relPath}`);

        const [tileWidth, tileHeight] = parseTileSize(path.basename(filePath));
        const imgMeta = await sharp(fileBuffer).metadata();
        const imgWidth = imgMeta.width ?? 0;
        const imgHeight = imgMeta.height ?? 0;
        const cols = tileWidth > 0 ? Math.floor(imgWidth / tileWidth) : 0;
        const rows = tileHeight > 0 ? Math.floor(imgHeight / tileHeight) : 0;

        const textLabel = relPath
          .replace(/^tilesets\//, "")
          .replace(/\.png$/i, "")
          .replace(/[_/\\]/g, " ")
          .replace(/\s+/g, " ")
          .trim();
        const textEmbedding = await embedText(textLabel);
        const imageEmbedding = await embedImage(filePath);

        db.updateMetadataAndReplaceEmbeddings(
          KIND_TILESET,
          externalId,
          { tileWidth, tileHeight, relPath, width: imgWidth, height: imgHeight, cols, rows },
          [imageEmbedding, textEmbedding],
        );

        log(`Single file: updated tileset metadata ${relPath}`);
        return;
      }

      // New tileset
      const [tileWidth, tileHeight] = parseTileSize(path.basename(filePath));
      const embedding = await embedImage(filePath);

      const textLabel = relPath
        .replace(/^tilesets\//, "")
        .replace(/\.png$/i, "")
        .replace(/[_/\\]/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      const textEmbedding = await embedText(textLabel);

      const imgMeta = await sharp(fileBuffer).metadata();
      const imgWidth = imgMeta.width ?? 0;
      const imgHeight = imgMeta.height ?? 0;
      const cols = tileWidth > 0 ? Math.floor(imgWidth / tileWidth) : 0;
      const rows = tileHeight > 0 ? Math.floor(imgHeight / tileHeight) : 0;

      db.upsertItem(
        KIND_TILESET,
        externalId,
        hash,
        { tileWidth, tileHeight, relPath, width: imgWidth, height: imgHeight, cols, rows },
        [],
        [embedding, textEmbedding],
        undefined,
        { width: imgWidth, height: imgHeight, fileSize: fileBuffer.length },
      );

      log(`Single file: indexed tileset ${relPath}`);
    } catch (err) {
      log(`Single file: error indexing tileset ${relPath}:`, err);
    }
    return;
  }

  // Resource JSON
  if (relPath.startsWith("game/resources/") && relPath.endsWith(".json")) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const resource = JSON.parse(content) as ResourceJson;
      const externalId = resource.id;
      const hash = sha256(content);
      const storedHash = db.getContentHash(KIND_RESOURCE, externalId);

      if (storedHash === hash) {
        log(`Single file: ${relPath} unchanged, skipping`);
        return;
      }

      const tagValues = resource.tags.map((t) => t.replace(/:/g, " ")).join(" ");
      const description = `${resource.name.replace(/:/g, " ")} ${tagValues}`.trim();
      const textEmbedding = await embedText(description);

      const metadata: Record<string, unknown> = {
        name: resource.name,
        tags: resource.tags,
        frameCount: resource.frames.length,
      };
      if (resource.frames.length > 0) {
        metadata.tilesetId = resource.frames[0].tilesetId;
      }

      db.upsertItem(KIND_RESOURCE, externalId, hash, metadata, resource.tags, [textEmbedding]);

      // Sprite image embedding
      if (resource.frames.length > 0) {
        const frame = resource.frames[0];
        try {
          const tilesetPath = resolveTilesetPath(dataDir, frame.tilesetId, undefined, db);
          if (!tilesetPath) {
            log(`Single file: cannot resolve tileset for ${externalId} (tilesetId=${frame.tilesetId.slice(0, 12)}…)`);
          } else {
            const [tileWidth, tileHeight] = parseTileSize(path.basename(tilesetPath));

            const spriteBuffer = await cropSpriteFrame(
              tilesetPath,
              frame.srcCol,
              frame.srcRow,
              frame.w,
              frame.h,
              tileWidth,
              tileHeight,
            );

            const imageEmbedding = await embedImageBuffer(spriteBuffer);
            db.upsertItem(KIND_RESOURCE_SPRITE, externalId, hash, metadata, resource.tags, [imageEmbedding]);
          }
        } catch (spriteErr) {
          log(`Single file: sprite embedding failed for ${externalId}:`, spriteErr);
        }
      }

      log(`Single file: indexed resource ${externalId}`);
    } catch (err) {
      log(`Single file: error indexing resource ${relPath}:`, err);
    }
    return;
  }

  // Composite JSON
  if (relPath.startsWith("game/composites/") && relPath.endsWith(".json")) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const composite = JSON.parse(content) as CompositeJson;
      const externalId = composite.id;
      const hash = sha256(content);
      const storedHash = db.getContentHash(KIND_COMPOSITE, externalId);

      if (storedHash === hash) {
        log(`Single file: ${relPath} unchanged, skipping`);
        return;
      }

      const description = `${composite.name} ${composite.category} composite with ${composite.parts.length} parts`;
      const textEmbedding = await embedText(description);

      const tags = [`category:${composite.category}`];
      const metadata: Record<string, unknown> = {
        name: composite.name,
        category: composite.category,
        partCount: composite.parts.length,
        displaySize: composite.displaySize,
      };

      db.upsertItem(KIND_COMPOSITE, externalId, hash, metadata, tags, [textEmbedding]);
      log(`Single file: indexed composite ${externalId}`);
    } catch (err) {
      log(`Single file: error indexing composite ${relPath}:`, err);
    }
    return;
  }

  // Room JSON
  if (relPath.startsWith("game/rooms/") && relPath.endsWith(".json")) {
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const room = JSON.parse(content) as RoomJson;
      const externalId = room.name;
      const hash = sha256(content);
      const storedHash = db.getContentHash(KIND_ROOM, externalId);

      if (storedHash === hash) {
        log(`Single file: ${relPath} unchanged, skipping`);
        return;
      }

      const description = `room ${room.name} ${room.width}x${room.height} with ${room.doors.length} doors and ${room.placements.length} placements`;
      const textEmbedding = await embedText(description);

      const metadata: Record<string, unknown> = {
        name: room.name,
        width: room.width,
        height: room.height,
        doorCount: room.doors.length,
        placementCount: room.placements.length,
      };

      db.upsertItem(KIND_ROOM, externalId, hash, metadata, [], [textEmbedding]);
      log(`Single file: indexed room ${externalId}`);
    } catch (err) {
      log(`Single file: error indexing room ${relPath}:`, err);
    }
    return;
  }

  log(`Single file: unknown file type, ignoring: ${relPath}`);
}

/**
 * Remove a single file's entries from the index (for the filesystem watcher).
 * Determines the kind from the file path and deletes the corresponding DB entries.
 */
export async function removeSingleFile(
  filePath: string,
  db: RagDb,
): Promise<void> {
  const dataDir = deriveDataDir(filePath);
  const relPath = path.relative(dataDir, filePath);

  // Tileset PNG
  if (relPath.startsWith("tilesets/") && relPath.endsWith(".png")) {
    // NOTE: externalId for tilesets is now the content hash, but we can't compute
    // it for a deleted file. A full reindex will clean up stale entries.
    // For now, try the old relPath-based deletion as a best-effort.
    db.deleteItem(KIND_TILESET, relPath);
    log(`Removed tileset (best-effort, may need reindex): ${relPath}`);
    return;
  }

  // Resource JSON — we need the resource id, which is the filename stem
  if (relPath.startsWith("game/resources/") && relPath.endsWith(".json")) {
    const stem = path.basename(filePath, ".json");
    db.deleteItem(KIND_RESOURCE, stem);
    db.deleteItem(KIND_RESOURCE_SPRITE, stem);
    log(`Removed resource: ${stem}`);
    return;
  }

  // Composite JSON — the id is the filename stem
  if (relPath.startsWith("game/composites/") && relPath.endsWith(".json")) {
    const stem = path.basename(filePath, ".json");
    db.deleteItem(KIND_COMPOSITE, stem);
    log(`Removed composite: ${stem}`);
    return;
  }

  // Room JSON — the id is the filename stem (room name)
  if (relPath.startsWith("game/rooms/") && relPath.endsWith(".json")) {
    const stem = path.basename(filePath, ".json");
    db.deleteItem(KIND_ROOM, stem);
    log(`Removed room: ${stem}`);
    return;
  }

  log(`Remove: unknown file type, ignoring: ${relPath}`);
}
