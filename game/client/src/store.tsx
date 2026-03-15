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
import type { Pack } from "@offisims/pack";

// ─── Types ────────────────────────────────────────────────────────

export interface ChannelMessage {
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

export type AppScreen = "join" | "channels" | "game";

export const screen = signal<AppScreen>("join");
export const joinStatus = signal("Loading...");
export const joinReady = signal(false);
export const gameData = signal<Pack | null>(null);

// ─── Channel state ────────────────────────────────────────────────

/** The channel the player has joined (e.g. "#lobby"). Set before entering game screen. */
export const currentChannel = signal<string | null>(null);

// ─── Connection state ─────────────────────────────────────────────

export const connected = signal(false);

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

// ─── Channel panel (left panel — room chat) ──────────────────────

export const channelOpen = signal(false);
export const channelMessages = signal<ChannelMessage[]>([]);

export function toggleChannel(): void {
  channelOpen.value = !channelOpen.value;
}

export function addChannelMessage(name: string, text: string, isSelf: boolean): void {
  const entry: ChannelMessage = { name, text, timestamp: Date.now(), isSelf };
  const msgs = channelMessages.value;
  const next = [...msgs, entry];
  channelMessages.value = next.length > 200 ? next.slice(next.length - 200) : next;
}

export function clearChannelMessages(): void {
  channelMessages.value = [];
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
