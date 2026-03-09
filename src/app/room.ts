/**
 * Tab 2: Room Editor
 *
 * Two-mode architecture:
 *
 * 1. LAYOUT MODE — two tools:
 *    a) Walkability: paint walkable/blocked tiles.
 *       Left-click/drag = blocked, Right-click/drag = walkable.
 *    b) Door: click to place door markers (teleport points).
 *       Click existing door to select & edit its target.
 *       Doors are walkable tiles — they teleport the player.
 *    Exports as room.dat (RoomLayout JSON with walkability + doors).
 *
 * 2. TEXTURE MODE — place tileset regions or composites on the grid.
 *    Left panel: tileset picker (click/drag to select region as brush)
 *              + composites list.
 *    Click on grid to place. Shift+drag = paint mode.
 *    Multiple textures can stack on the same tile.
 *    Click a tile to see its stack in the right panel — adjust zBias or delete.
 *    Layer selector (floor vs object).
 *    Exports as room_texture.dat (RoomTexture JSON).
 *
 * Rendering order (Option A — sort at render time):
 *   - Floor layer: sorted top-to-bottom, left-to-right (row-major)
 *   - Object layer: sorted by anchor Y (bottom edge = gridY + h + zBias), then X
 *   - Floor always renders before objects regardless of position
 *   - Array order in storage does NOT determine render order
 *   - Up/down buttons in tile stack panel adjust zBias for manual overrides
 *   - This matches the PixiJS game runtime (re-sort display list every frame)
 */

import {
  TILE_SIZE,
  type TilesetId,
  type TilesetRegion,
  type DoorDefinition,
  type RoomDefinition,
  type TexturePlacement,
  type CompositeObject,
  createWalkabilityGrid,
  extractRoomLayout,
  extractRoomTexture,
  getPlacementSize,
} from "@shared/types.js";
import { appState } from "@shared/state.js";
import { setStatus } from "./main.js";
import { TilesetPicker, loadTilesetImage, getCachedTilesetImage, populateTilesetSelect } from "./tileset-picker.js";

// ─── Types ────────────────────────────────────────────────────────

type EditorMode = "layout" | "texture";
type LayoutTool = "walk" | "door";
type LayerTab = "floor" | "object" | "both";

/** Brush can be a tileset region or a composite */
type Brush =
  | { type: "region"; region: TilesetRegion }
  | { type: "composite"; compositeId: string };

// ─── DOM elements ─────────────────────────────────────────────────

// Left panel: layout mode
const leftLayoutDiv = document.getElementById("room-left-layout") as HTMLDivElement;
const layoutStats = document.getElementById("room-layout-stats") as HTMLDivElement;
const layoutToolButtons = document.querySelectorAll<HTMLButtonElement>(".layout-tool-btn");
const layoutWalkInfo = document.getElementById("layout-walk-info") as HTMLDivElement;
const layoutDoorInfo = document.getElementById("layout-door-info") as HTMLDivElement;

// Door properties panel
const doorPropsPanel = document.getElementById("door-props-panel") as HTMLDivElement;
const doorPropsId = document.getElementById("door-props-id") as HTMLDivElement;
const doorTargetRoom = document.getElementById("door-target-room") as HTMLSelectElement;
const doorTargetDoor = document.getElementById("door-target-door") as HTMLSelectElement;
const doorTargetDisplay = document.getElementById("door-target-display") as HTMLDivElement;
const doorRemoveBtn = document.getElementById("door-remove-btn") as HTMLButtonElement;
const doorCountSpan = document.getElementById("room-door-count") as HTMLSpanElement;
const doorListDiv = document.getElementById("room-door-list") as HTMLDivElement;

// Left panel: texture mode
const leftTextureDiv = document.getElementById("room-left-texture") as HTMLDivElement;
const roomTilesetSelect = document.getElementById("room-tileset-select") as HTMLSelectElement;
const roomTilesetZoom = document.getElementById("room-tileset-zoom") as HTMLSelectElement;
const roomTilesetGridToggle = document.getElementById("room-tileset-grid") as HTMLInputElement;
const roomTilesetContainer = document.getElementById("room-tileset-container") as HTMLDivElement;
const roomSelectionInfo = document.getElementById("room-selection-info") as HTMLDivElement;
const compositeListDiv = document.getElementById("room-composite-list") as HTMLDivElement;

// Layer tabs (texture mode)
const layerTabsSpan = document.getElementById("room-layer-tabs") as HTMLSpanElement;
const layerTabButtons = document.querySelectorAll<HTMLButtonElement>(".layer-tab-btn");

// Toolbar
const modeButtons = document.querySelectorAll<HTMLButtonElement>(".room-mode-btn");
const zoomSelect = document.getElementById("room-zoom") as HTMLSelectElement;
const gridToggle = document.getElementById("room-grid-toggle") as HTMLInputElement;
const modeHint = document.getElementById("room-mode-hint") as HTMLDivElement;

// Canvas
const canvas = document.getElementById("room-canvas") as HTMLCanvasElement;
const canvasWrap = document.getElementById("room-canvas-wrap") as HTMLDivElement;
const canvasInner = document.getElementById("room-canvas-inner") as HTMLDivElement;
const overlaysDiv = document.getElementById("room-overlays") as HTMLDivElement;
const paintCursor = document.getElementById("room-paint-cursor") as HTMLDivElement;

// Right panel
const nameInput = document.getElementById("room-name") as HTMLInputElement;
const widthInput = document.getElementById("room-width") as HTMLInputElement;
const heightInput = document.getElementById("room-height") as HTMLInputElement;
const resizeBtn = document.getElementById("room-resize-btn") as HTMLButtonElement;
const roomInfo = document.getElementById("room-info") as HTMLDivElement;
const saveBtn = document.getElementById("room-save-btn") as HTMLButtonElement;
const clearBtn = document.getElementById("room-clear-btn") as HTMLButtonElement;
const exportLayoutBtn = document.getElementById("room-export-layout-btn") as HTMLButtonElement;
const exportTextureBtn = document.getElementById("room-export-texture-btn") as HTMLButtonElement;
const savedList = document.getElementById("room-saved-list") as HTMLDivElement;
const savedCount = document.getElementById("room-saved-count") as HTMLSpanElement;

// Tile stack panel (texture mode)
const tileStackPanel = document.getElementById("tile-stack-panel") as HTMLDivElement;
const tileStackCount = document.getElementById("tile-stack-count") as HTMLSpanElement;
const tileStackPos = document.getElementById("tile-stack-pos") as HTMLDivElement;
const tileStackList = document.getElementById("tile-stack-list") as HTMLDivElement;

// ─── Editor state ─────────────────────────────────────────────────

let mode: EditorMode = "layout";
let layoutTool: LayoutTool = "walk";
let layerTab: LayerTab = "floor";
let currentZoom = 1;
let showGrid = true;

let roomWidth = 16;
let roomHeight = 12;

/** Flat walkability grid. Index = row * roomWidth + col. true = walkable. */
let walkability: boolean[] = createWalkabilityGrid(roomWidth, roomHeight, true);

/** Door definitions */
let doors: DoorDefinition[] = [];

/** Auto-incrementing door counter for IDs */
let doorIdCounter = 1;

