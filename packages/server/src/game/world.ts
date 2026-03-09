/**
 * World — the authoritative game state.
 *
 * Holds all rooms, all avatars, and orchestrates game logic:
 *   - Avatar lifecycle (join, leave, move, room transitions)
 *   - Position validation against walkability grids
 *   - Chat message routing via ChatProvider
 *   - Broadcasting state updates to connected clients
 *
 * The World doesn't know about transports directly — it works with
 * SessionId references and emits events that the WebSocket layer
 * translates into wire messages.
 */

import type {
  ProjectData,
  CharacterDirection,
  ServerMessage,
  AvatarSnapshot,
  RoomSnapshot,
} from "@offisims/shared";
import { TILE_SIZE } from "@offisims/shared";
import type { SessionId } from "../transport/interface.js";
import type { ChatProvider } from "../chat/interface.js";
import { Room } from "./room.js";
import { createAvatar, avatarToSnapshot, type AvatarState } from "./avatar.js";

/** Global chat channel name */
const GLOBAL_CHANNEL = "#global";

/** Handler for sending messages to a specific session */
export type SendToSession = (sessionId: SessionId, msg: ServerMessage) => void;

export class World {
  /** All rooms by name */
  private rooms = new Map<string, Room>();
  /** All avatars by ID */
  private avatars = new Map<string, AvatarState>();
  /** Session → avatar ID mapping (one avatar per session for V1) */
  private sessionAvatars = new Map<SessionId, string>();
  /** The raw project data (for API serving) */
  private projectData: ProjectData | null = null;
  /** Chat provider */
  private chat: ChatProvider;
  /** Callback to send a message to a session */
  private sendToSession: SendToSession;
  /** Default room name */
  private defaultRoom = "";

  constructor(chat: ChatProvider, sendToSession: SendToSession) {
    this.chat = chat;
    this.sendToSession = sendToSession;

    // Wire up chat message delivery
    this.chat.onMessage((channel, avatarId, text) => {
      this.handleChatMessage(channel, avatarId, text);
    });

    // Create the global channel
    this.chat.createChannel(GLOBAL_CHANNEL);
  }

  // ─── Data loading ────────────────────────────────────────────

  /** Load game data from ProjectData JSON */
  loadGameData(data: ProjectData): void {
    this.projectData = data;

    // Create room instances
    this.rooms.clear();
    for (const roomDef of data.rooms) {
      const room = new Room(roomDef);
      this.rooms.set(room.name, room);
      // Create a chat channel for each room
      this.chat.createChannel(room.name);
    }

    // Set default room (first room if not configured)
    if (this.rooms.size > 0 && !this.defaultRoom) {
      this.defaultRoom = this.rooms.keys().next().value!;
    }

    console.log(
      `[World] Loaded ${this.rooms.size} rooms, ` +
        `${data.characters.length} characters, ` +
        `${data.composites.length} composites, ` +
        `${data.tilesets.length} tilesets`,
    );
  }

  /** Set the default room name */
  setDefaultRoom(name: string): void {
    this.defaultRoom = name;
  }

  /** Get the raw project data for API serving */
  getProjectData(): ProjectData | null {
    return this.projectData;
  }

  /** Get a room by name */
  getRoom(name: string): Room | undefined {
    return this.rooms.get(name);
  }

  /** Get all room names */
  getRoomNames(): string[] {
    return [...this.rooms.keys()];
  }

  // ─── Avatar lifecycle ────────────────────────────────────────

