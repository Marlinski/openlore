/**
 * Avatar — sprite rendering and animation for a single avatar.
 *
 * Handles both the local player avatar and remote avatars.
 * For the local player: reads input, does local collision checking,
 * manages animation state, and reports position to the server.
 * For remote avatars: interpolates toward the latest server position.
 *
 * Character rendering (from tester.ts reference):
 *   - 1×2 tiles (48×96 rendered from 16×32 source frames)
 *   - Occupies 1 walkability tile (bottom tile), anchor = bottom edge
 *   - Idle breathing animation when standing, walk animation when moving
 *   - Variant sequence support for cycling through animation variants
 *
 * Coordinate system: pixel-based, matching the server protocol.
 * Avatar position (x, y) is the CENTER of the walkability tile (bottom
 * tile of the 1×2 sprite). This matches server spawn positions.
 */

import { Sprite, Texture, Rectangle } from "pixi.js";
import {
  TILE_SIZE,
  type CharacterDefinition,
  type CharacterDirection,
  type CharacterAnimation,
  type VariantSequence,
  getCharacterAnimation,
  getCharacterAnimations,
  getCharacterSequences,
  type ProjectData,
} from "@offisims/shared";
import type { AvatarSnapshot } from "@offisims/shared";
import { findTilesetDef } from "../assets.js";

// ─── Types ────────────────────────────────────────────────────────

/** Tileset textures loaded as PixiJS base textures, keyed by tileset ID */
export type TextureCache = Map<string, Texture>;

/** Variant sequence playback state */
interface SeqPlayback {
  sequence: VariantSequence | null;
  stepIndex: number;
  repeatsDone: number;
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

  /** The PixiJS sprite (1×2 tiles = 48×96 rendered) */
  readonly sprite: Sprite;

  /** anchorY for z-sorting — bottom edge of the character in tiles */
  anchorY: number;

  /** Character definition (for animation lookup) */
  private charDef: CharacterDefinition;
  private gameData: ProjectData;
  private textureCache: TextureCache;

  /** Animation state */
  private animFrame = 0;
  private animTimer = 0;
  private seqPlayback: SeqPlayback = { sequence: null, stepIndex: 0, repeatsDone: 0 };

  /** Interpolation target for remote avatars */
  private targetX: number;
  private targetY: number;
  private interpSpeed = 8; // tiles/sec interpolation speed

