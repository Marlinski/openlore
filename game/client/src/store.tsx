/**
 * Game store — reactive state bridge between the imperative game engine
 * and Preact UI components.
 *
 * The game engine (SceneManager, Connection, etc.) remains fully imperative.
 * This store exposes @preact/signals that components read via `.value`.
 * The engine pushes updates into this store via exported setter functions.
 *
 * This is the ONLY place where game state crosses into Preact reactivity.
 */

import { signal, batch } from "@preact/signals";
import type { Pack } from "@openlore/pack";

// ─── Types ────────────────────────────────────────────────────────

export interface LoreMessage {
  name: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
}

export interface PmMessage {
  name: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
}

export interface SelectedAvatar {
  avatarId: string;
  name: string;
  characterId: string;
}

// ─── App-level state (screens, boot) ─────────────────────────────

export type AppScreen = "join" | "lore" | "game";

export const screen = signal<AppScreen>("lore");
export const joinStatus = signal("");
export const joinReady = signal(false);
export const gameData = signal<Pack | null>(null);
export const sessionToken = signal<string | null>(null);

// ─── Lore state ───────────────────────────────────────────────────

/** The lore the player has joined (e.g. "#lobby"). Set before entering game screen. */
export const currentLore = signal<string | null>(null);

/** The current IRC room channel (e.g. "#lobby-reception"). Changes on door transitions. */
export const ircRoom = signal("");

// ─── Connection state ─────────────────────────────────────────────

export const connected = signal(false);
export const ircConnected = signal(false);

// ─── Zoom state ───────────────────────────────────────────────────

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3];
const DEFAULT_ZOOM_INDEX = 2;

const zoomIndex = signal(DEFAULT_ZOOM_INDEX);
export const zoomLevel = () => ZOOM_LEVELS[zoomIndex.value];
/** Callback set by the game engine to receive zoom changes */
let onZoomChangeCb: ((zoom: number) => void) | null = null;

export function stepZoom(direction: number): void {
  const newIndex = zoomIndex.value + direction;
  if (newIndex < 0 || newIndex >= ZOOM_LEVELS.length) return;
  zoomIndex.value = newIndex;
  if (onZoomChangeCb) onZoomChangeCb(ZOOM_LEVELS[newIndex]);
}

export function setOnZoomChange(cb: (zoom: number) => void): void {
  onZoomChangeCb = cb;
}

// ─── Room name ────────────────────────────────────────────────────

export const roomName = signal("");

// ─── Lore panel (left panel — room chat) ─────────────────────────

export const loreOpen = signal(false);
export const loreMessages = signal<LoreMessage[]>([]);

export function toggleLore(): void {
  loreOpen.value = !loreOpen.value;
}

export function addLoreMessage(name: string, text: string, isSelf: boolean): void {
  const entry: LoreMessage = { name, text, timestamp: Date.now(), isSelf };
  const msgs = loreMessages.value;
  const next = [...msgs, entry];
  loreMessages.value = next.length > 200 ? next.slice(next.length - 200) : next;
}

export function clearLoreMessages(): void {
  loreMessages.value = [];
}

// ─── Character card (right panel — avatar PM chat) ───────────────

export const selectedAvatar = signal<SelectedAvatar | null>(null);
export const pmMessages = signal<PmMessage[]>([]);

export function openCharacterCard(avatarId: string, name: string, characterId: string): void {
  batch(() => {
    selectedAvatar.value = { avatarId, name, characterId };
  });
}

export function closeCharacterCard(): void {
  selectedAvatar.value = null;
}

export function setPmHistory(messages: PmMessage[]): void {
  pmMessages.value = [...messages];
}

export function addPmMessage(name: string, text: string, isSelf: boolean): void {
  const entry: PmMessage = { name, text, timestamp: Date.now(), isSelf };
  const msgs = pmMessages.value;
  const next = [...msgs, entry];
  pmMessages.value = next.length > 200 ? next.slice(next.length - 200) : next;
}

export function clearPmMessages(): void {
  pmMessages.value = [];
}
