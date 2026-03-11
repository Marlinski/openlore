/**
 * Tab 3: Tile Cutter
 *
 * Generic resource creation tool. Replaces the old Character Definer.
 * Select any tileset, drag-select frame ranges, tag them, and save
 * as Resources. Optionally save the cut pattern as a Mask for
 * batch-applying to similarly-shaped tilesets.
 *
 * Drag interaction:
 *   1. Drag → release (no Shift): Static rectangle selection.
 *      E.g. a 3×3 desk = single frame of 3×3 tiles.
 *   2. Hold Shift (mouse up or down doesn't matter): Locks the initial
 *      rectangle as the frame template. Mouse movement extends the
 *      selection rightward in frame-width increments.
 *      E.g. drag 1×2, hold Shift, move right → N frames of 1×2.
 *   3. Release Shift: Finalizes the sequence selection.
 *
 * FPS is NOT stored on resources — it's a preview-only global slider.
 */

import {
  type Resource,
  type ResourceFrame,
  type Mask,
  type MaskCut,
  type TilesetDefinition,
  generateId,
} from "@offisims/shared";
import { appState } from "./state.js";
import { setStatus } from "./main.js";
import { populateTilesetList, loadTilesetImage, getCachedTilesetImage } from "./tileset-picker.js";

// ─── DOM elements ─────────────────────────────────────────────────

const tilesetSelectContainer = document.getElementById("cut-tileset-select") as HTMLDivElement;
const sheetInfo = document.getElementById("cut-sheet-info") as HTMLDivElement;

const sharedTagsContainer = document.getElementById("cut-shared-tags") as HTMLDivElement;
const groupTagInput = document.getElementById("cut-group-tag") as HTMLInputElement;
const groupTagAc = document.getElementById("cut-group-tag-ac") as HTMLDivElement;
const maskNameInput = document.getElementById("cut-mask-name") as HTMLInputElement;
const saveMaskBtn = document.getElementById("cut-save-mask-btn") as HTMLButtonElement;

const zoomSelect = document.getElementById("cut-zoom") as HTMLSelectElement;
const gridToggle = document.getElementById("cut-grid-toggle") as HTMLInputElement;

const canvas = document.getElementById("cut-canvas") as HTMLCanvasElement;
const dragOverlay = document.getElementById("cut-drag-overlay") as HTMLDivElement;
const seqOverlay = document.getElementById("cut-seq-overlay") as HTMLDivElement;
const pendingOverlay = document.getElementById("cut-pending-overlay") as HTMLDivElement;

const assignForm = document.getElementById("cut-assign-form") as HTMLDivElement;
const assignHint = document.getElementById("cut-assign-hint") as HTMLDivElement;
const assignNameInput = document.getElementById("cut-assign-name") as HTMLInputElement;
const assignTagsInput = document.getElementById("cut-assign-tags") as HTMLInputElement;
const assignTagsAc = document.getElementById("cut-assign-tags-ac") as HTMLDivElement;
const assignInfoDiv = document.getElementById("cut-assign-info") as HTMLDivElement;
const pendingPreviewDiv = document.getElementById("cut-pending-preview") as HTMLDivElement;
const assignBtn = document.getElementById("cut-assign-btn") as HTMLButtonElement;
const assignCancelBtn = document.getElementById("cut-assign-cancel-btn") as HTMLButtonElement;

const saveResourcesBtn = document.getElementById("cut-save-resources-btn") as HTMLButtonElement;
const saveStatusDiv = document.getElementById("cut-save-status") as HTMLDivElement;

const maskCountSpan = document.getElementById("cut-mask-count") as HTMLSpanElement;
const maskListDiv = document.getElementById("cut-mask-list") as HTMLDivElement;

const entryCountSpan = document.getElementById("cut-entry-count") as HTMLSpanElement;
const entryListDiv = document.getElementById("cut-entry-list") as HTMLDivElement;

const previewSpeedRange = document.getElementById("cut-preview-speed") as HTMLInputElement;
const previewSpeedLabel = document.getElementById("cut-preview-speed-label") as HTMLSpanElement;
const previewArea = document.getElementById("cut-preview-area") as HTMLDivElement;

const resourceCountSpan = document.getElementById("cut-resource-count") as HTMLSpanElement;
const resourceFilterInput = document.getElementById("cut-resource-filter") as HTMLInputElement;
const resourceListDiv = document.getElementById("cut-resource-list") as HTMLDivElement;
const clearResourcesBtn = document.getElementById("cut-clear-resources-btn") as HTMLButtonElement;

// ─── State ────────────────────────────────────────────────────────

let currentTilesetId = "";
let currentZoom = 1;
let showGrid = true;

/** Current tileset image */
let currentImg: HTMLImageElement | null = null;

/** Current tileset info */
let currentInfo: TilesetDefinition | null = null;

/** Last-known shared tags for the current tileset (used for diffing group tag edits) */
let lastSharedTags: string[] = [];

// ─── Drag state machine ──────────────────────────────────────────
//
// Modes:
//   "idle"     — nothing happening
//   "dragging" — mouse is down, dragging a rectangle (no Shift)
//   "locked"   — Shift was pressed; the initial rectangle is locked as the
//                frame template, and mouse movement extends the sequence
//                rightward in frame-width increments.
//
// Transitions:
//   idle → dragging: mousedown
//   dragging → idle: mouseup (no Shift held) → commits as static rect
//   dragging → locked: Shift pressed (mouse up or down)
//   locked → idle: Shift released → commits as sequence
//   idle → locked: (not possible — need a rectangle first)

type DragMode = "idle" | "dragging" | "locked";

interface DragState {
  mode: DragMode;
  /** Rectangle origin (where the drag started, in tile coords) */
  anchorCol: number;
  anchorRow: number;
  /** Current mouse position in tile coords (updated during drag) */
  currentCol: number;
  currentRow: number;
  /** Locked frame template (set when entering "locked" mode) */
  frameRect: { col: number; row: number; w: number; h: number } | null;
  /** Number of frames in the sequence (computed from mouse offset in locked mode) */
  frameCount: number;
}

