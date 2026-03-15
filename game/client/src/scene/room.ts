/**
 * RoomScene — builds and manages the PixiJS scene for a single room.
 *
 * Rendering model (from tester.ts):
 *   - Floor layer: top-to-bottom, left-to-right (no z-sorting)
 *   - Object layer: z-sorted by anchorY (bottom edge + zBias) every frame
 *   - Characters interleaved in object sort by anchorY
 *
 * The RoomScene owns:
 *   - floorContainer: all floor tiles
 *   - objectContainer: object tiles + avatar sprites (z-sorted)
 *   - The list of ObjectEntry items for z-sorting
 *
 * Tileset textures are loaded as PixiJS Textures keyed by tileset ID.
 * Room tile sprites are cut from these using Rectangle frames.
 */

import { Container, Sprite, Texture, Rectangle } from "pixi.js";
import {
  PlacementLayer,
  type Pack,
  type RoomDefinition,
  type TexturePlacement,
} from "@offisims/pack";
import { TILE_SIZE } from "../constants.js";
import { findTilesetDef, getCachedImage } from "../assets.js";

// ─── Types ────────────────────────────────────────────────────────

export interface ObjectEntry {
  sprite: Sprite | Container;
  anchorY: number; // bottom edge + zBias in tile units, for sorting
}

// ─── RoomScene ────────────────────────────────────────────────────

export class RoomScene {
  /** The root container (add to world container) */
  readonly root: Container;
  /** Floor tiles (bottom layer, no z-sort) */
  readonly floorContainer: Container;
  /** Object tiles + avatar sprites (z-sorted each frame) */
  readonly objectContainer: Container;

  /** All object entries for z-sorting (including avatar sprites) */
  readonly objectEntries: ObjectEntry[] = [];

  /** Room dimensions in tiles */
  readonly width: number;
  readonly height: number;
  /** Room dimensions in pixels */
  readonly pixelWidth: number;
  readonly pixelHeight: number;

  /** Walkability grid (for local collision checking) */
  readonly walkability: boolean[];

  /** Door definitions */
  readonly doors: RoomDefinition["doors"];

  /** Tileset textures loaded as PixiJS textures */
  private textureCache: Map<string, Texture>;

  /** Pack data (needed to resolve tileset definitions) */
  private gameData: Pack;

  constructor(
    room: RoomDefinition,
    gameData: Pack,
    textureCache: Map<string, Texture>,
  ) {
    this.width = room.width;
    this.height = room.height;
    this.pixelWidth = room.width * TILE_SIZE;
    this.pixelHeight = room.height * TILE_SIZE;
    this.walkability = [...room.walkability];
    this.doors = [...room.doors];
    this.textureCache = textureCache;
    this.gameData = gameData;

    // Create containers
    this.root = new Container();
    this.floorContainer = new Container();
    this.objectContainer = new Container();
    this.root.addChild(this.floorContainer);
    this.root.addChild(this.objectContainer);

    // Load all tileset textures needed by this room
    this.loadRoomTextures(room, gameData);

    // Build sprites
    this.buildSprites(room, gameData);

  }

  /** Destroy all sprites and containers */
  destroy(): void {
    this.root.destroy({ children: true });
    this.objectEntries.length = 0;
  }

  /**
   * Add an avatar sprite to the object layer with z-sorting.
   * Returns the ObjectEntry so the caller can update anchorY each frame.
   */
  addAvatarSprite(sprite: Sprite, anchorY: number): ObjectEntry {
    this.objectContainer.addChild(sprite);
    const entry: ObjectEntry = { sprite, anchorY };
    this.objectEntries.push(entry);
    return entry;
  }

  /** Remove an avatar sprite from the object layer */
  removeAvatarSprite(sprite: Sprite): void {
    this.objectContainer.removeChild(sprite);
    const idx = this.objectEntries.findIndex((e) => e.sprite === sprite);
    if (idx >= 0) this.objectEntries.splice(idx, 1);
  }

