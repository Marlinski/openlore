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
 *   - Pushes UI state changes to the Solid store via callbacks
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

import { Application, Container, Sprite, Texture } from "pixi.js";
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
  ServerPrivateMessageMessage,
} from "@offisims/shared";
import { Connection } from "../connection.js";
import { Input } from "../input.js";
import { getCachedImage } from "../assets.js";
import { Camera } from "./camera.js";
import { RoomScene } from "./room.js";
import { Avatar, loadCharacterTextures, type TextureCache } from "./avatar.js";
import type { BubbleManager } from "../ui/components/BubbleOverlay.js";

// ─── Constants ────────────────────────────────────────────────────

/** Movement speed in pixels per second */
const MOVE_SPEED = 4 * TILE_SIZE; // 4 tiles/sec, same as tester

/** How often to send position updates while moving (ms) */
const POSITION_SEND_INTERVAL = 66; // ~15/sec

/** Click hit-test radius around avatar center in world pixels */
const AVATAR_CLICK_RADIUS = TILE_SIZE * 0.75;

/** Selection outline: how many extra pixels on each side for the white contour */
const OUTLINE_PAD = 2;

/** PM bubble replay: minimum time between successive PM bubbles (ms) */
const PM_REPLAY_BASE_MS = 2500;
/** Extra ms per character of text for PM bubble replay pacing */
const PM_REPLAY_MS_PER_CHAR = 30;

/** Badge size (diameter in screen pixels) */
const BADGE_SIZE = 10;
/** Badge border width */
const BADGE_BORDER = 1.5;

// ─── UI Callbacks interface ───────────────────────────────────────

export interface PmMessage {
  name: string;
  text: string;
  timestamp: number;
  isSelf: boolean;
}

/**
 * Callbacks that push state from the imperative game engine into
 * the SolidJS reactive store.
 */
export interface UICallbacks {
  setRoomName: (name: string) => void;
  addChannelMessage: (name: string, text: string, isSelf: boolean) => void;
  clearChannelMessages: () => void;
  openCharacterCard: (avatarId: string, name: string, characterId: string) => void;
  closeCharacterCard: () => void;
  setPmHistory: (messages: PmMessage[]) => void;
  addPmMessage: (name: string, text: string, isSelf: boolean) => void;
  clearPmMessages: () => void;
  getSelectedAvatarId: () => string | null;
  setChannelOpen: (open: boolean) => void;
}

// ─── SceneManager ─────────────────────────────────────────────────

export class SceneManager {
  private app: Application;
  private worldContainer: Container;
  private connection: Connection;
  private input: Input;
  private camera: Camera;
  private gameData: ProjectData;
  private bubbleManager: BubbleManager | null = null;
  private ui: UICallbacks;

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

  /** Selection outline sprite (white silhouette drawn behind selected avatar) */
  private outlineSprite: Sprite;
  private outlineCanvas: HTMLCanvasElement;
  private outlineCtx: CanvasRenderingContext2D;
  /** The texture UID of the avatar frame last used to generate the outline */
  private outlineLastTexUid: number = -1;

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

  /** PM history per avatar (avatarId → messages) */
  private pmHistory = new Map<string, PmMessage[]>();

  /** Unread PMs per avatar (avatarId → messages not yet seen) */
  private pmUnread = new Map<string, PmMessage[]>();

  /** Red badge sprites per avatar (unread PM indicator) */
  private badgeSprites = new Map<string, Sprite>();
  /** Shared badge texture (drawn once, reused) */
  private badgeTexture: Texture | null = null;

  /** PM replay queue (messages to play as bubbles after opening a card) */
  private pmReplayQueue: PmMessage[] = [];
  /** Avatar ID being replayed */
  private pmReplayAvatarId: string | null = null;
  /** Timestamp when the last PM replay bubble was shown */
  private pmReplayLastShow = 0;
  /** Delay before showing the next replay bubble */
  private pmReplayNextDelay = 0;

