/**
 * Studio-local constants and utilities that operate on pack types.
 *
 * These live here (not in @offisims/pack) because they are studio-only
 * concerns -- the pack library stays minimal and generic.
 */

import type {
  CompositeObject,
  DoorDefinition,
  RoomDefinition,
  TexturePlacement,
} from "@offisims/pack";
import { PlacementLayer } from "@offisims/pack";

// Re-export PlacementLayer so consumers don't need a separate import.
export { PlacementLayer };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Tile size in pixels (universal across the entire project). */
export const TILE_SIZE = 48;

// ---------------------------------------------------------------------------
// Layer helpers
// ---------------------------------------------------------------------------

/** Map a UI layer string to the protobuf PlacementLayer enum value. */
export function toPlacementLayer(s: "floor" | "object"): PlacementLayer {
  return s === "floor" ? PlacementLayer.FLOOR : PlacementLayer.OBJECT;
}

/** Check whether a placement is on the floor layer. */
export function isFloor(p: TexturePlacement): boolean {
  return p.layer === PlacementLayer.FLOOR;
}

/** Check whether a placement is on the object layer. */
export function isObject(p: TexturePlacement): boolean {
  return p.layer === PlacementLayer.OBJECT;
}

// ---------------------------------------------------------------------------
// ID generation
// ---------------------------------------------------------------------------

/** Generate a unique id (base-36 timestamp + random suffix). */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// ---------------------------------------------------------------------------
// Grid helpers
// ---------------------------------------------------------------------------

/** Create a flat walkability grid (all cells set to `walkable`). */
export function createWalkabilityGrid(
  w: number,
  h: number,
  walkable = false,
): boolean[] {
  return new Array(w * h).fill(walkable);
}

// ---------------------------------------------------------------------------
// Placement helpers
// ---------------------------------------------------------------------------

/**
 * Return the tile-size of a placement.
 *
 * For direct-region placements the size comes from the region itself.
 * For composite placements we look up the composite by ID and read its
 * flat `displayWidth` / `displayHeight` fields.
 */
export function getPlacementSize(
  p: TexturePlacement,
  getComposite: (id: string) => CompositeObject | undefined,
): { w: number; h: number } | null {
  if (p.region) {
    return { w: p.region.w, h: p.region.h };
  }
  if (p.compositeId) {
    const comp = getComposite(p.compositeId);
    return comp ? { w: comp.displayWidth, h: comp.displayHeight } : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Room export helpers
// ---------------------------------------------------------------------------

/** Layout portion of a room definition (room.dat). */
export interface RoomLayout {
  name: string;
  width: number;
  height: number;
  walkability: boolean[];
  doors: DoorDefinition[];
  version: number;
}

/** Texture portion of a room definition (room_texture.dat). */
export interface RoomTexture {
  name: string;
  width: number;
  height: number;
  placements: TexturePlacement[];
  version: number;
}

/** Extract the layout (room.dat) portion of a RoomDefinition. */
export function extractRoomLayout(room: RoomDefinition): RoomLayout {
  return {
    name: room.name,
    width: room.width,
    height: room.height,
    walkability: [...room.walkability],
    doors: room.doors.map((d) => ({ ...d })),
    version: 1,
  };
}

/** Extract the texture (room_texture.dat) portion of a RoomDefinition. */
export function extractRoomTexture(room: RoomDefinition): RoomTexture {
  return {
    name: room.name,
    width: room.width,
    height: room.height,
    placements: room.placements.map((p) => ({ ...p })),
    version: 1,
  };
}
