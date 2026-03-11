/**
 * Tab 4: Room Tester
 *
 * PixiJS-based interactive room tester. Loads compiled resources from
 * data/resources/ (atlas PNGs + room/character JSONs) and renders the
 * room with proper z-sorting, allowing the player to walk around with
 * WASD/arrow keys.
 *
 * Rendering model (matches room editor Option A):
 *   - Floor layer: top-to-bottom, left-to-right
 *   - Object layer: sorted by anchor Y (bottom edge + zBias), then X
 *   - Character interleaved in object sort by anchor Y (bottom of 1×2 sprite)
 *   - Re-sort every frame for correct depth ordering
 *
 * Character rendering:
 *   - 1×2 tiles (48×96 rendered from 16×32 source frames)
 *   - Occupies 1 walkability tile (bottom tile), anchor = bottom edge
 *   - Idle breathing animation when standing, walk animation when moving
 */

import {
  Application,
  Container,
  Sprite,
  Texture,
  Graphics,
  Rectangle,
} from "pixi.js";
import { TILE_SIZE, type CharacterDirection, type VariantSequence } from "@offisims/shared";
import { setStatus } from "./main.js";

// ─── Compiled resource types (mirrors compiler.ts output) ────────

interface CompiledRegionRef {
  atlas: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface CompiledPlacement {
  gridX: number;
  gridY: number;
  layer: "floor" | "object";
  region?: CompiledRegionRef;
  parts?: { region: CompiledRegionRef; offsetX: number; offsetY: number; zBias?: number }[];
  zBias?: number;
}

interface CompiledDoor {
  id: string;
  col: number;
  row: number;
  target: string;
}

interface CompiledRoom {
  name: string;
  width: number;
  height: number;
  walkability: boolean[];
  doors: CompiledDoor[];
  placements: CompiledPlacement[];
  atlases: string[];
}

interface CompiledAnimationStrip {
  frameWidth: number;
  frameHeight: number;
  frames: { atlas: string; x: number; y: number }[];
}

interface CompiledCharacterAnimation {
  family: string;
  direction: string;
  variant: number;
  strip: CompiledAnimationStrip;
}

interface CompiledCharacter {
  id: string;
  name: string;
  frameWidth: number;
  frameHeight: number;
  animations: CompiledCharacterAnimation[];
  familySpeeds: Record<string, number>;
  variantSequences: VariantSequence[];
  atlases: string[];
}

interface CompiledManifest {
  compiledAt: string;
  atlases: { file: string; tilesetId: string; regions: number; sizeBytes: number }[];
  rooms: { name: string; file: string }[];
  characters: { name: string; file: string }[];
}

// ─── Resource base path ──────────────────────────────────────────

const RESOURCES_BASE = "/data/resources";

// ─── DOM elements ─────────────────────────────────────────────────

const roomSelect = document.getElementById("tester-room-select") as HTMLSelectElement;
const charSelect = document.getElementById("tester-char-select") as HTMLSelectElement;
const loadBtn = document.getElementById("tester-load-btn") as HTMLButtonElement;
const infoDiv = document.getElementById("tester-info") as HTMLDivElement;
const zoomSelect = document.getElementById("tester-zoom") as HTMLSelectElement;
const gridToggle = document.getElementById("tester-grid-toggle") as HTMLInputElement;
const walkToggle = document.getElementById("tester-walk-toggle") as HTMLInputElement;
const modeHint = document.getElementById("tester-mode-hint") as HTMLDivElement;
const canvasWrap = document.getElementById("tester-canvas-wrap") as HTMLDivElement;
const hintDiv = document.getElementById("tester-hint") as HTMLDivElement;
const seqPanel = document.getElementById("tester-seq-panel") as HTMLDivElement;
const seqListDiv = document.getElementById("tester-seq-list") as HTMLDivElement;

// ─── State ────────────────────────────────────────────────────────

let pixiApp: Application | null = null;
let manifest: CompiledManifest | null = null;
let currentRoom: CompiledRoom | null = null;
let currentChar: CompiledCharacter | null = null;
let currentZoom = 1;
let showGrid = false;
let showWalkability = false;

/** Atlas textures loaded by atlas filename (e.g. "atlas_a1b2c3d4e5.png") */
const atlasTextures: Map<string, Texture> = new Map();

// ─── Character state ─────────────────────────────────────────────

/** Character position in tiles (floating point for smooth movement) */
let charX = 0;
let charY = 0;
let charDir: CharacterDirection = "down";
let charMoving = false;

/** Movement speed in tiles per second */
const MOVE_SPEED = 4;

/** Animation state */
let animFamily = "idle";
let animFrame = 0;
let animTimer = 0;

/**
 * Variant sequence playback state.
 * When a sequence is active for the current family+direction, we cycle
 * through its steps. Each step plays its variant's full strip `repeats` times.
 */
interface SeqPlaybackState {
  /** The active sequence (null = use variant 0 only) */
  sequence: VariantSequence | null;
  /** Current step index in the sequence */
  stepIndex: number;
  /** How many full-strip repeats we've done for the current step */
  repeatsDone: number;
}

let seqPlayback: SeqPlaybackState = { sequence: null, stepIndex: 0, repeatsDone: 0 };

/**
 * Selected sequence name per family+direction key ("family:direction").
 * Empty string or missing = use variant 0 only.
 */
const selectedSequences: Map<string, string> = new Map();

/** Key states */
const keys: Record<string, boolean> = {};

// ─── Door transition state ──────────────────────────────────────

/** The door ID the character is currently standing on (to avoid re-triggering) */
let currentDoorId: string | null = null;

/** True while a room transition is in progress (async) */
let transitioning = false;

// ─── PixiJS containers ──────────────────────────────────────────

/** Root container that holds everything (scaled by zoom) */
let worldContainer: Container | null = null;

/** Floor layer container */
let floorContainer: Container | null = null;

/** Object layer container (character interleaved here) */
let objectContainer: Container | null = null;

/** Overlay container for grid/walkability (on top of everything) */
let overlayContainer: Container | null = null;

/** The character sprite */
let charSprite: Sprite | null = null;

// ─── Object tracking for z-sort ──────────────────────────────────

interface ObjectEntry {
  sprite: Sprite | Container;
  anchorY: number; // bottom edge + zBias, used for sorting
}

let objectEntries: ObjectEntry[] = [];

// ─── Resource loading helpers ────────────────────────────────────

/** Fetch the compiled manifest */
async function loadManifest(): Promise<CompiledManifest | null> {
  try {
    const res = await fetch(`${RESOURCES_BASE}/manifest.json`);
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** Fetch a compiled room JSON */
async function loadCompiledRoom(roomFile: string): Promise<CompiledRoom> {
  const res = await fetch(`${RESOURCES_BASE}/rooms/${roomFile}`);
  if (!res.ok) throw new Error(`Failed to load room: ${roomFile}`);
  return await res.json();
}

/** Fetch a compiled character JSON */
async function loadCompiledCharacter(charFile: string): Promise<CompiledCharacter> {
  const res = await fetch(`${RESOURCES_BASE}/characters/${charFile}`);
  if (!res.ok) throw new Error(`Failed to load character: ${charFile}`);
  return await res.json();
}

/** Load an atlas PNG as a PixiJS texture */
function loadAtlasTexture(atlasFile: string): Promise<Texture> {
  const cached = atlasTextures.get(atlasFile);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const texture = Texture.from(img);
      texture.source.scaleMode = "nearest";
      atlasTextures.set(atlasFile, texture);
      resolve(texture);
    };
    img.onerror = () => reject(new Error(`Failed to load atlas ${atlasFile}`));
    img.src = `${RESOURCES_BASE}/atlas/${atlasFile}`;
  });
}

