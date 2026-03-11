import Database from "better-sqlite3";
import * as sqliteVec from "sqlite-vec";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

type Db = InstanceType<typeof Database>;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SearchResult {
  id: number;
  kind: string;
  externalId: string;
  contentHash: string;
  metadata: Record<string, unknown>;
  tags: string[];
  distance: number;
}

export interface RagDbStats {
  total: number;
  byKind: Record<string, number>;
  models: string[];
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS models (
  id INTEGER PRIMARY KEY,
  model_id TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  metadata TEXT NOT NULL,
  width           INTEGER,
  height          INTEGER,
  file_size       INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE(kind, external_id)
);

CREATE TABLE IF NOT EXISTS tags (
  item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  tag TEXT NOT NULL,
  PRIMARY KEY (item_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);
CREATE INDEX IF NOT EXISTS idx_items_content_hash ON items(content_hash);

CREATE VIRTUAL TABLE IF NOT EXISTS embeddings USING vec0(
  item_id INTEGER NOT NULL,
  model_id INTEGER NOT NULL,
  embedding float[512],
  kind TEXT NOT NULL partition key
);
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args: unknown[]) {
  console.log("[rag-db]", ...args);
}

function resolveModelId(db: Db, modelId: string): number {
  const row = db
    .prepare<[string], { id: number }>("SELECT id FROM models WHERE model_id = ?")
    .get(modelId);
  if (row) return row.id;
  const info = db.prepare("INSERT INTO models (model_id) VALUES (?)").run(modelId);
  return Number(info.lastInsertRowid);
}

function tagsForItem(db: Db, itemId: number): string[] {
  const rows = db
    .prepare<[number], { tag: string }>("SELECT tag FROM tags WHERE item_id = ?")
    .all(itemId);
  return rows.map((r) => r.tag);
}

// ---------------------------------------------------------------------------
// RagDb
// ---------------------------------------------------------------------------

export class RagDb {
  private db: Db;
  private defaultModelNumericId: number;
  private defaultModelId: string;

  // Prepared statements – initialized eagerly in constructor
  private stmtGetHash!: Database.Statement<[string, string], { content_hash: string }>;
  private stmtGetItem!: Database.Statement<[string, string], { id: number; kind: string; external_id: string; metadata: string; width: number | null; height: number | null; file_size: number | null }>;
  private stmtInsertItem!: Database.Statement<[string, string, string, string, number | null, number | null, number | null]>;
  private stmtUpdateItem!: Database.Statement<[string, string, number | null, number | null, number | null, string, string]>;
  private stmtDeleteItem!: Database.Statement<[string, string]>;
  private stmtDeleteTags!: Database.Statement<[number]>;
  private stmtInsertTag!: Database.Statement<[number, string]>;
  private stmtDeleteEmbeddings!: Database.Statement<[bigint]>;
  private stmtInsertEmbedding!: Database.Statement<[bigint, bigint, Float32Array, string]>;
  private stmtSearchVecKind!: Database.Statement<[Float32Array, string, number], { item_id: number; distance: number }>;
  private stmtSearchVec!: Database.Statement<[Float32Array, number], { item_id: number; distance: number }>;
  private stmtGetByHash!: Database.Statement<[string], { id: number; kind: string; external_id: string; content_hash: string; metadata: string; width: number | null; height: number | null; file_size: number | null }>;
  private stmtGetTilesetAreaRange!: Database.Statement<[], { min_area: number | null; max_area: number | null }>;

  constructor(db: Db, defaultModelId: string) {
    this.db = db;
    this.defaultModelId = defaultModelId;
    this.defaultModelNumericId = resolveModelId(db, defaultModelId);
    this.prepareStatements();
  }

