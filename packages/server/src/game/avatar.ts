/**
 * Avatar entity — represents a player or AI agent in the game world.
 *
 * The server is authoritative over avatar state. Clients send position
 * updates that the server validates against the room's walkability grid.
 *
 * Avatar coordinates are in pixels (not tiles), allowing smooth
 * sub-tile movement. The walkability check converts pixel position
 * to the tile the avatar's feet occupy.
 */

import type { CharacterDirection, AvatarSnapshot } from "@offisims/shared";
import type { SessionId } from "../transport/interface.js";

export interface AvatarState {
  /** Server-assigned unique ID */
  id: string;
  /** Display name */
  name: string;
  /** Character definition ID (for appearance) */
  characterId: string;
  /** Session that controls this avatar (null = AI-controlled in future) */
  sessionId: SessionId;
  /** Current room name */
  room: string;
  /** Pixel X within the room */
  x: number;
  /** Pixel Y within the room */
  y: number;
  /** Facing direction */
  direction: CharacterDirection;
  /** Whether currently moving */
  moving: boolean;
  /** Current animation family */
  family: string;
  /** Timestamp of last position update (for rate limiting) */
  lastUpdate: number;
}

let nextAvatarId = 1;

/** Create a new avatar with a unique ID */
export function createAvatar(
  sessionId: SessionId,
  name: string,
  characterId: string,
  room: string,
  spawnX: number,
  spawnY: number,
): AvatarState {
  return {
    id: `avatar-${nextAvatarId++}`,
    name,
    characterId,
    sessionId,
    room,
    x: spawnX,
    y: spawnY,
    direction: "down",
    moving: false,
    family: "idle",
    lastUpdate: Date.now(),
  };
}

/** Convert avatar state to a snapshot for sending to clients */
export function avatarToSnapshot(avatar: AvatarState): AvatarSnapshot {
  return {
    id: avatar.id,
    name: avatar.name,
    characterId: avatar.characterId,
    room: avatar.room,
    x: avatar.x,
    y: avatar.y,
    direction: avatar.direction,
    moving: avatar.moving,
    family: avatar.family,
  };
}