// ─── Populate dropdowns from manifest ────────────────────────────

async function populateDropdowns(): Promise<void> {
  manifest = await loadManifest();

  // Rooms
  roomSelect.innerHTML = "";
  if (!manifest || manifest.rooms.length === 0) {
    roomSelect.innerHTML = '<option value="">(no compiled rooms)</option>';
  } else {
    for (const room of manifest.rooms) {
      const opt = document.createElement("option");
      opt.value = room.file;
      opt.textContent = room.name;
      roomSelect.appendChild(opt);
    }
  }

  // Characters
  charSelect.innerHTML = "";
  if (!manifest || manifest.characters.length === 0) {
    charSelect.innerHTML = '<option value="">(no compiled characters)</option>';
  } else {
    for (const char of manifest.characters) {
      const opt = document.createElement("option");
      opt.value = char.file;
      opt.textContent = char.name;
      charSelect.appendChild(opt);
    }
  }

  updateLoadButton();
}

function updateLoadButton(): void {
  loadBtn.disabled = !roomSelect.value || !charSelect.value ||
    !manifest || manifest.rooms.length === 0 || manifest.characters.length === 0;
}

// ─── Load room into PixiJS ──────────────────────────────────────

async function loadRoom(): Promise<void> {
  const roomFile = roomSelect.value;
  const charFile = charSelect.value;

  if (!roomFile || !charFile) return;

  setStatus("Loading compiled room...");
  modeHint.textContent = "Loading...";

  try {
    // Load room and character JSONs
    const [room, char] = await Promise.all([
      loadCompiledRoom(roomFile),
      loadCompiledCharacter(charFile),
    ]);

    currentRoom = room;
    currentChar = char;

    // Load all needed atlas textures
    const neededAtlases = new Set<string>([...room.atlases, ...char.atlases]);
    await Promise.all([...neededAtlases].map((a) => loadAtlasTexture(a)));

    // Create or reset PixiJS app
    await initPixiApp(room, char);

    hintDiv.textContent = "WASD / Arrow keys to move. Walk onto doors to transition.";
    modeHint.textContent = `${room.name} — ${room.width}×${room.height} — ${char.name}`;
    updateInfo();
    setStatus(`Room "${room.name}" loaded. Use WASD to move.`);
  } catch (e) {
    setStatus(`Error loading room: ${e}`);
    modeHint.textContent = "Error loading room.";
  }
}