  private prepareStatements(): void {
    this.stmtGetHash = this.db.prepare<[string, string], { content_hash: string }>(
      "SELECT content_hash FROM items WHERE kind = ? AND external_id = ?",
    );
    this.stmtGetItem = this.db.prepare<
      [string, string],
      { id: number; kind: string; external_id: string; metadata: string; width: number | null; height: number | null; file_size: number | null }
    >("SELECT id, kind, external_id, metadata, width, height, file_size FROM items WHERE kind = ? AND external_id = ?");
    this.stmtInsertItem = this.db.prepare(
      `INSERT INTO items (kind, external_id, content_hash, metadata, width, height, file_size, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`,
    );
    this.stmtUpdateItem = this.db.prepare(
      `UPDATE items SET content_hash = ?, metadata = ?, width = ?, height = ?, file_size = ?, updated_at = unixepoch()
       WHERE kind = ? AND external_id = ?`,
    );
    this.stmtDeleteItem = this.db.prepare("DELETE FROM items WHERE kind = ? AND external_id = ?");
    this.stmtDeleteTags = this.db.prepare("DELETE FROM tags WHERE item_id = ?");
    this.stmtInsertTag = this.db.prepare("INSERT INTO tags (item_id, tag) VALUES (?, ?)");
    this.stmtDeleteEmbeddings = this.db.prepare("DELETE FROM embeddings WHERE item_id = ?");
    this.stmtInsertEmbedding = this.db.prepare(
      `INSERT INTO embeddings (item_id, model_id, embedding, kind)
       VALUES (?, ?, ?, ?)`,
    );
    this.stmtSearchVecKind = this.db.prepare<
      [Float32Array, string, number],
      { item_id: number; distance: number }
    >(
      `SELECT item_id, distance FROM embeddings
       WHERE embedding MATCH ? AND kind = ?
       ORDER BY distance LIMIT ?`,
    );
    this.stmtSearchVec = this.db.prepare<
      [Float32Array, number],
      { item_id: number; distance: number }
    >(
      `SELECT item_id, distance FROM embeddings
       WHERE embedding MATCH ?
       ORDER BY distance LIMIT ?`,
    );
    this.stmtGetByHash = this.db.prepare<
      [string],
      { id: number; kind: string; external_id: string; content_hash: string; metadata: string; width: number | null; height: number | null; file_size: number | null }
    >("SELECT id, kind, external_id, content_hash, metadata, width, height, file_size FROM items WHERE content_hash = ?");
    this.stmtGetTilesetAreaRange = this.db.prepare<
      [],
      { min_area: number | null; max_area: number | null }
    >(
      `SELECT
        MIN(json_extract(metadata, '$.cols') * json_extract(metadata, '$.rows')) as min_area,
        MAX(json_extract(metadata, '$.cols') * json_extract(metadata, '$.rows')) as max_area
      FROM items WHERE kind = 'tileset'`,
    );
  }

  // -- Public API -----------------------------------------------------------

  getContentHash(kind: string, externalId: string): string | null {
    const row = this.stmtGetHash.get(kind, externalId);
    return row ? row.content_hash : null;
  }

  getItemMetadata(kind: string, externalId: string): Record<string, unknown> | null {
    const row = this.stmtGetItem.get(kind, externalId);
    if (!row) return null;
    return JSON.parse(row.metadata) as Record<string, unknown>;
  }

  upsertItem(
    kind: string,
    externalId: string,
    contentHash: string,
    metadata: object,
    tags: string[],
    embeddings: Float32Array[],
    modelId?: string,
    dimensions?: { width: number; height: number; fileSize: number },
  ): number {
    const numericModelId = modelId
      ? resolveModelId(this.db, modelId)
      : this.defaultModelNumericId;
    const metadataJson = JSON.stringify(metadata);
    const w = dimensions?.width ?? null;
    const h = dimensions?.height ?? null;
    const fs = dimensions?.fileSize ?? null;

    const run = this.db.transaction(() => {
      const existing = this.stmtGetItem.get(kind, externalId);

      let itemId: number;
      if (existing) {
        itemId = existing.id;
        this.stmtUpdateItem.run(contentHash, metadataJson, w, h, fs, kind, externalId);
        this.stmtDeleteTags.run(itemId);
        this.stmtDeleteEmbeddings.run(BigInt(itemId));
      } else {
        const info = this.stmtInsertItem.run(kind, externalId, contentHash, metadataJson, w, h, fs);
        itemId = Number(info.lastInsertRowid);
      }

      for (const tag of tags) {
        this.stmtInsertTag.run(itemId, tag);
      }

      for (const emb of embeddings) {
        this.stmtInsertEmbedding.run(
          BigInt(itemId),
          BigInt(numericModelId),
          emb,
          kind,
        );
      }

      return itemId;
    });

    return run();
  }

