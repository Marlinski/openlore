/**
 * World — the authoritative game state.
 *
 * Holds all rooms, all avatars, and orchestrates game logic:
 *   - Avatar lifecycle (join, disconnect, reconnect, leave, move, room transitions)
 *   - Position validation against walkability grids
 *   - Chat message routing via ChatProvider
 *   - Broadcasting state updates to connected clients
 *
 * The World doesn't know about transports directly — it works with
 * SessionId references and emits events that the WebSocket layer
 * translates into wire messages.
 *
 * Reconnection model:
 *   Each avatar has a persistent token (UUID). When a session disconnects,
 *   the avatar enters a grace period. If a session reconnects with the same
 *   token within the grace window, the avatar is reattached. Multiple
 *   concurrent sessions per avatar are allowed (multi-tab).
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
import type { PlayerStore } from "../player.js";
import { Room } from "./room.js";
import { createAvatar, avatarToSnapshot, type AvatarState } from "./avatar.js";

/** Global chat channel name */
const GLOBAL_CHANNEL = "#global";

/** Grace period before a disconnected avatar is removed (ms) */
const DISCONNECT_GRACE_MS = 30_000;

/** Handler for sending messages to a specific session */
export type SendToSession = (sessionId: SessionId, msg: ServerMessage) => void;

export class World {
  /** All rooms by name */
  private rooms = new Map<string, Room>();
  /** All avatars by ID */
  private avatars = new Map<string, AvatarState>();
  /** Token → avatar ID lookup (for reconnection) */
  private tokenAvatars = new Map<string, string>();
  /** Avatar ID → set of controlling sessions (supports multi-tab) */
  private avatarSessions = new Map<string, Set<SessionId>>();
  /** Session → avatar ID mapping (reverse lookup) */
  private sessionAvatars = new Map<SessionId, string>();
  /** Grace timers for disconnected avatars (avatarId → timer) */
  private graceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** The raw project data (for API serving) */
  private projectData: ProjectData | null = null;
  /** Chat provider */
  private chat: ChatProvider;
  /** Player store (persistent identity) */
  private players: PlayerStore;
  /** Callback to send a message to a session */
  private sendToSession: SendToSession;
  /** Default room name */
  private defaultRoom = "";

  constructor(chat: ChatProvider, players: PlayerStore, sendToSession: SendToSession) {
    this.chat = chat;
    this.players = players;
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
   * Handle a client joining the game.
   *
   * The token identifies a registered player. If the token also maps
   * to a live avatar (or one in grace period), the session reattaches.
   * Otherwise a new avatar is spawned using the player record.
   */
  handleJoin(sessionId: SessionId, token: string): void {
    // Prevent double-join from the same session
    if (this.sessionAvatars.has(sessionId)) {
      this.sendToSession(sessionId, {
        type: "error",
        message: "Already joined. Disconnect first.",
      });
      return;
    }

    // ─── Try reconnection to existing avatar ──────────────────
    const existingAvatarId = this.tokenAvatars.get(token);
    if (existingAvatarId) {
      const avatar = this.avatars.get(existingAvatarId);
      if (avatar) {
        // Cancel grace timer if active
        const timer = this.graceTimers.get(existingAvatarId);
        if (timer) {
          clearTimeout(timer);
          this.graceTimers.delete(existingAvatarId);
          console.log(
            `[World] ${avatar.name} (${existingAvatarId}) reconnected within grace period`,
          );
        } else {
          console.log(
            `[World] ${avatar.name} (${existingAvatarId}) added session (multi-tab)`,
          );
        }

        // Attach session to this avatar
        this.addSessionToAvatar(sessionId, existingAvatarId);

        // Send welcome with avatar's current state
        const room = this.rooms.get(avatar.room)!;
        const roomAvatars = this.getAvatarsInRoom(avatar.room);

        this.sendToSession(sessionId, {
          type: "welcome",
          avatarId: avatar.id,
          room: room.toSnapshot(),
          spawnX: avatar.x,
          spawnY: avatar.y,
          avatars: roomAvatars,
        });

        return;
      }
    }

    // ─── New avatar from player record ────────────────────────

    const player = this.players.getByToken(token);
    if (!player) {
      this.sendToSession(sessionId, {
        type: "error",
        message: "Invalid or expired session.",
      });
      return;
    }

    // Resolve target room
    const targetRoomName = this.defaultRoom;
    const room = this.rooms.get(targetRoomName);
    if (!room) {
      this.sendToSession(sessionId, {
        type: "error",
        message: `Room "${targetRoomName}" not found.`,
      });
      return;
    }

    // Find spawn position
    const spawn = room.findSpawnPosition();

    // Create avatar (token is the player's persistent session token)
    const avatar = createAvatar(
      token,
      player.name,
      player.characterId,
      targetRoomName,
      spawn.x,
      spawn.y,
    );
    this.avatars.set(avatar.id, avatar);
    this.tokenAvatars.set(token, avatar.id);
    this.addSessionToAvatar(sessionId, avatar.id);
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
      { avatarId: avatar.id }, // exclude the new avatar itself
    );

    console.log(
      `[World] ${avatar.name} (${avatar.id}) joined room "${targetRoomName}"`,
    );
  }

