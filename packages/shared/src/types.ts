/**
 * Shared data types for Offisims
 *
 * Architecture: tileset-direct workflow.
 * Instead of pre-cutting sprites into an inventory, tools reference
 * rectangular regions within tileset images directly.
 * Users click or drag on a tileset to select a region, then place it.
 *
 * Composites still exist — they group multiple tileset regions into
 * pre-assembled multi-tile objects (e.g. a conference table).
 *
 * Textures are purely visual — they carry no physics or occupancy data.
 * Physical constraints (walkability, collision) are defined at the map level.
 *
 * Coordinate system:
 *   - Grid origin is top-left (0,0)
 *   - X increases rightward, Y increases downward
 *   - Rendering order: render-time sort by anchor Y (bottom edge + zBias),
 *     not array position. Floor layer renders first, then object layer.
 */

/** Tile size in pixels */
export const TILE_SIZE = 48;

// ─── Tileset definitions ────────────────────────────────────────────

/**
 * Dynamic tileset definition — stored in project data.
 * Each tileset has a unique string ID and the metadata needed to
 * interpret tile coordinates (tile size, grid dimensions) plus the
 * image path or data-URL for the actual pixels.
 */
export interface TilesetDefinition {
  /** Unique string identifier (e.g. "room_builder", "my_dungeon_tiles") */
  id: string;
  /** Human-readable label shown in dropdowns */
  label: string;
  /**
   * Image source — either an absolute URL path (e.g. "/data/sprites/foo.png")
   * or a data-URL for user-imported tilesets.
   */
  path: string;
  /** Tile width in pixels (e.g. 48, 32, 16) */
  tileWidth: number;
  /** Tile height in pixels (e.g. 48, 32, 16) */
  tileHeight: number;
  /** Number of tile columns in the tileset image */
  cols: number;
  /** Number of tile rows in the tileset image */
  rows: number;
}

/** Tileset ID is just a string — no longer a const union */
export type TilesetId = string;

// ─── Tileset Region ─────────────────────────────────────────────────

/**
 * A rectangular region within a tileset image, measured in tiles.
 * This is the fundamental building block — replaces the old BaseSprite concept.
 * Everything (placements, composite parts) references tileset regions directly.
 */
export interface TilesetRegion {
  /** Which tileset this region is from */
  tilesetId: TilesetId;
  /** Top-left tile column in the tileset (0-indexed) */
  srcCol: number;
  /** Top-left tile row in the tileset (0-indexed) */
  srcRow: number;
  /** Width in tiles */
  w: number;
  /** Height in tiles */
  h: number;
}

// ─── Categories ─────────────────────────────────────────────────────

export type SpriteCategory =
  | "floor"
  | "wall"
  | "furniture"
  | "decor"
  | "electronics"
  | "plant"
  | "door"
  | "window"
  | "rug"
  | "other";

export const SPRITE_CATEGORIES: SpriteCategory[] = [
  "floor",
  "wall",
  "furniture",
  "decor",
  "electronics",
  "plant",
  "door",
  "window",
  "rug",
  "other",
];

// ─── Composite Object ───────────────────────────────────────────────

/**
 * A composite object assembled from one or more tileset regions.
 * Used for large objects that span multiple regions (e.g. a conference table).
 */
export interface CompositeObject {
  /** Unique identifier */
  id: string;
  /** Human-readable name */
  name: string;
  /** Category */
  category: SpriteCategory;
  /**
   * Parts that make up this composite.
   * Each part is a tileset region positioned within the composite.
   */
  parts: CompositePart[];
  /**
   * Total display size in tiles (computed from parts bounding box).
   */
  displaySize: { w: number; h: number };
}

export interface CompositePart {
  /** The tileset region for this part */
  region: TilesetRegion;
  /** X offset in tiles from the composite's top-left */
  offsetX: number;
  /** Y offset in tiles from the composite's top-left */
  offsetY: number;
  /**
   * Manual z-order bias for render-time sorting within the composite.
   * Added to the anchor Y (bottom edge) when computing sort order.
   * Positive = renders further in front, negative = renders further behind.
   * Default 0 when omitted.
   */
  zBias?: number;
}

// ─── Doors ──────────────────────────────────────────────────────────