  /**
   * Update metadata and replace only the text embedding(s) for an existing item.
   * Keeps the image embedding intact by deleting all embeddings and re-inserting
   * both the existing image embedding and the new text embedding.
   * 
   * For tilesets: the image embedding (index 0) is preserved, and the text
   * embedding (index 1) is replaced. Pass the new full embeddings array.
   */
  updateMetadataAndReplaceEmbeddings(
    kind: string,
    externalId: string,
    metadata: object,
    embeddings: Float32Array[],
    modelId?: string,
  ): void {
    const numericModelId = modelId
      ? resolveModelId(this.db, modelId)
      : this.defaultModelNumericId;
    const metadataJson = JSON.stringify(metadata);

    const run = this.db.transaction(() => {
      const existing = this.stmtGetItem.get(kind, externalId);
      if (!existing) return;

      // Update metadata only (keep content_hash, width, height, file_size unchanged)
      this.db.prepare(
        `UPDATE items SET metadata = ?, updated_at = unixepoch() WHERE id = ?`,
      ).run(metadataJson, existing.id);

      // Replace all embeddings
      this.stmtDeleteEmbeddings.run(BigInt(existing.id));
      for (const emb of embeddings) {
        this.stmtInsertEmbedding.run(
          BigInt(existing.id),
          BigInt(numericModelId),
          emb,
          kind,
        );
      }
    });

    run();
  }

  deleteItem(kind: string, externalId: string): void {
    const existing = this.stmtGetItem.get(kind, externalId);
    if (!existing) return;

    const run = this.db.transaction(() => {
      this.stmtDeleteEmbeddings.run(BigInt(existing.id));
      this.stmtDeleteTags.run(existing.id);
      this.stmtDeleteItem.run(kind, externalId);
    });
    run();
  }

  searchByVector(
    embedding: Float32Array,
    opts?: { kind?: string; limit?: number; modelId?: string },
  ): SearchResult[] {
    const limit = opts?.limit ?? 20;
    const overfetch = limit * 2;

    let rows: { item_id: number; distance: number }[];
    if (opts?.kind) {
      rows = this.stmtSearchVecKind.all(embedding, opts.kind, overfetch);
    } else {
      rows = this.stmtSearchVec.all(embedding, overfetch);
    }

    // Deduplicate: keep the closest (smallest distance) per item_id
    const bestByItem = new Map<number, { item_id: number; distance: number }>();
    for (const row of rows) {
      const existing = bestByItem.get(row.item_id);
      if (!existing || row.distance < existing.distance) {
        bestByItem.set(row.item_id, row);
      }
    }

    // Sort by distance and trim to requested limit
    const deduped = [...bestByItem.values()]
      .sort((a, b) => a.distance - b.distance)
      .slice(0, limit);

    return this.hydrate(deduped);
  }

  searchByTags(
    tags: string[],
    opts?: { kind?: string; limit?: number },
  ): SearchResult[] {
    if (tags.length === 0) return [];
    const limit = opts?.limit ?? 50;

    const placeholders = tags.map(() => "?").join(", ");
    let sql = `
      SELECT t.item_id
      FROM tags t
      JOIN items i ON i.id = t.item_id
      WHERE t.tag IN (${placeholders})
    `;
    const params: (string | number)[] = [...tags];

    if (opts?.kind) {
      sql += " AND i.kind = ?";
      params.push(opts.kind);
    }

    sql += ` GROUP BY t.item_id HAVING COUNT(DISTINCT t.tag) = ? LIMIT ?`;
    params.push(tags.length, limit);

    const rows = this.db
      .prepare<unknown[], { item_id: number }>(sql)
      .all(...params);

    return this.hydrate(rows.map((r) => ({ item_id: r.item_id, distance: 0 })));
  }