/** Currently selected door id (layout mode, door tool) */
let selectedDoorId: string | null = null;

/** All texture placements in the room */
let placements: TexturePlacement[] = [];

/** Currently editing room name (for overwrite on save) */
let editingRoomName: string | null = null;

// ─── Layout mode state ───────────────────────────────────────────

let layoutPainting = false;
/** What value to paint: false = blocked, true = walkable */
let layoutPaintValue = false;

// ─── Texture mode state ──────────────────────────────────────────

/** Currently selected brush */
let selectedBrush: Brush | null = null;

/** Selected existing placement index (for drag/delete) */
let selectedPlacementIdx: number | null = null;

/** Shift+drag painting state */
let shiftPainting = false;
/** Set of grid keys already stamped this drag (prevent double-stamp) */
let shiftPaintedCells = new Set<string>();

/** Drag state for moving existing placements */
let draggingPlacementIdx: number | null = null;
let dragOffset = { x: 0, y: 0 };

/** Last-used layer — used by "both" tab to determine placement layer */
let lastUsedLayer: "floor" | "object" = "floor";

/** Currently inspected tile position for the stack panel */
let inspectedTile: { col: number; row: number } | null = null;

// ─── Auto-save editor state ──────────────────────────────────────

const EDITOR_STATE_KEY = "offisims_room_editor_state";

interface EditorSaveState {
  roomWidth: number;
  roomHeight: number;
  walkability: boolean[];
  doors: DoorDefinition[];
  doorIdCounter: number;
  placements: TexturePlacement[];
  roomName: string;
  editingRoomName: string | null;
  mode: EditorMode;
  layoutTool: LayoutTool;
  layerTab?: LayerTab;
}

/** Persist current editor state to localStorage (called on every mutation) */
function autoSaveEditorState(): void {
  const state: EditorSaveState = {
    roomWidth,
    roomHeight,
    walkability: [...walkability],
    doors: doors.map((d) => ({ ...d })),
    doorIdCounter,
    placements: placements.map((p) => ({ ...p })),
    roomName: nameInput.value,
    editingRoomName,
    mode,
    layoutTool,
    layerTab,
  };
  try {
    localStorage.setItem(EDITOR_STATE_KEY, JSON.stringify(state));
  } catch {
    // Storage full or unavailable — silently ignore
  }
}

/** Restore editor state from localStorage. Returns true if state was restored. */
function restoreEditorState(): boolean {
  try {
    const raw = localStorage.getItem(EDITOR_STATE_KEY);
    if (!raw) return false;
    const saved: EditorSaveState = JSON.parse(raw);

    // Validate basic shape
    if (
      typeof saved.roomWidth !== "number" ||
      typeof saved.roomHeight !== "number" ||
      !Array.isArray(saved.walkability) ||
      !Array.isArray(saved.doors) ||
      !Array.isArray(saved.placements)
    ) {
      return false;
    }

    roomWidth = saved.roomWidth;
    roomHeight = saved.roomHeight;
    widthInput.value = String(roomWidth);
    heightInput.value = String(roomHeight);
    walkability = saved.walkability;
    doors = saved.doors;
    doorIdCounter = saved.doorIdCounter ?? 1;

    // Filter out stale placements from old format (had itemId/isComposite instead of region/compositeId)
    placements = saved.placements.filter(
      (p: any) => p.region || p.compositeId
    );
    nameInput.value = saved.roomName ?? "";
    editingRoomName = saved.editingRoomName ?? null;

    // Restore mode/tool state
    if (saved.mode === "layout" || saved.mode === "texture") {
      mode = saved.mode;
    }
    if (saved.layoutTool === "walk" || saved.layoutTool === "door") {
      layoutTool = saved.layoutTool;
    }
    if (saved.layerTab === "floor" || saved.layerTab === "object" || saved.layerTab === "both") {
      layerTab = saved.layerTab;
    }

    // Reset transient state
    selectedPlacementIdx = null;
    selectedBrush = null;
    selectedDoorId = null;
    inspectedTile = null;
    doorPropsPanel.style.display = "none";

    return true;
  } catch {
    return false;
  }
}

/** Clear saved editor state (e.g. when user clicks Clear) */
function clearEditorSaveState(): void {
  localStorage.removeItem(EDITOR_STATE_KEY);
}

/** Check if there are unsaved changes that would be lost */
function hasUnsavedChanges(): boolean {
  // If there are any placements, doors, name, or non-default walkability, there's work in progress
  if (placements.length > 0) return true;
  if (doors.length > 0) return true;
  if (nameInput.value.trim().length > 0) return true;
  // Check if walkability has been changed from default (all walkable)
  if (walkability.some((w) => !w)) return true;
  return false;
}

/** Prompt user to confirm discarding unsaved changes. Returns true if ok to proceed. */
function confirmDiscardChanges(): boolean {
  if (!hasUnsavedChanges()) return true;
  return confirm("You have unsaved changes in the room editor. Discard them?");
}

// ─── Tileset Picker (texture mode) ───────────────────────────────

const roomPicker = new TilesetPicker(roomTilesetContainer, (region) => {
  selectedBrush = { type: "region", region };
  selectedPlacementIdx = null;
  roomSelectionInfo.textContent = `Selected: ${region.w}×${region.h} from (${region.srcCol},${region.srcRow})`;
  renderCompositeList(); // deselect any composite
  drawRoom();
});

roomTilesetSelect.addEventListener("change", () => {
  roomPicker.setTileset(roomTilesetSelect.value as TilesetId);
  selectedBrush = null;
  roomSelectionInfo.textContent = "Click/drag on tileset to select brush.";
});

roomTilesetZoom.addEventListener("change", () => {
  roomPicker.setZoom(parseInt(roomTilesetZoom.value));
});

roomTilesetGridToggle.addEventListener("change", () => {
  roomPicker.setShowGrid(roomTilesetGridToggle.checked);
});

// ─── Composite list (texture mode) ──────────────────────────────

function renderCompositeList(): void {
  compositeListDiv.innerHTML = "";

  if (appState.composites.length === 0) {
    compositeListDiv.innerHTML = '<div style="color: var(--text-dim); font-size: 11px;">No composites yet.</div>';
    return;
  }

  for (const comp of appState.composites) {
    const item = document.createElement("div");
    item.className = "room-palette-item";
    if (selectedBrush?.type === "composite" && selectedBrush.compositeId === comp.id) {
      item.classList.add("selected");
    }

    // Thumbnail
    const thumb = document.createElement("canvas");
    const maxDim = Math.max(comp.displaySize.w, comp.displaySize.h);
    const thumbScale = Math.min(32 / (maxDim * TILE_SIZE), 2);
    thumb.width = comp.displaySize.w * TILE_SIZE * thumbScale;
    thumb.height = comp.displaySize.h * TILE_SIZE * thumbScale;
    thumb.style.width = `${thumb.width}px`;
    thumb.style.height = `${thumb.height}px`;
    drawCompositeThumbnail(comp, thumb, thumbScale);

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `
      <div class="name">[C] ${comp.name}</div>
      <div class="meta">${comp.category} · ${comp.displaySize.w}×${comp.displaySize.h}</div>
    `;

    item.appendChild(thumb);
    item.appendChild(info);
    compositeListDiv.appendChild(item);

    item.addEventListener("click", () => {
      selectedBrush = { type: "composite", compositeId: comp.id };
      selectedPlacementIdx = null;
      roomPicker.clearSelection();
      roomSelectionInfo.textContent = `Composite: ${comp.name}`;
      renderCompositeList();
      drawRoom();
    });
  }
}

