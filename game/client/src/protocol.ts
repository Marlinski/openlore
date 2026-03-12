/**
 * WebSocket protocol types for the Offisims game.
 *
 * Hand-written (not proto-generated) because the WebSocket protocol
 * is JSON text frames today and will move to binary protobuf in Phase B.
 * Until then, these types define the JSON wire format.
 */

/** Character facing direction */
export type CharacterDirection = "down" | "up" | "left" | "right";

// ─── Avatar snapshot ─────────────────────────────────────────────

/** Full avatar state snapshot sent to clients */
export interface AvatarSnapshot {
  id: string;
  name: string;
  characterId: string;
  room: string;
  x: number;
  y: number;
  direction: CharacterDirection;
  moving: boolean;
  family: string;
}

/** Room snapshot sent to clients on join / room change */
export interface RoomSnapshot {
  name: string;
  width: number;
  height: number;
}

// ─── Client → Server messages ────────────────────────────────────

export interface ClientJoinMessage {
  type: "join";
  token: string;
}

export interface ClientPositionMessage {
  type: "position";
  x: number;
  y: number;
  direction: CharacterDirection;
  moving: boolean;
}

export interface ClientUseDoorMessage {
  type: "use-door";
  doorId: string;
}

export interface ClientChatMessage {
  type: "chat";
  text: string;
}

export interface ClientPrivateMessage {
  type: "private-message";
  targetAvatarId: string;
  text: string;
}

export interface ClientLeaveMessage {
  type: "leave";
}

export type ClientMessage =
  | ClientJoinMessage
  | ClientPositionMessage
  | ClientUseDoorMessage
  | ClientChatMessage
  | ClientPrivateMessage
  | ClientLeaveMessage;

// ─── Server → Client messages ────────────────────────────────────

export interface ServerWelcomeMessage {
  type: "welcome";
  avatarId: string;
  room: RoomSnapshot;
  spawnX: number;
  spawnY: number;
  avatars: AvatarSnapshot[];
}

export interface ServerAvatarJoinMessage {
  type: "avatar-join";
  avatar: AvatarSnapshot;
}

export interface ServerAvatarLeaveMessage {
  type: "avatar-leave";
  avatarId: string;
}

export interface ServerAvatarMoveMessage {
  type: "avatar-move";
  avatarId: string;
  x: number;
  y: number;
  direction: CharacterDirection;
  moving: boolean;
}

export interface ServerRoomChangeMessage {
  type: "room-change";
  room: RoomSnapshot;
  spawnX: number;
  spawnY: number;
  avatars: AvatarSnapshot[];
}

export interface ServerChatMessageMessage {
  type: "chat-message";
  avatarId: string;
  name: string;
  text: string;
}

export interface ServerPrivateMessageMessage {
  type: "private-message";
  fromAvatarId: string;
  fromName: string;
  toAvatarId: string;
  text: string;
}

export interface ServerSnapMessage {
  type: "snap";
  x: number;
  y: number;
}

export interface ServerErrorMessage {
  type: "error";
  message: string;
}

export type ServerMessage =
  | ServerWelcomeMessage
  | ServerAvatarJoinMessage
  | ServerAvatarLeaveMessage
  | ServerAvatarMoveMessage
  | ServerRoomChangeMessage
  | ServerChatMessageMessage
  | ServerPrivateMessageMessage
  | ServerSnapMessage
  | ServerErrorMessage;