  /**
   * Handle a session disconnecting (WebSocket close).
   *
   * Removes the session from the avatar's session set. If this was the
   * last session, starts a grace timer. The avatar stays in the room
   * (frozen in place) during the grace period, appearing AFK to others.
   */
  handleDisconnect(sessionId: SessionId): void {
    const avatarId = this.sessionAvatars.get(sessionId);
    if (!avatarId) return;

    const avatar = this.avatars.get(avatarId);
    if (!avatar) return;

    // Remove this session from the avatar
    this.removeSessionFromAvatar(sessionId, avatarId);

    const sessions = this.avatarSessions.get(avatarId);
    if (sessions && sessions.size > 0) {
      // Other tabs still connected — avatar stays fully active
      console.log(
        `[World] ${avatar.name} (${avatarId}) lost a session, ${sessions.size} remaining`,
      );
      return;
    }

    // Last session disconnected — freeze avatar and start grace timer
    avatar.moving = false;
    avatar.family = "idle";

    // Broadcast the stop so others see the avatar freeze
    this.broadcastToRoom(avatar.room, {
      type: "avatar-move",
      avatarId,
      x: avatar.x,
      y: avatar.y,
      direction: avatar.direction,
      moving: false,
    });

    console.log(
      `[World] ${avatar.name} (${avatarId}) disconnected, grace period ${DISCONNECT_GRACE_MS / 1000}s`,
    );

    const timer = setTimeout(() => {
      this.graceTimers.delete(avatarId);
      this.removeAvatar(avatarId);
    }, DISCONNECT_GRACE_MS);

    this.graceTimers.set(avatarId, timer);
  }

  /**
   * Handle an explicit leave message from a client.
   * Immediately removes the avatar (no grace period).
   */
  handleLeave(sessionId: SessionId): void {
    const avatarId = this.sessionAvatars.get(sessionId);
    if (!avatarId) return;

    // Cancel grace timer if any
    const timer = this.graceTimers.get(avatarId);
    if (timer) {
      clearTimeout(timer);
      this.graceTimers.delete(avatarId);
    }

    // Remove ALL sessions for this avatar (explicit leave = done)
    const sessions = this.avatarSessions.get(avatarId);
    if (sessions) {
      for (const sid of sessions) {
        this.sessionAvatars.delete(sid);
      }
    }
    this.avatarSessions.delete(avatarId);

    this.removeAvatar(avatarId);
  }

  /**
   * Clean up an avatar entirely — remove from room, broadcast leave,
   * leave chat, delete from all maps.
   */
  private removeAvatar(avatarId: string): void {
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

    // Clean up all maps
    this.tokenAvatars.delete(avatar.token);
    const sessions = this.avatarSessions.get(avatarId);
    if (sessions) {
      for (const sid of sessions) {
        this.sessionAvatars.delete(sid);
      }
    }
    this.avatarSessions.delete(avatarId);
    this.avatars.delete(avatarId);

    console.log(
      `[World] ${avatar.name} (${avatarId}) removed`,
    );
  }

  // ─── Session ↔ Avatar mapping helpers ───────────────────────