  /**
   * Z-sort the object container every frame.
   * Sort by anchorY, then by x position.
   */
  zSort(): void {
    this.objectEntries.sort((a, b) => {
      if (a.anchorY !== b.anchorY) return a.anchorY - b.anchorY;
      return a.sprite.x - b.sprite.x;
    });

    for (let i = 0; i < this.objectEntries.length; i++) {
      const entry = this.objectEntries[i];
      if (this.objectContainer.children.indexOf(entry.sprite) !== i) {
        this.objectContainer.setChildIndex(entry.sprite, i);
      }
    }
  }

  /**
   * Check if a pixel position is walkable.
   * Uses the same margin-based approach as the tester for smooth movement.
   * Position (px, py) is the CENTER of the character's walk tile.
   */
  isWalkable(px: number, py: number): boolean {
    // Character occupies 1 tile. Check the tile at (px, py).
    // The position is the center of the tile, so the character spans:
    //   left = px - TILE_SIZE/2, right = px + TILE_SIZE/2
    //   top = py - TILE_SIZE/2, bottom = py + TILE_SIZE/2
    const margin = TILE_SIZE * 0.05;
    const left = px - TILE_SIZE / 2 + margin;
    const right = px + TILE_SIZE / 2 - margin;
    const top = py - TILE_SIZE / 2 + margin;
    const bottom = py + TILE_SIZE / 2 - margin;

    const minCol = Math.floor(left / TILE_SIZE);
    const maxCol = Math.floor((right - 0.001) / TILE_SIZE);
    const minRow = Math.floor(top / TILE_SIZE);
    const maxRow = Math.floor((bottom - 0.001) / TILE_SIZE);

    for (let r = minRow; r <= maxRow; r++) {
      for (let c = minCol; c <= maxCol; c++) {
        if (c < 0 || c >= this.width || r < 0 || r >= this.height) return false;
        if (!this.walkability[r * this.width + c]) return false;
      }
    }
    return true;
  }

  /**
   * Find the door the character is standing on (if any).
   * Position is the center of the walk tile in pixels.
   */
  getDoorAtPosition(px: number, py: number): RoomDefinition["doors"][0] | undefined {
    const col = Math.floor(px / TILE_SIZE);
    const row = Math.floor(py / TILE_SIZE);
    return this.doors.find((d) => d.col === col && d.row === row);
  }

  // ─── Private ─────────────────────────────────────────────────

  /** Ensure all tileset textures needed by this room are loaded */
  private loadRoomTextures(room: RoomDefinition, gameData: Pack): void {
    const neededIds = new Set<string>();

    for (const p of room.placements) {
      if (p.region) neededIds.add(p.region.tilesetId);
      if (p.compositeId) {
        const comp = gameData.composites.find((c) => c.id === p.compositeId);
        if (comp) {
          for (const part of comp.parts) {
            if (part.region) neededIds.add(part.region.tilesetId);
          }
        }
      }
    }

    for (const id of neededIds) {
      if (this.textureCache.has(id)) continue;
      const tsDef = findTilesetDef(gameData, id);
      if (!tsDef) {
        console.warn(`[RoomScene] Tileset def not found for "${id}"`);
        continue;
      }
      const img = getCachedImage(tsDef.path);
      if (!img) {
        console.warn(`[RoomScene] Image not cached for "${tsDef.path}"`);
        continue;
      }
      const tex = Texture.from(img);
      tex.source.scaleMode = "nearest";
      this.textureCache.set(id, tex);
    }
  }

  /** Build all floor and object sprites from room placements */
  private buildSprites(room: RoomDefinition, gameData: Pack): void {
    const floors = room.placements.filter((p) => p.layer === PlacementLayer.FLOOR);
    const objects = room.placements.filter((p) => p.layer === PlacementLayer.OBJECT);

    // Floor: top-to-bottom, left-to-right
    floors.sort((a, b) => {
      if ((a.gridY || 0) !== (b.gridY || 0)) return (a.gridY || 0) - (b.gridY || 0);
      return (a.gridX || 0) - (b.gridX || 0);
    });

    for (const p of floors) {
      this.addFloorPlacement(p, gameData);
    }

    for (const p of objects) {
      this.addObjectPlacement(p, gameData);
    }
  }