function drawCompositeThumbnail(
  comp: CompositeObject,
  thumbCanvas: HTMLCanvasElement,
  scale: number
): void {
  const ctx = thumbCanvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Sort parts by render order: anchor Y (offsetY + h + zBias), then X
  const sorted = [...comp.parts].sort((a, b) => {
    const anchorA = a.offsetY + a.region.h + (a.zBias ?? 0);
    const anchorB = b.offsetY + b.region.h + (b.zBias ?? 0);
    if (anchorA !== anchorB) return anchorA - anchorB;
    return a.offsetX - b.offsetX;
  });

  for (const part of sorted) {
    const img = getCachedTilesetImage(part.region.tilesetId);
    if (!img) {
      loadTilesetImage(part.region.tilesetId).then(() => {
        drawCompositeThumbnail(comp, thumbCanvas, scale);
      });
      continue;
    }

    ctx.drawImage(
      img,
      part.region.srcCol * TILE_SIZE,
      part.region.srcRow * TILE_SIZE,
      part.region.w * TILE_SIZE,
      part.region.h * TILE_SIZE,
      part.offsetX * TILE_SIZE * scale,
      part.offsetY * TILE_SIZE * scale,
      part.region.w * TILE_SIZE * scale,
      part.region.h * TILE_SIZE * scale
    );
  }
}

// ─── Helper: get placement size ──────────────────────────────────

function getItemSize(p: TexturePlacement): { w: number; h: number } | null {
  return getPlacementSize(p, (id) => appState.getComposite(id));
}

/** Get brush size in tiles */
function getBrushSize(brush: Brush): { w: number; h: number } | null {
  if (brush.type === "region") {
    return { w: brush.region.w, h: brush.region.h };
  }
  const comp = appState.getComposite(brush.compositeId);
  return comp ? comp.displaySize : null;
}

// ─── Mode switching ──────────────────────────────────────────────

function setMode(newMode: EditorMode): void {
  mode = newMode;

  // Update mode buttons
  modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.roomMode === mode);
  });

  // Show/hide left panels + layer tabs
  if (mode === "layout") {
    leftLayoutDiv.style.display = "";
    leftTextureDiv.style.display = "none";
    layerTabsSpan.style.display = "none";
    updateLayoutToolHint();
  } else {
    leftLayoutDiv.style.display = "none";
    leftTextureDiv.style.display = "flex";
    layerTabsSpan.style.display = "";
    updateLayerTabHint();
    renderCompositeList();
  }

  // Show/hide tile stack panel
  tileStackPanel.style.display = mode === "texture" ? "" : "none";

  // Reset mode-specific state
  selectedPlacementIdx = null;
  selectedBrush = null;
  selectedDoorId = null;
  layoutPainting = false;
  shiftPainting = false;
  inspectedTile = null;

  drawRoom();
}

function updateLayoutToolHint(): void {
  if (layoutTool === "walk") {
    modeHint.textContent = "Left-click = blocked, Right-click = walkable. Drag to paint.";
  } else {
    modeHint.textContent = "Click to place a door. Click existing door to select/edit.";
  }
}

function updateLayerTabHint(): void {
  if (layerTab === "floor") {
    modeHint.textContent = "Floor layer — place floors & walls. Shift+drag to paint.";
  } else if (layerTab === "object") {
    modeHint.textContent = "Object layer — place furniture & decor. Depth-sorted by bottom edge.";
  } else {
    modeHint.textContent = "Both layers — preview mode. New placements use last-used layer.";
  }
}

modeButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setMode(btn.dataset.roomMode as EditorMode);
  });
});

// ─── Layer tab switching ─────────────────────────────────────────

function setLayerTab(tab: LayerTab): void {
  layerTab = tab;

  layerTabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.layerTab === tab);
  });

  // Reset selection state when switching layers
  selectedPlacementIdx = null;
  inspectedTile = null;

  updateLayerTabHint();
  drawRoom();
}

layerTabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setLayerTab(btn.dataset.layerTab as LayerTab);
  });
});

// ─── Layout tool switching ───────────────────────────────────────

function setLayoutTool(tool: LayoutTool): void {
  layoutTool = tool;
  layoutToolButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.layoutTool === tool);
  });

  // Show/hide tool-specific info
  layoutWalkInfo.style.display = tool === "walk" ? "" : "none";
  layoutDoorInfo.style.display = tool === "door" ? "" : "none";

  // Reset state
  layoutPainting = false;
  if (tool !== "door") {
    selectedDoorId = null;
    doorPropsPanel.style.display = "none";
  }

  updateLayoutToolHint();
  drawRoom();
}

layoutToolButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    setLayoutTool(btn.dataset.layoutTool as LayoutTool);
  });
});

// ─── Door helpers ────────────────────────────────────────────────

function nextDoorId(): string {
  const id = `door-${doorIdCounter}`;
  doorIdCounter++;
  return id;
}

function getDoorAt(col: number, row: number): DoorDefinition | undefined {
  return doors.find((d) => d.col === col && d.row === row);
}

function selectDoor(doorId: string | null): void {
  selectedDoorId = doorId;
  if (!doorId) {
    doorPropsPanel.style.display = "none";
    renderDoorList();
    return;
  }

  const door = doors.find((d) => d.id === doorId);
  if (!door) {
    doorPropsPanel.style.display = "none";
    renderDoorList();
    return;
  }

  doorPropsPanel.style.display = "";
  doorPropsId.textContent = door.id;

  // Populate target room dropdown
  populateDoorTargetRoomDropdown(door);

  // Show current target
  updateDoorTargetDisplay(door);

  renderDoorList();
}

function populateDoorTargetRoomDropdown(door: DoorDefinition): void {
  const [targetRoom] = parseDoorTarget(door.target);

  doorTargetRoom.innerHTML = '<option value="">(none)</option>';
  for (const room of appState.rooms) {
    const opt = document.createElement("option");
    opt.value = room.name;
    opt.textContent = room.name;
    if (room.name === targetRoom) opt.selected = true;
    doorTargetRoom.appendChild(opt);
  }

  populateDoorTargetDoorDropdown(door);
}

function populateDoorTargetDoorDropdown(door: DoorDefinition): void {
  const [, targetDoorId] = parseDoorTarget(door.target);
  const selectedRoom = doorTargetRoom.value;

  doorTargetDoor.innerHTML = '<option value="">(none)</option>';

  if (!selectedRoom) return;

  // Find the room and list its doors
  const room = appState.rooms.find((r) => r.name === selectedRoom);
  if (!room || !room.doors) return;

  for (const d of room.doors) {
    const opt = document.createElement("option");
    opt.value = d.id;
    opt.textContent = `${d.id} (${d.col},${d.row})`;
    if (d.id === targetDoorId) opt.selected = true;
    doorTargetDoor.appendChild(opt);
  }
}

function parseDoorTarget(target: string): [string, string] {
  if (!target || !target.includes("#")) return ["", ""];
  const [room, doorId] = target.split("#", 2);
  return [room, doorId];
}