  constructor(
    snapshot: AvatarSnapshot,
    charDef: CharacterDefinition,
    gameData: ProjectData,
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

    this.charDef = charDef;
    this.gameData = gameData;
    this.textureCache = textureCache;

    // Create sprite
    this.sprite = new Sprite();
    this.sprite.width = TILE_SIZE;
    this.sprite.height = TILE_SIZE * 2;

    // Initial z-sort anchor: bottom of character in tile coords
    this.anchorY = this.y / TILE_SIZE + 0.5;

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
    const wasMoving = this.moving;
    this.moving = moving;
    const newFamily = moving ? "walk" : "idle";
    if (newFamily !== this.family) {
      this.family = newFamily;
      this.animFrame = 0;
      this.animTimer = 0;
      this.syncSequence();
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

  /** Set direction and sync sequence playback */
  setDirection(dir: CharacterDirection): void {
    if (dir !== this.direction) {
      this.direction = dir;
      this.syncSequence();
    }
  }

  /**
   * Update each frame.
   * Handles interpolation (remote) and animation advancement.
   */
  update(dt: number): void {
    // Interpolate toward the target position.
    // For locally-driven avatars, x/targetX stay in sync (setPosition sets both),
    // so this is a no-op. It only kicks in when another tab sends position
    // updates via the server (avatar-move routed to this session).
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
    // Character feet are at (x, y), bottom of sprite is at y + TILE_SIZE/2
    this.anchorY = (this.y + TILE_SIZE / 2) / TILE_SIZE;
  }

  /** Position the sprite based on world coordinates */
  private positionSprite(): void {
    // Avatar position (x, y) is center of walkability tile.
    // Sprite is 1×2 tiles. Top-left of sprite:
    //   spriteX = x - TILE_SIZE/2  (center horizontally on the tile)
    //   spriteY = y - TILE_SIZE/2 - TILE_SIZE  (1 tile above the walk tile, centered vertically)
    this.sprite.x = this.x - TILE_SIZE / 2;
    this.sprite.y = this.y - TILE_SIZE / 2 - TILE_SIZE;
    this.sprite.width = TILE_SIZE;
    this.sprite.height = TILE_SIZE * 2;
  }

  /** Advance animation by dt seconds */
  private advanceAnimation(dt: number): void {
    const fps = this.charDef.familySpeeds[this.family] ?? (this.family === "walk" ? 8 : 4);
    const frameDuration = 1 / fps;
    this.animTimer += dt;

    while (this.animTimer >= frameDuration) {
      this.animTimer -= frameDuration;
      this.animFrame++;

      const currentAnim = this.getCurrentAnimation();
      if (currentAnim && this.animFrame >= currentAnim.strip.frameCount) {
        this.animFrame = 0;

        // Advance sequence step if active
        if (this.seqPlayback.sequence && this.seqPlayback.sequence.steps.length > 0) {
          this.seqPlayback.repeatsDone++;
          const step = this.seqPlayback.sequence.steps[
            this.seqPlayback.stepIndex % this.seqPlayback.sequence.steps.length
          ];
          if (this.seqPlayback.repeatsDone >= step.repeats) {
            this.seqPlayback.stepIndex =
              (this.seqPlayback.stepIndex + 1) % this.seqPlayback.sequence.steps.length;
            this.seqPlayback.repeatsDone = 0;
          }
        }
      }
    }
  }

  /** Get the current animation based on family + direction + sequence state */
  private getCurrentAnimation(): CharacterAnimation | undefined {
    if (this.seqPlayback.sequence && this.seqPlayback.sequence.steps.length > 0) {
      const step = this.seqPlayback.sequence.steps[
        this.seqPlayback.stepIndex % this.seqPlayback.sequence.steps.length
      ];
      const anims = getCharacterAnimations(this.charDef, this.family, this.direction);
      return anims.find((a) => a.variant === step.variant) ?? anims[0];
    }
    return getCharacterAnimation(this.charDef, this.family, this.direction);
  }

  /** Sync sequence playback for current family + direction */
  private syncSequence(): void {
    // For V1, just use variant 0 (no sequence selection UI in game client)
    // but keep the mechanism for future use
    const sequences = getCharacterSequences(this.charDef, this.family, this.direction);
    if (sequences.length > 0) {
      // Auto-select first sequence
      if (this.seqPlayback.sequence !== sequences[0]) {
        this.seqPlayback.sequence = sequences[0];
        this.seqPlayback.stepIndex = 0;
        this.seqPlayback.repeatsDone = 0;
      }
    } else {
      this.seqPlayback.sequence = null;
    }
  }

  /** Update the sprite texture to the current animation frame */
  private updateTexture(): void {
    const anim = this.getCurrentAnimation();
    if (!anim) {
      // Fallback to idle variant 0
      const fallback = getCharacterAnimation(this.charDef, "idle", this.direction);
      if (!fallback) return;
      const tex = this.getFrameTexture(fallback, 0);
      if (tex) this.sprite.texture = tex;
      return;
    }

    const frameIdx = this.animFrame % anim.strip.frameCount;
    const tex = this.getFrameTexture(anim, frameIdx);
    if (tex) this.sprite.texture = tex;
  }

  /** Get a texture for a specific frame of an animation */
  private getFrameTexture(
    anim: CharacterAnimation,
    frameIndex: number,
  ): Texture | null {
    const baseTex = this.textureCache.get(anim.strip.tilesetId);
    if (!baseTex) return null;

    const fw = this.charDef.frameWidth;
    const fh = this.charDef.frameHeight;
    const col = anim.strip.startFrame + frameIndex;

    const frame = new Rectangle(col * fw, anim.strip.row * fh, fw, fh);
    return new Texture({ source: baseTex.source, frame });
  }
}

/**
 * Load PixiJS base textures for all tilesets referenced by a character.
 * Uses the HTMLImageElement cache from assets.ts and converts to PixiJS textures.
 */
export function loadCharacterTextures(
  charDef: CharacterDefinition,
  gameData: ProjectData,
  textureCache: TextureCache,
  getImage: (path: string) => HTMLImageElement | undefined,
): void {
  const neededIds = new Set<string>();
  for (const anim of charDef.animations) {
    neededIds.add(anim.strip.tilesetId);
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