  private addFloorPlacement(p: TexturePlacement, gameData: Pack): void {
    if (p.compositeId) {
      const comp = gameData.composites.find((c) => c.id === p.compositeId);
      if (!comp) return;
      const sorted = [...comp.parts].sort((a, b) => {
        const anchorA = (a.offsetY || 0) + (a.region?.h ?? 0) + (a.zBias ?? 0);
        const anchorB = (b.offsetY || 0) + (b.region?.h ?? 0) + (b.zBias ?? 0);
        if (anchorA !== anchorB) return anchorA - anchorB;
        return (a.offsetX || 0) - (b.offsetX || 0);
      });
      for (const part of sorted) {
        if (!part.region) continue;
        const sprite = this.createRegionSprite(
          part.region.tilesetId, part.region.srcCol, part.region.srcRow,
          part.region.w, part.region.h,
        );
        if (sprite) {
          sprite.x = ((p.gridX || 0) + (part.offsetX || 0)) * TILE_SIZE;
          sprite.y = ((p.gridY || 0) + (part.offsetY || 0)) * TILE_SIZE;
          this.floorContainer.addChild(sprite);
        }
      }
    } else if (p.region) {
      const sprite = this.createRegionSprite(
        p.region.tilesetId, p.region.srcCol, p.region.srcRow,
        p.region.w, p.region.h,
      );
      if (sprite) {
        sprite.x = (p.gridX || 0) * TILE_SIZE;
        sprite.y = (p.gridY || 0) * TILE_SIZE;
        this.floorContainer.addChild(sprite);
      }
    }
  }

  private addObjectPlacement(p: TexturePlacement, gameData: Pack): void {
    if (p.compositeId) {
      const comp = gameData.composites.find((c) => c.id === p.compositeId);
      if (!comp) return;
      for (const part of comp.parts) {
        if (!part.region) continue;
        const sprite = this.createRegionSprite(
          part.region.tilesetId, part.region.srcCol, part.region.srcRow,
          part.region.w, part.region.h,
        );
        if (sprite) {
          sprite.x = ((p.gridX || 0) + (part.offsetX || 0)) * TILE_SIZE;
          sprite.y = ((p.gridY || 0) + (part.offsetY || 0)) * TILE_SIZE;
          const anchorY = (p.gridY || 0) + (part.offsetY || 0) + (part.region.h || 0) + (part.zBias ?? 0) + (p.zBias ?? 0);
          this.objectContainer.addChild(sprite);
          this.objectEntries.push({ sprite, anchorY });
        }
      }
    } else if (p.region) {
      const sprite = this.createRegionSprite(
        p.region.tilesetId, p.region.srcCol, p.region.srcRow,
        p.region.w, p.region.h,
      );
      if (sprite) {
        sprite.x = (p.gridX || 0) * TILE_SIZE;
        sprite.y = (p.gridY || 0) * TILE_SIZE;
        const anchorY = (p.gridY || 0) + (p.region.h || 0) + (p.zBias ?? 0);
        this.objectContainer.addChild(sprite);
        this.objectEntries.push({ sprite, anchorY });
      }
    }
  }

  private createRegionSprite(
    tilesetId: string,
    srcCol: number,
    srcRow: number,
    w: number,
    h: number,
  ): Sprite | null {
    const baseTexture = this.textureCache.get(tilesetId);
    if (!baseTexture) return null;

    // Use tileset's actual tile dimensions for source rectangle.
    // Atlas tilesets have tileWidth=1/tileHeight=1 (coords are pixels),
    // while legacy tilesets use TILE_SIZE (48) per cell.
    const tsDef = findTilesetDef(this.gameData, tilesetId);
    const tw = tsDef?.tileWidth || TILE_SIZE;
    const th = tsDef?.tileHeight || TILE_SIZE;

    // Guard against protojson zero-value omission (srcCol/srcRow may be undefined)
    const frame = new Rectangle(
      (srcCol || 0) * tw,
      (srcRow || 0) * th,
      (w || 0) * tw,
      (h || 0) * th,
    );
    const texture = new Texture({ source: baseTexture.source, frame });
    return new Sprite(texture);
  }
}