const drag: DragState = {
  mode: "idle",
  anchorCol: 0,
  anchorRow: 0,
  currentCol: 0,
  currentRow: 0,
  frameRect: null,
  frameCount: 1,
};

function resetDrag(): void {
  drag.mode = "idle";
  drag.frameRect = null;
  drag.frameCount = 1;
  dragOverlay.style.display = "none";
  seqOverlay.style.display = "none";
}

function hidePendingOverlay(): void {
  pendingOverlay.style.display = "none";
}

/** Show the pending overlay for a finalized selection */
function showPendingOverlay(sel: PendingSelection): void {
  if (!currentInfo) return;
  const z = currentZoom;
  const tw = currentInfo.tileWidth * z;
  const th = currentInfo.tileHeight * z;
  pendingOverlay.style.display = "block";
  pendingOverlay.style.left = `${sel.col * tw}px`;
  pendingOverlay.style.top = `${sel.row * th}px`;
  pendingOverlay.style.width = `${sel.frameWidth * sel.frameCount * tw}px`;
  pendingOverlay.style.height = `${sel.frameHeight * th}px`;
}

/** Stop and clear the pending-selection preview animation */
function hidePendingPreview(): void {
  if (pendingPreviewTimer !== null) {
    clearInterval(pendingPreviewTimer);
    pendingPreviewTimer = null;
  }
  pendingPreviewDiv.innerHTML = "";
}

/** Show an animated preview of the pending selection inside the assign form */
function showPendingPreview(sel: PendingSelection): void {
  hidePendingPreview();
  if (!currentImg || !currentInfo) return;
  // Static selections: show a single still frame instead of animation
  const isStatic = sel.frameCount <= 1;

  const tw = currentInfo.tileWidth;
  const th = currentInfo.tileHeight;
  const fw = sel.frameWidth * tw;
  const fh = sel.frameHeight * th;

  // Scale to fit a max height of 64px (readable but compact)
  const maxH = 64;
  const scale = fh > maxH ? maxH / fh : 1;

  const cvs = document.createElement("canvas");
  cvs.width = Math.round(fw * scale);
  cvs.height = Math.round(fh * scale);
  cvs.style.width = `${cvs.width}px`;
  cvs.style.height = `${cvs.height}px`;
  cvs.style.imageRendering = "pixelated";
  cvs.style.border = "1px solid var(--border)";
  cvs.style.borderRadius = "3px";
  pendingPreviewDiv.appendChild(cvs);

  const ctx = cvs.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  const frames: { sx: number; sy: number }[] = [];
  for (let f = 0; f < sel.frameCount; f++) {
    frames.push({
      sx: (sel.col + f * sel.frameWidth) * tw,
      sy: sel.row * th,
    });
  }

  let currentFrame = 0;
  const draw = () => {
    const frame = frames[currentFrame];
    ctx.clearRect(0, 0, cvs.width, cvs.height);
    ctx.drawImage(
      currentImg!,
      frame.sx, frame.sy, fw, fh,
      0, 0, cvs.width, cvs.height,
    );
  };

  draw();
  if (!isStatic && frames.length > 1) {
    const fps = parseInt(previewSpeedRange.value) || 4;
    pendingPreviewTimer = window.setInterval(() => {
      currentFrame = (currentFrame + 1) % frames.length;
      draw();
    }, 1000 / fps);
  }
}

/** Get the normalized rectangle from anchor → current (handles any drag direction) */
function getDragRect(): { col: number; row: number; w: number; h: number } {
  const minCol = Math.min(drag.anchorCol, drag.currentCol);
  const maxCol = Math.max(drag.anchorCol, drag.currentCol);
  const minRow = Math.min(drag.anchorRow, drag.currentRow);
  const maxRow = Math.max(drag.anchorRow, drag.currentRow);
  return { col: minCol, row: minRow, w: maxCol - minCol + 1, h: maxRow - minRow + 1 };
}

/** Compute frame count from mouse position in locked mode */
function computeSequenceFrameCount(mouseCol: number): number {
  if (!drag.frameRect || !currentInfo) return 1;
  const fr = drag.frameRect;
  // How many frame-widths fit from the frame's left edge to the mouse?
  const offset = mouseCol - fr.col + 1; // columns from left of frame rect to mouse (inclusive)
  const count = Math.max(1, Math.ceil(offset / fr.w));
  // Clamp to tileset bounds
  const maxFrames = Math.floor((currentInfo.cols - fr.col) / fr.w);
  return Math.min(count, Math.max(1, maxFrames));
}

/** Pending selection (after interaction completes, before tagging) */
interface PendingSelection {
  /** Top-left tile column of the first frame */
  col: number;
  /** Top-left tile row of the first frame */
  row: number;
  /** Width of each frame in tiles */
  frameWidth: number;
  /** Height of each frame in tiles */
  frameHeight: number;
  /** Number of frames (1 for static) */
  frameCount: number;
}

let pendingSelection: PendingSelection | null = null;

/**
 * Cut entries for the current working session.
 * Each cut will become a Resource when "Save Resources" is clicked.
 */
interface CutEntry {
  /** Internal UI id */
  id: string;
  /** Resource name */
  name: string;
  /** Tags */
  tags: string[];
  /** Top-left tile column of the first frame */
  col: number;
  /** Top-left tile row */
  row: number;
  /** Width of each frame in tiles */
  frameWidth: number;
  /** Height of each frame in tiles */
  frameHeight: number;
  /** Number of frames (1 = static) */
  frameCount: number;
}

let cuts: CutEntry[] = [];

/** Currently selected cut entry (for highlighting) */
let selectedCutId: string | null = null;

/** Animation previews */
interface AnimPreview {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  frames: { sx: number; sy: number; sw: number; sh: number }[];
  currentFrame: number;
}

let animPreviews: AnimPreview[] = [];
let animTimer: number | null = null;

/** Pending selection preview (shown in assign form before "Add Cut") */
let pendingPreviewTimer: number | null = null;

// ─── Cut colors ──────────────────────────────────────────────────

const CUT_COLORS = [
  "#e06c75", "#e5c07b", "#61afef", "#c678dd", "#56b6c2",
  "#98c379", "#d19a66", "#be5046", "#7ec8e3", "#c8ccd4",
];