function updateDoorTargetDisplay(door: DoorDefinition): void {
  if (door.target) {
    doorTargetDisplay.textContent = `Target: ${door.target}`;
    doorTargetDisplay.style.color = "var(--green)";
  } else {
    doorTargetDisplay.textContent = "Not linked";
    doorTargetDisplay.style.color = "var(--text-dim)";
  }
}

// Door target dropdowns change handlers
doorTargetRoom.addEventListener("change", () => {
  const door = doors.find((d) => d.id === selectedDoorId);
  if (!door) return;

  populateDoorTargetDoorDropdown(door);
  const roomName = doorTargetRoom.value;
  const doorId = doorTargetDoor.value;
  door.target = roomName && doorId ? `${roomName}#${doorId}` : "";
  updateDoorTargetDisplay(door);
  renderDoorList();
  autoSaveEditorState();
});

doorTargetDoor.addEventListener("change", () => {
  const door = doors.find((d) => d.id === selectedDoorId);
  if (!door) return;

  const roomName = doorTargetRoom.value;
  const doorId = doorTargetDoor.value;
  door.target = roomName && doorId ? `${roomName}#${doorId}` : "";
  updateDoorTargetDisplay(door);
  renderDoorList();
  autoSaveEditorState();
});

doorRemoveBtn.addEventListener("click", () => {
  if (!selectedDoorId) return;
  doors = doors.filter((d) => d.id !== selectedDoorId);
  selectedDoorId = null;
  doorPropsPanel.style.display = "none";
  renderDoorList();
  drawRoom();
  setStatus("Door removed");
});

function renderDoorList(): void {
  doorCountSpan.textContent = String(doors.length);
  doorListDiv.innerHTML = "";

  for (const door of doors) {
    const item = document.createElement("div");
    item.className = "door-list-item" + (door.id === selectedDoorId ? " selected" : "");

    const colorDot = document.createElement("div");
    colorDot.className = "door-color";

    const info = document.createElement("div");
    info.className = "info";
    const targetText = door.target || "unlinked";
    info.innerHTML = `
      <div class="name">${door.id} (${door.col},${door.row})</div>
      <div class="meta">${targetText}</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      doors = doors.filter((d) => d.id !== door.id);
      if (selectedDoorId === door.id) {
        selectedDoorId = null;
        doorPropsPanel.style.display = "none";
      }
      renderDoorList();
      drawRoom();
      setStatus(`Removed ${door.id}`);
    });

    item.addEventListener("click", () => {
      selectDoor(door.id);
      drawRoom();
    });

    item.appendChild(colorDot);
    item.appendChild(info);
    item.appendChild(delBtn);
    doorListDiv.appendChild(item);
  }
}

// ─── Room canvas drawing ─────────────────────────────────────────

function drawRoom(): void {
  const ts = TILE_SIZE * currentZoom;
  const w = roomWidth * ts;
  const h = roomHeight * ts;

  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  canvasInner.style.width = `${w}px`;
  canvasInner.style.height = `${h}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Background
  ctx.fillStyle = "#1a1a2e";
  ctx.fillRect(0, 0, w, h);

  if (mode === "layout") {
    drawLayoutMode(ctx, ts);
  } else {
    drawTextureMode(ctx, ts);
  }

  // Grid
  if (showGrid) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= roomWidth; x++) {
      ctx.beginPath();
      ctx.moveTo(x * ts + 0.5, 0);
      ctx.lineTo(x * ts + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= roomHeight; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * ts + 0.5);
      ctx.lineTo(w, y * ts + 0.5);
      ctx.stroke();
    }
  }

  updateOverlays();
  updateDetails();
  autoSaveEditorState();
}

function drawLayoutMode(ctx: CanvasRenderingContext2D, ts: number): void {
  // Draw walkability grid as colored cells
  for (let row = 0; row < roomHeight; row++) {
    for (let col = 0; col < roomWidth; col++) {
      const idx = row * roomWidth + col;
      const isWalkable = walkability[idx];

      if (isWalkable) {
        ctx.fillStyle = "rgba(74, 222, 128, 0.25)";
      } else {
        ctx.fillStyle = "rgba(239, 68, 68, 0.3)";
      }
      ctx.fillRect(col * ts, row * ts, ts, ts);
    }
  }

  // Draw door markers
  for (const door of doors) {
    const isSelected = door.id === selectedDoorId;
    const hasTarget = door.target.length > 0;

    // Door tile fill
    ctx.fillStyle = isSelected
      ? "rgba(147, 130, 255, 0.5)"
      : "rgba(147, 130, 255, 0.3)";
    ctx.fillRect(door.col * ts, door.row * ts, ts, ts);

    // Door border
    ctx.strokeStyle = isSelected ? "#9382ff" : "rgba(147, 130, 255, 0.6)";
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.strokeRect(door.col * ts + 0.5, door.row * ts + 0.5, ts - 1, ts - 1);

    // Door label
    ctx.fillStyle = "#fff";
    ctx.font = `bold ${Math.max(9, ts / 5)}px monospace`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(door.id.replace("door-", "D"), door.col * ts + ts / 2, door.row * ts + ts / 2 - ts / 8);

    // Small indicator: green dot = linked, gray = unlinked
    const dotRadius = Math.max(3, ts / 14);
    ctx.beginPath();
    ctx.arc(door.col * ts + ts / 2, door.row * ts + ts / 2 + ts / 6, dotRadius, 0, Math.PI * 2);
    ctx.fillStyle = hasTarget ? "#4ade80" : "#666";
    ctx.fill();
  }

  // Update layout stats
  const walkableCount = walkability.filter(Boolean).length;
  const total = roomWidth * roomHeight;
  layoutStats.textContent = `Walkable: ${walkableCount} / ${total} · Doors: ${doors.length}`;

  // Update door list
  renderDoorList();
}

function drawTextureMode(ctx: CanvasRenderingContext2D, ts: number): void {
  // ── Render-time z-sorting (Option A) ──
  // 1. Separate floor vs object placements (with original indices for selection)
  // 2. Sort floor: top-to-bottom, left-to-right (row-major by top-left position)
  // 3. Sort objects: by anchor Y (bottom edge = gridY + h + zBias), then X
  // 4. Draw floor first, then objects

  // Filter placements by active layer tab
  const indexed = placements.map((p, i) => ({ p, i }));
  const visible = indexed.filter(({ p }) => {
    if (layerTab === "floor") return p.layer === "floor";
    if (layerTab === "object") return p.layer === "object";
    return true; // "both" — show all
  });

  const floors = visible.filter(({ p }) => p.layer === "floor");
  const objects = visible.filter(({ p }) => p.layer === "object");

  // Sort floors: top-to-bottom, left-to-right
  floors.sort((a, b) => {
    if (a.p.gridY !== b.p.gridY) return a.p.gridY - b.p.gridY;
    return a.p.gridX - b.p.gridX;
  });

  // Sort objects: by anchor Y (bottom edge + zBias), then X
  objects.sort((a, b) => {
    const sizeA = getItemSize(a.p);
    const sizeB = getItemSize(b.p);
    const anchorA = a.p.gridY + (sizeA?.h ?? 1) + (a.p.zBias ?? 0);
    const anchorB = b.p.gridY + (sizeB?.h ?? 1) + (b.p.zBias ?? 0);
    if (anchorA !== anchorB) return anchorA - anchorB;
    return a.p.gridX - b.p.gridX;
  });

  // Draw floor layer
  for (const { p } of floors) {
    drawPlacement(ctx, p, ts);
  }

  // Draw object layer
  for (const { p } of objects) {
    drawPlacement(ctx, p, ts);
  }

  // Draw faint walkability ghost overlay
  for (let row = 0; row < roomHeight; row++) {
    for (let col = 0; col < roomWidth; col++) {
      const idx = row * roomWidth + col;
      if (!walkability[idx]) {
        ctx.fillStyle = "rgba(239, 68, 68, 0.12)";
        ctx.fillRect(col * ts, row * ts, ts, ts);
      }
    }
  }

  // Draw faint door ghost overlay
  for (const door of doors) {
    ctx.fillStyle = "rgba(147, 130, 255, 0.15)";
    ctx.fillRect(door.col * ts, door.row * ts, ts, ts);
  }

  // Update composite list + tile stack panel
  renderTileStack();
}

