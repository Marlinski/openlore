/**
 * Shared application state across all tabs.
 * Uses localStorage for persistence with event-driven updates.
 *
 * V4: Added dynamic tilesets registry to ProjectData.
 * Tilesets are now stored alongside composites/rooms/characters.
 * Default LimeZu tilesets are seeded on first load.
 * Migrates from v3 (adds tilesets array with defaults).
 */

import type { CompositeObject, RoomDefinition, CharacterDefinition, CharacterAnimation, CharacterDirection, ProjectData, TilesetDefinition } from "@offisims/shared";
import { CHARACTER_DIRECTIONS, DEFAULT_TILESETS, findTileset, charTilesetId, makeCharTileset } from "@offisims/shared";

const STORAGE_KEY = "offisims_project_v4";
const OLD_STORAGE_KEY = "offisims_project_v3";

type Listener = () => void;

class AppState {
  tilesets: TilesetDefinition[] = [];
  composites: CompositeObject[] = [];
  rooms: RoomDefinition[] = [];
  characters: CharacterDefinition[] = [];
  private listeners: Listener[] = [];

  constructor() {
    this.load();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.push(fn);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== fn);
    };
  }

  private notify(): void {
    this.save();
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

  // ─── Character tileset registration ─────────────────────────

  /**
   * Scan all characters and ensure their referenced char_* tilesets exist.
   * This fixes the case where character data references tileset IDs like
   * "char_adam_idle" but those tilesets were never added (e.g. because the
   * Character Definer tab wasn't visited, or data was imported without them).
   *
   * We can't know the exact image dimensions here (the image hasn't loaded),
   * so we create tilesets with cols=0, rows=0 as placeholders. The Character
   * Definer (or tester) will update them after loading the actual image.
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

  // ─── Persistence ────────────────────────────────────────────

  private save(): void {
    const data: ProjectData = {
      tilesets: this.tilesets,
      composites: this.composites,
      rooms: this.rooms,
      characters: this.characters,
    };
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error("Failed to save state:", e);
    }
  }

  private load(): void {
    try {
      let raw = localStorage.getItem(STORAGE_KEY);
      let migrated = false;

      // Migrate from v3 if v4 doesn't exist yet
      if (!raw) {
        raw = localStorage.getItem(OLD_STORAGE_KEY);
        if (raw) migrated = true;
      }

      if (raw) {
        const data = JSON.parse(raw);
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

        // Load tilesets or seed defaults
        if (Array.isArray(data.tilesets) && data.tilesets.length > 0) {
          this.tilesets = data.tilesets;
        } else {
          // v3 data or empty tilesets — seed with defaults
          this.tilesets = DEFAULT_TILESETS.map((t) => ({ ...t }));
        }

        // Ensure all default tilesets are present (merge, don't replace)
        for (const def of DEFAULT_TILESETS) {
          if (!findTileset(this.tilesets, def.id)) {
            this.tilesets.push({ ...def });
          }
        }

        if (migrated) {
          console.log("Migrated project data from v3 to v4 (added tilesets)");
          this.save(); // persist as v4
        }

        // Ensure all character sheet tilesets are registered
        this.ensureCharacterTilesets();
      } else {
        // Brand new — seed with defaults
        this.tilesets = DEFAULT_TILESETS.map((t) => ({ ...t }));
      }
    } catch (e) {
      console.error("Failed to load state:", e);
      this.tilesets = DEFAULT_TILESETS.map((t) => ({ ...t }));
    }
  }

  exportToJSON(): string {
    const data: ProjectData = {
      tilesets: this.tilesets,
      composites: this.composites,
      rooms: this.rooms,
      characters: this.characters,
    };
    return JSON.stringify(data, null, 2);
  }

  importFromJSON(json: string): void {
    const data: ProjectData = JSON.parse(json);

    // Merge tilesets: skip duplicates (by id)
    const incomingTilesets = data.tilesets || [];
    const existingTilesetIds = new Set(this.tilesets.map((t) => t.id));
    let addedTilesets = 0;
    for (const ts of incomingTilesets) {
      if (!existingTilesetIds.has(ts.id)) {
        this.tilesets.push(ts);
        existingTilesetIds.add(ts.id);
        addedTilesets++;
      }
    }

    const incomingComposites = data.composites || [];
    const incomingRooms = data.rooms || [];
    const incomingCharacters = (data.characters || []).map((c: any) => migrateCharacter(c));

    // Merge composites: skip duplicates (by id)
    const existingCompIds = new Set(this.composites.map((c) => c.id));
    let addedComps = 0;
    for (const comp of incomingComposites) {
      if (!existingCompIds.has(comp.id)) {
        this.composites.push(comp);
        existingCompIds.add(comp.id);
        addedComps++;
      }
    }

    // Merge rooms: skip duplicates (by name)
    const existingRoomNames = new Set(this.rooms.map((r) => r.name));
    let addedRooms = 0;
    for (const room of incomingRooms) {
      if (!existingRoomNames.has(room.name)) {
        this.rooms.push(room);
        existingRoomNames.add(room.name);
        addedRooms++;
      }
    }

    // Merge characters: skip duplicates (by id)
    const existingCharIds = new Set(this.characters.map((c) => c.id));
    let addedChars = 0;
    for (const char of incomingCharacters) {
      if (!existingCharIds.has(char.id)) {
        this.characters.push(char);
        existingCharIds.add(char.id);
        addedChars++;
      }
    }

    console.log(`Import: ${addedTilesets} tilesets, ${addedComps} composites, ${addedRooms} rooms, ${addedChars} characters added`);
    // Ensure all character sheet tilesets are registered
    this.ensureCharacterTilesets();
    this.notify();
  }

  exportToFile(): void {
    const blob = new Blob([this.exportToJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "offisims_project.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  importFromFile(): Promise<void> {
    return new Promise((resolve) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".json";
      input.onchange = async () => {
        const file = input.files?.[0];
        if (!file) return resolve();
        const text = await file.text();
        this.importFromJSON(text);
        resolve();
      };
      input.click();
    });
  }

  // ─── Server sync ────────────────────────────────────────────

  /** Push current project data to the game server (PUT /api/game-data) */
  async pushToServer(): Promise<{ ok: boolean; message: string }> {
    const data: ProjectData = {
      tilesets: this.tilesets,
      composites: this.composites,
      rooms: this.rooms,
      characters: this.characters,
    };

    try {
      const resp = await fetch("/api/game-data", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
      });

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return { ok: false, message: `Server error: ${err.error || resp.statusText}` };
      }

      const result = await resp.json();
      return {
        ok: true,
        message: `Synced: ${result.rooms} rooms, ${result.characters} characters, ${result.composites} composites, ${result.tilesets} tilesets`,
      };
    } catch (err: any) {
      return { ok: false, message: `Connection failed: ${err.message}` };
    }
  }

  /** Pull project data from the game server (GET /api/game-data) and replace local state */
  async pullFromServer(): Promise<{ ok: boolean; message: string }> {
    try {
      const resp = await fetch("/api/game-data");

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({ error: resp.statusText }));
        return { ok: false, message: `Server error: ${err.error || resp.statusText}` };
      }

      const data: ProjectData = await resp.json();

      // Full replace (not merge) — this is a "load from server" operation
      this.tilesets = data.tilesets || [];
      this.composites = data.composites || [];
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
      this.characters = (data.characters || []).map((c: any) => migrateCharacter(c));

      // Ensure default tilesets are present
      for (const def of DEFAULT_TILESETS) {
        if (!findTileset(this.tilesets, def.id)) {
          this.tilesets.push({ ...def });
        }
      }

      // Ensure character tilesets are registered
      this.ensureCharacterTilesets();

      // Persist and notify listeners
      this.save();
      for (const fn of this.listeners) fn();

      return {
        ok: true,
        message: `Loaded: ${this.rooms.length} rooms, ${this.characters.length} characters, ${this.composites.length} composites, ${this.tilesets.length} tilesets`,
      };
    } catch (err: any) {
      return { ok: false, message: `Connection failed: ${err.message}` };
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