function getCutColor(idx: number): string {
  return CUT_COLORS[idx % CUT_COLORS.length];
}

// ─── Helpers ──────────────────────────────────────────────────────

function newEntryId(): string {
  return "c" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function parseTags(input: string): string[] {
  return input.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean);
}

// ─── Tileset-scoped resource helpers ─────────────────────────────

/** Get all saved resources that have at least one frame from the current tileset */
function getTilesetResources(): Resource[] {
  if (!currentTilesetId) return [];
  return appState.resources.filter((r) =>
    r.frames.some((f) => f.tilesetId === currentTilesetId)
  );
}

/** Compute the tags shared by ALL resources for the current tileset */
function getSharedTilesetTags(): string[] {
  const resources = getTilesetResources();
  if (resources.length === 0) return [];
  // Start with the first resource's tags, intersect with the rest
  let shared = new Set(resources[0].tags);
  for (let i = 1; i < resources.length; i++) {
    const tags = new Set(resources[i].tags);
    shared = new Set([...shared].filter((t) => tags.has(t)));
    if (shared.size === 0) break;
  }
  return [...shared].sort();
}

/** Render shared tag pills and sync state */
function syncGroupTagFromResources(): void {
  const shared = getSharedTilesetTags();
  lastSharedTags = shared;
  renderSharedTagPills();
}

/** Render the pill UI for shared tags */
function renderSharedTagPills(): void {
  sharedTagsContainer.innerHTML = "";
  for (const tag of lastSharedTags) {
    const pill = document.createElement("span");
    pill.className = "tag-pill";
    pill.textContent = tag;

    const x = document.createElement("button");
    x.className = "remove-tag";
    x.textContent = "\u00d7";
    x.title = `Remove "${tag}" from all resources`;
    x.addEventListener("click", () => removeSharedTag(tag));

    pill.appendChild(x);
    sharedTagsContainer.appendChild(pill);
  }
}

/** Add a shared tag to all resources for the current tileset */
function addSharedTag(tag: string): void {
  if (!tag || lastSharedTags.includes(tag)) return;

  const resources = getTilesetResources();
  for (const res of resources) {
    if (!res.tags.includes(tag)) {
      appState.addResource({ ...res, tags: [tag, ...res.tags] });
    }
  }

  lastSharedTags.push(tag);
  lastSharedTags.sort();
  renderSharedTagPills();
  renderResourceList();
  setStatus(`Added tag "${tag}" to ${resources.length} resource(s)`);
}

/** Remove a shared tag from all resources for the current tileset */
function removeSharedTag(tag: string): void {
  const resources = getTilesetResources();
  for (const res of resources) {
    const filtered = res.tags.filter((t) => t !== tag);
    if (filtered.length !== res.tags.length) {
      appState.addResource({ ...res, tags: filtered });
    }
  }

  lastSharedTags = lastSharedTags.filter((t) => t !== tag);
  renderSharedTagPills();
  renderResourceList();
  setStatus(`Removed tag "${tag}" from ${resources.length} resource(s)`);
}

// ─── Tag autocomplete ────────────────────────────────────────────

/** Collect all known tags: saved resources + current session cuts */
function collectAllTags(): string[] {
  const tagSet = new Set<string>();
  for (const r of appState.resources) {
    for (const t of r.tags) tagSet.add(t);
  }
  for (const c of cuts) {
    for (const t of c.tags) tagSet.add(t);
  }
  return [...tagSet].sort();
}

/** Active autocomplete state */
let activeAcInput: HTMLInputElement | null = null;
let activeAcDropdown: HTMLDivElement | null = null;
let acSelectedIdx = -1;

function showAutocomplete(input: HTMLInputElement, dropdown: HTMLDivElement): void {
  // Get the current token being typed (last comma-separated segment)
  const raw = input.value;
  const parts = raw.split(",");
  const current = parts[parts.length - 1].trimStart().toLowerCase();

  if (!current) {
    dropdown.style.display = "none";
    return;
  }

  const allTags = collectAllTags();
  const existing = new Set(parts.slice(0, -1).map((t) => t.trim().toLowerCase()));
  const matches = allTags.filter((t) => t.startsWith(current) && !existing.has(t));

  if (matches.length === 0) {
    dropdown.style.display = "none";
    return;
  }

  activeAcInput = input;
  activeAcDropdown = dropdown;
  acSelectedIdx = -1;

  dropdown.innerHTML = "";
  for (let i = 0; i < matches.length; i++) {
    const item = document.createElement("div");
    item.className = "ac-item";
    item.textContent = matches[i];
    item.addEventListener("mousedown", (e) => {
      e.preventDefault(); // Don't blur the input
      acceptAutocomplete(matches[i]);
    });
    dropdown.appendChild(item);
  }
  dropdown.style.display = "block";
}

function acceptAutocomplete(tag: string): void {
  if (!activeAcInput || !activeAcDropdown) return;
  const parts = activeAcInput.value.split(",");
  parts[parts.length - 1] = " " + tag;
  // If it's the shared-tag input, add as shared tag and clear
  if (activeAcInput === groupTagInput) {
    addSharedTag(tag);
    activeAcInput.value = "";
    activeAcDropdown.style.display = "none";
    activeAcInput.focus();
    return;
  } else {
    activeAcInput.value = parts.join(",") + ", ";
  }
  activeAcDropdown.style.display = "none";
  activeAcInput.focus();
}

function handleAcKeydown(e: KeyboardEvent, dropdown: HTMLDivElement): boolean {
  if (dropdown.style.display === "none") return false;
  const items = dropdown.querySelectorAll(".ac-item");
  if (items.length === 0) return false;

  if (e.key === "ArrowDown") {
    e.preventDefault();
    acSelectedIdx = Math.min(acSelectedIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle("active", i === acSelectedIdx));
    return true;
  }
  if (e.key === "ArrowUp") {
    e.preventDefault();
    acSelectedIdx = Math.max(acSelectedIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle("active", i === acSelectedIdx));
    return true;
  }
  if (e.key === "Enter" || e.key === "Tab") {
    if (acSelectedIdx >= 0 && acSelectedIdx < items.length) {
      e.preventDefault();
      acceptAutocomplete(items[acSelectedIdx].textContent!);
      return true;
    }
  }
  if (e.key === "Escape") {
    dropdown.style.display = "none";
    return true;
  }
  return false;
}

