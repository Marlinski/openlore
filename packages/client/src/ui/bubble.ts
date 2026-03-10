/**
 * BubbleManager — HTML overlay name labels and speech bubbles above avatars.
 *
 * Manages two types of overlays per avatar:
 *   1. Name label — always visible, shows the avatar's display name
 *   2. Speech bubble — appears on chat, auto-dismisses with fade-out
 *
 * Both are positioned using world-to-screen coordinate mapping from the
 * Camera. They're HTML elements (not PixiJS) for easy text rendering
 * and styling.
 *
 * Speech bubbles have a cartoonish pixelated style (Sims-like) with
 * max-width clamping and text-overflow ellipsis for long messages.
 */

import { TILE_SIZE } from "@offisims/shared";
import type { Camera } from "../scene/camera.js";
import type { Avatar } from "../scene/avatar.js";

// ─── Constants ────────────────────────────────────────────────────

/** How long a bubble stays visible (ms) */
const BUBBLE_DURATION = 6000;
/** Fade-out duration (ms) */
const FADE_DURATION = 600;
/** Max bubbles per avatar (oldest removed) */
const MAX_BUBBLES = 1;
/** Offset from the avatar sprite top in world pixels (negative = lower/closer to head) */
const NAME_OFFSET_Y = -TILE_SIZE * 0.35;
/** Extra offset above name label for the speech bubble (screen pixels) */
const BUBBLE_ABOVE_NAME = 4;

// ─── Types ────────────────────────────────────────────────────────

interface Bubble {
  avatarId: string;
  element: HTMLDivElement;
  createdAt: number;
}

interface NameLabel {
  avatarId: string;
  element: HTMLDivElement;
}

// ─── BubbleManager ────────────────────────────────────────────────

export class BubbleManager {
  private container: HTMLDivElement;
  private camera: Camera;
  private getAvatars: () => Map<string, Avatar>;
  private bubbles: Bubble[] = [];
  private nameLabels = new Map<string, NameLabel>();

  constructor(
    container: HTMLDivElement,
    camera: Camera,
    getAvatars: () => Map<string, Avatar>,
  ) {
    this.container = container;
    this.camera = camera;
    this.getAvatars = getAvatars;
  }

  /** Ensure a name label exists for this avatar */
  ensureNameLabel(avatarId: string, name: string): void {
    if (this.nameLabels.has(avatarId)) return;

    const el = document.createElement("div");
    el.className = "avatar-name-label";
    el.textContent = name;
    this.container.appendChild(el);

    this.nameLabels.set(avatarId, { avatarId, element: el });
  }

  /** Remove name label for an avatar */
  removeNameLabel(avatarId: string): void {
    const label = this.nameLabels.get(avatarId);
    if (label) {
      label.element.remove();
      this.nameLabels.delete(avatarId);
    }
  }

  /** Show a speech bubble above an avatar. Hides the name label while active. */
  show(avatarId: string, name: string, text: string, pm = false): void {
    // Remove old bubbles for this avatar
    this.removeBubbles(avatarId);

    const el = document.createElement("div");
    el.className = pm ? "speech-bubble pm" : "speech-bubble";

    // Inner text div for line-clamping (clamp doesn't work with mixed children)
    const inner = document.createElement("div");
    inner.className = "speech-bubble-text";
    inner.textContent = `${name}: ${text}`;
    el.appendChild(inner);

    this.container.appendChild(el);

    // Hide name label while bubble is showing
    const label = this.nameLabels.get(avatarId);
    if (label) label.element.style.display = "none";

    const bubble: Bubble = {
      avatarId,
      element: el,
      createdAt: Date.now(),
    };
    this.bubbles.push(bubble);
  }

  /** Show a PM speech bubble (purple-tinted) */
  showPm(avatarId: string, name: string, text: string): void {
    this.show(avatarId, name, text, true);
  }

  /** Remove all bubbles for an avatar (restores name label) */
  removeBubbles(avatarId: string): void {
    this.bubbles = this.bubbles.filter((b) => {
      if (b.avatarId === avatarId) {
        b.element.remove();
        return false;
      }
      return true;
    });
    // Restore name label visibility
    const label = this.nameLabels.get(avatarId);
    if (label) label.element.style.display = "";
  }

  /** Remove bubbles AND name label for an avatar */
  remove(avatarId: string): void {
    this.removeBubbles(avatarId);
    this.removeNameLabel(avatarId);
  }

  /** Remove all bubbles and name labels */
  clearAll(): void {
    for (const b of this.bubbles) {
      b.element.remove();
    }
    this.bubbles = [];
    for (const label of this.nameLabels.values()) {
      label.element.remove();
    }
    this.nameLabels.clear();
  }

  /** Update positions and handle expiry (call each frame) */
  update(): void {
    const now = Date.now();
    const avatars = this.getAvatars();

    // Update name labels
    for (const label of this.nameLabels.values()) {
      const avatar = avatars.get(label.avatarId);
      if (!avatar) {
        label.element.style.display = "none";
        continue;
      }

      // Keep hidden if a bubble is active for this avatar
      const hasBubble = this.bubbles.some((b) => b.avatarId === label.avatarId);
      if (hasBubble) continue;

      label.element.style.display = "";

      // Position above the avatar sprite top
      // Avatar sprite top = y - TILE_SIZE/2 - TILE_SIZE
      const worldX = avatar.x;
      const worldY = avatar.y - TILE_SIZE / 2 - TILE_SIZE - NAME_OFFSET_Y;
      const screen = this.camera.worldToScreen(worldX, worldY);
      label.element.style.left = `${screen.x}px`;
      label.element.style.top = `${screen.y}px`;
    }

    // Update bubbles
    this.bubbles = this.bubbles.filter((bubble) => {
      const age = now - bubble.createdAt;

      // Remove expired bubbles
      if (age > BUBBLE_DURATION + FADE_DURATION) {
        bubble.element.remove();
        // Restore name label
        const label = this.nameLabels.get(bubble.avatarId);
        if (label) label.element.style.display = "";
        return false;
      }

      // Fade out
      if (age > BUBBLE_DURATION) {
        const fadeProgress = (age - BUBBLE_DURATION) / FADE_DURATION;
        bubble.element.style.opacity = String(1 - fadeProgress);
      }

      // Position above the name label
      const avatar = avatars.get(bubble.avatarId);
      if (!avatar) {
        bubble.element.style.display = "none";
        return true;
      }

      bubble.element.style.display = "";

      // Bubble sits at the sprite top position (same as where name label would be)
      const worldX = avatar.x;
      const worldY = avatar.y - TILE_SIZE / 2 - TILE_SIZE - NAME_OFFSET_Y;
      const screen = this.camera.worldToScreen(worldX, worldY);

      bubble.element.style.left = `${screen.x}px`;
      bubble.element.style.top = `${screen.y}px`;

      return true;
    });
  }
}
