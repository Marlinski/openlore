/**
 * SceneManager — orchestrates the game scene.
 *
 * Responsibilities:
 *   - Owns the PixiJS Application and world container
 *   - Manages the current RoomScene and all Avatar instances
 *   - Runs the game loop (movement, animation, z-sort, camera)
 *   - Handles local player movement with collision checking
 *   - Sends position updates to the server via Connection
 *   - Responds to server messages (welcome, avatar-join/leave/move, room-change, snap, chat)
 *   - Coordinates with BubbleManager for speech bubbles and name labels
 *   - Manages CharacterCard (right panel) for avatar click interactions
 *   - Manages ChannelPanel (left panel) for room channel chat
 *   - Renders selection highlight (aura) on the selected avatar
 *
 * Flow:
 *   1. Client connects WebSocket → sends join
 *   2. Server sends welcome → SceneManager builds room + spawns local avatar
 *   3. Game loop: input → move → collision → animate → z-sort → render
 *   4. Position updates sent to server ~15/sec while moving
 *   5. Server messages update remote avatars / trigger room transitions
 *   6. Click on avatar → opens character card, shows selection highlight
 */

import { Application, Container, Graphics, Texture } from "pixi.js";
import {
  TILE_SIZE,
  type ProjectData,
  type RoomDefinition,
  type CharacterDirection,
  type CharacterDefinition,
} from "@offisims/shared";
import type {
  AvatarSnapshot,
  ServerWelcomeMessage,
  ServerAvatarJoinMessage,
  ServerAvatarLeaveMessage,
  ServerAvatarMoveMessage,
  ServerRoomChangeMessage,
  ServerSnapMessage,
  ServerChatMessageMessage,
} from "@offisims/shared";
import { Connection } from "../connection.js";
import { Input } from "../input.js";
import { getCachedImage } from "../assets.js";
import { Camera } from "./camera.js";
import { RoomScene } from "./room.js";
import { Avatar, loadCharacterTextures, type TextureCache } from "./avatar.js";
import type { BubbleManager } from "../ui/bubble.js";
import type { Hud } from "../ui/hud.js";
import type { CharacterCard } from "../ui/panel.js";
import type { ChannelPanel } from "../ui/channel.js";

// ─── Constants ────────────────────────────────────────────────────

/** Movement speed in pixels per second */
const MOVE_SPEED = 4 * TILE_SIZE; // 4 tiles/sec, same as tester

/** How often to send position updates while moving (ms) */
const POSITION_SEND_INTERVAL = 66; // ~15/sec

/** Click hit-test radius around avatar center in world pixels */
const AVATAR_CLICK_RADIUS = TILE_SIZE * 0.75;

/** Selection highlight color */
const SELECTION_COLOR = 0x60a5fa; // blue
const SELECTION_ALPHA = 0.3;

// ─── SceneManager ─────────────────────────────────────────────────

export class SceneManager {
  private app: Application;
  private worldContainer: Container;
  private connection: Connection;
  private input: Input;
  private camera: Camera;
  private gameData: ProjectData;
  private bubbleManager: BubbleManager | null = null;
  private hud: Hud | null = null;
  private characterCard: CharacterCard | null = null;
  private channelPanel: ChannelPanel | null = null;

  /** Shared PixiJS texture cache (tileset ID → base Texture) */
  private textureCache: TextureCache = new Map();

  /** Current room scene */
  private roomScene: RoomScene | null = null;

  /** All avatars by ID */
  private avatars = new Map<string, Avatar>();

  /** Local player's avatar ID */
  private localAvatarId: string | null = null;

  /** Currently selected avatar ID (for character card + highlight) */
  private selectedAvatarId: string | null = null;

  /** Selection highlight graphics (ellipse aura under selected avatar) */
  private selectionGfx: Graphics;
  private selectionPulse = 0; // animation timer

  /** Current room name */
  private currentRoomName = "";

  /** Door the local player is currently standing on (to avoid re-triggering) */
  private currentDoorId: string | null = null;