async function initPixiApp(room: CompiledRoom, char: CompiledCharacter): Promise<void> {
  // Destroy old app if exists
  if (pixiApp) {
    pixiApp.destroy(true, { children: true });
    pixiApp = null;
    worldContainer = null;
    floorContainer = null;
    objectContainer = null;
    overlayContainer = null;
    charSprite = null;
    objectEntries = [];
  }

  const roomPxW = room.width * TILE_SIZE;
  const roomPxH = room.height * TILE_SIZE;

  const app = new Application();
  await app.init({
    width: roomPxW * currentZoom,
    height: roomPxH * currentZoom,
    backgroundColor: 0x1a1a2e,
    antialias: false,
    roundPixels: true,
  });

  // PixiJS v8 — canvas is app.canvas
  const canvasEl = app.canvas as HTMLCanvasElement;
  canvasEl.style.imageRendering = "pixelated";

  // Clear old canvases from wrap
  const existingCanvas = canvasWrap.querySelector("canvas");
  if (existingCanvas) existingCanvas.remove();
  canvasWrap.appendChild(canvasEl);

  pixiApp = app;

  // World container (scaled)
  worldContainer = new Container();
  worldContainer.scale.set(currentZoom);
  app.stage.addChild(worldContainer);

  // Floor container
  floorContainer = new Container();
  worldContainer.addChild(floorContainer);

  // Object container (character will be interleaved here)
  objectContainer = new Container();
  worldContainer.addChild(objectContainer);

  // Overlay container
  overlayContainer = new Container();
  worldContainer.addChild(overlayContainer);

  // Build room sprites
  buildRoomSprites(room);

  // Create character sprite
  createCharacterSprite(char, room);

  // Populate variant sequence selectors
  populateSequenceSelectors();

  // Draw overlays (grid, walkability)
  drawOverlays(room);

  // Start game loop
  app.ticker.add((ticker) => {
    if (currentRoom && currentChar) {
      updateCharacter(ticker.deltaMS / 1000);
      zSortObjects();
    }
  });
}

// ─── Build room sprites from compiled data ──────────────────────

function buildRoomSprites(room: CompiledRoom): void {
  if (!floorContainer || !objectContainer) return;

  objectEntries = [];

  // Separate floor and object placements
  const floors = room.placements.filter((p) => p.layer === "floor");
  const objects = room.placements.filter((p) => p.layer === "object");

  // Sort floors: top-to-bottom, left-to-right
  floors.sort((a, b) => {
    if (a.gridY !== b.gridY) return a.gridY - b.gridY;
    return a.gridX - b.gridX;
  });

  // Add floor sprites
  for (const p of floors) {
    addFloorPlacement(p);
  }

  // Add object sprites — each sprite gets its own anchorY for z-sorting
  for (const p of objects) {
    addObjectPlacement(p);
  }
}

/** Create a Sprite from a CompiledRegionRef (atlas pixel coords) */
function createAtlasSprite(ref: CompiledRegionRef): Sprite | null {
  const baseTex = atlasTextures.get(ref.atlas);
  if (!baseTex) return null;

  const frame = new Rectangle(ref.x, ref.y, ref.w, ref.h);
  const texture = new Texture({ source: baseTex.source, frame });
  return new Sprite(texture);
}

/** Add a floor placement (no z-sorting needed, just draw order) */
function addFloorPlacement(p: CompiledPlacement): void {
  if (!floorContainer) return;

  if (p.parts) {
    // Composite: expanded inline as parts — sort by render order for floor
    const sorted = [...p.parts].sort((a, b) => {
      const anchorA = a.offsetY + a.region.h / TILE_SIZE + (a.zBias ?? 0);
      const anchorB = b.offsetY + b.region.h / TILE_SIZE + (b.zBias ?? 0);
      if (anchorA !== anchorB) return anchorA - anchorB;
      return a.offsetX - b.offsetX;
    });
    for (const part of sorted) {
      const sprite = createAtlasSprite(part.region);
      if (sprite) {
        sprite.x = (p.gridX + part.offsetX) * TILE_SIZE;
        sprite.y = (p.gridY + part.offsetY) * TILE_SIZE;
        floorContainer.addChild(sprite);
      }
    }
  } else if (p.region) {
    const sprite = createAtlasSprite(p.region);
    if (sprite) {
      sprite.x = p.gridX * TILE_SIZE;
      sprite.y = p.gridY * TILE_SIZE;
      floorContainer.addChild(sprite);
    }
  }
}

