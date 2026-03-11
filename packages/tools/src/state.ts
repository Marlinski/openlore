/**
 * Shared application state across all tabs.
 * Persists to disk via the FS API (Vite plugin middleware).
 *
 * All mutations save immediately to data/game/game-data.json.
 * No localStorage, no server sync — the file on disk is the single source of truth.
 */

import type { CompositeObject, RoomDefinition, CharacterDefinition, CharacterAnimation, CharacterDirection, ProjectData, TilesetDefinition, Resource, Mask } from "@offisims/shared";
import { CHARACTER_DIRECTIONS, findTileset, charTilesetId, makeCharTileset } from "@offisims/shared";

/** Path to the project data file, relative to the data/ directory */
const PROJECT_PATH = "game/game-data.json";

type Listener = () => void;

class AppState {
  tilesets: TilesetDefinition[] = [];
  composites: CompositeObject[] = [];
  rooms: RoomDefinition[] = [];
  characters: CharacterDefinition[] = [];
  resources: Resource[] = [];
  masks: Mask[] = [];
  private listeners: Listener[] = [];

  /**
   * IDs of tilesets that were explicitly saved in game-data.json (user overrides).
   * Only these get serialized back to disk — scanned tilesets are ephemeral.
   */
  private _savedTilesetIds = new Set<string>();

  /** Whether initial load from disk has completed */
  private _ready = false;
  /** Promise that resolves when initial load is done */
  private _readyPromise: Promise<void>;
  private _resolveReady!: () => void;

  /** Debounce timer for save operations */
  private _saveTimer: ReturnType<typeof setTimeout> | null = null;
  /** Minimum ms between disk writes */
  private static SAVE_DEBOUNCE_MS = 300;

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

  private notify(): void {
    this.scheduleSave();
    for (const fn of this.listeners) fn();
  }

  // ─── Tilesets ────────────────────────────────────────────────

  /** Get a tileset by ID */
  getTileset(id: string): TilesetDefinition | undefined {
    return findTileset(this.tilesets, id);
  }

  /** Add or update a tileset */
  addTileset(tileset: TilesetDefinition): void {
    const idx = this.tilesets.findIndex((t) => t.id === tileset.id);
    if (idx >= 0) this.tilesets[idx] = tileset;
    else this.tilesets.push(tileset);
    this.notify();
  }

  /** Remove a tileset by ID */
  removeTileset(id: string): void {
    this.tilesets = this.tilesets.filter((t) => t.id !== id);
    this.notify();
  }

  // ─── Composites ─────────────────────────────────────────────

  addComposite(composite: CompositeObject): void {
    this.composites = this.composites.filter((c) => c.id !== composite.id);
    this.composites.push(composite);
    this.notify();
  }

  removeComposite(id: string): void {
    this.composites = this.composites.filter((c) => c.id !== id);
    this.notify();
  }

  getComposite(id: string): CompositeObject | undefined {
    return this.composites.find((c) => c.id === id);
  }

  // ─── Rooms ──────────────────────────────────────────────────

  addRoom(room: RoomDefinition): void {
    const idx = this.rooms.findIndex((r) => r.name === room.name);
    if (idx >= 0) this.rooms[idx] = room;
    else this.rooms.push(room);
    this.notify();
  }