function wireAutocomplete(input: HTMLInputElement, dropdown: HTMLDivElement): void {
  input.addEventListener("input", () => showAutocomplete(input, dropdown));
  input.addEventListener("keydown", (e) => handleAcKeydown(e, dropdown));
  input.addEventListener("blur", () => {
    // Small delay so mousedown on dropdown fires first
    setTimeout(() => { dropdown.style.display = "none"; }, 150);
  });
  input.addEventListener("focus", () => showAutocomplete(input, dropdown));
}

// ─── Tileset loading ──────────────────────────────────────────────

async function loadTileset(): Promise<void> {
  if (!currentTilesetId) {
    sheetInfo.textContent = "No tileset selected.";
    currentImg = null;
    currentInfo = null;
    canvas.width = 0;
    canvas.height = 0;
    return;
  }

  sheetInfo.textContent = "Loading...";
  currentInfo = appState.getTileset(currentTilesetId) ?? null;

  if (!currentInfo) {
    sheetInfo.textContent = `Unknown tileset: ${currentTilesetId}`;
    currentImg = null;
    return;
  }

  try {
    currentImg = await loadTilesetImage(currentTilesetId);

    // Update tileset dimensions if they were placeholders
    if (currentInfo.cols === 0 || currentInfo.rows === 0) {
      const newCols = Math.floor(currentImg.width / currentInfo.tileWidth);
      const newRows = Math.floor(currentImg.height / currentInfo.tileHeight);
      appState.addTileset({
        ...currentInfo,
        cols: newCols,
        rows: newRows,
      });
      currentInfo = appState.getTileset(currentTilesetId) ?? currentInfo;
    }

    sheetInfo.textContent =
      `${currentImg.width}x${currentImg.height}px · ` +
      `${currentInfo.cols}x${currentInfo.rows} tiles · ` +
      `${currentInfo.tileWidth}x${currentInfo.tileHeight}px/tile`;

    clearSelection();
    drawCanvas();
    renderCutList();
    updatePreviews();
    updateSaveState();
  } catch (e) {
    sheetInfo.textContent = `Error: ${e}`;
    currentImg = null;
  }
}

// ─── Canvas rendering ────────────────────────────────────────────

function drawCanvas(): void {
  if (!currentImg || !currentInfo) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }

  const z = currentZoom;
  const tw = currentInfo.tileWidth * z;
  const th = currentInfo.tileHeight * z;
  const w = currentInfo.cols * tw;
  const h = currentInfo.rows * th;

  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Draw tileset
  ctx.drawImage(currentImg, 0, 0, w, h);

  // Draw cut overlays
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    const color = getCutColor(i);
    const isSelected = cut.id === selectedCutId;

    const x = cut.col * tw;
    const y = cut.row * th;
    const totalW = cut.frameWidth * cut.frameCount * tw;
    const totalH = cut.frameHeight * th;

    // Fill the full region
    ctx.fillStyle = color + (isSelected ? "40" : "20");
    ctx.fillRect(x, y, totalW, totalH);

    // Outer border
    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 3 : 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, totalW - 1, totalH - 1);

    // Frame division lines (for sequences with frameCount > 1)
    if (cut.frameCount > 1) {
      ctx.strokeStyle = color + "80";
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      for (let f = 1; f < cut.frameCount; f++) {
        const fx = x + f * cut.frameWidth * tw;
        ctx.beginPath();
        ctx.moveTo(fx + 0.5, y);
        ctx.lineTo(fx + 0.5, y + totalH);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    // Label
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(10, z * 3)}px monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const label = cut.name || cut.tags.join(", ") || `cut ${i + 1}`;
    ctx.fillText(label, x + 3, y + 2);
  }

  // Grid
  if (showGrid) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
    ctx.lineWidth = 1;
    for (let c = 0; c <= currentInfo.cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * tw + 0.5, 0);
      ctx.lineTo(c * tw + 0.5, h);
      ctx.stroke();
    }
    for (let r = 0; r <= currentInfo.rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * th + 0.5);
      ctx.lineTo(w, r * th + 0.5);
      ctx.stroke();
    }
  }
}

// ─── Drag interaction ────────────────────────────────────────────

function getGridPos(e: MouseEvent): { col: number; row: number } | null {
  if (!currentInfo) return null;
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const z = currentZoom;
  const tw = currentInfo.tileWidth * z;
  const th = currentInfo.tileHeight * z;
  const col = Math.floor(x / tw);
  const row = Math.floor(y / th);
  if (col < 0 || col >= currentInfo.cols || row < 0 || row >= currentInfo.rows) return null;
  return { col, row };
}

canvas.addEventListener("mousedown", (e) => {
  if (e.button !== 0) return;
  if (drag.mode === "locked") return; // Don't start a new drag while in locked mode
  e.preventDefault();
  const pos = getGridPos(e);
  if (!pos) return;

  // Dismiss any pending selection
  if (pendingSelection) clearSelection();

  drag.mode = "dragging";
  drag.anchorCol = pos.col;
  drag.anchorRow = pos.row;
  drag.currentCol = pos.col;
  drag.currentRow = pos.row;
  drag.frameRect = null;
  drag.frameCount = 1;
  updateDragOverlay();
});

canvas.addEventListener("mousemove", (e) => {
  const pos = getGridPos(e);
  if (!pos) return;

  if (drag.mode === "dragging") {
    drag.currentCol = pos.col;
    drag.currentRow = pos.row;
    updateDragOverlay();
  } else if (drag.mode === "locked") {
    // In locked mode, mouse movement extends the sequence
    drag.frameCount = computeSequenceFrameCount(pos.col);
    updateDragOverlay();
  }
});

