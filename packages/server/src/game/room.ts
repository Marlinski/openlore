/**
 * Room instance — runtime representation of a room in the game world.
 *
 * Holds the walkability grid, door definitions, and tracks which
 * avatars are currently in the room.
 *
 * Position validation: checks if a pixel position is walkable by
 * converting to tile coordinates and looking up the walkability grid.
 */

import { TILE_SIZE } from "@offisims/shared";
import type { RoomDefinition, DoorDefinition, RoomSnapshot } from "@offisims/shared";

export class Room {
  readonly name: string;
  readonly width: number;
  readonly height: number;
  readonly walkability: boolean[];
  readonly doors: DoorDefinition[];

  /** Set of avatar IDs currently in this room */
  readonly avatarIds = new Set<string>();

  constructor(def: RoomDefinition) {
    this.name = def.name;
    this.width = def.width;
    this.height = def.height;
    this.walkability = [...def.walkability];
    this.doors = [...def.doors];
  }

  /**
   * Check if a pixel position is walkable.
   * The avatar's "feet" are at (x, y) in pixel coords.
   * We check the tile that contains this pixel position.
   */
  isWalkable(px: number, py: number): boolean {
    const col = Math.floor(px / TILE_SIZE);
    const row = Math.floor(py / TILE_SIZE);

    if (col < 0 || col >= this.width || row < 0 || row >= this.height) {
      return false;
    }

    return this.walkability[row * this.width + col];
  }

  /** Find a door at a given pixel position */
  getDoorAt(px: number, py: number): DoorDefinition | undefined {
    const col = Math.floor(px / TILE_SIZE);
    const row = Math.floor(py / TILE_SIZE);
    return this.doors.find((d) => d.col === col && d.row === row);
  }

  /** Find a door by ID */
  getDoor(doorId: string): DoorDefinition | undefined {
    return this.doors.find((d) => d.id === doorId);
  }

  /** Get a snapshot for sending to clients */
  toSnapshot(): RoomSnapshot {
    return {
      name: this.name,
      width: this.width,
      height: this.height,
    };
  }

  /**
   * Find a suitable spawn position in this room.
   * If a door ID is given (door transition), spawn on that door tile.
   * Otherwise (initial join), pick a random walkable non-door tile.
   * Returns pixel coordinates (center of the tile).
   */
  findSpawnPosition(preferDoorId?: string): { x: number; y: number } {
    // Door transition — spawn at the target door
    if (preferDoorId) {
      const door = this.getDoor(preferDoorId);
      if (door) {
        return {
          x: door.col * TILE_SIZE + TILE_SIZE / 2,
          y: door.row * TILE_SIZE + TILE_SIZE / 2,
        };
      }
    }

    // Initial join — collect door tile indices for exclusion
    const doorTiles = new Set<number>();
    for (const door of this.doors) {
      if (door.col >= 0 && door.col < this.width && door.row >= 0 && door.row < this.height) {
        doorTiles.add(door.row * this.width + door.col);
      }
    }

    // Gather all walkable non-door tiles
    const candidates: number[] = [];
    for (let i = 0; i < this.walkability.length; i++) {
      if (this.walkability[i] && !doorTiles.has(i)) {
        candidates.push(i);
      }
    }

    // Pick a random candidate
    if (candidates.length > 0) {
      const idx = candidates[Math.floor(Math.random() * candidates.length)];
      const col = idx % this.width;
      const row = Math.floor(idx / this.width);
      return {
        x: col * TILE_SIZE + TILE_SIZE / 2,
        y: row * TILE_SIZE + TILE_SIZE / 2,
      };
    }

    // Fallback: any walkable tile (even if it's a door)
    for (let i = 0; i < this.walkability.length; i++) {
      if (this.walkability[i]) {
        const col = i % this.width;
        const row = Math.floor(i / this.width);
        return {
          x: col * TILE_SIZE + TILE_SIZE / 2,
          y: row * TILE_SIZE + TILE_SIZE / 2,
        };
      }
    }

    // Last resort: center of room
    return {
      x: (this.width * TILE_SIZE) / 2,
      y: (this.height * TILE_SIZE) / 2,
    };
  }
}