function drawPlacement(ctx: CanvasRenderingContext2D, p: TexturePlacement, ts: number): void {
  if (p.compositeId) {
    const comp = appState.getComposite(p.compositeId);
    if (!comp) return;

    // Sort composite parts by render order: anchor Y (offsetY + h + zBias), then X
    const sorted = [...comp.parts].sort((a, b) => {
      const anchorA = a.offsetY + a.region.h + (a.zBias ?? 0);
      const anchorB = b.offsetY + b.region.h + (b.zBias ?? 0);
      if (anchorA !== anchorB) return anchorA - anchorB;
      return a.offsetX - b.offsetX;
    });

    for (const part of sorted) {
      drawRegionAt(ctx, part.region, (p.gridX + part.offsetX) * ts, (p.gridY + part.offsetY) * ts, ts);
    }
  } else if (p.region) {
    drawRegionAt(ctx, p.region, p.gridX * ts, p.gridY * ts, ts);
  }
}

/** Draw a TilesetRegion at a pixel position, scaled to the current tile size */
function drawRegionAt(
  ctx: CanvasRenderingContext2D,
  region: TilesetRegion,
  px: number,
  py: number,
  tileSize: number
): void {
  const img = getCachedTilesetImage(region.tilesetId);
  if (!img) {
    loadTilesetImage(region.tilesetId).then(() => drawRoom());
    return;
  }

  ctx.drawImage(
    img,
    region.srcCol * TILE_SIZE,
    region.srcRow * TILE_SIZE,
    region.w * TILE_SIZE,
    region.h * TILE_SIZE,
    px, py,
    region.w * tileSize,
    region.h * tileSize
  );
}

// ─── Tile stack panel (texture mode) ─────────────────────────────

/** Get indices of all placements that cover a given tile */
function getPlacementsAtTile(col: number, row: number): number[] {
  const indices: number[] = [];
  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];
    const size = getItemSize(p);
    if (!size) continue;
    if (col >= p.gridX && col < p.gridX + size.w && row >= p.gridY && row < p.gridY + size.h) {
      indices.push(i);
    }
  }
  return indices;
}

function renderTileStack(): void {
  if (!inspectedTile) {
    tileStackCount.textContent = "0";
    tileStackPos.textContent = "";
    tileStackList.innerHTML = '<div style="color: var(--text-dim); font-size: 11px;">Click a tile to inspect its stack.</div>';
    return;
  }

  const { col, row } = inspectedTile;
  const allIndices = getPlacementsAtTile(col, row);

  // Filter by active layer tab
  const indices = allIndices.filter((i) => {
    const p = placements[i];
    if (layerTab === "floor") return p.layer === "floor";
    if (layerTab === "object") return p.layer === "object";
    return true; // "both"
  });

  tileStackPos.textContent = `Tile (${col}, ${row})`;
  tileStackCount.textContent = String(indices.length);
  tileStackList.innerHTML = "";

  if (indices.length === 0) {
    tileStackList.innerHTML = '<div style="color: var(--text-dim); font-size: 11px;">Empty tile.</div>';
    return;
  }

  // Sort the indices by render order (matching drawTextureMode):
  // floor first (top-to-bottom, left-to-right), then objects (by anchor Y + zBias, then X)
  const sortedIndices = [...indices].sort((ai, bi) => {
    const a = placements[ai];
    const b = placements[bi];
    const aLayer = a.layer === "floor" ? 0 : 1;
    const bLayer = b.layer === "floor" ? 0 : 1;
    if (aLayer !== bLayer) return aLayer - bLayer;
    if (a.layer === "floor") {
      // Floor: top-to-bottom, left-to-right
      if (a.gridY !== b.gridY) return a.gridY - b.gridY;
      return a.gridX - b.gridX;
    }
    // Object: by anchor Y + zBias, then X
    const sizeA = getItemSize(a);
    const sizeB = getItemSize(b);
    const anchorA = a.gridY + (sizeA?.h ?? 1) + (a.zBias ?? 0);
    const anchorB = b.gridY + (sizeB?.h ?? 1) + (b.zBias ?? 0);
    if (anchorA !== anchorB) return anchorA - anchorB;
    return a.gridX - b.gridX;
  });

  // Show bottom-to-top (first in render order = behind = shown at top of list)
  for (let listIdx = 0; listIdx < sortedIndices.length; listIdx++) {
    const placementIdx = sortedIndices[listIdx];
    const p = placements[placementIdx];
    const size = getItemSize(p);

    const item = document.createElement("div");
    item.className = "tile-stack-item" + (placementIdx === selectedPlacementIdx ? " selected" : "");

    // Z-order label (render order index)
    const zLabel = document.createElement("div");
    zLabel.style.cssText = "width: 18px; text-align: center; font-size: 10px; color: var(--text-dim); flex-shrink: 0;";
    zLabel.textContent = String(listIdx);

    // Thumbnail
    const thumb = document.createElement("canvas");
    const thumbSize = 24;
    const thumbScale = size ? Math.min(thumbSize / (Math.max(size.w, size.h) * TILE_SIZE), 1) : 1;
    thumb.width = (size?.w ?? 1) * TILE_SIZE * thumbScale;
    thumb.height = (size?.h ?? 1) * TILE_SIZE * thumbScale;
    thumb.style.width = `${thumb.width}px`;
    thumb.style.height = `${thumb.height}px`;

    if (p.compositeId) {
      const comp = appState.getComposite(p.compositeId);
      if (comp) drawCompositeThumbnail(comp, thumb, thumbScale);
    } else if (p.region) {
      drawRegionThumbnail(p.region, thumb);
    }

    // Info
    const info = document.createElement("div");
    info.className = "info";
    let label: string;
    if (p.compositeId) {
      const comp = appState.getComposite(p.compositeId);
      label = `[C] ${comp?.name ?? p.compositeId}`;
    } else if (p.region) {
      label = `[T] ${p.region.w}×${p.region.h}`;
    } else {
      label = "?";
    }
    const biasStr = (p.zBias ?? 0) !== 0 ? ` zBias:${p.zBias! > 0 ? "+" : ""}${p.zBias}` : "";
    info.innerHTML = `
      <div class="name">${label}</div>
      <div class="meta">${p.layer} · (${p.gridX},${p.gridY})${biasStr}</div>
    `;

    // Up/Down buttons for z-bias adjustment
    const actions = document.createElement("div");
    actions.className = "stack-actions";

    const upBtn = document.createElement("button");
    upBtn.textContent = "\u25B2";
    upBtn.title = "Increase z-bias (render more in front)";
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      p.zBias = (p.zBias ?? 0) + 1;
      drawRoom();
    });

    const downBtn = document.createElement("button");
    downBtn.textContent = "\u25BC";
    downBtn.title = "Decrease z-bias (render more behind)";
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      p.zBias = (p.zBias ?? 0) - 1;
      drawRoom();
    });

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      placements.splice(placementIdx, 1);
      if (selectedPlacementIdx === placementIdx) selectedPlacementIdx = null;
      else if (selectedPlacementIdx !== null && selectedPlacementIdx > placementIdx) selectedPlacementIdx--;
      drawRoom();
      setStatus("Removed placement");
    });

    // Click to select
    item.addEventListener("click", () => {
      selectedPlacementIdx = placementIdx;
      selectedBrush = null;
      renderCompositeList();
      drawRoom();
    });

    item.appendChild(zLabel);
    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(actions);
    item.appendChild(delBtn);
    tileStackList.appendChild(item);
  }
}