window.addEventListener("mouseup", () => {
  if (drag.mode === "dragging") {
    // If Shift is not held, finalize as static rectangle
    // (If Shift IS held, the keydown handler will transition to locked)
    const rect = getDragRect();
    resetDrag();

    if (rect.w < 1 || rect.h < 1) return;

    pendingSelection = {
      col: rect.col,
      row: rect.row,
      frameWidth: rect.w,
      frameHeight: rect.h,
      frameCount: 1,
    };
    showPendingOverlay(pendingSelection);
    showAssignForm();
  }
  // In "locked" mode, mouseup does nothing — we wait for Shift release
});

// Shift key handling: transitions between dragging↔locked and idle↔locked
window.addEventListener("keydown", (e) => {
  if (e.key !== "Shift") return;

  if (drag.mode === "dragging") {
    // Lock the current rectangle as the frame template
    const rect = getDragRect();
    drag.frameRect = rect;
    drag.frameCount = 1;
    drag.mode = "locked";
    updateDragOverlay();
  }
  // If idle with no pending work, Shift does nothing.
  // If already locked, Shift keydown is a no-op (already locked).
});

window.addEventListener("keyup", (e) => {
  if (e.key !== "Shift") return;

  if (drag.mode === "locked" && drag.frameRect) {
    // Finalize the sequence
    const fr = drag.frameRect;
    const frameCount = drag.frameCount;
    resetDrag();

    pendingSelection = {
      col: fr.col,
      row: fr.row,
      frameWidth: fr.w,
      frameHeight: fr.h,
      frameCount,
    };
    showPendingOverlay(pendingSelection);
    showAssignForm();
  }
});

function updateDragOverlay(): void {
  if (!currentInfo) {
    dragOverlay.style.display = "none";
    seqOverlay.style.display = "none";
    return;
  }

  const z = currentZoom;
  const tw = currentInfo.tileWidth * z;
  const th = currentInfo.tileHeight * z;

  if (drag.mode === "dragging") {
    const rect = getDragRect();
    dragOverlay.style.display = "block";
    dragOverlay.style.left = `${rect.col * tw}px`;
    dragOverlay.style.top = `${rect.row * th}px`;
    dragOverlay.style.width = `${rect.w * tw}px`;
    dragOverlay.style.height = `${rect.h * th}px`;
    seqOverlay.style.display = "none";
  } else if (drag.mode === "locked" && drag.frameRect) {
    const fr = drag.frameRect;
    // Base rectangle: solid accent overlay
    dragOverlay.style.display = "block";
    dragOverlay.style.left = `${fr.col * tw}px`;
    dragOverlay.style.top = `${fr.row * th}px`;
    dragOverlay.style.width = `${fr.w * tw}px`;
    dragOverlay.style.height = `${fr.h * th}px`;
    // Sequence extension: dashed, lighter overlay for frames 2+
    if (drag.frameCount > 1) {
      seqOverlay.style.display = "block";
      seqOverlay.style.left = `${(fr.col + fr.w) * tw}px`;
      seqOverlay.style.top = `${fr.row * th}px`;
      seqOverlay.style.width = `${fr.w * (drag.frameCount - 1) * tw}px`;
      seqOverlay.style.height = `${fr.h * th}px`;
    } else {
      seqOverlay.style.display = "none";
    }
  } else {
    dragOverlay.style.display = "none";
    seqOverlay.style.display = "none";
  }
}

// ─── Selection / Assignment ──────────────────────────────────────

function showAssignForm(): void {
  if (!pendingSelection) return;
  const sel = pendingSelection;

  assignForm.style.display = "block";
  assignHint.style.display = "none";

  if (sel.frameCount === 1) {
    assignInfoDiv.textContent =
      `Static ${sel.frameWidth}×${sel.frameHeight} at (${sel.col}, ${sel.row})`;
  } else {
    assignInfoDiv.textContent =
      `${sel.frameCount} frames of ${sel.frameWidth}×${sel.frameHeight} at (${sel.col}, ${sel.row})`;
  }

  // Button text changes depending on whether we're editing or adding
  assignBtn.textContent = editingResourceId ? "Update" : "Add Cut";

  // Auto-suggest name from tileset label (only for new cuts)
  if (!assignNameInput.value && !editingResourceId) {
    const tsLabel = currentInfo?.label ?? currentTilesetId;
    const shortLabel = tsLabel.replace(/[^a-zA-Z0-9]/g, "_").toLowerCase().slice(0, 20);
    assignNameInput.value = `${shortLabel}_r${sel.row}_c${sel.col}`;
  }

  showPendingPreview(sel);
}

function clearSelection(): void {
  pendingSelection = null;
  selectedCutId = null;
  editingResourceId = null;
  assignForm.style.display = "none";
  assignHint.style.display = "block";
  assignBtn.textContent = "Add Cut";
  resetDrag();
  hidePendingOverlay();
  hidePendingPreview();
  assignNameInput.value = "";
  assignTagsInput.value = "";
  renderResourceList();
}

function addCut(): void {
  if (!pendingSelection) return;

  const name = assignNameInput.value.trim();
  const cutTags = parseTags(assignTagsInput.value);
  const groupTags = [...lastSharedTags];

  if (!name) {
    setStatus("Enter a name for the cut.");
    return;
  }

  // Merge group tags with per-cut tags (avoid duplicates)
  const tags = [...groupTags];
  for (const t of cutTags) {
    if (!tags.includes(t)) tags.push(t);
  }

  // If editing an existing resource, update it in place
  if (editingResourceId && currentTilesetId) {
    const frames: ResourceFrame[] = [];
    if (pendingSelection.frameCount === 1) {
      frames.push({
        tilesetId: currentTilesetId,
        srcCol: pendingSelection.col,
        srcRow: pendingSelection.row,
        w: pendingSelection.frameWidth,
        h: pendingSelection.frameHeight,
      });
    } else {
      for (let f = 0; f < pendingSelection.frameCount; f++) {
        frames.push({
          tilesetId: currentTilesetId,
          srcCol: pendingSelection.col + f * pendingSelection.frameWidth,
          srcRow: pendingSelection.row,
          w: pendingSelection.frameWidth,
          h: pendingSelection.frameHeight,
        });
      }
    }

    appState.addResource({
      id: editingResourceId,
      name,
      tags,
      frames,
    });

    clearSelection();
    drawCanvas();
    renderResourceList();
    syncGroupTagFromResources();
    setStatus(`Updated resource "${name}"`);
    return;
  }

  // Otherwise, add as a new cut entry
  cuts.push({
    id: newEntryId(),
    name,
    tags,
    col: pendingSelection.col,
    row: pendingSelection.row,
    frameWidth: pendingSelection.frameWidth,
    frameHeight: pendingSelection.frameHeight,
    frameCount: pendingSelection.frameCount,
  });

  clearSelection();
  drawCanvas();
  renderCutList();
  updatePreviews();
  updateSaveState();
  setStatus(`Added cut "${name}" (${tags.length} tags)`);
}