  /** Position send throttle */
  private lastPositionSend = 0;
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentMoving = false;

  /** Room transition in progress */
  private transitioning = false;

  constructor(
    app: Application,
    connection: Connection,
    input: Input,
    gameData: ProjectData,
  ) {
    this.app = app;
    this.connection = connection;
    this.input = input;
    this.gameData = gameData;
    this.camera = new Camera();

    // Create world container
    this.worldContainer = new Container();
    app.stage.addChild(this.worldContainer);

    // Create selection highlight graphics
    this.selectionGfx = new Graphics();
    this.selectionGfx.visible = false;

    // Set initial viewport
    this.camera.setViewport(app.screen.width, app.screen.height);

    // Wire up server message handlers
    this.connection.on<ServerWelcomeMessage>("welcome", (msg) => this.onWelcome(msg));
    this.connection.on<ServerAvatarJoinMessage>("avatar-join", (msg) => this.onAvatarJoin(msg));
    this.connection.on<ServerAvatarLeaveMessage>("avatar-leave", (msg) => this.onAvatarLeave(msg));
    this.connection.on<ServerAvatarMoveMessage>("avatar-move", (msg) => this.onAvatarMove(msg));
    this.connection.on<ServerRoomChangeMessage>("room-change", (msg) => this.onRoomChange(msg));
    this.connection.on<ServerSnapMessage>("snap", (msg) => this.onSnap(msg));
    this.connection.on<ServerChatMessageMessage>("chat-message", (msg) => this.onChatMessage(msg));

    // Wire up input handlers
    this.input.onDoorUse(() => this.tryUseDoor());

    // Start game loop
    app.ticker.add((ticker) => {
      this.update(ticker.deltaMS / 1000);
    });
  }

  /** Set the bubble manager (called after construction) */
  setBubbleManager(bm: BubbleManager): void {
    this.bubbleManager = bm;
  }

  /** Set the HUD (called after construction) */
  setHud(hud: Hud): void {
    this.hud = hud;
  }

  /** Set the character card (called after construction) */
  setCharacterCard(card: CharacterCard): void {
    this.characterCard = card;
  }

  /** Set the channel panel (called after construction) */
  setChannelPanel(panel: ChannelPanel): void {
    this.channelPanel = panel;
  }

  /** Handle window resize */
  onResize(width: number, height: number): void {
    this.camera.setViewport(width, height);
    this.app.renderer.resize(width, height);
  }

  /** Get the camera (for bubble/hud positioning) */
  getCamera(): Camera {
    return this.camera;
  }

  /** Get the local avatar (for bubble positioning) */
  getLocalAvatar(): Avatar | null {
    if (!this.localAvatarId) return null;
    return this.avatars.get(this.localAvatarId) ?? null;
  }

  /** Get all avatars */
  getAvatars(): Map<string, Avatar> {
    return this.avatars;
  }

  /**
   * Handle a click on the game canvas.
   * Tests if the click hit an avatar and opens the character card.
   */
  handleCanvasClick(screenX: number, screenY: number): void {
    // If character card is open, close it and deselect
    if (this.characterCard?.isOpen()) {
      this.deselectAvatar();
      return;
    }

    const world = this.camera.screenToWorld(screenX, screenY);

    // Find the closest avatar within click radius
    let closestAvatar: Avatar | null = null;
    let closestDist = AVATAR_CLICK_RADIUS;

    for (const avatar of this.avatars.values()) {
      // Don't select self
      if (avatar.id === this.localAvatarId) continue;
      // Hit-test against the avatar's center (the walkability tile center)
      const dx = world.x - avatar.x;
      const dy = world.y - avatar.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closestDist = dist;
        closestAvatar = avatar;
      }
    }

