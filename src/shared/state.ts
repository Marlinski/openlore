/**
 * Shared application state across all tabs.
 * Uses localStorage for persistence with event-driven updates.
 *
 * V3: Removed baseSprites. Placements and composite parts reference
 * tileset regions directly. No intermediate sprite inventory.
 */

import type { CompositeObject, RoomDefinition, CharacterDefinition, CharacterAnimation, CharacterDirection, ProjectData } from "./types.js";
import { CHARACTER_DIRECTIONS } from "./types.js";

const STORAGE_KEY = "offisims_project_v3";

type Listener = () => void;

class AppState {
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
    this.notify();
  }

  removeCharacter(id: string): void {
    this.characters = this.characters.filter((c) => c.id !== id);
    this.notify();
  }

  getCharacter(id: string): CharacterDefinition | undefined {
    return this.characters.find((c) => c.id === id);
  }

  // ─── Persistence ────────────────────────────────────────────

  private save(): void {
    const data: ProjectData = {
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
      const raw = localStorage.getItem(STORAGE_KEY);
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
      }
    } catch (e) {
      console.error("Failed to load state:", e);
    }
  }

  exportToJSON(): string {
    const data: ProjectData = {
      composites: this.composites,
      rooms: this.rooms,
      characters: this.characters,
    };
    return JSON.stringify(data, null, 2);
  }

  importFromJSON(json: string): void {
    const data: ProjectData = JSON.parse(json);
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

    console.log(`Import: ${addedComps} composites, ${addedRooms} rooms, ${addedChars} characters added`);
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
}

/** Singleton app state */
export const appState = new AppState();

// ─── Migration helper ─────────────────────────────────────────────

/**
 * Migrate old-format CharacterDefinition (with idle/walk Records)
 * to new format (with animations[] array + familySpeeds).
 * If already in new format, returns as-is.
 */
function migrateCharacter(c: any): CharacterDefinition {
  // New format already has animations array
  if (Array.isArray(c.animations)) return c as CharacterDefinition;

  // Old format: { idle: Record<dir, {row, startFrame, frameCount}>, walk: Record<dir, ...>, idleSpeed, walkSpeed }
  const animations: CharacterAnimation[] = [];

  if (c.idle) {
    for (const dir of CHARACTER_DIRECTIONS) {
      const strip = c.idle[dir];
      if (strip) {
        animations.push({
          family: "idle",
          direction: dir as CharacterDirection,
          variant: 0,
          strip: { sheet: "idle", row: strip.row, startFrame: strip.startFrame, frameCount: strip.frameCount },
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
          strip: { sheet: "walk", row: strip.row, startFrame: strip.startFrame, frameCount: strip.frameCount },
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
    sheetId: c.sheetId,
    frameWidth: c.frameWidth || 16,
    frameHeight: c.frameHeight || 32,
    animations,
    familySpeeds,
  };
}