/**
 * A door is a single-tile teleport point that connects two rooms.
 * Placed in Layout mode. The tile is walkable — when the player
 * steps on it the game transitions to the target room & door.
 *
 * Target format: "roomName#doorId" (e.g. "lobby#door-2").
 * An empty target means the door is not yet connected.
 */
export interface DoorDefinition {
  /** Auto-generated id, unique within the room (e.g. "door-1") */
  id: string;
  /** Grid column */
  col: number;
  /** Grid row */
  row: number;
  /**
   * Where this door leads: "roomName#doorId".
   * Empty string means unlinked.
   */
  target: string;
}

// ─── Room Layout (room.dat) ─────────────────────────────────────────

/**
 * Room layout — pure physics/geometry, no visuals.
 * Exported as room.dat. Designed to be extensible.
 * Contains walkability grid + doors (teleport points).
 */
export interface RoomLayout {
  /** Room name (also used as filename stem) */
  name: string;
  /** Grid width in tiles */
  width: number;
  /** Grid height in tiles */
  height: number;
  /**
   * Walkability grid: flat array of width*height booleans.
   * Index = row * width + col. true = walkable, false = blocked.
   * Row 0 is the top row.
   */
  walkability: boolean[];
  /** Door teleport points */
  doors: DoorDefinition[];
  /** Format version for future compatibility */
  version: number;
}

// ─── Room Texture (room_texture.dat) ────────────────────────────────

/**
 * A texture placement on the room grid.
 * References either a tileset region directly, or a composite by ID.
 * Multiple textures can stack on the same tile (floor under wall under decor).
 */
export interface TexturePlacement {
  /** Grid X position (left edge, in tiles) */
  gridX: number;
  /** Grid Y position (top edge, in tiles) */
  gridY: number;
  /** Render layer: floor renders first, objects get depth-sorted */
  layer: "floor" | "object";
  /**
   * For direct tileset placements: the region to draw.
   * Mutually exclusive with compositeId.
   */
  region?: TilesetRegion;
  /**
   * For composite placements: reference to CompositeObject.id.
   * Mutually exclusive with region.
   */
  compositeId?: string;
  /**
   * Manual z-order bias for render-time sorting.
   * Added to the anchor Y (bottom edge) when computing sort order.
   * Positive = renders further in front, negative = renders further behind.
   * Default 0 when omitted.
   */
  zBias?: number;
}

/**
 * Room texture data — the visual layer.
 * Contains all sprite/composite placements, ordered top-left to bottom-right.
 * Exported as room_texture.dat.
 */
export interface RoomTexture {
  /** Must match the corresponding RoomLayout.name */
  name: string;
  /** Grid dimensions (must match RoomLayout) */
  width: number;
  height: number;
  /** All texture placements, ordered for rendering */
  placements: TexturePlacement[];
  /** Format version */
  version: number;
}

/**
 * Combined room definition stored in project state.
 * Contains both layout and texture data for editor use.
 */
export interface RoomDefinition {
  /** Room name */
  name: string;
  /** Grid width in tiles */
  width: number;
  /** Grid height in tiles */
  height: number;
  /** Walkability grid (flat array, row-major) */
  walkability: boolean[];
  /** Door teleport points */
  doors: DoorDefinition[];
  /** Texture placements */
  placements: TexturePlacement[];
}

// ─── Resource ───────────────────────────────────────────────────────

/**
 * A resource is the fundamental unit in the asset system.
 * It is a sequence of 1+ frames (a static tile is a sequence of length 1).
 *
 * Resources are tagged with arbitrary strings. Tags serve double duty:
 *   - Metadata: "idle", "walk", "down", "variant_0", "48x48"
 *   - Grouping: "adam", "desk_fan", "office_furniture"
 *
 * A "character" is not a special type — it's a set of resources that share
 * a common group tag (e.g. "adam") and have the right animation tags
 * (e.g. "idle" + "down", "walk" + "left", etc.).
 *
 * Resources can be created:
 *   - Manually via the Tile Cutter (drag-select on a tileset)
 *   - In batch by applying a Mask to a tileset
 *   - By the Composite tool (stitching resources together)
 */