  searchByTagPrefix(prefix: string, limit = 20): string[] {
    const rows = this.db
      .prepare<[string, number], { tag: string }>(
        `SELECT DISTINCT tag FROM tags WHERE tag GLOB ? LIMIT ?`,
      )
      .all(`${prefix}*`, limit);
    return rows.map((r) => r.tag);
  }

  getStats(): RagDbStats {
    const total =
      this.db.prepare<[], { c: number }>("SELECT COUNT(*) as c FROM items").get()?.c ?? 0;

    const kindRows = this.db
      .prepare<[], { kind: string; c: number }>(
        "SELECT kind, COUNT(*) as c FROM items GROUP BY kind",
      )
      .all();
    const byKind: Record<string, number> = {};
    for (const row of kindRows) {
      byKind[row.kind] = row.c;
    }

    const modelRows = this.db
      .prepare<[], { model_id: string }>("SELECT model_id FROM models")
      .all();

    return {
      total,
      byKind,
      models: modelRows.map((r) => r.model_id),
    };
  }

  getAllHashes(kind: string): Map<string, string> {
    const rows = this.db
      .prepare<[string], { external_id: string; content_hash: string }>(
        "SELECT external_id, content_hash FROM items WHERE kind = ?",
      )
      .all(kind);

    const map = new Map<string, string>();
    for (const row of rows) {
      map.set(row.external_id, row.content_hash);
    }
    return map;
  }

  getByHash(contentHash: string): {
    id: number;
    kind: string;
    externalId: string;
    contentHash: string;
    metadata: Record<string, unknown>;
    width: number | null;
    height: number | null;
    fileSize: number | null;
  } | null {
    const row = this.stmtGetByHash.get(contentHash);
    if (!row) return null;
    return {
      id: row.id,
      kind: row.kind,
      externalId: row.external_id,
      contentHash: row.content_hash,
      metadata: JSON.parse(row.metadata) as Record<string, unknown>,
      width: row.width,
      height: row.height,
      fileSize: row.file_size,
    };
  }

  getTilesetAreaRange(): { min: number; max: number } {
    const row = this.stmtGetTilesetAreaRange.get();
    return { min: row?.min_area ?? 1, max: row?.max_area ?? 1 };
  }

