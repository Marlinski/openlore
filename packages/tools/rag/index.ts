/**
 * RAG system main entry point.
 *
 * Initializes CLIP, opens the vector database, runs the initial index,
 * starts the filesystem watcher, and returns a search API object that
 * the Vite middleware can use.
 */

import fs from "node:fs";
import path from "node:path";
import { initClip, embedText, embedImage, embedImageBuffer, getModelId } from "./clip.js";
import { initDb, type RagDb, type SearchResult, type RagDbStats } from "./db.js";
import { runFullIndex, type IndexResult } from "./indexer.js";
import { startWatcher, type WatcherHandle } from "./watcher.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export type { SearchResult, RagDbStats, IndexResult };

export interface RagApi {
  /** Semantic search: embed the query text with CLIP, do KNN search */
  search(query: string, opts?: { kind?: string; limit?: number }): Promise<SearchResult[]>;

  /** Find items visually similar to an image */
  searchByImage(imagePath: string, opts?: { kind?: string; limit?: number }): Promise<SearchResult[]>;

  /** Find items visually similar to an image buffer */
  searchByImageBuffer(buffer: Buffer, opts?: { kind?: string; limit?: number }): Promise<SearchResult[]>;

  /** Find items matching all given tags */
  searchByTags(tags: string[], opts?: { kind?: string; limit?: number }): SearchResult[];

  /** Autocomplete tags */
  tagAutocomplete(prefix: string, limit?: number): string[];

  /** Get indexing stats */
  getStats(): RagDbStats;

  /** Trigger a manual re-index */
  reindex(): Promise<IndexResult>;

  /** Search tilesets with unified text + semantic search, area filtering */
  searchTilesets(opts: {
    q?: string;
    minArea?: number;
    maxArea?: number;
    limit?: number;
  }): Promise<{
    results: {
      contentHash: string;
      label: string;
      relPath: string;
      tileWidth: number;
      tileHeight: number;
      cols: number;
      rows: number;
      area: number;
      width: number;
      height: number;
      source: "text" | "semantic";
      distance: number | null;
    }[];
    totalTextMatches: number;
  }>;

  /** Get the min/max area range across all indexed tilesets */
  getTilesetAreaRange(): { min: number; max: number };

  /** Resolve a content hash to its item info */
  resolveHash(hash: string): { externalId: string; metadata: Record<string, unknown>; width: number; height: number; fileSize: number } | null;

  /** Shutdown: close watcher and DB */
  close(): void;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(...args: unknown[]) {
  console.log("[rag]", ...args);
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * Initialize the RAG system: load CLIP, open DB, run initial index, start watcher.
 * Called from the Vite plugin's configureServer hook.
 * Returns a search API object that the Vite middleware can use.
 */
export async function initRag(dataDir: string): Promise<RagApi> {
  const modelsDir = path.join(dataDir, "models", "clip-vit-base-patch32");
  const onnxDir = path.join(modelsDir, "onnx");

  // Check if CLIP models exist
  if (!fs.existsSync(onnxDir)) {
    log(`CLIP models not found at ${onnxDir}`);
    log("Running in degraded mode — metadata-only search (no semantic/image search).");
    return createDegradedApi(dataDir);
  }

  // 1. Load CLIP models
  await initClip(modelsDir);

  // 2. Open the database
  const db = initDb(dataDir, getModelId());

  // 3. Kick off full index in the background (don't await)
  runFullIndex(dataDir, db).catch((err) => {
    log("Background indexing failed:", err);
  });

  // 4. Start filesystem watcher
  const watcher = startWatcher(dataDir, db);

  // 5. Return the API
  return createApi(db, watcher, dataDir);
}

// ─── API construction ────────────────────────────────────────────────────────

function createApi(db: RagDb, watcher: WatcherHandle, dataDir: string): RagApi {
  return {
    async search(query, opts) {
      const embedding = await embedText(query);
      return db.searchByVector(embedding, opts);
    },

    async searchByImage(imagePath, opts) {
      const embedding = await embedImage(imagePath);
      return db.searchByVector(embedding, opts);
    },

    async searchByImageBuffer(buffer, opts) {
      const embedding = await embedImageBuffer(buffer);
      return db.searchByVector(embedding, opts);
    },

    searchByTags(tags, opts) {
      return db.searchByTags(tags, opts);
    },

    tagAutocomplete(prefix, limit) {
      return db.searchByTagPrefix(prefix, limit);
    },

    getStats() {
      return db.getStats();
    },

    async reindex() {
      return runFullIndex(dataDir, db);
    },

    async searchTilesets(opts) {
      let embedding: Float32Array | undefined;
      if (opts.q && opts.q.trim().length >= 2) {
        embedding = await embedText(opts.q);
      }
      return db.searchTilesets({ ...opts, embedding });
    },

    getTilesetAreaRange() {
      return db.getTilesetAreaRange();
    },

    resolveHash(hash) {
      const item = db.getByHash(hash);
      if (!item) return null;
      return {
        externalId: item.externalId,
        metadata: item.metadata,
        width: item.width ?? 0,
        height: item.height ?? 0,
        fileSize: item.fileSize ?? 0,
      };
    },

    close() {
      log("Shutting down...");
      watcher.close();
      db.close();
      log("Shutdown complete.");
    },
  };
}

/**
 * Create a degraded API that only supports tag-based search.
 * Used when CLIP models are not available.
 */
function createDegradedApi(dataDir: string): RagApi {
  const db = initDb(dataDir, "none");

  return {
    async search(_query, _opts) {
      log("Semantic search unavailable — CLIP models not loaded.");
      return [];
    },

    async searchByImage(_imagePath, _opts) {
      log("Image search unavailable — CLIP models not loaded.");
      return [];
    },

    async searchByImageBuffer(_buffer, _opts) {
      log("Image search unavailable — CLIP models not loaded.");
      return [];
    },

    searchByTags(tags, opts) {
      return db.searchByTags(tags, opts);
    },

    tagAutocomplete(prefix, limit) {
      return db.searchByTagPrefix(prefix, limit);
    },

    getStats() {
      return db.getStats();
    },

    async reindex() {
      log("Re-index unavailable — CLIP models not loaded.");
      return { indexed: 0, skipped: 0, deleted: 0, errors: 0, elapsed: 0 };
    },

    async searchTilesets(_opts) {
      return { results: [], totalTextMatches: 0 };
    },

    getTilesetAreaRange() {
      return { min: 1, max: 1 };
    },

    resolveHash(_hash) {
      return null;
    },

    close() {
      db.close();
    },
  };
}