function drawRegionThumbnail(region: TilesetRegion, thumbCanvas: HTMLCanvasElement): void {
  const img = getCachedTilesetImage(region.tilesetId);
  if (!img) {
    loadTilesetImage(region.tilesetId).then(() => drawRegionThumbnail(region, thumbCanvas));
    return;
  }
  const ctx = thumbCanvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(
    img,
    region.srcCol * TILE_SIZE,
    region.srcRow * TILE_SIZE,
    region.w * TILE_SIZE,
    region.h * TILE_SIZE,
    0, 0,
    thumbCanvas.width,
    thumbCanvas.height
  );
}


// ─── Overlays (texture mode only) ────────────────────────────────

function updateOverlays(): void {
  overlaysDiv.innerHTML = "";

  if (mode !== "texture") {
    overlaysDiv.style.pointerEvents = "none";
    return;
  }

  overlaysDiv.style.pointerEvents = "auto";
  const ts = TILE_SIZE * currentZoom;

  for (let i = 0; i < placements.length; i++) {
    const p = placements[i];

    // Filter overlays by active layer tab
    if (layerTab === "floor" && p.layer !== "floor") continue;
    if (layerTab === "object" && p.layer !== "object") continue;

    const size = getItemSize(p);
    if (!size) continue;

    const el = document.createElement("div");
    el.className = "room-item-overlay" + (i === selectedPlacementIdx ? " selected" : "");
    el.style.left = `${p.gridX * ts}px`;
    el.style.top = `${p.gridY * ts}px`;
    el.style.width = `${size.w * ts}px`;
    el.style.height = `${size.h * ts}px`;

    const idx = i;
    el.addEventListener("mousedown", (e) => {
      // Shift+click on overlay = start shift-painting (don't select)
      if (e.shiftKey && selectedBrush) {
        e.stopPropagation();
        e.preventDefault();
        const pos = getGridPos(e);
        if (pos) {
          shiftPainting = true;
          shiftPaintedCells.clear();
          stampBrushAt(pos.col, pos.row);
        }
        return;
      }

      // If a brush is active, place it instead of selecting the existing placement.
      // This allows stacking multiple elements on the same tile.
      if (selectedBrush && e.button === 0) {
        e.stopPropagation();
        e.preventDefault();
        const pos = getGridPos(e);
        if (pos) {
          placeBrushAt(pos.col, pos.row);
          inspectedTile = { col: pos.col, row: pos.row };
        }
        return;
      }

      e.stopPropagation();
      e.preventDefault();
      selectedPlacementIdx = idx;
      selectedBrush = null;

      // Set inspected tile to the clicked position
      const rect = canvasInner.getBoundingClientRect();
      const clickTs = TILE_SIZE * currentZoom;
      const col = Math.floor((e.clientX - rect.left) / clickTs);
      const row = Math.floor((e.clientY - rect.top) / clickTs);
      if (col >= 0 && col < roomWidth && row >= 0 && row < roomHeight) {
        inspectedTile = { col, row };
      }

      // Start dragging
      draggingPlacementIdx = idx;
      dragOffset = {
        x: e.clientX - rect.left - p.gridX * ts,
        y: e.clientY - rect.top - p.gridY * ts,
      };

      renderCompositeList();
      drawRoom();
    });

    overlaysDiv.appendChild(el);
  }
}

// ─── Canvas mouse handlers ───────────────────────────────────────

function getGridPos(e: MouseEvent): { col: number; row: number } | null {
  const rect = canvasInner.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const ts = TILE_SIZE * currentZoom;
  const col = Math.floor(x / ts);
  const row = Math.floor(y / ts);
  if (col < 0 || col >= roomWidth || row < 0 || row >= roomHeight) return null;
  return { col, row };
}

// Prevent context menu on the canvas area
canvasWrap.addEventListener("contextmenu", (e) => {
  e.preventDefault();
});

canvas.addEventListener("mousedown", (e) => {
  if (mode === "layout") {
    handleLayoutMouseDown(e);
  } else {
    handleTextureMouseDown(e);
  }
});

canvas.addEventListener("mousemove", (e) => {
  if (mode === "layout") {
    handleLayoutMouseMove(e);
  } else {
    handleTextureMouseMove(e);
  }
});

canvasWrap.addEventListener("mousemove", (e) => {
  if (mode === "texture" && draggingPlacementIdx !== null) {
    handleTextureDragMove(e);
  }
});

window.addEventListener("mouseup", () => {
  layoutPainting = false;
  shiftPainting = false;
  shiftPaintedCells.clear();
  if (draggingPlacementIdx !== null) {
    // No need to re-sort — render-time sorting handles draw order
    draggingPlacementIdx = null;
    drawRoom();
  }
  paintCursor.style.display = "none";
});

// ─── Layout mode mouse handlers ──────────────────────────────────

function handleLayoutMouseDown(e: MouseEvent): void {
  e.preventDefault();
  const pos = getGridPos(e);
  if (!pos) return;

  if (layoutTool === "walk") {
    // Left-click = blocked (false), Right-click = walkable (true)
    layoutPaintValue = e.button === 2;
    layoutPainting = true;

    const idx = pos.row * roomWidth + pos.col;
    walkability[idx] = layoutPaintValue;
    drawRoom();
  } else if (layoutTool === "door") {
    // Check if there's already a door at this tile
    const existing = getDoorAt(pos.col, pos.row);
    if (existing) {
      // Select it
      selectDoor(existing.id);
      drawRoom();
    } else {
      // Place a new door
      const newDoor: DoorDefinition = {
        id: nextDoorId(),
        col: pos.col,
        row: pos.row,
        target: "",
      };
      doors.push(newDoor);

      // Door tiles are walkable
      const idx = pos.row * roomWidth + pos.col;
      walkability[idx] = true;

      selectDoor(newDoor.id);
      drawRoom();
      setStatus(`Placed ${newDoor.id} at (${pos.col}, ${pos.row})`);
    }
  }
}