  constructor(
    app: Application,
    connection: Connection,
    input: Input,
    gameData: ProjectData,
    ui: UICallbacks,
  ) {
    this.app = app;
    this.connection = connection;
    this.input = input;
    this.gameData = gameData;
    this.camera = new Camera();
    this.ui = ui;

    // Create world container
    this.worldContainer = new Container();
    app.stage.addChild(this.worldContainer);

    // Create selection outline sprite + offscreen canvas
    this.outlineSprite = new Sprite();
    this.outlineSprite.visible = false;
    this.outlineCanvas = document.createElement("canvas");
    this.outlineCtx = this.outlineCanvas.getContext("2d")!;

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
    this.connection.on<ServerPrivateMessageMessage>("private-message", (msg) => this.onPrivateMessage(msg));

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

  /** Handle window resize */
  onResize(width: number, height: number): void {
    this.camera.setViewport(width, height);
    this.app.renderer.resize(width, height);
  }

  /** Set the camera zoom level */
  setZoom(zoom: number): void {
    this.camera.setZoom(zoom);
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
    const currentSelected = this.ui.getSelectedAvatarId();
    if (currentSelected !== null) {
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

    this.ui.openCharacterCard(avatar.id, avatar.name, avatar.characterId);

    // Load PM history for this avatar
    const history = this.pmHistory.get(avatar.id) ?? [];
    this.ui.setPmHistory(history);

    // Drain unread PMs and start replay as bubbles
    const unreads = this.pmUnread.get(avatar.id);
    if (unreads && unreads.length > 0) {
      this.pmReplayQueue = [...unreads];
      this.pmReplayAvatarId = avatar.id;
      this.pmReplayLastShow = 0; // show first one immediately
      this.pmReplayNextDelay = 0;
      unreads.length = 0;
    }
    this.pmUnread.delete(avatar.id);
    this.hideBadge(avatar.id);

    // Show selection outline
    this.outlineSprite.visible = true;
    this.outlineLastTexUid = -1; // force regeneration
  }

  /** Deselect the current avatar: close card + hide highlight */
  deselectAvatar(): void {
    this.selectedAvatarId = null;
    this.outlineSprite.visible = false;

    // Clear any ongoing PM replay (messages are already marked read)
    this.pmReplayQueue = [];
    this.pmReplayAvatarId = null;

    this.ui.closeCharacterCard();
    this.ui.clearPmMessages();
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

    // 4. Update unread PM badges
    this.updateBadges();

    // 5. Tick PM replay queue
    this.tickPmReplay();

    // 6. Z-sort
    this.roomScene.zSort();

    // 7. Update camera
    const localAvatar = this.getLocalAvatar();
    if (localAvatar) {
      this.camera.setTarget(localAvatar.x, localAvatar.y);
    }
    this.camera.update(dt);
    this.camera.applyTo(this.worldContainer);

    // 8. Update bubbles and name labels
    if (this.bubbleManager) {
      this.bubbleManager.update();
    }
  }

  /** Update the selection outline (white silhouette behind selected avatar) */
  private updateSelectionHighlight(_dt: number): void {
    if (!this.selectedAvatarId || !this.outlineSprite.visible) return;

    const avatar = this.avatars.get(this.selectedAvatarId);
    if (!avatar) {
      this.deselectAvatar();
      return;
    }

    // Only regenerate the outline texture when the avatar's frame changes
    const tex = avatar.sprite.texture;
    const texUid = tex.uid;
    if (texUid !== this.outlineLastTexUid) {
      this.outlineLastTexUid = texUid;
      this.generateOutlineTexture(tex);
    }

    // Position: the outline is OUTLINE_PAD pixels larger on each side,
    // so offset by -OUTLINE_PAD relative to the avatar sprite position.
    this.outlineSprite.x = avatar.sprite.x - OUTLINE_PAD;
    this.outlineSprite.y = avatar.sprite.y - OUTLINE_PAD;

    // Update z-sort anchorY to be just below the avatar's, so outline renders behind
    if (this.roomScene) {
      const entry = this.roomScene.objectEntries.find((e) => e.sprite === this.outlineSprite);
      if (entry) {
        entry.anchorY = avatar.anchorY - 0.001;
      }
    }
  }

  /**
   * Generate a white silhouette outline texture from the given avatar frame.
   *
   * Algorithm:
   *   1. Draw the source frame at rendered size onto an offscreen canvas
   *   2. Read pixel data, turn all non-transparent pixels white
   *   3. Expand the white area by OUTLINE_PAD pixels in every direction
   *      (only into transparent pixels) to form a contour
   *   4. Punch out the original opaque area so only the contour ring remains
   *   5. Upload as a PixiJS texture on the outline sprite
   */
  private generateOutlineTexture(tex: Texture): void {
    const srcW = TILE_SIZE;
    const srcH = TILE_SIZE * 2;
    const pad = OUTLINE_PAD;
    const w = srcW + pad * 2;
    const h = srcH + pad * 2;

    const canvas = this.outlineCanvas;
    const ctx = this.outlineCtx;
    canvas.width = w;
    canvas.height = h;
    ctx.clearRect(0, 0, w, h);

    // Draw the avatar's current frame at rendered size, offset by pad
    ctx.imageSmoothingEnabled = false;
    const frame = tex.frame;
    const source = tex.source;
    const img = (source as any).resource as HTMLImageElement | undefined;
    if (!img) return;

    ctx.drawImage(
      img,
      frame.x, frame.y, frame.width, frame.height,
      pad, pad, srcW, srcH,
    );

    // Read pixels
    const imageData = ctx.getImageData(0, 0, w, h);
    const data = imageData.data;

    // Build alpha mask of original pixels (1 = opaque)
    const origMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      origMask[i] = data[i * 4 + 3] > 0 ? 1 : 0;
    }

    // Expand: any transparent pixel adjacent (within pad distance) to an opaque pixel becomes white
    const outlineMask = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const idx = y * w + x;
        if (origMask[idx]) continue; // skip already-opaque pixels

        // Check if any opaque pixel is within pad distance (Chebyshev)
        let near = false;
        for (let dy = -pad; dy <= pad && !near; dy++) {
          for (let dx = -pad; dx <= pad && !near; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx >= 0 && nx < w && ny >= 0 && ny < h) {
              if (origMask[ny * w + nx]) near = true;
            }
          }
        }
        if (near) outlineMask[idx] = 1;
      }
    }

    // Write outline pixels (white, fully opaque) and clear original pixels
    ctx.clearRect(0, 0, w, h);
    const outData = ctx.createImageData(w, h);
    const od = outData.data;
    for (let i = 0; i < w * h; i++) {
      if (outlineMask[i]) {
        od[i * 4] = 255;     // R
        od[i * 4 + 1] = 255; // G
        od[i * 4 + 2] = 255; // B
        od[i * 4 + 3] = 255; // A
      }
    }
    ctx.putImageData(outData, 0, 0);

    // Create texture from the canvas
    const outlineTex = Texture.from(canvas);
    outlineTex.source.scaleMode = "nearest";
    // Force the source to update (canvas content changed)
    outlineTex.source.update();
    this.outlineSprite.texture = outlineTex;
    this.outlineSprite.width = w;
    this.outlineSprite.height = h;
  }

  // ─── Unread PM badges ──────────────────────────────────────

  /** Create the shared badge texture (red circle with white border) */
  private ensureBadgeTexture(): Texture {
    if (this.badgeTexture) return this.badgeTexture;

    const size = BADGE_SIZE * 2; // draw at 2x for crispness
    const canvas = document.createElement("canvas");
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d")!;

    const cx = size / 2;
    const cy = size / 2;
    const r = size / 2 - BADGE_BORDER;

    // White border
    ctx.beginPath();
    ctx.arc(cx, cy, r + BADGE_BORDER, 0, Math.PI * 2);
    ctx.fillStyle = "#ffffff";
    ctx.fill();

    // Red fill
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = "#ef4444";
    ctx.fill();

    this.badgeTexture = Texture.from(canvas);
    this.badgeTexture.source.scaleMode = "nearest";
    return this.badgeTexture;
  }

  /** Show the unread badge on an avatar */
  private showBadge(avatarId: string): void {
    if (this.badgeSprites.has(avatarId)) return; // already showing
    if (!this.roomScene) return;

    const tex = this.ensureBadgeTexture();
    const badge = new Sprite(tex);
    badge.width = BADGE_SIZE;
    badge.height = BADGE_SIZE;
    badge.visible = true;

    // Add to the room's object container so it z-sorts with avatars
    // Place it at a very high anchorY so it renders in front
    this.roomScene.addAvatarSprite(badge, 999999);
    this.badgeSprites.set(avatarId, badge);
  }

  /** Hide the unread badge from an avatar */
  private hideBadge(avatarId: string): void {
    const badge = this.badgeSprites.get(avatarId);
    if (!badge) return;

    if (this.roomScene) {
      this.roomScene.removeAvatarSprite(badge);
    }
    this.badgeSprites.delete(avatarId);
  }

  /** Update badge positions each frame (track avatar head) */
  private updateBadges(): void {
    for (const [avatarId, badge] of this.badgeSprites) {
      const avatar = this.avatars.get(avatarId);
      if (!avatar) {
        badge.visible = false;
        continue;
      }

      badge.visible = true;
      // Position at top-right of avatar sprite
      // Avatar sprite: x = avatar.x - TILE_SIZE/2, y = avatar.y - TILE_SIZE/2 - TILE_SIZE
      // Top-right corner: x + TILE_SIZE, y (sprite top)
      badge.x = avatar.sprite.x + TILE_SIZE - BADGE_SIZE / 2;
      badge.y = avatar.sprite.y - BADGE_SIZE / 2;
    }
  }

  /** Remove all badge sprites (room change cleanup) */
  private clearBadges(): void {
    for (const [, badge] of this.badgeSprites) {
      if (this.roomScene) {
        this.roomScene.removeAvatarSprite(badge);
      }
    }
    this.badgeSprites.clear();
  }

  // ─── PM replay queue ───────────────────────────────────────

  /** Tick the PM replay queue — show next bubble when ready */
  private tickPmReplay(): void {
    if (this.pmReplayQueue.length === 0 || !this.pmReplayAvatarId) return;
    if (!this.bubbleManager) return;

    const now = Date.now();

    // Wait for the delay before showing next bubble
    if (this.pmReplayLastShow > 0 && now - this.pmReplayLastShow < this.pmReplayNextDelay) {
      return;
    }

    // Show next message
    const msg = this.pmReplayQueue.shift()!;
    this.bubbleManager.showPm(this.pmReplayAvatarId, msg.name, msg.text);
    this.pmReplayLastShow = now;

    // Calculate delay for the next one (proportional to text length)
    this.pmReplayNextDelay = PM_REPLAY_BASE_MS + msg.text.length * PM_REPLAY_MS_PER_CHAR;

    // If queue is empty, we're done
    if (this.pmReplayQueue.length === 0) {
      this.pmReplayAvatarId = null;
    }
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

      // Send position to server (throttled)
      this.sendPositionThrottled(avatar);
    } else if (wasMoving) {
      // Keys just released — send one final stop, then done
      avatar.setMoving(false);
      this.sendStop(avatar);
    } else {
      avatar.setMoving(false);
    }
  }

  /** Send a position update to the server, throttled to POSITION_SEND_INTERVAL */
  private sendPositionThrottled(avatar: Avatar): void {
    const now = Date.now();
    const timeSince = now - this.lastPositionSend;

    if (timeSince >= POSITION_SEND_INTERVAL) {
      this.connection.send({
        type: "position",
        x: avatar.x,
        y: avatar.y,
        direction: avatar.direction,
        moving: true,
      });
      this.lastPositionSend = now;
      this.lastSentX = avatar.x;
      this.lastSentY = avatar.y;
      this.lastSentMoving = true;
    }
  }

  /** Send a single stop update (keys released) */
  private sendStop(avatar: Avatar): void {
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
    this.lastPositionSend = Date.now();
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
    // Clean up unread badge
    this.hideBadge(msg.avatarId);
    this.pmUnread.delete(msg.avatarId);
    this.removeAvatar(msg.avatarId);
  }

  private onAvatarMove(msg: ServerAvatarMoveMessage): void {
    const avatar = this.avatars.get(msg.avatarId);
    if (!avatar) return;
    // Note: we don't skip isLocal here. The server already excludes the
    // sending session, so this tab only receives avatar-move for its own
    // avatar when *another* tab sent the update. In that case we must
    // apply the position so multi-tab stays in sync.
    avatar.applyServerPosition(msg.x, msg.y, msg.direction, msg.moving);

    // Keep position tracking in sync so this tab doesn't send a stale
    // "stop" correction when it regains focus.
    if (avatar.id === this.localAvatarId) {
      this.lastSentX = msg.x;
      this.lastSentY = msg.y;
      this.lastSentMoving = msg.moving;
    }
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
    avatar.applySnap(msg.x, msg.y);
    this.lastSentX = msg.x;
    this.lastSentY = msg.y;
  }

  private onChatMessage(msg: ServerChatMessageMessage): void {
    // Show speech bubble
    if (this.bubbleManager) {
      this.bubbleManager.show(msg.avatarId, msg.name, msg.text);
    }

    // Add to channel panel via store
    const isSelf = msg.avatarId === this.localAvatarId;
    this.ui.addChannelMessage(msg.name, msg.text, isSelf);
  }

  private onPrivateMessage(msg: ServerPrivateMessageMessage): void {
    // Determine the "other" avatar for PM history keying
    const isSelf = msg.fromAvatarId === this.localAvatarId;
    const otherAvatarId = isSelf ? msg.toAvatarId : msg.fromAvatarId;

    // Store in PM history
    const entry: PmMessage = {
      name: msg.fromName,
      text: msg.text,
      timestamp: Date.now(),
      isSelf,
    };

    let history = this.pmHistory.get(otherAvatarId);
    if (!history) {
      history = [];
      this.pmHistory.set(otherAvatarId, history);
    }
    history.push(entry);
    while (history.length > 200) {
      history.shift();
    }

    // If the character card is open for this avatar, append the message live
    const currentSelected = this.ui.getSelectedAvatarId();
    if (currentSelected === otherAvatarId) {
      this.ui.addPmMessage(msg.fromName, msg.text, isSelf);
    } else if (!isSelf) {
      // Card is NOT open for this avatar — track as unread + show badge
      let unreads = this.pmUnread.get(otherAvatarId);
      if (!unreads) {
        unreads = [];
        this.pmUnread.set(otherAvatarId, unreads);
      }
      unreads.push(entry);
      this.showBadge(otherAvatarId);
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
    this.clearBadges();
    if (this.bubbleManager) {
      this.bubbleManager.clearAll();
    }

    // Deselect any selected avatar
    this.deselectAvatar();

    // Notify UI
    this.ui.clearChannelMessages();
    this.ui.setRoomName(roomDef.name);

    // Build new room scene
    this.roomScene = new RoomScene(roomDef, this.gameData, this.textureCache);
    this.worldContainer.addChild(this.roomScene.root);

    // Add selection outline sprite to the object container (so it z-sorts with objects)
    this.roomScene.addAvatarSprite(this.outlineSprite, 0);

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
