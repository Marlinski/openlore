/**
 * BubbleManager — HTML overlay speech bubbles above avatars.
 *
 * Speech bubbles are positioned using world-to-screen coordinate mapping
 * from the Camera. They're HTML elements (not PixiJS) for easy text
 * rendering and styling.
 *
 * Each bubble has a timed auto-dismiss and fades out.
 */

import { TILE_SIZE } from "@offisims/shared";
import type { Camera } from "../scene/camera.js";
import type { Avatar } from "../scene/avatar.js";

// ─── Constants ────────────────────────────────────────────────────

/** How long a bubble stays visible (ms) */
const BUBBLE_DURATION = 5000;
/** Fade-out duration (ms) */
const FADE_DURATION = 500;
/** Max bubbles per avatar (oldest removed) */
const MAX_BUBBLES = 1;
/** Offset above the avatar sprite top in pixels (world coords) */
const BUBBLE_OFFSET_Y = 8;

// ─── Types ────────────────────────────────────────────────────────

interface Bubble {
  avatarId: string;
  element: HTMLDivElement;
  createdAt: number;
}

// ─── BubbleManager ────────────────────────────────────────────────

export class BubbleManager {
  private container: HTMLDivElement;
  private camera: Camera;
  private getAvatars: () => Map<string, Avatar>;
  private bubbles: Bubble[] = [];

  constructor(
    container: HTMLDivElement,
    camera: Camera,
    getAvatars: () => Map<string, Avatar>,
  ) {
    this.container = container;
    this.camera = camera;
    this.getAvatars = getAvatars;
  }

  /** Show a speech bubble above an avatar */
  show(avatarId: string, text: string): void {
    // Remove old bubbles for this avatar
    this.remove(avatarId);

    const el = document.createElement("div");
    el.className = "speech-bubble";
    el.textContent = text;
    this.container.appendChild(el);

    const bubble: Bubble = {
      avatarId,
      element: el,
      createdAt: Date.now(),
    };
    this.bubbles.push(bubble);
  }

  /** Remove all bubbles for an avatar */
  remove(avatarId: string): void {
    this.bubbles = this.bubbles.filter((b) => {
      if (b.avatarId === avatarId) {
        b.element.remove();
        return false;
      }
      return true;
    });
  }

  /** Remove all bubbles */
  clearAll(): void {
    for (const b of this.bubbles) {
      b.element.remove();
    }
    this.bubbles = [];
  }

  /** Update bubble positions and handle expiry (call each frame) */
  update(): void {
    const now = Date.now();
    const avatars = this.getAvatars();

    this.bubbles = this.bubbles.filter((bubble) => {
      const age = now - bubble.createdAt;

      // Remove expired bubbles
      if (age > BUBBLE_DURATION + FADE_DURATION) {
        bubble.element.remove();
        return false;
      }

      // Fade out
      if (age > BUBBLE_DURATION) {
        const fadeProgress = (age - BUBBLE_DURATION) / FADE_DURATION;
        bubble.element.style.opacity = String(1 - fadeProgress);
      }

      // Position above avatar
      const avatar = avatars.get(bubble.avatarId);
      if (!avatar) {
        bubble.element.style.display = "none";
        return true; // keep it, avatar might come back
      }

      bubble.element.style.display = "";

      // World position: center top of the avatar sprite
      // Avatar sprite top = y - TILE_SIZE/2 - TILE_SIZE (sprite is 2 tiles tall)
      const worldX = avatar.x;
      const worldY = avatar.y - TILE_SIZE / 2 - TILE_SIZE - BUBBLE_OFFSET_Y;

      const screen = this.camera.worldToScreen(worldX, worldY);
      bubble.element.style.left = `${screen.x}px`;
      bubble.element.style.top = `${screen.y}px`;

      return true;
    });
  }
}