/** Add an object placement — each sprite gets its own anchorY for z-sort */
function addObjectPlacement(p: CompiledPlacement): void {
  if (!objectContainer) return;

  if (p.parts) {
    // Composite: each part gets its own z-sort entry
    for (const part of p.parts) {
      const sprite = createAtlasSprite(part.region);
      if (sprite) {
        sprite.x = (p.gridX + part.offsetX) * TILE_SIZE;
        sprite.y = (p.gridY + part.offsetY) * TILE_SIZE;
        // Per-part anchorY = placement gridY + part bottom edge (in tiles) + part zBias + placement zBias
        const partHeightTiles = part.region.h / TILE_SIZE;
        const anchorY = p.gridY + part.offsetY + partHeightTiles + (part.zBias ?? 0) + (p.zBias ?? 0);
        objectContainer.addChild(sprite);
        objectEntries.push({ sprite, anchorY });
      }
    }
  } else if (p.region) {
    const sprite = createAtlasSprite(p.region);
    if (sprite) {
      sprite.x = p.gridX * TILE_SIZE;
      sprite.y = p.gridY * TILE_SIZE;
      const heightTiles = p.region.h / TILE_SIZE;
      const anchorY = p.gridY + heightTiles + (p.zBias ?? 0);
      objectContainer.addChild(sprite);
      objectEntries.push({ sprite, anchorY });
    }
  }
}

// ─── Character sprite ───────────────────────────────────────────

function createCharacterSprite(char: CompiledCharacter, room: CompiledRoom): void {
  if (!objectContainer) return;

  // Find a walkable tile to start on
  let startCol = Math.floor(room.width / 2);
  let startRow = Math.floor(room.height / 2);

  // Search for nearest walkable tile
  for (let r = 0; r < room.height; r++) {
    for (let c = 0; c < room.width; c++) {
      if (room.walkability[r * room.width + c]) {
        // Pick first walkable tile near center
        if (Math.abs(c - startCol) + Math.abs(r - startRow) <
            Math.abs(charX - startCol) + Math.abs(charY - startRow) || charSprite === null) {
          startCol = c;
          startRow = r;
        }
      }
    }
  }

  charX = startCol;
  charY = startRow;
  charDir = "down";
  charMoving = false;
  currentDoorId = null;
  animFamily = "idle";
  animFrame = 0;
  animTimer = 0;

  // Create sprite with initial frame
  charSprite = new Sprite();
  charSprite.width = TILE_SIZE; // 1 tile wide
  charSprite.height = TILE_SIZE * 2; // 2 tiles tall
  updateCharacterTexture();
  positionCharacterSprite();

  objectContainer.addChild(charSprite);

  // Add to object entries for z-sorting
  // anchorY will be updated every frame
  objectEntries.push({
    sprite: charSprite,
    anchorY: charY + 1, // bottom of character = charY + 1 (1 tile tall occupancy)
  });
}

/**
 * Get a PixiJS texture for a specific frame from the compiled character data.
 * Each frame has its own atlas + pixel coords (frames may not be contiguous).
 */
function getCharacterFrameTexture(
  anim: CompiledCharacterAnimation,
  frameIndex: number,
): Texture | null {
  if (!currentChar) return null;

  const frame = anim.strip.frames[frameIndex];
  if (!frame) return null;

  const baseTex = atlasTextures.get(frame.atlas);
  if (!baseTex) return null;

  const rect = new Rectangle(frame.x, frame.y, anim.strip.frameWidth, anim.strip.frameHeight);
  return new Texture({ source: baseTex.source, frame: rect });
}

function updateCharacterTexture(): void {
  if (!charSprite || !currentChar) return;

  const anim = getCurrentAnimation();
  if (!anim) {
    // Fallback: try idle variant 0
    const fallback = currentChar.animations.find(
      (a) => a.family === "idle" && a.direction === charDir && a.variant === 0,
    );
    if (!fallback) return;
    const tex = getCharacterFrameTexture(fallback, 0);
    if (tex) charSprite.texture = tex;
    return;
  }

  const frameIdx = animFrame % anim.strip.frames.length;
  const tex = getCharacterFrameTexture(anim, frameIdx);
  if (tex) charSprite.texture = tex;
}

