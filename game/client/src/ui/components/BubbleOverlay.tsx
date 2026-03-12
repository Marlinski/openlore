/**
 * BubbleOverlay — HTML overlay name labels and speech bubbles above avatars.
 *
 * This component manages imperative DOM overlays positioned using the Camera's
 * worldToScreen() transform. It runs its own update loop tied to requestAnimationFrame,
 * keeping the HTML in sync with the PixiJS canvas without triggering Preact re-renders.
 *
 * The BubbleManager class is exposed to the game engine via a ref callback
 * so SceneManager can call show(), remove(), etc.
 */

import { useEffect, useRef } from "preact/hooks";
import { TILE_SIZE } from "../../constants.js";
import type { Camera } from "../../scene/camera";
import type { Avatar } from "../../scene/avatar";

// ─── Constants ────────────────────────────────────────────────────

const BUBBLE_DURATION = 6000;
const FADE_DURATION = 600;
const NAME_OFFSET_Y = -TILE_SIZE * 0.35;

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

// ─── BubbleManager (imperative API for the game engine) ──────────

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

  ensureNameLabel(avatarId: string, name: string): void {
    if (this.nameLabels.has(avatarId)) return;

    const el = document.createElement("div");
    el.className = "avatar-name-label";
    el.textContent = name;
    this.container.appendChild(el);

    this.nameLabels.set(avatarId, { avatarId, element: el });
  }

  removeNameLabel(avatarId: string): void {
    const label = this.nameLabels.get(avatarId);
    if (label) {
      label.element.remove();
      this.nameLabels.delete(avatarId);
    }
  }

  show(avatarId: string, name: string, text: string, pm = false): void {
    this.removeBubbles(avatarId);

    const el = document.createElement("div");
    el.className = pm ? "speech-bubble pm" : "speech-bubble";

    const inner = document.createElement("div");
    inner.className = "speech-bubble-text";
    inner.textContent = `${name}: ${text}`;
    el.appendChild(inner);

    this.container.appendChild(el);

    const label = this.nameLabels.get(avatarId);
    if (label) label.element.style.display = "none";

    this.bubbles.push({
      avatarId,
      element: el,
      createdAt: Date.now(),
    });
  }

  showPm(avatarId: string, name: string, text: string): void {
    this.show(avatarId, name, text, true);
  }

  removeBubbles(avatarId: string): void {
    this.bubbles = this.bubbles.filter((b) => {
      if (b.avatarId === avatarId) {
        b.element.remove();
        return false;
      }
      return true;
    });
    const label = this.nameLabels.get(avatarId);
    if (label) label.element.style.display = "";
  }

  remove(avatarId: string): void {
    this.removeBubbles(avatarId);
    this.removeNameLabel(avatarId);
  }

  clearAll(): void {
    for (const b of this.bubbles) b.element.remove();
    this.bubbles = [];
    for (const label of this.nameLabels.values()) label.element.remove();
    this.nameLabels.clear();
  }

  update(): void {
    const now = Date.now();
    const avatars = this.getAvatars();

    for (const label of this.nameLabels.values()) {
      const avatar = avatars.get(label.avatarId);
      if (!avatar) {
        label.element.style.display = "none";
        continue;
      }

      const hasBubble = this.bubbles.some((b) => b.avatarId === label.avatarId);
      if (hasBubble) continue;

      label.element.style.display = "";

      const worldX = avatar.x;
      const worldY = avatar.y - TILE_SIZE / 2 - TILE_SIZE - NAME_OFFSET_Y;
      const screen = this.camera.worldToScreen(worldX, worldY);
      label.element.style.left = `${screen.x}px`;
      label.element.style.top = `${screen.y}px`;
    }

    this.bubbles = this.bubbles.filter((bubble) => {
      const age = now - bubble.createdAt;

      if (age > BUBBLE_DURATION + FADE_DURATION) {
        bubble.element.remove();
        const label = this.nameLabels.get(bubble.avatarId);
        if (label) label.element.style.display = "";
        return false;
      }

      if (age > BUBBLE_DURATION) {
        const fadeProgress = (age - BUBBLE_DURATION) / FADE_DURATION;
        bubble.element.style.opacity = String(1 - fadeProgress);
      }

      const avatar = avatars.get(bubble.avatarId);
      if (!avatar) {
        bubble.element.style.display = "none";
        return true;
      }

      bubble.element.style.display = "";

      const worldX = avatar.x;
      const worldY = avatar.y - TILE_SIZE / 2 - TILE_SIZE - NAME_OFFSET_Y;
      const screen = this.camera.worldToScreen(worldX, worldY);
      bubble.element.style.left = `${screen.x}px`;
      bubble.element.style.top = `${screen.y}px`;

      return true;
    });
  }
}

// ─── Preact component ────────────────────────────────────────────

interface BubbleOverlayProps {
  camera: Camera;
  getAvatars: () => Map<string, Avatar>;
  onReady: (manager: BubbleManager) => void;
}

export function BubbleOverlay(props: BubbleOverlayProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (containerRef.current) {
      const manager = new BubbleManager(containerRef.current, props.camera, props.getAvatars);
      props.onReady(manager);
    }
  }, []);

  return <div class="bubble-container" ref={containerRef} />;
}
