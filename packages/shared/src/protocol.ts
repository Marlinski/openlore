/**
 * WebSocket protocol definitions for Offisims game.
 *
 * The server is authoritative. Clients send intents, the server
 * validates and broadcasts state updates.
 *
 * Movement model: client-side prediction with server reconciliation.
 * The client moves locally (pixel-granular, local collision check),
 * sends position updates ~10-20/sec while moving, and the server
 * validates and relays to other clients in the same room.
 *
 * Message format: JSON over WebSocket text frames.
 * Each message has a `type` discriminator field.
 */

import type { CharacterDirection } from "./types.js";

// ─── Avatar snapshot (shared between server and client) ──────────

/** Full avatar state snapshot sent to clients */
export interface AvatarSnapshot {
  /** Unique avatar ID (server-assigned) */
  id: string;
  /** Display name */
  name: string;
  /** Character definition ID (references ProjectData.characters[].id) */
  characterId: string;
  /** Current room name */
  room: string;
  /** Pixel X position within the room */
  x: number;
  /** Pixel Y position within the room */
  y: number;
  /** Facing direction */
  direction: CharacterDirection;
  /** Whether the avatar is currently moving */
  moving: boolean;
  /** Current animation family (e.g. "idle", "walk", "sit_office") */
  family: string;
}

/** Room snapshot sent to clients on join / room change */
export interface RoomSnapshot {
  /** Room name */
  name: string;
  /** Grid width in tiles */
  width: number;
  /** Grid height in tiles */
  height: number;
}

// ─── Client → Server messages ────────────────────────────────────

/** Client requests to join the game with a new avatar */
export interface ClientJoinMessage {
  type: "join";
  /** Desired display name */
  name: string;
  /** Character definition ID to use for appearance */
  characterId: string;
  /** (Optional) Room to spawn in. If omitted, server picks default. */
  room?: string;
}

/**
 * Client reports its avatar's position.
 * Sent periodically while moving (~10-20/sec).
 * The client does local collision checking; the server validates.
 */
export interface ClientPositionMessage {
  type: "position";
  /** Pixel X within current room */
  x: number;
  /** Pixel Y within current room */
  y: number;
  /** Facing direction */
  direction: CharacterDirection;
  /** Whether currently moving */
  moving: boolean;
}

/** Client requests to use a door (teleport to another room) */
export interface ClientUseDoorMessage {
  type: "use-door";
  /** The door ID the avatar is standing on */
  doorId: string;
}

/** Client sends a chat message to the current room */
export interface ClientChatMessage {
  type: "chat";
  /** Message text */
  text: string;
}

/** Client requests to leave the game (disconnect gracefully) */
export interface ClientLeaveMessage {
  type: "leave";
}

/** Union of all client → server message types */
export type ClientMessage =
  | ClientJoinMessage
  | ClientPositionMessage
  | ClientUseDoorMessage
  | ClientChatMessage
  | ClientLeaveMessage;

// ─── Server → Client messages ────────────────────────────────────

/**
 * Sent to a client immediately after joining.
 * Contains the client's avatar ID, current room state, and all
 * avatars currently in the room.
 */
export interface ServerWelcomeMessage {
  type: "welcome";
  /** The server-assigned avatar ID for this client */
  avatarId: string;
  /** Current room snapshot */
  room: RoomSnapshot;
  /** Spawn position (pixel X) */
  spawnX: number;
  /** Spawn position (pixel Y) */
  spawnY: number;
  /** All avatars currently in this room (including the new one) */
  avatars: AvatarSnapshot[];
}

/** Broadcast when a new avatar enters the client's current room */
export interface ServerAvatarJoinMessage {
  type: "avatar-join";
  /** The avatar that joined */
  avatar: AvatarSnapshot;
}

/** Broadcast when an avatar leaves the client's current room */
export interface ServerAvatarLeaveMessage {
  type: "avatar-leave";
  /** ID of the avatar that left */
  avatarId: string;
}

/**
 * Broadcast when another avatar moves within the client's current room.
 * Clients interpolate between position updates for smooth rendering.
 */
export interface ServerAvatarMoveMessage {
  type: "avatar-move";
  /** ID of the avatar */
  avatarId: string;
  /** New pixel X */
  x: number;
  /** New pixel Y */
  y: number;
  /** Facing direction */
  direction: CharacterDirection;
  /** Whether the avatar is moving */
  moving: boolean;
}

/**
 * Sent to a client when their avatar transitions to a new room.
 * Contains the new room snapshot, spawn position, and all avatars
 * in the destination room.
 */
export interface ServerRoomChangeMessage {
  type: "room-change";
  /** New room snapshot */
  room: RoomSnapshot;
  /** Spawn pixel X (at destination door) */
  spawnX: number;
  /** Spawn pixel Y (at destination door) */
  spawnY: number;
  /** All avatars in the new room */
  avatars: AvatarSnapshot[];
}

/** Chat message from an avatar in the client's current room */
export interface ServerChatMessageMessage {
  type: "chat-message";
  /** Avatar ID of the sender */
  avatarId: string;
  /** Sender's display name (convenience — client can also look up from avatar list) */
  name: string;
  /** Message text */
  text: string;
}

/**
 * Server corrects the client's avatar position.
 * Sent when the server detects the client reported an invalid position
 * (e.g. inside a wall). The client should snap to this position.
 */
export interface ServerSnapMessage {
  type: "snap";
  /** Corrected pixel X */
  x: number;
  /** Corrected pixel Y */
  y: number;
}

/** Server reports an error to the client */
export interface ServerErrorMessage {
  type: "error";
  /** Error description */
  message: string;
}

/** Union of all server → client message types */
export type ServerMessage =
  | ServerWelcomeMessage
  | ServerAvatarJoinMessage
  | ServerAvatarLeaveMessage
  | ServerAvatarMoveMessage
  | ServerRoomChangeMessage
  | ServerChatMessageMessage
  | ServerSnapMessage
  | ServerErrorMessage;

// ─── Message type guards ─────────────────────────────────────────

/** Type guard for client messages */
export function isClientMessage(msg: unknown): msg is ClientMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    typeof (msg as any).type === "string" &&
    ["join", "position", "use-door", "chat", "leave"].includes(
      (msg as any).type,
    )
  );
}

/** Type guard for server messages */
export function isServerMessage(msg: unknown): msg is ServerMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    "type" in msg &&
    typeof (msg as any).type === "string" &&
    [
      "welcome",
      "avatar-join",
      "avatar-leave",
      "avatar-move",
      "room-change",
      "chat-message",
      "snap",
      "error",
    ].includes((msg as any).type)
  );
}