/**
 * Get the current animation to play, taking variant sequences into account.
 * If a sequence is active, returns the animation for the current step's variant.
 * Otherwise returns variant 0.
 */
function getCurrentAnimation(): CompiledCharacterAnimation | undefined {
  if (!currentChar) return undefined;

  if (seqPlayback.sequence) {
    const seq = seqPlayback.sequence;
    if (seq.steps.length > 0) {
      const step = seq.steps[seqPlayback.stepIndex % seq.steps.length];
      // Find the animation for this variant
      const anims = currentChar.animations.filter(
        (a) => a.family === animFamily && a.direction === charDir,
      );
      return anims.find((a) => a.variant === step.variant) ?? anims[0];
    }
  }

  // Default: variant 0
  return currentChar.animations.find(
    (a) => a.family === animFamily && a.direction === charDir && a.variant === 0,
  );
}

/**
 * Build sequence selector UI in seqListDiv.
 * For each family+direction that has >=1 variant sequence defined,
 * show a <select> dropdown with "(variant 0 only)" + all sequence names.
 * Also shows/hides the seqPanel based on whether any sequences exist.
 */
function populateSequenceSelectors(): void {
  seqListDiv.innerHTML = "";
  selectedSequences.clear();
  seqPlayback = { sequence: null, stepIndex: 0, repeatsDone: 0 };

  if (!currentChar) {
    seqPanel.style.display = "none";
    return;
  }

  const seqs = currentChar.variantSequences || [];
  if (seqs.length === 0) {
    seqPanel.style.display = "none";
    return;
  }

  // Group sequences by family+direction
  const grouped = new Map<string, VariantSequence[]>();
  for (const s of seqs) {
    const key = `${s.family}:${s.direction}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(s);
  }

  seqPanel.style.display = "";

  for (const [key, keySeqs] of grouped) {
    const [family, direction] = key.split(":");

    const row = document.createElement("div");
    row.style.marginBottom = "4px";
    row.style.display = "flex";
    row.style.alignItems = "center";
    row.style.gap = "6px";

    const label = document.createElement("span");
    label.style.fontSize = "11px";
    label.style.color = "var(--text-dim)";
    label.style.minWidth = "80px";
    label.textContent = `${family} ${direction}`;
    row.appendChild(label);

    const select = document.createElement("select");
    select.style.flex = "1";
    select.style.fontSize = "11px";

    // Default option — no sequence
    const defaultOpt = document.createElement("option");
    defaultOpt.value = "";
    defaultOpt.textContent = "(variant 0 only)";
    select.appendChild(defaultOpt);

    for (const s of keySeqs) {
      const opt = document.createElement("option");
      opt.value = s.name;
      opt.textContent = s.name;
      select.appendChild(opt);
    }

    select.addEventListener("change", () => {
      selectedSequences.set(key, select.value);
      syncSequencePlayback();
    });

    row.appendChild(select);
    seqListDiv.appendChild(row);
  }
}

/**
 * Look up and activate the appropriate sequence for the current family+direction.
 */
function syncSequencePlayback(): void {
  if (!currentChar) {
    seqPlayback.sequence = null;
    return;
  }

  const key = `${animFamily}:${charDir}`;
  const seqName = selectedSequences.get(key);

  if (!seqName) {
    seqPlayback.sequence = null;
    return;
  }

  const sequences = (currentChar.variantSequences || []).filter(
    (s) => s.family === animFamily && s.direction === charDir,
  );
  const seq = sequences.find((s) => s.name === seqName) ?? null;

  // Only reset playback if the sequence actually changed
  if (seq !== seqPlayback.sequence) {
    seqPlayback.sequence = seq;
    seqPlayback.stepIndex = 0;
    seqPlayback.repeatsDone = 0;
  }
}

// ─── Door transitions ───────────────────────────────────────────

/** Parse a door target string "roomName#doorId" into [roomName, doorId] */
function parseDoorTarget(target: string): [string, string] {
  if (!target || !target.includes("#")) return ["", ""];
  const [room, doorId] = target.split("#", 2);
  return [room, doorId];
}

/** Find the door the character is currently standing on (if any) */
function getDoorAtPosition(room: CompiledRoom, x: number, y: number): CompiledDoor | undefined {
  const col = Math.floor(x + 0.5); // use center of character
  const row = Math.floor(y + 0.5);
  return room.doors.find((d) => d.col === col && d.row === row);
}

/**
 * Transition to a different room via a door.
 * Loads the target room from compiled resources, rebuilds the scene,
 * and places the character on the target door tile.
 */
async function transitionToRoom(targetRoomName: string, targetDoorId: string): Promise<void> {
  if (transitioning || !currentChar || !manifest) return;
  transitioning = true;

  // Find the room file in the manifest
  const roomEntry = manifest.rooms.find((r) => r.name === targetRoomName);
  if (!roomEntry) {
    setStatus(`Door target room "${targetRoomName}" not found in manifest`);
    transitioning = false;
    return;
  }

  setStatus(`Transitioning to "${targetRoomName}"...`);

  try {
    const targetRoom = await loadCompiledRoom(roomEntry.file);

    const targetDoor = targetRoom.doors.find((d) => d.id === targetDoorId);
    if (!targetDoor) {
      setStatus(`Door "${targetDoorId}" not found in room "${targetRoomName}"`);
      transitioning = false;
      return;
    }

    // Same room — just teleport the character, no scene rebuild needed
    if (currentRoom && targetRoom.name === currentRoom.name) {
      charX = targetDoor.col;
      charY = targetDoor.row;
      charMoving = false;
      animFamily = "idle";
      animFrame = 0;
      animTimer = 0;
      positionCharacterSprite();
      syncSequencePlayback();
      currentDoorId = targetDoorId;
      updateInfo();
      setStatus(`Teleported to ${targetDoorId}`);
      transitioning = false;
      return;
    }

    // Different room — load needed atlases and rebuild
    const neededAtlases = new Set<string>([...targetRoom.atlases, ...currentChar.atlases]);
    await Promise.all([...neededAtlases].map((a) => loadAtlasTexture(a)));

    // Save character state we want to preserve across rooms
    const preservedDir = charDir;

    // Update current room reference
    currentRoom = targetRoom;

    // Rebuild the entire scene
    await initPixiApp(targetRoom, currentChar);

    // Override the spawn position to the target door (initPixiApp picked center)
    charX = targetDoor.col;
    charY = targetDoor.row;
    charDir = preservedDir;
    charMoving = false;
    animFamily = "idle";
    animFrame = 0;
    animTimer = 0;
    positionCharacterSprite();
    syncSequencePlayback();

    // Mark the destination door as "already on it" so we don't re-trigger
    currentDoorId = targetDoorId;

    // Update the room dropdown to reflect current room
    // Find the matching option by room name
    for (let i = 0; i < roomSelect.options.length; i++) {
      const opt = roomSelect.options[i];
      if (opt.textContent === targetRoomName || opt.value === roomEntry.file) {
        roomSelect.selectedIndex = i;
        break;
      }
    }

    modeHint.textContent = `${targetRoom.name} — ${targetRoom.width}×${targetRoom.height} — ${currentChar.name}`;
    hintDiv.textContent = "WASD / Arrow keys to move";
    updateInfo();
    setStatus(`Entered "${targetRoomName}" through ${targetDoorId}`);
  } catch (e) {
    setStatus(`Error transitioning: ${e}`);
  } finally {
    transitioning = false;
  }
}

// ─── Character position / sprite ─────────────────────────────────

function positionCharacterSprite(): void {
  if (!charSprite) return;
  // Character is 1×2 tiles. charX/charY is the walkability tile (bottom tile).
  // Sprite top-left is 1 tile above the walkability tile.
  charSprite.x = charX * TILE_SIZE;
  charSprite.y = (charY - 1) * TILE_SIZE;
  charSprite.width = TILE_SIZE;
  charSprite.height = TILE_SIZE * 2;
}

// ─── Character update (movement + animation) ────────────────────

function updateCharacter(dt: number): void {
  if (!currentRoom || !currentChar || transitioning) return;

  // Determine movement direction from keys
  let dx = 0;
  let dy = 0;

  if (keys["ArrowUp"] || keys["KeyW"]) dy -= 1;
  if (keys["ArrowDown"] || keys["KeyS"]) dy += 1;
  if (keys["ArrowLeft"] || keys["KeyA"]) dx -= 1;
  if (keys["ArrowRight"] || keys["KeyD"]) dx += 1;

  // Normalize diagonal
  if (dx !== 0 && dy !== 0) {
    const len = Math.sqrt(dx * dx + dy * dy);
    dx /= len;
    dy /= len;
  }

  charMoving = dx !== 0 || dy !== 0;

  // Update direction
  if (charMoving) {
    if (Math.abs(dy) >= Math.abs(dx)) {
      charDir = dy < 0 ? "up" : "down";
    } else {
      charDir = dx < 0 ? "left" : "right";
    }
  }

  // Switch animation family
  const prevFamily = animFamily;
  const prevDir = charDir;
  const newFamily = charMoving ? "walk" : "idle";
  if (newFamily !== animFamily) {
    animFamily = newFamily;
    animFrame = 0;
    animTimer = 0;
  }

  // If family or direction changed, sync sequence playback
  if (prevFamily !== animFamily || prevDir !== charDir) {
    syncSequencePlayback();
  }

  // Move with collision
  if (charMoving) {
    const speed = MOVE_SPEED * dt;
    const newX = charX + dx * speed;
    const newY = charY + dy * speed;

    // Try X then Y separately for sliding along walls
    if (isWalkable(newX, charY, currentRoom)) {
      charX = newX;
    }
    if (isWalkable(charX, newY, currentRoom)) {
      charY = newY;
    }
  }

  // Check for door transition — only trigger when ENTERING a door tile
  if (currentRoom.doors.length > 0) {
    const door = getDoorAtPosition(currentRoom, charX, charY);
    const doorId = door?.id ?? null;

    if (door && door.target && doorId !== currentDoorId) {
      // Just stepped onto a new linked door — trigger transition
      const [targetRoomName, targetDoorId] = parseDoorTarget(door.target);
      if (targetRoomName && targetDoorId) {
        transitionToRoom(targetRoomName, targetDoorId);
        return; // skip the rest of this frame
      }
    }

    // Track which door we're on (null if not on any door)
    currentDoorId = doorId;
  }

  // Advance animation with sequence awareness
  const fps = currentChar.familySpeeds[animFamily] ?? (animFamily === "walk" ? 8 : 4);
  animTimer += dt;
  const frameDuration = 1 / fps;
  while (animTimer >= frameDuration) {
    animTimer -= frameDuration;
    animFrame++;

    // Check if we wrapped past the current animation's frame count
    const currentAnim = getCurrentAnimation();
    if (currentAnim && animFrame >= currentAnim.strip.frames.length) {
      animFrame = 0;

      // If a sequence is active, advance the sequence step
      if (seqPlayback.sequence && seqPlayback.sequence.steps.length > 0) {
        seqPlayback.repeatsDone++;
        const step = seqPlayback.sequence.steps[seqPlayback.stepIndex % seqPlayback.sequence.steps.length];
        if (seqPlayback.repeatsDone >= step.repeats) {
          // Advance to next step
          seqPlayback.stepIndex = (seqPlayback.stepIndex + 1) % seqPlayback.sequence.steps.length;
          seqPlayback.repeatsDone = 0;
        }
      }
    }
  }

  // Update sprite
  updateCharacterTexture();
  positionCharacterSprite();

  // Update z-sort anchor for character
  const charEntry = objectEntries.find((e) => e.sprite === charSprite);
  if (charEntry) {
    charEntry.anchorY = charY + 1; // bottom edge of character
  }
}

function isWalkable(x: number, y: number, room: CompiledRoom): boolean {
  // Character occupies 1 tile at (x, y). Check bounds + walkability.
  // We add a small margin for smooth movement
  const margin = 0.05;
  const left = x + margin;
  const right = x + 1 - margin;
  const top = y + margin;
  const bottom = y + 1 - margin;

  // Check all grid cells that the character overlaps
  const minCol = Math.floor(left);
  const maxCol = Math.floor(right - 0.001);
  const minRow = Math.floor(top);
  const maxRow = Math.floor(bottom - 0.001);

  for (let r = minRow; r <= maxRow; r++) {
    for (let c = minCol; c <= maxCol; c++) {
      if (c < 0 || c >= room.width || r < 0 || r >= room.height) return false;
      if (!room.walkability[r * room.width + c]) return false;
    }
  }

  return true;
}

// ─── Z-sort objects every frame ─────────────────────────────────

function zSortObjects(): void {
  if (!objectContainer) return;

  // Sort by anchorY, then by x position
  objectEntries.sort((a, b) => {
    if (a.anchorY !== b.anchorY) return a.anchorY - b.anchorY;
    return a.sprite.x - b.sprite.x;
  });

  // Apply sort order to container
  for (let i = 0; i < objectEntries.length; i++) {
    const entry = objectEntries[i];
    if (objectContainer.children.indexOf(entry.sprite) !== i) {
      objectContainer.setChildIndex(entry.sprite, i);
    }
  }
}

// ─── Overlay drawing (grid + walkability) ───────────────────────

function drawOverlays(room: CompiledRoom): void {
  if (!overlayContainer) return;
  overlayContainer.removeChildren();

  if (showWalkability) {
    const g = new Graphics();
    for (let r = 0; r < room.height; r++) {
      for (let c = 0; c < room.width; c++) {
        const walkable = room.walkability[r * room.width + c];
        if (walkable) {
          g.rect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
          g.fill({ color: 0x4ade80, alpha: 0.2 });
        } else {
          g.rect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
          g.fill({ color: 0xef4444, alpha: 0.25 });
        }
      }
    }
    overlayContainer.addChild(g);
  }

  if (showGrid) {
    const g = new Graphics();
    g.setStrokeStyle({ width: 1, color: 0xffffff, alpha: 0.1 });
    for (let x = 0; x <= room.width; x++) {
      g.moveTo(x * TILE_SIZE, 0);
      g.lineTo(x * TILE_SIZE, room.height * TILE_SIZE);
    }
    for (let y = 0; y <= room.height; y++) {
      g.moveTo(0, y * TILE_SIZE);
      g.lineTo(room.width * TILE_SIZE, y * TILE_SIZE);
    }
    g.stroke();
    overlayContainer.addChild(g);
  }

  // Draw door markers (always visible — purple tiles with link indicator)
  if (room.doors.length > 0) {
    const g = new Graphics();
    for (const door of room.doors) {
      const px = door.col * TILE_SIZE;
      const py = door.row * TILE_SIZE;

      // Purple semi-transparent fill
      g.rect(px, py, TILE_SIZE, TILE_SIZE);
      g.fill({ color: 0xa855f7, alpha: 0.3 });

      // Border — brighter if linked
      const linked = door.target !== "";
      g.rect(px, py, TILE_SIZE, TILE_SIZE);
      g.stroke({ width: 2, color: linked ? 0xa855f7 : 0x6b21a8, alpha: linked ? 0.8 : 0.4 });

      // Small dot: green = linked, gray = unlinked
      const dotX = px + TILE_SIZE - 8;
      const dotY = py + 4;
      g.circle(dotX, dotY, 3);
      g.fill({ color: linked ? 0x4ade80 : 0x666666, alpha: 1 });
    }
    overlayContainer.addChild(g);
  }
}

function updateInfo(): void {
  if (!currentRoom || !currentChar) {
    infoDiv.textContent = "Select a room and character, then click \"Load Room\".";
    return;
  }

  const col = Math.floor(charX);
  const row = Math.floor(charY);
  const walkable = currentRoom.walkability[row * currentRoom.width + col] ? "yes" : "no";
  const lines = [
    `<strong>Position:</strong> (${charX.toFixed(1)}, ${charY.toFixed(1)})`,
    `<strong>Tile:</strong> (${col}, ${row}) walkable: ${walkable}`,
    `<strong>Direction:</strong> ${charDir}`,
    `<strong>Animation:</strong> ${animFamily} frame ${animFrame}`,
  ];

  // Show door info if standing on one
  const door = getDoorAtPosition(currentRoom, charX, charY);
  if (door) {
    if (door.target) {
      const [targetRoom, targetDoor] = parseDoorTarget(door.target);
      lines.push(`<strong>Door:</strong> ${door.id} → ${targetRoom} (${targetDoor})`);
    } else {
      lines.push(`<strong>Door:</strong> ${door.id} (unlinked)`);
    }
  }

  infoDiv.innerHTML = lines.join("<br/>");
}

// ─── Zoom / overlay toggles ─────────────────────────────────────

function applyZoom(): void {
  if (!worldContainer || !pixiApp || !currentRoom) return;

  worldContainer.scale.set(currentZoom);
  const w = currentRoom.width * TILE_SIZE * currentZoom;
  const h = currentRoom.height * TILE_SIZE * currentZoom;
  pixiApp.renderer.resize(w, h);
}

zoomSelect.addEventListener("change", () => {
  currentZoom = parseInt(zoomSelect.value);
  applyZoom();
});

gridToggle.addEventListener("change", () => {
  showGrid = gridToggle.checked;
  if (currentRoom) drawOverlays(currentRoom);
});

walkToggle.addEventListener("change", () => {
  showWalkability = walkToggle.checked;
  if (currentRoom) drawOverlays(currentRoom);
});

// ─── Load button ─────────────────────────────────────────────────

loadBtn.addEventListener("click", () => {
  loadRoom();
});

roomSelect.addEventListener("change", updateLoadButton);
charSelect.addEventListener("change", updateLoadButton);

// ─── Keyboard input ─────────────────────────────────────────────

window.addEventListener("keydown", (e) => {
  // Only capture when tester tab is active
  const testerTab = document.getElementById("tab-tester");
  if (!testerTab || !testerTab.classList.contains("active")) return;
  if (!currentRoom) return;

  // Prevent arrow keys scrolling
  if (e.code.startsWith("Arrow") || e.code === "KeyW" || e.code === "KeyA" ||
      e.code === "KeyS" || e.code === "KeyD") {
    e.preventDefault();
  }

  keys[e.code] = true;
});

window.addEventListener("keyup", (e) => {
  keys[e.code] = false;
});

// ─── Update info panel periodically ─────────────────────────────

setInterval(() => {
  const testerTab = document.getElementById("tab-tester");
  if (testerTab?.classList.contains("active") && currentRoom) {
    updateInfo();
  }
}, 100);

// ─── Init ────────────────────────────────────────────────────────

export function initTesterTab(): void {
  populateDropdowns();
}