function handleLayoutMouseMove(e: MouseEvent): void {
  if (layoutTool !== "walk" || !layoutPainting) return;
  const pos = getGridPos(e);
  if (!pos) return;

  const idx = pos.row * roomWidth + pos.col;
  if (walkability[idx] !== layoutPaintValue) {
    walkability[idx] = layoutPaintValue;
    drawRoom();
  }
}

// ─── Texture mode mouse handlers ─────────────────────────────────

function handleTextureMouseDown(e: MouseEvent): void {
  e.preventDefault();

  const pos = getGridPos(e);
  if (!pos) return;

  // Shift+click = start paint mode
  if (e.shiftKey && selectedBrush) {
    shiftPainting = true;
    shiftPaintedCells.clear();
    stampBrushAt(pos.col, pos.row);
    return;
  }

  // If we have a brush selected, place it
  if (selectedBrush && e.button === 0) {
    placeBrushAt(pos.col, pos.row);
    // Set inspected tile to see the new stack
    inspectedTile = { col: pos.col, row: pos.row };
    return;
  }

  // No brush — inspect the tile stack
  inspectedTile = { col: pos.col, row: pos.row };
  selectedPlacementIdx = null;
  selectedBrush = null;
  renderCompositeList();
  drawRoom();
}

function handleTextureMouseMove(e: MouseEvent): void {
  const pos = getGridPos(e);
  const ts = TILE_SIZE * currentZoom;

  // Show paint cursor when we have a brush
  if (selectedBrush && pos) {
    const size = getBrushSize(selectedBrush);
    if (size) {
      paintCursor.style.display = "block";
      paintCursor.style.left = `${pos.col * ts}px`;
      paintCursor.style.top = `${pos.row * ts}px`;
      paintCursor.style.width = `${size.w * ts}px`;
      paintCursor.style.height = `${size.h * ts}px`;
    }
  } else {
    paintCursor.style.display = "none";
  }

  // Shift+drag painting
  if (shiftPainting && selectedBrush && pos) {
    stampBrushAt(pos.col, pos.row);
  }
}

function handleTextureDragMove(e: MouseEvent): void {
  if (draggingPlacementIdx === null) return;
  const p = placements[draggingPlacementIdx];
  if (!p) return;

  const size = getItemSize(p);
  if (!size) return;

  const ts = TILE_SIZE * currentZoom;
  const rect = canvasInner.getBoundingClientRect();
  const x = e.clientX - rect.left - dragOffset.x;
  const y = e.clientY - rect.top - dragOffset.y;

  let gridX = Math.round(x / ts);
  let gridY = Math.round(y / ts);

  gridX = Math.max(0, Math.min(roomWidth - size.w, gridX));
  gridY = Math.max(0, Math.min(roomHeight - size.h, gridY));

  if (p.gridX !== gridX || p.gridY !== gridY) {
    p.gridX = gridX;
    p.gridY = gridY;
    drawRoom();
  }
}

/** Place brush at grid position (single click) */
function placeBrushAt(col: number, row: number): void {
  if (!selectedBrush) return;

  const size = getBrushSize(selectedBrush);
  if (!size) return;

  // Clamp to room bounds
  const gridX = Math.min(col, roomWidth - size.w);
  const gridY = Math.min(row, roomHeight - size.h);
  if (gridX < 0 || gridY < 0) return;

  // Determine placement layer from active tab
  let layer: "floor" | "object";
  if (layerTab === "floor") {
    layer = "floor";
  } else if (layerTab === "object") {
    layer = "object";
  } else {
    // "both" tab — use last-used layer
    layer = lastUsedLayer;
  }
  lastUsedLayer = layer;

  let newPlacement: TexturePlacement;
  if (selectedBrush.type === "region") {
    newPlacement = {
      gridX,
      gridY,
      layer,
      region: { ...selectedBrush.region },
    };
  } else {
    newPlacement = {
      gridX,
      gridY,
      layer,
      compositeId: selectedBrush.compositeId,
    };
  }

  placements.push(newPlacement);
  selectedPlacementIdx = placements.length - 1;

  drawRoom();
  const label = selectedBrush.type === "region"
    ? `${selectedBrush.region.w}×${selectedBrush.region.h} region`
    : `composite`;
  setStatus(`Placed ${label} at (${gridX}, ${gridY}) on ${layer} layer`);
}

/** Stamp brush at grid position (Shift+drag painting, skips already-stamped cells) */
function stampBrushAt(col: number, row: number): void {
  const key = `${col},${row}`;
  if (shiftPaintedCells.has(key)) return;
  shiftPaintedCells.add(key);
  placeBrushAt(col, row);
}

// ─── Canvas leave: hide paint cursor ─────────────────────────────

canvas.addEventListener("mouseleave", () => {
  paintCursor.style.display = "none";
});

// ─── Keyboard ────────────────────────────────────────────────────

window.addEventListener("keydown", (e) => {
  const roomTab = document.getElementById("tab-room")!;
  if (!roomTab.classList.contains("active")) return;

  // Skip if typing in inputs
  if (
    document.activeElement === nameInput ||
    document.activeElement === widthInput ||
    document.activeElement === heightInput
  ) return;

  if (mode === "texture") {
    if ((e.key === "Delete" || e.key === "Backspace") && selectedPlacementIdx !== null) {
      e.preventDefault();
      placements.splice(selectedPlacementIdx, 1);
      selectedPlacementIdx = null;
      drawRoom();
      setStatus("Removed placement");
    }

    if (e.key === "Escape") {
      e.preventDefault();
      selectedPlacementIdx = null;
      selectedBrush = null;
      inspectedTile = null;
      roomPicker.clearSelection();
      roomSelectionInfo.textContent = "Click/drag on tileset to select brush.";
      renderCompositeList();
      drawRoom();
    }
  }

  if (mode === "layout") {
    if (e.key === "Escape") {
      e.preventDefault();
      layoutPainting = false;
      selectedDoorId = null;
      doorPropsPanel.style.display = "none";
      renderDoorList();
      drawRoom();
    }

    if ((e.key === "Delete" || e.key === "Backspace") && selectedDoorId) {
      e.preventDefault();
      doors = doors.filter((d) => d.id !== selectedDoorId);
      selectedDoorId = null;
      doorPropsPanel.style.display = "none";
      renderDoorList();
      drawRoom();
      setStatus("Door removed");
    }
  }
});

// ─── Details panel ───────────────────────────────────────────────

function updateDetails(): void {
  const floorCount = placements.filter((p) => p.layer === "floor").length;
  const objCount = placements.filter((p) => p.layer === "object").length;
  const walkableCount = walkability.filter(Boolean).length;
  const total = roomWidth * roomHeight;

  const lines: string[] = [];
  lines.push(`Grid: ${roomWidth}\u00d7${roomHeight} (${total} tiles)`);
  lines.push(`Walkable: ${walkableCount} / ${total}`);
  lines.push(`Doors: ${doors.length}`);
  if (placements.length > 0) {
    lines.push(`Placements: ${placements.length} (floor: ${floorCount}, objects: ${objCount})`);
  }

  roomInfo.innerHTML = lines.map((l) => `<div>${l}</div>`).join("");

  const hasName = nameInput.value.trim().length > 0;
  saveBtn.disabled = !hasName;
  exportLayoutBtn.disabled = !hasName;
  exportTextureBtn.disabled = !hasName;
}

