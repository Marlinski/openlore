/**
 * HUD — minimal on-screen overlay.
 *
 * The HUD is pure HTML, positioned absolutely over the game canvas.
 * It handles:
 *   - Connection status indicator (top-right)
 *   - Zoom controls (top-center)
 *
 * Chat input and chat log have moved to the ChannelPanel (left panel).
 * Room name display has moved to the ChannelPanel tab.
 */

import type { Connection } from "../connection.js";

// ─── Zoom presets ─────────────────────────────────────────────────

/** Available zoom levels (ascending order) */
const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3];
/** Default zoom index (1x) */
const DEFAULT_ZOOM_INDEX = 2;

// ─── Hud ──────────────────────────────────────────────────────────

export class Hud {
  private container: HTMLDivElement;
  private connection: Connection;
  private statusEl: HTMLDivElement;

  private zoomLabel: HTMLSpanElement;
  private zoomIndex: number = DEFAULT_ZOOM_INDEX;
  private onZoomChange: ((zoom: number) => void) | null = null;

  constructor(container: HTMLDivElement, connection: Connection) {
    this.container = container;
    this.connection = connection;

    // Build HUD elements
    this.statusEl = document.createElement("div");
    this.statusEl.className = "hud-status";
    container.appendChild(this.statusEl);

    // Build zoom controls
    const zoomWrap = document.createElement("div");
    zoomWrap.className = "hud-zoom";

    const minusBtn = document.createElement("button");
    minusBtn.className = "hud-zoom-btn";
    minusBtn.textContent = "\u2212"; // minus sign
    minusBtn.title = "Zoom out";
    minusBtn.addEventListener("click", () => this.stepZoom(-1));

    this.zoomLabel = document.createElement("span");
    this.zoomLabel.className = "hud-zoom-label";
    this.updateZoomLabel();

    const plusBtn = document.createElement("button");
    plusBtn.className = "hud-zoom-btn";
    plusBtn.textContent = "+";
    plusBtn.title = "Zoom in";
    plusBtn.addEventListener("click", () => this.stepZoom(1));

    zoomWrap.appendChild(minusBtn);
    zoomWrap.appendChild(this.zoomLabel);
    zoomWrap.appendChild(plusBtn);
    container.appendChild(zoomWrap);

    this.updateStatus();
  }

  /** Register a callback for zoom changes */
  setOnZoomChange(cb: (zoom: number) => void): void {
    this.onZoomChange = cb;
  }

  /** Step zoom up (+1) or down (-1) */
  private stepZoom(direction: number): void {
    const newIndex = this.zoomIndex + direction;
    if (newIndex < 0 || newIndex >= ZOOM_LEVELS.length) return;
    this.zoomIndex = newIndex;
    this.updateZoomLabel();
    if (this.onZoomChange) {
      this.onZoomChange(ZOOM_LEVELS[this.zoomIndex]);
    }
  }

  private updateZoomLabel(): void {
    const level = ZOOM_LEVELS[this.zoomIndex];
    // Display as "0.5x", "1x", "2x", etc.
    this.zoomLabel.textContent = `${level}x`;
  }

  /** Update connection status */
  updateStatus(): void {
    if (this.connection.connected) {
      this.statusEl.textContent = "Connected";
      this.statusEl.classList.remove("disconnected");
      this.statusEl.classList.add("connected");
    } else {
      this.statusEl.textContent = "Disconnected";
      this.statusEl.classList.remove("connected");
      this.statusEl.classList.add("disconnected");
    }
  }
}
