/**
 * Avatar — sprite rendering and animation for a single avatar.
 *
 * Handles both the local player avatar and remote avatars.
 * For the local player: reads input, does local collision checking,
 * manages animation state, and reports position to the server.
 * For remote avatars: interpolates toward the latest server position.
 *
 * Character rendering:
 *   - Characters are assembled from tagged resources at runtime.
 *   - Each Resource has frames: ResourceFrame[] (individual tile regions).
 *   - Tags follow convention: entity:character, name:adam, action:idle,
 *     dir:down, variant:read, etc.
 *   - The avatar queries resources by tags (action + dir) with fallback.
 *   - 1x2 tiles (48x96 rendered from source frames), anchor = bottom edge.
 *
 * Coordinate system: pixel-based, matching the server protocol.
 * Avatar position (x, y) is the CENTER of the walkability tile (bottom
 * tile of the 1x2 sprite). This matches server spawn positions.
 */

import { Sprite, Texture, Rectangle } from "pixi.js";
import type { Pack, Resource, ResourceFrame } from "@offisims/pack";
import type { CharacterDirection, AvatarSnapshot } from "../protocol.js";
import { TILE_SIZE } from "../constants.js";
import { findTilesetDef } from "../assets.js";

// ─── Types ────────────────────────────────────────────────────────

/** Tileset textures loaded as PixiJS base textures, keyed by tileset ID */
export type TextureCache = Map<string, Texture>;

/** Resolved character resources grouped for quick lookup */
export interface CharacterResources {
  /** Character group name (e.g. "adam") */
  name: string;
  /** All resources belonging to this character */
  all: Resource[];
}

// ─── Tag-based resource lookup ────────────────────────────────────

/**
 * Find a resource matching an action + direction combo.
 * Tags use colon-prefix convention: "action:idle", "dir:down".
 *
 * Fallback chain:
 *   1. action:X + dir:Y  (exact match)
 *   2. action:X           (any direction — e.g. single idle anim)
 *   3. dir:down + action:idle  (ultimate fallback)
 *   4. first resource       (last resort)
 */
function findResource(
  resources: Resource[],
  action: string,
  dir: string,
): Resource | undefined {
  const actionTag = `action:${action}`;
  const dirTag = `dir:${dir}`;

  // 1. Exact: action + dir
  let match = resources.find(
    (r) => r.tags.includes(actionTag) && r.tags.includes(dirTag),
  );
  if (match) return match;

  // 2. Action only (direction-agnostic resource)
  match = resources.find((r) => r.tags.includes(actionTag));
  if (match) return match;

  // 3. Fallback to idle + down
  if (action !== "idle" || dir !== "down") {
    match = resources.find(
      (r) => r.tags.includes("action:idle") && r.tags.includes("dir:down"),
    );
    if (match) return match;
  }

  // 4. Last resort: first resource
  return resources[0];
}

// ─── Avatar class ─────────────────────────────────────────────────

export class Avatar {
  readonly id: string;
  readonly name: string;
  readonly characterId: string;
  readonly isLocal: boolean;

  /** Pixel position — center of the walkability tile */
  x: number;
  y: number;
  direction: CharacterDirection;
  moving: boolean;
  family: string;

  /** The PixiJS sprite (1x2 tiles = 48x96 rendered) */
  readonly sprite: Sprite;

  /** anchorY for z-sorting — bottom edge of the character in tiles */
  anchorY: number;

  /** Character resources (for tag-based animation lookup) */
  private charResources: CharacterResources;
  private gameData: Pack;
  private textureCache: TextureCache;

  /** Currently active resource + frame index */
  private currentResource: Resource | undefined;
  private animFrame = 0;
  private animTimer = 0;

  /** Default animation speed (fps) per family */
  private static readonly FAMILY_FPS: Record<string, number> = {
    idle: 4,
    walk: 8,
    sit: 4,
    sit_office: 4,
  };

  /** Interpolation target for remote avatars */
  private targetX: number;
  private targetY: number;
  private interpSpeed = 8; // tiles/sec interpolation speed

  constructor(
    snapshot: AvatarSnapshot,
    charResources: CharacterResources,
    gameData: Pack,
    textureCache: TextureCache,
    isLocal: boolean,
  ) {
    this.id = snapshot.id;
    this.name = snapshot.name;
    this.characterId = snapshot.characterId;
    this.isLocal = isLocal;

    this.x = snapshot.x;
    this.y = snapshot.y;
    this.direction = snapshot.direction;
    this.moving = snapshot.moving;
    this.family = snapshot.family;

    this.targetX = snapshot.x;
    this.targetY = snapshot.y;

    this.charResources = charResources;
    this.gameData = gameData;
    this.textureCache = textureCache;

    // Create sprite
    this.sprite = new Sprite();
    this.sprite.width = TILE_SIZE;
    this.sprite.height = TILE_SIZE * 2;

    // Initial z-sort anchor: bottom of character in tile coords
    this.anchorY = this.y / TILE_SIZE + 0.5;

    // Resolve initial resource
    this.syncResource();
    this.updateTexture();
    this.positionSprite();
  }

  /**
   * Apply a server position update.
   * Sets the interpolation target — the update loop will smoothly
   * move toward it. For snap corrections, also teleports immediately.
   */
  applyServerPosition(
    x: number,
    y: number,
    direction: CharacterDirection,
    moving: boolean,
  ): void {
    this.targetX = x;
    this.targetY = y;
    this.direction = direction;
    this.setMoving(moving);
  }

