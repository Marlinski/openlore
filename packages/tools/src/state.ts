/**
 * Shared application state across all tabs.
 * Persists to disk via the FS API (Vite plugin middleware).
 *
 * Data layout on disk (under data/game/):
 *   tilesets.json        — array of TilesetDefinition (user overrides only)
 *   characters.json      — array of CharacterDefinition
 *   resources/<id>.json  — one Resource per file
 *   composites/<id>.json — one CompositeObject per file
 *   rooms/<name>.json    — one RoomDefinition per file (keyed by name)
 *   masks/<id>.json      — one Mask per file
 *
 * Each mutation writes only the affected file(s) — no monolithic save.
 * No localStorage, no server sync — the files on disk are the single source of truth.
 */

import type { CompositeObject, RoomDefinition, CharacterDefinition, CharacterAnimation, CharacterDirection, TilesetDefinition, Resource, Mask } from "@offisims/shared";
import { CHARACTER_DIRECTIONS, findTileset, charTilesetId, makeCharTileset } from "@offisims/shared";

/** Base path for all game data, relative to data/ */
const BASE = "game";

type Listener = () => void;

// ─── FS helpers ──────────────────────────────────────────────────

/** Write a JSON file to data/<relPath> */
async function fsWrite(relPath: string, data: unknown): Promise<void> {
  try {
    const resp = await fetch(`/fs/write?path=${encodeURIComponent(relPath)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data, null, 2),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.error(`[AppState] Failed to write ${relPath}:`, err);
    }
  } catch (err) {
    console.error(`[AppState] Failed to write ${relPath}:`, err);
  }
}

/** Delete a file at data/<relPath>. Silently ignores 404. */
async function fsDelete(relPath: string): Promise<void> {
  try {
    const resp = await fetch(`/fs/delete?path=${encodeURIComponent(relPath)}`, {
      method: "DELETE",
    });
    if (!resp.ok && resp.status !== 404) {
      const err = await resp.json().catch(() => ({ error: resp.statusText }));
      console.error(`[AppState] Failed to delete ${relPath}:`, err);
    }
  } catch (err) {
    console.error(`[AppState] Failed to delete ${relPath}:`, err);
  }
}

/** Read a JSON file from data/<relPath>. Returns null on 404 or error. */
async function fsReadJSON<T>(relPath: string): Promise<T | null> {
  try {
    const resp = await fetch(`/fs/read?path=${encodeURIComponent(relPath)}`);
    if (resp.ok) return await resp.json() as T;
    if (resp.status !== 404) {
      console.warn(`[AppState] Failed to read ${relPath}: ${resp.status}`);
    }
    return null;
  } catch (err) {
    console.warn(`[AppState] Failed to read ${relPath}:`, err);
    return null;
  }
}

/** Read all JSON files in a directory. Returns parsed objects keyed by filename. */
async function fsReadDir<T>(relDir: string): Promise<Record<string, T>> {
  try {
    const resp = await fetch(`/fs/read-dir?dir=${encodeURIComponent(relDir)}`);
    if (resp.ok) {
      const { files } = await resp.json() as { files: Record<string, T> };
      return files;
    }
    if (resp.status !== 404) {
      console.warn(`[AppState] Failed to read dir ${relDir}: ${resp.status}`);
    }
    return {};
  } catch (err) {
    console.warn(`[AppState] Failed to read dir ${relDir}:`, err);
    return {};
  }
}

// ─── AppState ────────────────────────────────────────────────────

class AppState {
  tilesets: TilesetDefinition[] = [];
  composites: CompositeObject[] = [];
  rooms: RoomDefinition[] = [];
  characters: CharacterDefinition[] = [];
  resources: Resource[] = [];
  masks: Mask[] = [];
  private listeners: Listener[] = [];

  /**
   * IDs of tilesets that were explicitly saved (user overrides).
   * Only these get serialized to tilesets.json — scanned tilesets are ephemeral.
   */
  private _savedTilesetIds = new Set<string>();

  /** Whether initial load from disk has completed */
  private _ready = false;
  /** Promise that resolves when initial load is done */
  private _readyPromise: Promise<void>;
  private _resolveReady!: () => void;

  constructor() {
    this._readyPromise = new Promise((resolve) => {
      this._resolveReady = resolve;
    });
    this.loadFromDisk();
  }

  /** Wait for initial load to complete */
  get ready(): Promise<void> {
    return this._readyPromise;
  }

  get isReady(): boolean {
    return this._ready;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  /** Notify all listeners of a state change (does NOT trigger a save — saves are per-mutation) */
  private notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ─── Tilesets ────────────────────────────────────────────────

  /** Get a tileset by ID */
  getTileset(id: string): TilesetDefinition | undefined {
    return findTileset(this.tilesets, id);
  }

  /** Add or update a tileset and persist tilesets.json */
  addTileset(tileset: TilesetDefinition): void {
    const idx = this.tilesets.findIndex((t) => t.id === tileset.id);
    if (idx >= 0) this.tilesets[idx] = tileset;
    else this.tilesets.push(tileset);
    this._savedTilesetIds.add(tileset.id);
    this.saveTilesets();
    this.notify();
  }

  /** Remove a tileset by ID and persist tilesets.json */
  removeTileset(id: string): void {
    this.tilesets = this.tilesets.filter((t) => t.id !== id);
    this._savedTilesetIds.delete(id);
    this.saveTilesets();
    this.notify();
  }

  /** Write tilesets.json (only user-saved tilesets, not scanned) */
  private saveTilesets(): void {
    const saved = this.tilesets.filter((t) => this._savedTilesetIds.has(t.id));
    fsWrite(`${BASE}/tilesets.json`, saved);
  }

  // ─── Composites ─────────────────────────────────────────────

  addComposite(composite: CompositeObject): void {
    this.composites = this.composites.filter((c) => c.id !== composite.id);
    this.composites.push(composite);
    fsWrite(`${BASE}/composites/${composite.id}.json`, composite);
    this.notify();
  }

  removeComposite(id: string): void {
    this.composites = this.composites.filter((c) => c.id !== id);
    fsDelete(`${BASE}/composites/${id}.json`);
    this.notify();
  }

  getComposite(id: string): CompositeObject | undefined {
    return this.composites.find((c) => c.id === id);
  }

  // ─── Rooms ──────────────────────────────────────────────────

  addRoom(room: RoomDefinition): void {
    // If renaming, remove the old file
    const existing = this.rooms.find((r) => r.name !== room.name);
    // Actually, rooms are keyed by name so just upsert
    const idx = this.rooms.findIndex((r) => r.name === room.name);
    if (idx >= 0) this.rooms[idx] = room;
    else this.rooms.push(room);
    fsWrite(`${BASE}/rooms/${room.name}.json`, room);
    this.notify();
  }

  removeRoom(name: string): void {
    this.rooms = this.rooms.filter((r) => r.name !== name);
    fsDelete(`${BASE}/rooms/${name}.json`);
    this.notify();
  }

  // ─── Characters ─────────────────────────────────────────────

  addCharacter(char: CharacterDefinition): void {
    this.characters = this.characters.filter((c) => c.id !== char.id);
    this.characters.push(char);
    // Ensure character sheet tilesets are registered
    const fw = char.frameWidth || 16;
    const fh = char.frameHeight || 32;
    for (const sheet of ["idle", "walk"] as const) {
      const tsId = charTilesetId(char.sheetId, sheet);
      if (!findTileset(this.tilesets, tsId)) {
        this.tilesets.push(makeCharTileset(char.sheetId, sheet, fw, fh, 0, 0));
        this._savedTilesetIds.add(tsId);
      }
    }
    this.saveCharacters();
    this.saveTilesets();
    this.notify();
  }

  removeCharacter(id: string): void {
    this.characters = this.characters.filter((c) => c.id !== id);
    this.saveCharacters();
    this.notify();
  }

  getCharacter(id: string): CharacterDefinition | undefined {
    return this.characters.find((c) => c.id === id);
  }

  /** Write characters.json */
  private saveCharacters(): void {
    fsWrite(`${BASE}/characters.json`, this.characters);
  }

  // ─── Resources ──────────────────────────────────────────────

  addResource(resource: Resource): void {
    this.resources = this.resources.filter((r) => r.id !== resource.id);
    this.resources.push(resource);
    fsWrite(`${BASE}/resources/${resource.id}.json`, resource);
    this.notify();
  }

  removeResource(id: string): void {
    this.resources = this.resources.filter((r) => r.id !== id);
    fsDelete(`${BASE}/resources/${id}.json`);
    this.notify();
  }

  getResource(id: string): Resource | undefined {
    return this.resources.find((r) => r.id === id);
  }

  /** Find all resources that have ALL of the given tags */
  getResourcesByTags(tags: string[]): Resource[] {
    return this.resources.filter((r) => tags.every((t) => r.tags.includes(t)));
  }

  /** Get all unique tags across all resources */
  getAllResourceTags(): string[] {
    const tagSet = new Set<string>();
    for (const r of this.resources) {
      for (const t of r.tags) tagSet.add(t);
    }
    return [...tagSet].sort();
  }

  // ─── Masks ─────────────────────────────────────────────────

  addMask(mask: Mask): void {
    this.masks = this.masks.filter((m) => m.id !== mask.id);
    this.masks.push(mask);
    fsWrite(`${BASE}/masks/${mask.id}.json`, mask);
    this.notify();
  }

  removeMask(id: string): void {
    this.masks = this.masks.filter((m) => m.id !== id);
    fsDelete(`${BASE}/masks/${id}.json`);
    this.notify();
  }

  getMask(id: string): Mask | undefined {
    return this.masks.find((m) => m.id === id);
  }

  // ─── Character tileset registration ─────────────────────────

  /**
   * Scan all characters and ensure their referenced char_* tilesets exist.
   * Creates tilesets with cols=0, rows=0 as placeholders — they get updated
   * after the actual image loads.
   */
  private ensureCharacterTilesets(): void {
    for (const char of this.characters) {
      const sheetId = char.sheetId;
      const fw = char.frameWidth || 16;
      const fh = char.frameHeight || 32;

      for (const sheet of ["idle", "walk"] as const) {
        const tsId = charTilesetId(sheetId, sheet);
        if (!findTileset(this.tilesets, tsId)) {
          this.tilesets.push(makeCharTileset(sheetId, sheet, fw, fh, 0, 0));
        }
      }
    }
  }

  // ─── Disk Persistence ───────────────────────────────────────

  /**
   * Load all game data from disk.
   *
   * Reads:
   *   game/tilesets.json        → this.tilesets (+ _savedTilesetIds)
   *   game/characters.json      → this.characters (with migration)
   *   game/resources/*.json     → this.resources
   *   game/composites/*.json    → this.composites
   *   game/rooms/*.json         → this.rooms
   *   game/masks/*.json         → this.masks
   *
   * Then merges in scanned tilesets from data/tilesets/.
   */
  private async loadFromDisk(): Promise<void> {
    try {
      // Fire all reads in parallel
      const [tilesetsData, charsData, resourceFiles, compositeFiles, roomFiles, maskFiles] = await Promise.all([
        fsReadJSON<TilesetDefinition[]>(`${BASE}/tilesets.json`),
        fsReadJSON<CharacterDefinition[]>(`${BASE}/characters.json`),
        fsReadDir<Resource>(`${BASE}/resources`),
        fsReadDir<CompositeObject>(`${BASE}/composites`),
        fsReadDir<RoomDefinition>(`${BASE}/rooms`),
        fsReadDir<Mask>(`${BASE}/masks`),
      ]);

      // Tilesets
      this.tilesets = Array.isArray(tilesetsData) ? tilesetsData : [];
      this._savedTilesetIds = new Set(this.tilesets.map((t) => t.id));

      // Characters (with migration)
      const rawChars = Array.isArray(charsData) ? charsData : [];
      this.characters = rawChars.map((c: any) => migrateCharacter(c));

      // Resources — one per file
      this.resources = Object.values(resourceFiles);

      // Composites — one per file
      this.composites = Object.values(compositeFiles);

      // Rooms — one per file, with defaults for missing fields
      this.rooms = Object.values(roomFiles).map((r: any) => {
        if (!r.doors) r.doors = [];
        if (!r.placements) r.placements = [];
        if (!r.walkability) {
          const w = r.width || 16;
          const h = r.height || 12;
          r.walkability = new Array(w * h).fill(true);
        }
        return r as RoomDefinition;
      });

      // Masks — one per file
      this.masks = Object.values(maskFiles);

      // Ensure all character sheet tilesets are registered
      this.ensureCharacterTilesets();

      console.log(
        `[AppState] Loaded from disk: ${this.tilesets.length} tilesets, ` +
        `${this.composites.length} composites, ${this.rooms.length} rooms, ` +
        `${this.characters.length} characters, ${this.resources.length} resources, ` +
        `${this.masks.length} masks`
      );
    } catch (err) {
      console.error("[AppState] Failed to load from disk:", err);
    }

    // Scan filesystem for all available tilesets and merge them in
    await this.scanAndMergeTilesets();

    this._ready = true;
    this._resolveReady();
    // Notify listeners that data is loaded
    for (const fn of this.listeners) fn();
  }

  /**
   * Fetch all PNGs from /fs/scan-tilesets and merge into this.tilesets.
   * Saved tilesets (already in this.tilesets) take precedence.
   * Scanned tilesets get cols=0, rows=0 — resolved lazily when the image loads.
   */
  private async scanAndMergeTilesets(): Promise<void> {
    try {
      const resp = await fetch("/fs/scan-tilesets");
      if (!resp.ok) {
        console.warn("[AppState] Failed to scan tilesets:", resp.statusText);
        return;
      }
      const { tilesets: scanned } = await resp.json() as {
        tilesets: { relPath: string; tileWidth: number; tileHeight: number }[];
      };

      // Build a set of existing tileset paths for dedup
      const existingByPath = new Map<string, TilesetDefinition>();
      for (const ts of this.tilesets) {
        existingByPath.set(ts.path, ts);
      }

      let added = 0;
      for (const s of scanned) {
        const path = `/data/${s.relPath}`;

        // Skip if already present (saved override takes precedence)
        if (existingByPath.has(path)) continue;

        // Derive an id from the relative path:
        //   "tilesets/3_office/Room_Builder_48x48.png" → "tilesets/3_office/Room_Builder_48x48"
        const id = s.relPath.replace(/\.png$/i, "");

        // Label: just the filename without extension and size suffix
        const filename = s.relPath.split("/").pop() || s.relPath;
        const label = filename.replace(/\.png$/i, "");

        const ts: TilesetDefinition = {
          id,
          label,
          path,
          tileWidth: s.tileWidth,
          tileHeight: s.tileHeight,
          cols: 0, // resolved lazily when image loads
          rows: 0,
        };
        this.tilesets.push(ts);
        added++;
      }

      console.log(`[AppState] Scanned ${scanned.length} tilesets, added ${added} new (${this.tilesets.length} total)`);
    } catch (err) {
      console.warn("[AppState] Failed to scan tilesets:", err);
    }
  }
}

/** Singleton app state */
export const appState = new AppState();

// ─── Migration helper ─────────────────────────────────────────────

/**
 * Migrate old-format CharacterDefinition to current format.
 *
 * Handles two old formats:
 * 1. Oldest: { idle: Record<dir, strip>, walk: Record<dir, strip>, idleSpeed, walkSpeed }
 * 2. Intermediate (v4): animations[] with strip.sheet ("idle"|"walk") instead of strip.tilesetId
 *
 * Current format: animations[] with strip.tilesetId = "char_{sheetId}_{idle|walk}"
 */
function migrateCharacter(c: any): CharacterDefinition {
  const sheetId: string = c.sheetId || "unknown";

  // Oldest format: no animations array at all
  if (!Array.isArray(c.animations)) {
    const animations: CharacterAnimation[] = [];

    if (c.idle) {
      for (const dir of CHARACTER_DIRECTIONS) {
        const strip = c.idle[dir];
        if (strip) {
          animations.push({
            family: "idle",
            direction: dir as CharacterDirection,
            variant: 0,
            strip: { tilesetId: charTilesetId(sheetId, "idle"), row: strip.row, startFrame: strip.startFrame, frameCount: strip.frameCount },
          });
        }
      }
    }

    if (c.walk) {
      for (const dir of CHARACTER_DIRECTIONS) {
        const strip = c.walk[dir];
        if (strip) {
          animations.push({
            family: "walk",
            direction: dir as CharacterDirection,
            variant: 0,
            strip: { tilesetId: charTilesetId(sheetId, "walk"), row: strip.row, startFrame: strip.startFrame, frameCount: strip.frameCount },
          });
        }
      }
    }

    const familySpeeds: Record<string, number> = {};
    if (c.idleSpeed) familySpeeds["idle"] = c.idleSpeed;
    if (c.walkSpeed) familySpeeds["walk"] = c.walkSpeed;

    return {
      id: c.id,
      name: c.name,
      sheetId,
      frameWidth: c.frameWidth || 16,
      frameHeight: c.frameHeight || 32,
      animations,
      familySpeeds,
      variantSequences: c.variantSequences || [],
    };
  }

  // Intermediate format: animations[] exists but strips may have .sheet instead of .tilesetId
  let needsMigration = false;
  const animations: CharacterAnimation[] = c.animations.map((a: any) => {
    const strip = a.strip;
    if (strip && "sheet" in strip && !strip.tilesetId) {
      needsMigration = true;
      const sheet = strip.sheet as "idle" | "walk";
      return {
        ...a,
        strip: {
          tilesetId: charTilesetId(sheetId, sheet),
          row: strip.row,
          startFrame: strip.startFrame,
          frameCount: strip.frameCount,
        },
      };
    }
    return a;
  });

  if (needsMigration) {
    console.log(`Migrated character "${c.name}" strips from sheet to tilesetId`);
  }

  return {
    id: c.id,
    name: c.name,
    sheetId,
    frameWidth: c.frameWidth || 16,
    frameHeight: c.frameHeight || 32,
    animations,
    familySpeeds: c.familySpeeds || {},
    variantSequences: c.variantSequences || [],
  };
}