export interface Resource {
  /** Unique identifier */
  id: string;
  /** Human-readable name (e.g. "adam_idle_down", "desk_fan_spin") */
  name: string;
  /** Tags for grouping, filtering, and semantic meaning */
  tags: string[];
  /**
   * Ordered list of frames. Length 1 = static resource.
   * All frames must have the same pixel dimensions (w * tileWidth, h * tileHeight).
   */
  frames: ResourceFrame[];
}

/**
 * A single frame in a resource, referencing a rectangular tile region
 * in a source tileset image.
 *
 * Coordinates are in tiles (not pixels) — resolved via the tileset's
 * tileWidth/tileHeight at render time.
 */
export interface ResourceFrame {
  /** Source tileset ID */
  tilesetId: TilesetId;
  /** Top-left tile column in the tileset (0-indexed) */
  srcCol: number;
  /** Top-left tile row in the tileset (0-indexed) */
  srcRow: number;
  /** Width in tiles */
  w: number;
  /** Height in tiles */
  h: number;
}

// ─── Mask ───────────────────────────────────────────────────────────

/**
 * A mask is a reusable cut template for batch-creating tagged resources
 * from a tileset. It defines a set of "cuts" — each cut specifies where
 * to extract frames and what tags to apply to the resulting resource.
 *
 * Masks are created by the Tile Cutter: you manually cut a tileset into
 * resources, then "Save as Mask" captures the cut pattern. Later, you
 * can apply the same mask to a different tileset of the same shape
 * (e.g. different character spritesheet with the same layout).
 *
 * When applying a mask, the user provides a "group tag" (e.g. "amanda")
 * that gets added to every resource created by the mask, along with
 * the cut-specific tags (e.g. "idle", "down").
 */
export interface Mask {
  /** Unique identifier */
  id: string;
  /** Human-readable name (e.g. "limezu_legacy_character") */
  name: string;
  /** Expected tile width of the source tileset */
  tileWidth: number;
  /** Expected tile height of the source tileset */
  tileHeight: number;
  /** The cuts that define how to slice the tileset */
  cuts: MaskCut[];
}

/**
 * A single cut within a mask. Defines a contiguous frame range
 * to extract, plus the tags to apply to the resulting resource.
 *
 * Coordinates are relative to the tileset grid (tile columns/rows).
 * When applied, each cut creates one Resource.
 */
export interface MaskCut {
  /** Tags to apply to the resource created by this cut (e.g. ["idle", "down"]) */
  tags: string[];
  /** Row in the tileset grid (0-indexed) */
  row: number;
  /** Starting frame column (0-indexed) */
  startFrame: number;
  /** Number of frames to extract */
  frameCount: number;
  /** Width of each frame in tiles (defaults to 1 if omitted) */
  frameWidth?: number;
  /** Height of each frame in tiles (defaults to 1 if omitted) */
  frameHeight?: number;
}

// ─── Project data (saved to localStorage / exported as JSON) ────────

export interface ProjectData {
  /** Registered tilesets (images + metadata) */
  tilesets: TilesetDefinition[];
  composites: CompositeObject[];
  rooms: RoomDefinition[];
  /** Tagged resources (sequences and statics) */
  resources?: Resource[];
  /** Reusable cut templates */
  masks?: Mask[];
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Generate a unique id */
export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** Create an empty walkability grid (all blocked by default) */
export function createWalkabilityGrid(w: number, h: number, walkable = false): boolean[] {
  return new Array(w * h).fill(walkable);
}

/** Get the size of a placement in tiles */
export function getPlacementSize(
  p: TexturePlacement,
  getComposite: (id: string) => CompositeObject | undefined
): { w: number; h: number } | null {
  if (p.region) {
    return { w: p.region.w, h: p.region.h };
  }
  if (p.compositeId) {
    const comp = getComposite(p.compositeId);
    return comp ? comp.displaySize : null;
  }
  return null;
}

/** Extract RoomLayout (room.dat) from a RoomDefinition */
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

/** Extract RoomTexture (room_texture.dat) from a RoomDefinition */
export function extractRoomTexture(room: RoomDefinition): RoomTexture {
  return {
    name: room.name,
    width: room.width,
    height: room.height,
    placements: room.placements.map((p) => ({ ...p })),
    version: 1,
  };
}