  searchTilesets(opts: {
    q?: string;
    minArea?: number;
    maxArea?: number;
    limit?: number;
    embedding?: Float32Array;
  }): {
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
  } {
    const limit = opts.limit ?? 50;

    // ---- Text/substring results ----
    const conditions: string[] = ["kind = 'tileset'"];
    const params: unknown[] = [];

    if (opts.minArea != null) {
      conditions.push("json_extract(metadata, '$.cols') * json_extract(metadata, '$.rows') >= ?");
      params.push(opts.minArea);
    }
    if (opts.maxArea != null) {
      conditions.push("json_extract(metadata, '$.cols') * json_extract(metadata, '$.rows') <= ?");
      params.push(opts.maxArea);
    }

    const tokens = opts.q
      ? opts.q.trim().split(/\s+/).filter((t) => t.length > 0)
      : [];
    for (const token of tokens) {
      conditions.push("json_extract(metadata, '$.relPath') LIKE ?");
      params.push(`%${token}%`);
    }

    const whereClause = conditions.join(" AND ");

    // Count total matches before limit
    const countSql = `SELECT COUNT(*) as c FROM items WHERE ${whereClause}`;
    const totalTextMatches =
      (this.db.prepare<unknown[], { c: number }>(countSql).get(...params) as { c: number } | undefined)?.c ?? 0;

    // Fetch text results
    const orderBy = tokens.length > 0
      ? "json_extract(metadata, '$.cols') * json_extract(metadata, '$.rows') DESC"
      : "json_extract(metadata, '$.cols') * json_extract(metadata, '$.rows') DESC";
    const selectSql = `SELECT content_hash, metadata FROM items WHERE ${whereClause} ORDER BY ${orderBy} LIMIT ?`;
    const textRows = this.db
      .prepare<unknown[], { content_hash: string; metadata: string }>(selectSql)
      .all(...params, limit);

    type ResultRow = {
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
    };

    const seen = new Set<string>();
    const results: ResultRow[] = [];

    for (const row of textRows) {
      const meta = JSON.parse(row.metadata) as Record<string, unknown>;
      const relPath = (meta.relPath as string) ?? "";
      const cols = (meta.cols as number) ?? 0;
      const rows = (meta.rows as number) ?? 0;
      const tileWidth = (meta.tileWidth as number) ?? 0;
      const tileHeight = (meta.tileHeight as number) ?? 0;
      const label = relPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? relPath;
      results.push({
        contentHash: row.content_hash,
        label,
        relPath,
        tileWidth,
        tileHeight,
        cols,
        rows,
        area: cols * rows,
        width: cols * tileWidth,
        height: rows * tileHeight,
        source: "text",
        distance: null,
      });
      seen.add(row.content_hash);
    }

    // ---- Semantic/vector results ----
    if (opts.embedding) {
      const vecResults = this.searchByVector(opts.embedding, {
        kind: "tileset",
        limit,
      });
      for (const vr of vecResults) {
        if (seen.has(vr.contentHash)) continue;
        const meta = vr.metadata;
        const relPath = (meta.relPath as string) ?? "";
        const cols = (meta.cols as number) ?? 0;
        const rows = (meta.rows as number) ?? 0;
        const tileWidth = (meta.tileWidth as number) ?? 0;
        const tileHeight = (meta.tileHeight as number) ?? 0;
        const label = relPath.split("/").pop()?.replace(/\.[^.]+$/, "") ?? relPath;
        results.push({
          contentHash: vr.contentHash,
          label,
          relPath,
          tileWidth,
          tileHeight,
          cols,
          rows,
          area: cols * rows,
          width: cols * tileWidth,
          height: rows * tileHeight,
          source: "semantic",
          distance: vr.distance,
        });
        seen.add(vr.contentHash);
        if (results.length >= limit) break;
      }
    }

    return { results: results.slice(0, limit), totalTextMatches };
  }

  close(): void {
    log("closing database");
    this.db.close();
  }

  // -- Internal helpers -----------------------------------------------------

  private hydrate(
    rows: { item_id: number; distance: number }[],
  ): SearchResult[] {
    const stmtItem = this.db.prepare<
      [number],
      { id: number; kind: string; external_id: string; content_hash: string; metadata: string }
    >("SELECT id, kind, external_id, content_hash, metadata FROM items WHERE id = ?");

    const results: SearchResult[] = [];
    for (const row of rows) {
      const item = stmtItem.get(row.item_id);
      if (!item) continue;
      results.push({
        id: item.id,
        kind: item.kind,
        externalId: item.external_id,
        contentHash: item.content_hash,
        metadata: JSON.parse(item.metadata) as Record<string, unknown>,
        tags: tagsForItem(this.db, item.id),
        distance: row.distance,
      });
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function initDb(dataDir: string, modelId: string): RagDb {
  const dbPath = join(dataDir, "rag.db");
  mkdirSync(dataDir, { recursive: true });

  log(`opening database at ${dbPath}`);
  const db = new Database(dbPath);

  // Load sqlite-vec extension
  sqliteVec.load(db);
  log("sqlite-vec extension loaded");

  // Performance pragmas
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // Run schema migrations
  const statements = SCHEMA.split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  for (const stmt of statements) {
    db.exec(stmt);
  }
  log("schema migrations applied");

  const ragDb = new RagDb(db, modelId);
  log(`initialized with model "${modelId}"`);

  return ragDb;
}