// ─── Room resize ─────────────────────────────────────────────────

resizeBtn.addEventListener("click", () => {
  const w = parseInt(widthInput.value);
  const h = parseInt(heightInput.value);
  if (!(w >= 4 && w <= 50 && h >= 4 && h <= 50)) return;

  // Resize walkability grid, preserving existing data where possible
  const newWalk = createWalkabilityGrid(w, h, true);
  for (let row = 0; row < Math.min(h, roomHeight); row++) {
    for (let col = 0; col < Math.min(w, roomWidth); col++) {
      newWalk[row * w + col] = walkability[row * roomWidth + col];
    }
  }

  roomWidth = w;
  roomHeight = h;
  walkability = newWalk;

  // Remove doors that are now out of bounds
  doors = doors.filter((d) => d.col < roomWidth && d.row < roomHeight);
  if (selectedDoorId && !doors.find((d) => d.id === selectedDoorId)) {
    selectedDoorId = null;
    doorPropsPanel.style.display = "none";
  }

  // Remove placements that are now out of bounds
  placements = placements.filter((p) => {
    const size = getItemSize(p);
    if (!size) return false;
    return p.gridX + size.w <= roomWidth && p.gridY + size.h <= roomHeight;
  });

  selectedPlacementIdx = null;
  inspectedTile = null;
  drawRoom();
  setStatus(`Room resized to ${w}\u00d7${h}`);
});

nameInput.addEventListener("input", () => {
  updateDetails();
  autoSaveEditorState();
});

// ─── Save room ───────────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return;

  const room: RoomDefinition = {
    name: editingRoomName || name,
    width: roomWidth,
    height: roomHeight,
    walkability: [...walkability],
    doors: doors.map((d) => ({ ...d })),
    placements: placements.map((p) => ({ ...p })),
  };

  appState.addRoom(room);
  setStatus(`Saved room "${name}" (${roomWidth}\u00d7${roomHeight}, ${doors.length} doors, ${placements.length} placements)`);
  editingRoomName = name;
  renderSavedRooms();
});

// ─── Export room.dat / room_texture.dat ──────────────────────────

function buildRoomDefinition(): RoomDefinition {
  return {
    name: nameInput.value.trim(),
    width: roomWidth,
    height: roomHeight,
    walkability: [...walkability],
    doors: doors.map((d) => ({ ...d })),
    placements: placements.map((p) => ({ ...p })),
  };
}

exportLayoutBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return;

  const layout = extractRoomLayout(buildRoomDefinition());
  const json = JSON.stringify(layout, null, 2);
  downloadFile(`${name}_layout.dat`, json, "application/json");
  setStatus(`Exported ${name}_layout.dat`);
});

exportTextureBtn.addEventListener("click", () => {
  const name = nameInput.value.trim();
  if (!name) return;

  const texture = extractRoomTexture(buildRoomDefinition());
  const json = JSON.stringify(texture, null, 2);
  downloadFile(`${name}_texture.dat`, json, "application/json");
  setStatus(`Exported ${name}_texture.dat`);
});

function downloadFile(filename: string, content: string, mimeType: string): void {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── Clear room ──────────────────────────────────────────────────

function clearRoom(): void {
  walkability = createWalkabilityGrid(roomWidth, roomHeight, true);
  doors = [];
  doorIdCounter = 1;
  placements = [];
  selectedPlacementIdx = null;
  selectedBrush = null;
  selectedDoorId = null;
  inspectedTile = null;
  editingRoomName = null;
  nameInput.value = "";
  doorPropsPanel.style.display = "none";
  clearEditorSaveState();
  drawRoom();
  if (mode === "texture") renderCompositeList();
}

clearBtn.addEventListener("click", () => {
  if (!confirmDiscardChanges()) return;
  clearRoom();
  setStatus("Room cleared");
});

// ─── Saved rooms list ────────────────────────────────────────────

function renderSavedRooms(): void {
  savedCount.textContent = String(appState.rooms.length);
  savedList.innerHTML = "";

  for (const room of appState.rooms) {
    const item = document.createElement("div");
    item.className = "room-saved-item";

    const info = document.createElement("div");
    info.className = "info";
    const doorCount = room.doors?.length ?? 0;
    info.innerHTML = `
      <div class="name">${room.name}</div>
      <div class="meta">${room.width}\u00d7${room.height} \u00b7 ${doorCount} doors \u00b7 ${room.placements.length} placements</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Delete room";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      appState.removeRoom(room.name);
      renderSavedRooms();
      setStatus(`Deleted room "${room.name}"`);
    });

    item.addEventListener("click", () => {
      loadRoom(room);
    });

    item.appendChild(info);
    item.appendChild(delBtn);
    savedList.appendChild(item);
  }
}

function loadRoom(room: RoomDefinition): void {
  if (!confirmDiscardChanges()) return;

  roomWidth = room.width;
  roomHeight = room.height;
  widthInput.value = String(room.width);
  heightInput.value = String(room.height);
  nameInput.value = room.name;
  editingRoomName = room.name;
  walkability = [...room.walkability];
  doors = (room.doors || []).map((d) => ({ ...d }));
  placements = room.placements.map((p) => ({ ...p }));
  selectedPlacementIdx = null;
  selectedBrush = null;
  selectedDoorId = null;
  inspectedTile = null;
  doorPropsPanel.style.display = "none";

  // Reset door counter to be above existing IDs
  doorIdCounter = 1;
  for (const d of doors) {
    const match = d.id.match(/^door-(\d+)$/);
    if (match) {
      const num = parseInt(match[1]);
      if (num >= doorIdCounter) doorIdCounter = num + 1;
    }
  }

  drawRoom();
  if (mode === "texture") renderCompositeList();
  setStatus(`Loaded room "${room.name}"`);
}

// ─── Control listeners ───────────────────────────────────────────

zoomSelect.addEventListener("change", () => {
  currentZoom = parseInt(zoomSelect.value);
  drawRoom();
});

gridToggle.addEventListener("change", () => {
  showGrid = gridToggle.checked;
  drawRoom();
});

appState.subscribe(() => {
  if (mode === "texture") renderCompositeList();
  renderSavedRooms();
});

// ─── Init ────────────────────────────────────────────────────────

export function initRoomTab(): void {
  // Try to restore previous editor state before anything else
  const restored = restoreEditorState();

  // Populate tileset dropdown dynamically
  populateTilesetSelect(roomTilesetSelect);

  // Preload all tileset images
  const loadPromises = appState.tilesets.map((ts) => loadTilesetImage(ts.id));

  Promise.all(loadPromises).then(() => {
    roomPicker.setTileset(roomTilesetSelect.value as TilesetId);
    renderSavedRooms();

    if (restored) {
      // Restore the mode/tool UI to match the restored state
      setMode(mode);
      setLayoutTool(layoutTool);
      setLayerTab(layerTab);
      setStatus("Room Editor ready — restored previous session");
    } else {
      setMode("layout"); // start in layout mode — this calls drawRoom()
      setStatus("Room Editor ready");
    }
  });
}