// ─── Cut list rendering ─────────────────────────────────────────

function renderCutList(): void {
  entryListDiv.innerHTML = "";
  entryCountSpan.textContent = String(cuts.length);

  if (cuts.length === 0) {
    const hint = document.createElement("div");
    hint.style.cssText = "color: var(--text-dim); font-size: 11px; padding: 4px 0;";
    hint.textContent = "No cuts yet. Drag on the tileset to select a region.";
    entryListDiv.appendChild(hint);
    return;
  }

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    const item = document.createElement("div");
    item.className = "cut-entry-item" + (cut.id === selectedCutId ? " selected" : "");

    // Mini thumbnail — show up to 4 frames side-by-side
    const thumb = document.createElement("canvas");
    const thumbFrames = Math.min(4, cut.frameCount);
    if (currentInfo && currentImg) {
      const tw = currentInfo.tileWidth;
      const th = currentInfo.tileHeight;
      const fw = cut.frameWidth * tw; // pixel width of one frame
      const fh = cut.frameHeight * th; // pixel height of one frame
      // Scale to fit a max height of 32px
      const maxThumbH = 32;
      const thumbScale = fh > maxThumbH ? maxThumbH / fh : 1;
      thumb.width = Math.round(thumbFrames * fw * thumbScale);
      thumb.height = Math.round(fh * thumbScale);
      thumb.style.width = `${thumb.width}px`;
      thumb.style.height = `${thumb.height}px`;
      const tctx = thumb.getContext("2d")!;
      tctx.imageSmoothingEnabled = false;
      for (let f = 0; f < thumbFrames; f++) {
        const dx = Math.round(f * fw * thumbScale);
        const dw = Math.round(fw * thumbScale);
        const dh = Math.round(fh * thumbScale);
        tctx.drawImage(
          currentImg,
          (cut.col + f * cut.frameWidth) * tw, cut.row * th, fw, fh,
          dx, 0, dw, dh,
        );
      }
    }

    const info = document.createElement("div");
    info.className = "info";
    const tagsStr = cut.tags.length > 0 ? cut.tags.join(", ") : "(no tags)";
    const sizeStr = cut.frameCount === 1
      ? `static ${cut.frameWidth}×${cut.frameHeight}`
      : `${cut.frameCount}f of ${cut.frameWidth}×${cut.frameHeight}`;
    info.innerHTML = `
      <div class="name" style="color: ${getCutColor(i)}">${cut.name}</div>
      <div class="meta">(${cut.col},${cut.row}) ${sizeStr}</div>
      <div class="tags">${tagsStr}</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Remove cut";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      cuts = cuts.filter((c) => c.id !== cut.id);
      if (selectedCutId === cut.id) selectedCutId = null;
      drawCanvas();
      renderCutList();
      updatePreviews();
      updateSaveState();
    });

    item.addEventListener("click", (e) => {
      const tag = (e.target as HTMLElement).tagName;
      if (tag === "BUTTON") return;
      selectedCutId = selectedCutId === cut.id ? null : cut.id;
      drawCanvas();
      renderCutList();
    });

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(delBtn);
    entryListDiv.appendChild(item);
  }
}

// ─── Animation preview ──────────────────────────────────────────

function updatePreviews(): void {
  if (animTimer !== null) {
    clearInterval(animTimer);
    animTimer = null;
  }
  animPreviews = [];
  previewArea.innerHTML = "";

  if (cuts.length === 0 || !currentImg || !currentInfo) {
    previewArea.innerHTML = '<div style="color: var(--text-dim); font-size: 11px;">Add cuts to preview.</div>';
    return;
  }

  const previewScale = 2;
  const fps = parseInt(previewSpeedRange.value);
  const tw = currentInfo.tileWidth;
  const th = currentInfo.tileHeight;

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i];
    if (cut.frameCount <= 1) continue; // Skip static cuts

    const fw = cut.frameWidth * tw; // pixel width of one frame
    const fh = cut.frameHeight * th; // pixel height of one frame

    const box = document.createElement("div");
    box.className = "cut-preview-box";

    const cvs = document.createElement("canvas");
    cvs.width = fw * previewScale;
    cvs.height = fh * previewScale;
    cvs.style.width = `${cvs.width}px`;
    cvs.style.height = `${cvs.height}px`;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = cut.name;
    label.style.color = getCutColor(i);

    box.appendChild(cvs);
    box.appendChild(label);
    previewArea.appendChild(box);

    const ctx = cvs.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    const frames: { sx: number; sy: number; sw: number; sh: number }[] = [];
    for (let f = 0; f < cut.frameCount; f++) {
      frames.push({
        sx: (cut.col + f * cut.frameWidth) * tw,
        sy: cut.row * th,
        sw: fw,
        sh: fh,
      });
    }

    animPreviews.push({ canvas: cvs, ctx, frames, currentFrame: 0 });
  }

  if (animPreviews.length === 0) {
    previewArea.innerHTML = '<div style="color: var(--text-dim); font-size: 11px;">No sequences to preview (only static cuts).</div>';
    return;
  }

  const tick = () => {
    for (const preview of animPreviews) {
      if (preview.frames.length === 0) continue;
      const frame = preview.frames[preview.currentFrame];
      preview.ctx.clearRect(0, 0, preview.canvas.width, preview.canvas.height);
      preview.ctx.drawImage(
        currentImg!,
        frame.sx, frame.sy, frame.sw, frame.sh,
        0, 0, preview.canvas.width, preview.canvas.height,
      );
      preview.currentFrame = (preview.currentFrame + 1) % preview.frames.length;
    }
  };

  tick();
  animTimer = window.setInterval(tick, 1000 / fps);
}

// ─── Save state ─────────────────────────────────────────────────

function updateSaveState(): void {
  if (cuts.length === 0) {
    saveStatusDiv.textContent = "No cuts to save.";
    saveStatusDiv.style.color = "var(--text-dim)";
    saveResourcesBtn.disabled = true;
    saveMaskBtn.disabled = true;
    return;
  }

  saveStatusDiv.textContent = `${cuts.length} cut(s) ready to save.`;
  saveStatusDiv.style.color = "var(--green)";
  saveResourcesBtn.disabled = false;
  saveMaskBtn.disabled = false;
}

// ─── Save Resources ─────────────────────────────────────────────

function saveResources(): void {
  if (cuts.length === 0 || !currentTilesetId) return;

  const groupTags = [...lastSharedTags];
  let saved = 0;
  for (const cut of cuts) {
    const frames: ResourceFrame[] = [];

    if (cut.frameCount === 1) {
      frames.push({
        tilesetId: currentTilesetId,
        srcCol: cut.col,
        srcRow: cut.row,
        w: cut.frameWidth,
        h: cut.frameHeight,
      });
    } else {
      for (let f = 0; f < cut.frameCount; f++) {
        frames.push({
          tilesetId: currentTilesetId,
          srcCol: cut.col + f * cut.frameWidth,
          srcRow: cut.row,
          w: cut.frameWidth,
          h: cut.frameHeight,
        });
      }
    }

    // Merge group tags with per-cut tags (avoid duplicates)
    const resTags = [...groupTags];
    for (const t of cut.tags) {
      if (!resTags.includes(t)) resTags.push(t);
    }

    const resource: Resource = {
      id: generateId(),
      name: cut.name,
      tags: resTags,
      frames,
    };

    appState.addResource(resource);
    saved++;
  }

  cuts = [];
  clearSelection();
  drawCanvas();
  renderCutList();
  updatePreviews();
  updateSaveState();
  renderResourceList();
  syncGroupTagFromResources();
  setStatus(`Saved ${saved} resource(s)`);
}

// ─── Save as Mask ───────────────────────────────────────────────

function saveMask(): void {
  if (cuts.length === 0 || !currentInfo) return;

  const name = maskNameInput.value.trim();
  if (!name) {
    setStatus("Enter a mask name.");
    maskNameInput.focus();
    return;
  }

  // Strip shared/group tags — masks should only store per-cut semantic tags
  const sharedTags = new Set(lastSharedTags);

  const maskCuts: MaskCut[] = cuts.map((cut) => ({
    tags: cut.tags.filter((t) => !sharedTags.has(t)),
    row: cut.row,
    startFrame: cut.col,
    frameCount: cut.frameCount,
    frameWidth: cut.frameWidth > 1 ? cut.frameWidth : undefined,
    frameHeight: cut.frameHeight > 1 ? cut.frameHeight : undefined,
  }));

  const mask: Mask = {
    id: generateId(),
    name,
    tileWidth: currentInfo.tileWidth,
    tileHeight: currentInfo.tileHeight,
    cuts: maskCuts,
  };

  appState.addMask(mask);
  renderMaskList();
  setStatus(`Saved mask "${name}" with ${maskCuts.length} cuts`);
}

// ─── Apply Mask ─────────────────────────────────────────────────

function applyMask(maskId: string): void {
  if (!currentTilesetId) return;

  const mask = appState.getMask(maskId);
  if (!mask) return;

  const groupTag = groupTagInput.value.trim().toLowerCase();

  for (const cut of mask.cuts) {
    const fw = cut.frameWidth ?? 1;
    const fh = cut.frameHeight ?? 1;
    const cutTags = [...cut.tags];
    if (groupTag && !cutTags.includes(groupTag)) {
      cutTags.unshift(groupTag);
    }

    const name = groupTag
      ? `${groupTag}_${cut.tags.join("_") || `r${cut.row}_f${cut.startFrame}`}`
      : cut.tags.join("_") || `r${cut.row}_f${cut.startFrame}`;

    cuts.push({
      id: newEntryId(),
      name,
      tags: cutTags,
      col: cut.startFrame,
      row: cut.row,
      frameWidth: fw,
      frameHeight: fh,
      frameCount: cut.frameCount,
    });
  }

  clearSelection();
  drawCanvas();
  renderCutList();
  updatePreviews();
  updateSaveState();
  setStatus(`Applied mask "${mask.name}": ${mask.cuts.length} cuts added`);
}

// ─── Mask list rendering ────────────────────────────────────────

function renderMaskList(): void {
  maskCountSpan.textContent = String(appState.masks.length);
  maskListDiv.innerHTML = "";

  for (const mask of appState.masks) {
    const item = document.createElement("div");
    item.className = "cut-mask-item";

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `
      <div class="name">${mask.name}</div>
      <div class="meta">${mask.cuts.length} cuts · ${mask.tileWidth}×${mask.tileHeight}px</div>
    `;

    const applyBtn = document.createElement("button");
    applyBtn.className = "btn-sm";
    applyBtn.textContent = "Apply";
    applyBtn.title = "Apply this mask to the current tileset";
    applyBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      applyMask(mask.id);
    });

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Delete mask";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      appState.removeMask(mask.id);
      renderMaskList();
      setStatus(`Deleted mask "${mask.name}"`);
    });

    item.appendChild(info);
    item.appendChild(applyBtn);
    item.appendChild(delBtn);
    maskListDiv.appendChild(item);
  }
}

// ─── Saved resource list rendering ──────────────────────────────

/** ID of resource currently being edited (loaded back into assign form) */
let editingResourceId: string | null = null;

function renderResourceList(): void {
  const tilesetResources = getTilesetResources();
  resourceCountSpan.textContent = String(tilesetResources.length);
  clearResourcesBtn.style.display = tilesetResources.length > 0 ? "" : "none";
  resourceListDiv.innerHTML = "";

  const filterText = resourceFilterInput.value.trim().toLowerCase();
  const filterTags = filterText ? filterText.split(",").map((t) => t.trim()).filter(Boolean) : [];

  const filtered = filterTags.length > 0
    ? tilesetResources.filter((r) =>
        filterTags.some((ft) =>
          r.tags.some((t) => t.includes(ft)) || r.name.toLowerCase().includes(ft)
        )
      )
    : tilesetResources;

  if (filtered.length === 0) {
    const hint = document.createElement("div");
    hint.style.cssText = "color: var(--text-dim); font-size: 11px; padding: 4px 0;";
    hint.textContent = tilesetResources.length === 0
      ? "No resources for this tileset."
      : "No resources match the filter.";
    resourceListDiv.appendChild(hint);
    return;
  }

  for (const res of filtered) {
    const item = document.createElement("div");
    item.className = "cut-saved-item" + (res.id === editingResourceId ? " selected" : "");
    item.style.cursor = "pointer";

    const info = document.createElement("div");
    info.className = "info";
    const framesStr = res.frames.length === 1 ? "static" : `${res.frames.length} frames`;
    info.innerHTML = `
      <div class="name">${res.name}</div>
      <div class="meta">${framesStr}</div>
      <div class="tags">${res.tags.join(", ") || "(no tags)"}</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Delete resource";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      appState.removeResource(res.id);
      if (editingResourceId === res.id) {
        editingResourceId = null;
        clearSelection();
      }
      renderResourceList();
      syncGroupTagFromResources();
      setStatus(`Deleted resource "${res.name}"`);
    });

    item.addEventListener("click", (e) => {
      if ((e.target as HTMLElement).tagName === "BUTTON") return;
      editResource(res.id);
    });

    item.appendChild(info);
    item.appendChild(delBtn);
    resourceListDiv.appendChild(item);
  }
}

