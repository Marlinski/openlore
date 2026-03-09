/**
 * HUD — minimal on-screen overlay.
 *
 * The HUD is pure HTML, positioned absolutely over the game canvas.
 * It handles:
 *   - Connection status indicator (top-right)
 *
 * Chat input and chat log have moved to the ChannelPanel (left panel).
 * Room name display has moved to the ChannelPanel tab.
 */

import type { Connection } from "../connection.js";

// ─── Hud ──────────────────────────────────────────────────────────

export class Hud {
  private container: HTMLDivElement;
  private connection: Connection;
  private statusEl: HTMLDivElement;

  constructor(container: HTMLDivElement, connection: Connection) {
    this.container = container;
    this.connection = connection;

    // Build HUD elements
    this.statusEl = document.createElement("div");
    this.statusEl.className = "hud-status";
    container.appendChild(this.statusEl);

    this.updateStatus();
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
