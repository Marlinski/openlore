/**
 * Game store — reactive state bridge between the imperative game engine
 * and SolidJS UI components.
 *
 * The game engine (SceneManager, Connection, etc.) remains fully imperative.
 * This store exposes SolidJS signals and store slices that components read.
 * The engine pushes updates into this store via exported setter functions.
 *
 * This is the ONLY place where game state crosses into Solid reactivity.
 */

import { createSignal, batch } from "solid-js";
import { createStore, produce } from "solid-js/store";
import type { ProjectData } from "@offisims/shared";

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

export type AppScreen = "join" | "game";

const [screen, setScreen] = createSignal<AppScreen>("join");
const [joinStatus, setJoinStatus] = createSignal("Loading...");
const [joinReady, setJoinReady] = createSignal(false);
const [gameData, setGameData] = createSignal<ProjectData | null>(null);

export { screen, setScreen, joinStatus, setJoinStatus, joinReady, setJoinReady, gameData, setGameData };

// ─── Connection state ─────────────────────────────────────────────

const [connected, setConnected] = createSignal(false);

export { connected, setConnected };

// ─── Zoom state ───────────────────────────────────────────────────

const ZOOM_LEVELS = [0.5, 0.75, 1, 1.5, 2, 3];
const DEFAULT_ZOOM_INDEX = 2;

const [zoomIndex, setZoomIndex] = createSignal(DEFAULT_ZOOM_INDEX);
const zoomLevel = () => ZOOM_LEVELS[zoomIndex()];
/** Callback set by the game engine to receive zoom changes */
let onZoomChangeCb: ((zoom: number) => void) | null = null;

function stepZoom(direction: number): void {
  const newIndex = zoomIndex() + direction;
  if (newIndex < 0 || newIndex >= ZOOM_LEVELS.length) return;
  setZoomIndex(newIndex);
  if (onZoomChangeCb) onZoomChangeCb(ZOOM_LEVELS[newIndex]);
}

function setOnZoomChange(cb: (zoom: number) => void): void {
  onZoomChangeCb = cb;
}

export { zoomLevel, stepZoom, setOnZoomChange };

// ─── Room name ────────────────────────────────────────────────────

const [roomName, setRoomName] = createSignal("");

export { roomName, setRoomName };

// ─── Channel panel (left panel — room chat) ──────────────────────

const [channelOpen, setChannelOpen] = createSignal(false);
const [channelMessages, setChannelMessages] = createStore<ChannelMessage[]>([]);

function toggleChannel(): void {
  setChannelOpen((prev) => !prev);
}

function addChannelMessage(name: string, text: string, isSelf: boolean): void {
  const entry: ChannelMessage = { name, text, timestamp: Date.now(), isSelf };
  setChannelMessages(
    produce((msgs) => {
      msgs.push(entry);
      while (msgs.length > 200) msgs.shift();
    }),
  );
}

function clearChannelMessages(): void {
  setChannelMessages([]);
}

export {
  channelOpen, setChannelOpen, toggleChannel,
  channelMessages, addChannelMessage, clearChannelMessages,
};

// ─── Character card (right panel — avatar PM chat) ───────────────

const [selectedAvatar, setSelectedAvatar] = createSignal<SelectedAvatar | null>(null);
const [pmMessages, setPmMessages] = createStore<PmMessage[]>([]);

function openCharacterCard(avatarId: string, name: string, characterId: string): void {
  batch(() => {
    setSelectedAvatar({ avatarId, name, characterId });
  });
}

function closeCharacterCard(): void {
  setSelectedAvatar(null);
}

function setPmHistory(messages: PmMessage[]): void {
  setPmMessages([...messages]);
}

function addPmMessage(name: string, text: string, isSelf: boolean): void {
  const entry: PmMessage = { name, text, timestamp: Date.now(), isSelf };
  setPmMessages(
    produce((msgs) => {
      msgs.push(entry);
      while (msgs.length > 200) msgs.shift();
    }),
  );
}

function clearPmMessages(): void {
  setPmMessages([]);
}

export {
  selectedAvatar, openCharacterCard, closeCharacterCard,
  pmMessages, setPmHistory, addPmMessage, clearPmMessages,
};