  /** Link a session to an avatar */
  private addSessionToAvatar(sessionId: SessionId, avatarId: string): void {
    this.sessionAvatars.set(sessionId, avatarId);
    let sessions = this.avatarSessions.get(avatarId);
    if (!sessions) {
      sessions = new Set();
      this.avatarSessions.set(avatarId, sessions);
    }
    sessions.add(sessionId);
  }

  /** Unlink a session from an avatar */
  private removeSessionFromAvatar(sessionId: SessionId, avatarId: string): void {
    this.sessionAvatars.delete(sessionId);
    const sessions = this.avatarSessions.get(avatarId);
    if (sessions) {
      sessions.delete(sessionId);
    }
  }

  /** Send a message to ALL sessions controlling an avatar */
  private sendToAvatar(avatarId: string, msg: ServerMessage): void {
    const sessions = this.avatarSessions.get(avatarId);
    if (!sessions) return;
    for (const sid of sessions) {
      this.sendToSession(sid, msg);
    }
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

    // Broadcast to other players in the room.
    // Exclude only the sending session (not the whole avatar) so that
    // other tabs of the same avatar still receive the position update.
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
      { sessionId }, // exclude the sending session only
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

    // Send room change to ALL sessions of the transitioning avatar
    this.sendToAvatar(avatarId, {
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
      { avatarId },
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
   * Handle a private message from one avatar to another.
   * Routes directly — bypasses ChatProvider entirely.
   * Sends the message to both sender (echo) and recipient.
   */
  handlePrivateMessage(
    sessionId: SessionId,
    targetAvatarId: string,
    text: string,
  ): void {
    const senderAvatarId = this.sessionAvatars.get(sessionId);
    if (!senderAvatarId) return;

    const sender = this.avatars.get(senderAvatarId);
    if (!sender) return;

    const target = this.avatars.get(targetAvatarId);
    if (!target) {
      this.sendToSession(sessionId, {
        type: "error",
        message: "That player is no longer online.",
      });
      return;
    }

    const pm: ServerMessage = {
      type: "private-message",
      fromAvatarId: senderAvatarId,
      fromName: sender.name,
      toAvatarId: targetAvatarId,
      text,
    };

    // Send to all sessions of the recipient
    this.sendToAvatar(targetAvatarId, pm);

    // Echo to all sessions of the sender (if sender != recipient)
    if (targetAvatarId !== senderAvatarId) {
      this.sendToAvatar(senderAvatarId, pm);
    }
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

    const msg: ServerMessage = {
      type: "chat-message",
      avatarId,
      name: avatar.name,
      text,
    };

    // Get all members of the channel and send chat-message to their sessions
    const members = this.chat.getMembers(channel);
    for (const memberId of members) {
      const memberAvatar = this.avatars.get(memberId);
      if (!memberAvatar) continue;
      this.sendToAvatar(memberId, msg);
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

  /**
   * Broadcast a message to all sessions with avatars in a room.
   *
   * Exclusion options (mutually exclusive):
   *   - excludeAvatarId: skip ALL sessions of this avatar (used for join/leave)
   *   - excludeSessionId: skip only this one session (used for position updates,
   *     so other tabs of the same avatar still receive the update)
   */
  private broadcastToRoom(
    roomName: string,
    msg: ServerMessage,
    exclude?: { avatarId: string } | { sessionId: SessionId },
  ): void {
    const room = this.rooms.get(roomName);
    if (!room) return;

    if (exclude && "avatarId" in exclude) {
      // Skip all sessions of the excluded avatar
      for (const avatarId of room.avatarIds) {
        if (avatarId === exclude.avatarId) continue;
        this.sendToAvatar(avatarId, msg);
      }
    } else if (exclude && "sessionId" in exclude) {
      // Send to everyone, but skip a single session
      for (const avatarId of room.avatarIds) {
        const sessions = this.avatarSessions.get(avatarId);
        if (!sessions) continue;
        for (const sid of sessions) {
          if (sid === exclude.sessionId) continue;
          this.sendToSession(sid, msg);
        }
      }
    } else {
      // No exclusion — send to everyone
      for (const avatarId of room.avatarIds) {
        this.sendToAvatar(avatarId, msg);
      }
    }
  }
}