  removeRoom(name: string): void {
    this.rooms = this.rooms.filter((r) => r.name !== name);
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
      }
    }
    this.notify();
  }

  removeCharacter(id: string): void {
    this.characters = this.characters.filter((c) => c.id !== id);
    this.notify();
  }

  getCharacter(id: string): CharacterDefinition | undefined {
    return this.characters.find((c) => c.id === id);
  }

  // ─── Resources ──────────────────────────────────────────────

  addResource(resource: Resource): void {
    this.resources = this.resources.filter((r) => r.id !== resource.id);
    this.resources.push(resource);
    this.notify();
  }

  removeResource(id: string): void {
    this.resources = this.resources.filter((r) => r.id !== id);
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
    this.notify();
  }

  removeMask(id: string): void {
    this.masks = this.masks.filter((m) => m.id !== id);
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

  /** Serialize current state to ProjectData JSON */
  private toJSON(): string {
    // Only persist tilesets that were in the original game-data.json (user overrides),
    // not the auto-scanned ones — those are rediscovered on every load.
    const savedTilesets = this.tilesets.filter((t) => this._savedTilesetIds.has(t.id));
    const data: ProjectData = {
      tilesets: savedTilesets,
      composites: this.composites,
      rooms: this.rooms,
      characters: this.characters,
      resources: this.resources,
      masks: this.masks,
    };
    return JSON.stringify(data, null, 2);
  }

  /** Schedule a debounced save to disk */
  private scheduleSave(): void {
    if (this._saveTimer) clearTimeout(this._saveTimer);
    this._saveTimer = setTimeout(() => {
      this._saveTimer = null;
      this.saveToDisk();
    }, AppState.SAVE_DEBOUNCE_MS);
  }

  /** Write project data to disk via FS API */
  private async saveToDisk(): Promise<void> {
    try {
      const json = this.toJSON();
      const resp = await fetch(`/fs/write?path=${encodeURIComponent(PROJECT_PATH)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: json,
      });
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        console.error("[AppState] Failed to save to disk:", err);
      }
    } catch (err) {
      console.error("[AppState] Failed to save to disk:", err);
    }
  }

  /** Load project data from disk via FS API, then merge with scanned tilesets */
  private async loadFromDisk(): Promise<void> {
    try {
      const resp = await fetch(`/fs/read?path=${encodeURIComponent(PROJECT_PATH)}`);

      if (resp.ok) {
        const data: ProjectData = await resp.json();
        this.hydrate(data);
        console.log(
          `[AppState] Loaded from disk: ${this.tilesets.length} tilesets, ` +
          `${this.composites.length} composites, ${this.rooms.length} rooms, ` +
          `${this.characters.length} characters, ${this.resources.length} resources, ` +
          `${this.masks.length} masks`
        );
      } else if (resp.status === 404) {
        // No project file yet — start empty. Tilesets come from game-data.json
        // or are registered by individual tools (room editor, character definer).
        console.log("[AppState] No project file on disk, starting fresh");
        await this.saveToDisk();
      } else {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        console.error("[AppState] Failed to load from disk:", err);
      }
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
   * Game-data overrides (already in this.tilesets) take precedence.
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

        // Skip if already present (game-data override takes precedence)
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

  /** Hydrate state from a ProjectData object, applying migrations */
  private hydrate(data: ProjectData): void {
    this.composites = data.composites || [];

    // Migrate old-format characters to new animations[] format
    this.characters = (data.characters || []).map((c: any) => migrateCharacter(c));

    // Ensure rooms have doors array
    this.rooms = (data.rooms || []).map((r: any) => {
      if (!r.doors) r.doors = [];
      if (!r.placements) r.placements = [];
      if (!r.walkability) {
        const w = r.width || 16;
        const h = r.height || 12;
        r.walkability = new Array(w * h).fill(true);
      }
      return r;
    });

    // Load tilesets from project data (no defaults — everything comes from disk)
    this.tilesets = Array.isArray(data.tilesets) ? data.tilesets : [];
    // Track which tilesets came from game-data.json so only those get saved back
    this._savedTilesetIds = new Set(this.tilesets.map((t) => t.id));

    // Load resources and masks
    this.resources = Array.isArray(data.resources) ? data.resources : [];
    this.masks = Array.isArray(data.masks) ? data.masks : [];

    // Ensure all character sheet tilesets referenced by characters are registered
    this.ensureCharacterTilesets();
  }

  /** Export current state as a JSON string (for debugging or manual export) */
  exportToJSON(): string {
    return this.toJSON();
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