  /**
   * Handle a new client joining the game.
   * Creates an avatar, places it in the default room (or specified room),
   * and sends the welcome message + notifies other players in the room.
   */
  handleJoin(
    sessionId: SessionId,
    name: string,
    characterId: string,
    roomName?: string,
  ): void {
    // Prevent double-join
    if (this.sessionAvatars.has(sessionId)) {
      this.sendToSession(sessionId, {
        type: "error",
        message: "Already joined. Disconnect first.",
      });
      return;
    }

    // Resolve target room
    const targetRoomName = roomName || this.defaultRoom;
    const room = this.rooms.get(targetRoomName);
    if (!room) {
      this.sendToSession(sessionId, {
        type: "error",
        message: `Room "${targetRoomName}" not found.`,
      });
      return;
    }

    // Validate character exists
    if (this.projectData) {
      const charDef = this.projectData.characters.find(
        (c) => c.id === characterId,
      );
      if (!charDef) {
        this.sendToSession(sessionId, {
          type: "error",
          message: `Character "${characterId}" not found.`,
        });
        return;
      }
    }

    // Find spawn position
    const spawn = room.findSpawnPosition();

    // Create avatar
    const avatar = createAvatar(
      sessionId,
      name,
      characterId,
      targetRoomName,
      spawn.x,
      spawn.y,
    );
    this.avatars.set(avatar.id, avatar);
    this.sessionAvatars.set(sessionId, avatar.id);
    room.avatarIds.add(avatar.id);

    // Join chat channels
    this.chat.join(targetRoomName, avatar.id);
    this.chat.join(GLOBAL_CHANNEL, avatar.id);

    // Get all avatars in the room (for the welcome message)
    const roomAvatars = this.getAvatarsInRoom(targetRoomName);

    // Send welcome to the new client
    this.sendToSession(sessionId, {
      type: "welcome",
      avatarId: avatar.id,
      room: room.toSnapshot(),
      spawnX: spawn.x,
      spawnY: spawn.y,
      avatars: roomAvatars,
    });

    // Notify other players in the room
    this.broadcastToRoom(
      targetRoomName,
      {
        type: "avatar-join",
        avatar: avatarToSnapshot(avatar),
      },
      avatar.id, // exclude the new avatar itself
    );

    console.log(
      `[World] ${avatar.name} (${avatar.id}) joined room "${targetRoomName}"`,
    );
  }

  /**
   * Handle a client disconnecting.
   * Removes the avatar from the room and notifies others.
   */
  handleLeave(sessionId: SessionId): void {
    const avatarId = this.sessionAvatars.get(sessionId);
    if (!avatarId) return;

    const avatar = this.avatars.get(avatarId);
    if (!avatar) return;

    // Remove from room
    const room = this.rooms.get(avatar.room);
    if (room) {
      room.avatarIds.delete(avatarId);
      // Notify others in the room
      this.broadcastToRoom(avatar.room, {
        type: "avatar-leave",
        avatarId,
      });
    }

    // Leave all chat channels
    this.chat.leaveAll(avatarId);

    // Clean up
    this.avatars.delete(avatarId);
    this.sessionAvatars.delete(sessionId);

    console.log(
      `[World] ${avatar.name} (${avatarId}) left`,
    );
  }

  // ─── Position updates ────────────────────────────────────────

  /**
   * Handle a position update from a client.
   * Validates the position against the walkability grid.
   * If valid, updates the avatar and broadcasts to other players.
   * If invalid, sends a snap correction.
   */
  handlePosition(
    sessionId: SessionId,
    x: number,
    y: number,
    direction: CharacterDirection,
    moving: boolean,
  ): void {
    const avatarId = this.sessionAvatars.get(sessionId);
    if (!avatarId) return;

    const avatar = this.avatars.get(avatarId);
    if (!avatar) return;

    const room = this.rooms.get(avatar.room);
    if (!room) return;

    // Validate position: check the tile the avatar's feet are on
    // Avatar feet position is at the bottom of the 1x2 sprite
    const feetX = x;
    const feetY = y;

    if (!room.isWalkable(feetX, feetY)) {
      // Invalid position — snap back to last known good position
      this.sendToSession(sessionId, {
        type: "snap",
        x: avatar.x,
        y: avatar.y,
      });
      return;
    }

    // Bounds check
    const maxX = room.width * TILE_SIZE;
    const maxY = room.height * TILE_SIZE;
    if (x < 0 || x > maxX || y < 0 || y > maxY) {
      this.sendToSession(sessionId, {
        type: "snap",
        x: avatar.x,
        y: avatar.y,
      });
      return;
    }

    // Update avatar state
    avatar.x = x;
    avatar.y = y;
    avatar.direction = direction;
    avatar.moving = moving;
    avatar.family = moving ? "walk" : "idle";
    avatar.lastUpdate = Date.now();

    // Broadcast to other players in the room
    this.broadcastToRoom(
      avatar.room,
      {
        type: "avatar-move",
        avatarId,
        x,
        y,
        direction,
        moving,
      },
      avatarId, // exclude the avatar itself
    );
  }

  // ─── Door transitions ───────────────────────────────────────