  /**
   * Apply a snap correction — teleport immediately with no interpolation.
   * Used when the server rejects a position (collision, bounds).
   */
  applySnap(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.targetX = x;
    this.targetY = y;
  }

  /** Set the moving state and update animation family */
  setMoving(moving: boolean): void {
    this.moving = moving;
    const newFamily = moving ? "walk" : "idle";
    if (newFamily !== this.family) {
      this.family = newFamily;
      this.animFrame = 0;
      this.animTimer = 0;
      this.syncResource();
    }
  }

  /**
   * Set position directly (for local avatar movement).
   */
  setPosition(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.targetX = x;
    this.targetY = y;
  }

  /** Set direction and sync resource */
  setDirection(dir: CharacterDirection): void {
    if (dir !== this.direction) {
      this.direction = dir;
      this.syncResource();
    }
  }

  /**
   * Update each frame.
   * Handles interpolation (remote) and animation advancement.
   */
  update(dt: number): void {
    // Interpolate toward the target position.
    const dx = this.targetX - this.x;
    const dy = this.targetY - this.y;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist > 1) {
      const speed = this.interpSpeed * TILE_SIZE * dt;
      if (speed >= dist) {
        this.x = this.targetX;
        this.y = this.targetY;
      } else {
        this.x += (dx / dist) * speed;
        this.y += (dy / dist) * speed;
      }
    } else {
      this.x = this.targetX;
      this.y = this.targetY;
    }

    // Advance animation
    this.advanceAnimation(dt);

    // Update sprite
    this.updateTexture();
    this.positionSprite();

    // Update z-sort anchor (bottom edge of character in tile units)
    this.anchorY = (this.y + TILE_SIZE / 2) / TILE_SIZE;
  }

  /** Position the sprite based on world coordinates */
  private positionSprite(): void {
    // Avatar position (x, y) is center of walkability tile.
    // Sprite is 1x2 tiles. Top-left of sprite:
    this.sprite.x = this.x - TILE_SIZE / 2;
    this.sprite.y = this.y - TILE_SIZE / 2 - TILE_SIZE;
    this.sprite.width = TILE_SIZE;
    this.sprite.height = TILE_SIZE * 2;
  }

  /** Resolve the current resource based on family + direction */
  private syncResource(): void {
    const prev = this.currentResource;
    this.currentResource = findResource(
      this.charResources.all,
      this.family,
      this.direction,
    );
    // Reset animation if the resource changed
    if (this.currentResource !== prev) {
      this.animFrame = 0;
      this.animTimer = 0;
    }
  }

  /** Advance animation by dt seconds */
  private advanceAnimation(dt: number): void {
    const res = this.currentResource;
    if (!res || res.frames.length <= 1) return; // static or missing

    const fps = Avatar.FAMILY_FPS[this.family] ?? 4;
    const frameDuration = 1 / fps;
    this.animTimer += dt;

    while (this.animTimer >= frameDuration) {
      this.animTimer -= frameDuration;
      this.animFrame = (this.animFrame + 1) % res.frames.length;
    }
  }

  /** Update the sprite texture to the current animation frame */
  private updateTexture(): void {
    const res = this.currentResource;
    if (!res || res.frames.length === 0) return;

    const frame = res.frames[this.animFrame % res.frames.length];
    const tex = this.getFrameTexture(frame);
    if (tex) this.sprite.texture = tex;
  }

  /** Get a PixiJS texture for a single ResourceFrame */
  private getFrameTexture(frame: ResourceFrame): Texture | null {
    const baseTex = this.textureCache.get(frame.tilesetId);
    if (!baseTex) return null;

    // Look up the tileset definition to get tile dimensions
    const tsDef = findTilesetDef(this.gameData, frame.tilesetId);
    if (!tsDef) return null;

    const px = frame.srcCol * tsDef.tileWidth;
    const py = frame.srcRow * tsDef.tileHeight;
    const pw = frame.w * tsDef.tileWidth;
    const ph = frame.h * tsDef.tileHeight;

    const rect = new Rectangle(px, py, pw, ph);
    return new Texture({ source: baseTex.source, frame: rect });
  }
}

/**
 * Build a CharacterResources object from game data for a given character ID.
 * The characterId is the group name (e.g. "adam") — we find all resources
 * tagged with entity:character + name:<characterId>.
 */
export function resolveCharacterResources(
  characterId: string,
  gameData: Pack,
): CharacterResources {
  const resources = gameData.resources ?? [];
  const nameTag = `name:${characterId}`;
  const filtered = resources.filter(
    (r) => r.tags.includes("entity:character") && r.tags.includes(nameTag),
  );
  return { name: characterId, all: filtered };
}

/**
 * Load PixiJS base textures for all tilesets referenced by a character's resources.
 * Uses the HTMLImageElement cache from assets.ts and converts to PixiJS textures.
 */
export function loadCharacterTextures(
  charResources: CharacterResources,
  gameData: Pack,
  textureCache: TextureCache,
  getImage: (path: string) => HTMLImageElement | undefined,
): void {
  const neededIds = new Set<string>();
  for (const res of charResources.all) {
    for (const frame of res.frames) {
      neededIds.add(frame.tilesetId);
    }
  }

  for (const id of neededIds) {
    if (textureCache.has(id)) continue;
    const tsDef = findTilesetDef(gameData, id);
    if (!tsDef) continue;
    const img = getImage(tsDef.path);
    if (!img) continue;
    const tex = Texture.from(img);
    tex.source.scaleMode = "nearest";
    textureCache.set(id, tex);
  }
}