/** Load a saved resource back into the assign form for editing */
function editResource(resourceId: string): void {
  const res = appState.getResource(resourceId);
  if (!res || !currentInfo) return;

  // If clicking the same resource again, deselect it
  if (editingResourceId === resourceId) {
    editingResourceId = null;
    clearSelection();
    renderResourceList();
    return;
  }

  editingResourceId = resourceId;

  // Derive the selection geometry from the resource frames
  const f0 = res.frames[0];
  const sel: PendingSelection = {
    col: f0.srcCol,
    row: f0.srcRow,
    frameWidth: f0.w,
    frameHeight: f0.h,
    frameCount: res.frames.length,
  };

  pendingSelection = sel;

  // Populate the assign form
  assignForm.style.display = "block";
  assignHint.style.display = "none";
  assignNameInput.value = res.name;

  // Show tags, but exclude the shared tileset tags (those are in the group tag field)
  const sharedTags = getSharedTilesetTags();
  const perResourceTags = res.tags.filter((t) => !sharedTags.includes(t));
  assignTagsInput.value = perResourceTags.join(", ");

  if (sel.frameCount === 1) {
    assignInfoDiv.textContent =
      `Static ${sel.frameWidth}×${sel.frameHeight} at (${sel.col}, ${sel.row})`;
  } else {
    assignInfoDiv.textContent =
      `${sel.frameCount} frames of ${sel.frameWidth}×${sel.frameHeight} at (${sel.col}, ${sel.row})`;
  }

  showPendingOverlay(sel);
  showPendingPreview(sel);
  drawCanvas();
  renderResourceList();
}