  /**
   * Handle a door use request.
   * Validates the door exists and is linked, then teleports the avatar.
   */
  handleUseDoor(sessionId: SessionId, doorId: string): void {
    const avatarId = this.sessionAvatars.get(sessionId);
    if (!avatarId) return;

    const avatar = this.avatars.get(avatarId);
    if (!avatar) return;

    const room = this.rooms.get(avatar.room);
    if (!room) return;

    // Find the door
    const door = room.getDoor(doorId);
    if (!door) {
      this.sendToSession(sessionId, {
        type: "error",
        message: `Door "${doorId}" not found in room "${avatar.room}".`,
      });
      return;
    }

    // Check the door has a target
    if (!door.target) {
      this.sendToSession(sessionId, {
        type: "error",
        message: "This door is not linked to anywhere.",
      });
      return;
    }

    // Parse target: "roomName#doorId"
    const [targetRoomName, targetDoorId] = door.target.split("#");
    const targetRoom = this.rooms.get(targetRoomName);
    if (!targetRoom) {
      this.sendToSession(sessionId, {
        type: "error",
        message: `Target room "${targetRoomName}" not found.`,
      });
      return;
    }

    // Find spawn position in target room (at target door)
    const spawn = targetRoom.findSpawnPosition(targetDoorId);

    // Leave current room
    room.avatarIds.delete(avatarId);
    this.broadcastToRoom(avatar.room, {
      type: "avatar-leave",
      avatarId,
    });
    this.chat.leave(avatar.room, avatarId);

    // Enter new room
    avatar.room = targetRoomName;
    avatar.x = spawn.x;
    avatar.y = spawn.y;
    avatar.moving = false;
    avatar.family = "idle";
    targetRoom.avatarIds.add(avatarId);
    this.chat.join(targetRoomName, avatarId);

    // Get all avatars in the new room
    const roomAvatars = this.getAvatarsInRoom(targetRoomName);

    // Send room change to the transitioning client
    this.sendToSession(sessionId, {
      type: "room-change",
      room: targetRoom.toSnapshot(),
      spawnX: spawn.x,
      spawnY: spawn.y,
      avatars: roomAvatars,
    });

    // Notify others in the new room
    this.broadcastToRoom(
      targetRoomName,
      {
        type: "avatar-join",
        avatar: avatarToSnapshot(avatar),
      },
      avatarId,
    );

    console.log(
      `[World] ${avatar.name} transitioned to "${targetRoomName}"`,
    );
  }

  // ─── Chat ───────────────────────────────────────────────────

  /**
   * Handle a chat message from a client.
   * Routes it through the ChatProvider (room channel).
   */
  handleChat(sessionId: SessionId, text: string): void {
    const avatarId = this.sessionAvatars.get(sessionId);
    if (!avatarId) return;

    const avatar = this.avatars.get(avatarId);
    if (!avatar) return;

    // Send to the room channel
    this.chat.send(avatar.room, avatarId, text);
  }

  /**
   * Called by the ChatProvider when a message is sent to a channel.
   * Broadcasts to all clients whose avatars are in that channel.
   */
  private handleChatMessage(
    channel: string,
    avatarId: string,
    text: string,
  ): void {
    const avatar = this.avatars.get(avatarId);
    if (!avatar) return;

    // Get all members of the channel and send chat-message to their sessions
    const members = this.chat.getMembers(channel);
    for (const memberId of members) {
      const memberAvatar = this.avatars.get(memberId);
      if (!memberAvatar) continue;

      this.sendToSession(memberAvatar.sessionId, {
        type: "chat-message",
        avatarId,
        name: avatar.name,
        text,
      });
    }
  }

  // ─── Helpers ────────────────────────────────────────────────

  /** Get avatar snapshots for all avatars in a room */
  private getAvatarsInRoom(roomName: string): AvatarSnapshot[] {
    const room = this.rooms.get(roomName);
    if (!room) return [];

    const snapshots: AvatarSnapshot[] = [];
    for (const avatarId of room.avatarIds) {
      const avatar = this.avatars.get(avatarId);
      if (avatar) snapshots.push(avatarToSnapshot(avatar));
    }
    return snapshots;
  }

  /** Broadcast a message to all sessions with avatars in a room, optionally excluding one */
  private broadcastToRoom(
    roomName: string,
    msg: ServerMessage,
    excludeAvatarId?: string,
  ): void {
    const room = this.rooms.get(roomName);
    if (!room) return;

    for (const avatarId of room.avatarIds) {
      if (avatarId === excludeAvatarId) continue;
      const avatar = this.avatars.get(avatarId);
      if (avatar) {
        this.sendToSession(avatar.sessionId, msg);
      }
    }
  }
}