    if (closestAvatar) {
      this.selectAvatar(closestAvatar);
    }
  }

  /** Select an avatar: open character card + show highlight */
  private selectAvatar(avatar: Avatar): void {
    this.selectedAvatarId = avatar.id;

    if (this.characterCard) {
      this.characterCard.open(avatar.id, avatar.name, avatar.characterId);
    }

    // Show selection highlight
    this.selectionGfx.visible = true;
    this.selectionPulse = 0;
  }

  /** Deselect the current avatar: close card + hide highlight */
  deselectAvatar(): void {
    this.selectedAvatarId = null;
    this.selectionGfx.visible = false;

    if (this.characterCard) {
      this.characterCard.close();
    }
  }

  // ─── Game loop ──────────────────────────────────────────────

  private update(dt: number): void {
    if (!this.roomScene || this.transitioning) return;

    // 1. Handle local player movement
    this.updateLocalPlayer(dt);

    // 2. Update all avatars (animation, interpolation)
    for (const avatar of this.avatars.values()) {
      avatar.update(dt);
      // Update z-sort entry for this avatar
      const entry = this.roomScene.objectEntries.find((e) => e.sprite === avatar.sprite);
      if (entry) {
        entry.anchorY = avatar.anchorY;
      }
    }

    // 3. Update selection highlight
    this.updateSelectionHighlight(dt);

    // 4. Z-sort
    this.roomScene.zSort();

    // 5. Update camera
    const localAvatar = this.getLocalAvatar();
    if (localAvatar) {
      this.camera.setTarget(localAvatar.x, localAvatar.y);
    }
    this.camera.update(dt);
    this.camera.applyTo(this.worldContainer);

    // 6. Update bubbles and name labels
    if (this.bubbleManager) {
      this.bubbleManager.update();
    }
  }

  /** Update the selection highlight ellipse */
  private updateSelectionHighlight(dt: number): void {
    if (!this.selectedAvatarId || !this.selectionGfx.visible) return;

    const avatar = this.avatars.get(this.selectedAvatarId);
    if (!avatar) {
      this.deselectAvatar();
      return;
    }

    // Pulse animation (gentle breathing)
    this.selectionPulse += dt * 3;
    const pulse = 0.7 + 0.3 * Math.sin(this.selectionPulse);
    const alpha = SELECTION_ALPHA * pulse;

    // Draw ellipse at avatar feet
    const rx = TILE_SIZE * 0.45;
    const ry = TILE_SIZE * 0.2;

    this.selectionGfx.clear();
    this.selectionGfx.ellipse(0, 0, rx, ry);
    this.selectionGfx.fill({ color: SELECTION_COLOR, alpha });
    this.selectionGfx.ellipse(0, 0, rx + 1, ry + 0.5);
    this.selectionGfx.stroke({ color: SELECTION_COLOR, alpha: alpha * 1.5, width: 1.5 });

    // Position at avatar's feet (bottom of walkability tile)
    this.selectionGfx.x = avatar.x;
    this.selectionGfx.y = avatar.y + TILE_SIZE * 0.3;
  }

  private updateLocalPlayer(dt: number): void {
    const avatar = this.getLocalAvatar();
    if (!avatar || !this.roomScene) return;

    const { dx, dy } = this.input.getMovement();
    const wasMoving = avatar.moving;

    if (dx !== 0 || dy !== 0) {
      // Update direction
      if (Math.abs(dy) >= Math.abs(dx)) {
        avatar.setDirection(dy < 0 ? "up" : "down");
      } else {
        avatar.setDirection(dx < 0 ? "left" : "right");
      }

      // Move with collision checking (try X and Y separately for wall sliding)
      const speed = MOVE_SPEED * dt;
      const newX = avatar.x + dx * speed;
      const newY = avatar.y + dy * speed;

      if (this.roomScene.isWalkable(newX, avatar.y)) {
        avatar.setPosition(newX, avatar.y);
      }
      if (this.roomScene.isWalkable(avatar.x, newY)) {
        avatar.setPosition(avatar.x, newY);
      }

      avatar.setMoving(true);

      // Check for door (auto-trigger on walk-over)
      this.checkDoorTransition();
    } else {
      avatar.setMoving(false);
    }

    // Send position to server (throttled)
    this.maybeSendPosition(avatar);
  }

  private maybeSendPosition(avatar: Avatar): void {
    const now = Date.now();
    const moved = avatar.x !== this.lastSentX || avatar.y !== this.lastSentY;
    const timeSince = now - this.lastPositionSend;

    // Send if moved and enough time has passed
    if (moved && timeSince >= POSITION_SEND_INTERVAL) {
      this.connection.send({
        type: "position",
        x: avatar.x,
        y: avatar.y,
        direction: avatar.direction,
        moving: avatar.moving,
      });
      this.lastPositionSend = now;
      this.lastSentX = avatar.x;
      this.lastSentY = avatar.y;
      this.lastSentMoving = avatar.moving;
    } else if (!avatar.moving && (moved || this.lastSentMoving)) {
      // Send final stop: either position changed or moving state changed
      this.connection.send({
        type: "position",
        x: avatar.x,
        y: avatar.y,
        direction: avatar.direction,
        moving: false,
      });
      this.lastSentX = avatar.x;
      this.lastSentY = avatar.y;
      this.lastSentMoving = false;
      this.lastPositionSend = now;
    }
  }

  /** Check if the local player is standing on a door and trigger transition */
  private checkDoorTransition(): void {
    const avatar = this.getLocalAvatar();
    if (!avatar || !this.roomScene) return;

    const door = this.roomScene.getDoorAtPosition(avatar.x, avatar.y);
    const doorId = door?.id ?? null;

    if (door && door.target && doorId !== this.currentDoorId) {
      // Walked onto a new linked door — send use-door to server
      this.connection.send({ type: "use-door", doorId: door.id });
    }

    this.currentDoorId = doorId;
  }

  /** Manually try to use a door (E key) */
  private tryUseDoor(): void {
    const avatar = this.getLocalAvatar();
    if (!avatar || !this.roomScene) return;

    const door = this.roomScene.getDoorAtPosition(avatar.x, avatar.y);
    if (door && door.target) {
      this.connection.send({ type: "use-door", doorId: door.id });
    }
  }

  // ─── Server message handlers ────────────────────────────────

  private onWelcome(msg: ServerWelcomeMessage): void {
    this.localAvatarId = msg.avatarId;
    this.currentRoomName = msg.room.name;

    // Find the room definition
    const roomDef = this.gameData.rooms.find((r) => r.name === msg.room.name);
    if (!roomDef) {
      console.error(`[Scene] Room "${msg.room.name}" not found in game data`);
      return;
    }

    this.buildRoom(roomDef, msg.avatars, msg.spawnX, msg.spawnY);
  }

  private onAvatarJoin(msg: ServerAvatarJoinMessage): void {
    if (this.avatars.has(msg.avatar.id)) return; // already exists
    this.spawnAvatar(msg.avatar, false);
  }

  private onAvatarLeave(msg: ServerAvatarLeaveMessage): void {
    // If the leaving avatar was selected, deselect
    if (msg.avatarId === this.selectedAvatarId) {
      this.deselectAvatar();
    }
    this.removeAvatar(msg.avatarId);
  }

  private onAvatarMove(msg: ServerAvatarMoveMessage): void {
    const avatar = this.avatars.get(msg.avatarId);
    if (!avatar || avatar.isLocal) return;
    avatar.applyServerPosition(msg.x, msg.y, msg.direction, msg.moving);
  }

  private onRoomChange(msg: ServerRoomChangeMessage): void {
    this.transitioning = true;
    this.currentRoomName = msg.room.name;

    const roomDef = this.gameData.rooms.find((r) => r.name === msg.room.name);
    if (!roomDef) {
      console.error(`[Scene] Room "${msg.room.name}" not found in game data`);
      this.transitioning = false;
      return;
    }

    this.buildRoom(roomDef, msg.avatars, msg.spawnX, msg.spawnY);
    this.transitioning = false;
  }

  private onSnap(msg: ServerSnapMessage): void {
    const avatar = this.getLocalAvatar();
    if (!avatar) return;
    avatar.applyServerPosition(msg.x, msg.y, avatar.direction, avatar.moving);
    this.lastSentX = msg.x;
    this.lastSentY = msg.y;
  }

  private onChatMessage(msg: ServerChatMessageMessage): void {
    // Show speech bubble
    if (this.bubbleManager) {
      this.bubbleManager.show(msg.avatarId, msg.name, msg.text);
    }

    // Add to channel panel
    if (this.channelPanel) {
      const isSelf = msg.avatarId === this.localAvatarId;
      this.channelPanel.addMessage(msg.name, msg.text, isSelf);
    }
  }

  // ─── Room building ──────────────────────────────────────────

  private buildRoom(
    roomDef: RoomDefinition,
    avatarSnapshots: AvatarSnapshot[],
    spawnX: number,
    spawnY: number,
  ): void {
    // Clean up old room
    if (this.roomScene) {
      this.worldContainer.removeChild(this.roomScene.root);
      this.roomScene.destroy();
      this.roomScene = null;
    }
    this.avatars.clear();
    if (this.bubbleManager) {
      this.bubbleManager.clearAll();
    }
    if (this.characterCard) {
      this.characterCard.clearPanel();
    }
    if (this.channelPanel) {
      this.channelPanel.clearMessages();
      this.channelPanel.setRoomName(roomDef.name);
    }

    // Deselect any selected avatar
    this.deselectAvatar();

    // Build new room scene
    this.roomScene = new RoomScene(roomDef, this.gameData, this.textureCache);
    this.worldContainer.addChild(this.roomScene.root);

    // Add selection highlight to the object container (so it z-sorts with objects)
    this.roomScene.root.addChild(this.selectionGfx);

    // Set camera bounds
    this.camera.setWorldBounds(this.roomScene.pixelWidth, this.roomScene.pixelHeight);

    // Spawn all avatars in the room
    for (const snap of avatarSnapshots) {
      const isLocal = snap.id === this.localAvatarId;
      // Override local avatar position with server-provided spawn
      if (isLocal) {
        snap.x = spawnX;
        snap.y = spawnY;
      }
      this.spawnAvatar(snap, isLocal);
    }

    // Center camera on local avatar
    const localAvatar = this.getLocalAvatar();
    if (localAvatar) {
      this.camera.centerOn(localAvatar.x, localAvatar.y);
    }

    // Pre-set currentDoorId to whatever door the player is standing on
    // so that it doesn't count as "walking onto" a new door.
    if (localAvatar && this.roomScene) {
      const door = this.roomScene.getDoorAtPosition(localAvatar.x, localAvatar.y);
      this.currentDoorId = door?.id ?? null;
    } else {
      this.currentDoorId = null;
    }
  }

  private spawnAvatar(snapshot: AvatarSnapshot, isLocal: boolean): Avatar | null {
    if (!this.roomScene) return null;

    // Find the character definition
    const charDef = this.gameData.characters.find((c) => c.id === snapshot.characterId);
    if (!charDef) {
      console.warn(`[Scene] Character "${snapshot.characterId}" not found for avatar ${snapshot.id}`);
      return null;
    }

    // Load character textures
    loadCharacterTextures(charDef, this.gameData, this.textureCache, getCachedImage);

    // Create avatar
    const avatar = new Avatar(snapshot, charDef, this.gameData, this.textureCache, isLocal);

    // Add sprite to room's object layer
    this.roomScene.addAvatarSprite(avatar.sprite, avatar.anchorY);

    // Create name label
    if (this.bubbleManager) {
      this.bubbleManager.ensureNameLabel(avatar.id, avatar.name);
    }

    this.avatars.set(avatar.id, avatar);
    return avatar;
  }

  private removeAvatar(avatarId: string): void {
    const avatar = this.avatars.get(avatarId);
    if (!avatar) return;

    if (this.roomScene) {
      this.roomScene.removeAvatarSprite(avatar.sprite);
    }
    if (this.bubbleManager) {
      this.bubbleManager.remove(avatarId);
    }
    this.avatars.delete(avatarId);
  }
}
