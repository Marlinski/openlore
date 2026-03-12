/**
 * Camera — viewport tracking and world-to-screen coordinate mapping.
 *
 * The camera follows the local player's avatar, centering it on screen.
 * Provides world→screen transforms used by:
 *   - PixiJS world container positioning
 *   - HTML overlay positioning (speech bubbles, name labels)
 *
 * The camera works in pixel coordinates (matching the server protocol).
 */

import { Container } from "pixi.js";

export class Camera {
  /** Camera center position in world pixels */
  private _x = 0;
  private _y = 0;

  /** Viewport size in screen pixels */
  private _viewWidth = 800;
  private _viewHeight = 600;

  /** Zoom level (1 = 1:1 pixel mapping) */
  private _zoom = 1;

  /** World bounds in pixels (for clamping) */
  private _worldWidth = 0;
  private _worldHeight = 0;

  /** Smoothing factor (0 = instant, 1 = no movement). Lower = snappier. */
  private _smoothing = 0.1;

  /** Target position for smooth following */
  private _targetX = 0;
  private _targetY = 0;

  get x(): number { return this._x; }
  get y(): number { return this._y; }
  get zoom(): number { return this._zoom; }
  get viewWidth(): number { return this._viewWidth; }
  get viewHeight(): number { return this._viewHeight; }

  /** Set the viewport size (call on resize) */
  setViewport(width: number, height: number): void {
    this._viewWidth = width;
    this._viewHeight = height;
  }

  /** Set the world bounds (call on room change) */
  setWorldBounds(width: number, height: number): void {
    this._worldWidth = width;
    this._worldHeight = height;
  }

  /** Set zoom level */
  setZoom(zoom: number): void {
    this._zoom = Math.max(0.25, Math.min(4, zoom));
  }

  /** Instantly center the camera on a world position */
  centerOn(worldX: number, worldY: number): void {
    this._targetX = worldX;
    this._targetY = worldY;
    this._x = worldX;
    this._y = worldY;
    this.clamp();
  }

  /** Set the follow target (smooth movement toward it each frame) */
  setTarget(worldX: number, worldY: number): void {
    this._targetX = worldX;
    this._targetY = worldY;
  }

  /** Update camera position (call each frame) */
  update(dt: number): void {
    // Lerp toward target
    const t = 1 - Math.pow(this._smoothing, dt * 60);
    this._x += (this._targetX - this._x) * t;
    this._y += (this._targetY - this._y) * t;
    this.clamp();
  }

  /**
   * Apply the camera transform to a PixiJS container.
   */
  applyTo(container: Container): void {
    container.scale.set(this._zoom);
    container.x = Math.round(this._viewWidth / 2 - this._x * this._zoom);
    container.y = Math.round(this._viewHeight / 2 - this._y * this._zoom);
  }

  /**
   * Convert world pixel coordinates to screen coordinates.
   * Used for positioning HTML overlays (speech bubbles, name labels).
   */
  worldToScreen(worldX: number, worldY: number): { x: number; y: number } {
    return {
      x: (worldX - this._x) * this._zoom + this._viewWidth / 2,
      y: (worldY - this._y) * this._zoom + this._viewHeight / 2,
    };
  }

  /**
   * Convert screen coordinates to world pixel coordinates.
   * Used for click-to-move or similar interactions (future).
   */
  screenToWorld(screenX: number, screenY: number): { x: number; y: number } {
    return {
      x: (screenX - this._viewWidth / 2) / this._zoom + this._x,
      y: (screenY - this._viewHeight / 2) / this._zoom + this._y,
    };
  }

  /** Clamp camera so we don't show outside the world */
  private clamp(): void {
    if (this._worldWidth <= 0 || this._worldHeight <= 0) return;

    const halfViewW = this._viewWidth / (2 * this._zoom);
    const halfViewH = this._viewHeight / (2 * this._zoom);

    // If the world is smaller than the viewport, center it
    if (this._worldWidth <= this._viewWidth / this._zoom) {
      this._x = this._worldWidth / 2;
    } else {
      this._x = Math.max(halfViewW, Math.min(this._worldWidth - halfViewW, this._x));
    }

    if (this._worldHeight <= this._viewHeight / this._zoom) {
      this._y = this._worldHeight / 2;
    } else {
      this._y = Math.max(halfViewH, Math.min(this._worldHeight - halfViewH, this._y));
    }
  }
}