/** Remove all resources belonging to the current tileset */
function clearTilesetResources(): void {
  const resources = getTilesetResources();
  if (resources.length === 0) return;

  for (const res of resources) {
    appState.removeResource(res.id);
  }

  if (editingResourceId) {
    editingResourceId = null;
    clearSelection();
  }

  renderResourceList();
  syncGroupTagFromResources();
  setStatus(`Removed ${resources.length} resource(s) from this tileset`);
}

// ─── Event listeners ────────────────────────────────────────────

// FilterableList instance — created during init
let cutTilesetList: ReturnType<typeof populateTilesetList>;

zoomSelect.addEventListener("change", () => {
  currentZoom = parseInt(zoomSelect.value);
  drawCanvas();
});

gridToggle.addEventListener("change", () => {
  showGrid = gridToggle.checked;
  drawCanvas();
});

previewSpeedRange.addEventListener("input", () => {
  const fps = parseInt(previewSpeedRange.value);
  previewSpeedLabel.textContent = `${fps} fps`;
  updatePreviews();
});

assignBtn.addEventListener("click", addCut);
assignCancelBtn.addEventListener("click", clearSelection);

saveResourcesBtn.addEventListener("click", saveResources);
saveMaskBtn.addEventListener("click", saveMask);

// Add shared tag on Enter
groupTagInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const tag = groupTagInput.value.trim().toLowerCase();
    if (tag) addSharedTag(tag);
    groupTagInput.value = "";
  }
});

resourceFilterInput.addEventListener("input", renderResourceList);
clearResourcesBtn.addEventListener("click", clearTilesetResources);

appState.subscribe(() => {
  renderResourceList();
  renderMaskList();
});

// ─── Init ────────────────────────────────────────────────────────

export function initCutterTab(): void {
  cutTilesetList = populateTilesetList(tilesetSelectContainer);

  cutTilesetList.onSelect((id) => {
    currentTilesetId = id;
    // Clear working cuts when switching tilesets
    cuts = [];
    selectedCutId = null;
    editingResourceId = null;
    clearSelection();
    loadTileset();
    renderResourceList();
    syncGroupTagFromResources();
    renderCutList();
    updatePreviews();
    updateSaveState();
  });

  currentTilesetId = cutTilesetList.getValue() || "";
  loadTileset();
  renderResourceList();
  syncGroupTagFromResources();
  renderMaskList();

  // Wire tag autocomplete on both inputs
  wireAutocomplete(groupTagInput, groupTagAc);
  wireAutocomplete(assignTagsInput, assignTagsAc);
}
