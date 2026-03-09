/**
 * Tab 3: Character Definer
 *
 * Unified sprite sheet view: both idle and walk sheets displayed stacked.
 * Drag-select a region on either sheet to define a frame range, then
 * assign it to a family (idle/walk/sit_office/sit_couch/custom) + direction.
 *
 * Supports multiple variants per family+direction (e.g. idle-down #0 = breathing,
 * idle-down #1 = sipping coffee). The game runtime can cycle through variants.
 *
 * Sprite sheet format (LimeZu):
 *   - Frame size: 16×32 pixels (configurable)
 *   - Idle: 384×32 = 24 frames, 1 row
 *   - Walk: 384×224 = 24 columns × 7 rows
 */

import {
  type CharacterDefinition,
  type CharacterDirection,
  type CharacterAnimation,
  type CharacterSheet,
  type AnimationStrip,
  type VariantSequence,
  type VariantSequenceStep,
  CHARACTER_DIRECTIONS,
  BUILTIN_FAMILIES,
  charTilesetId,
  makeCharTileset,
  generateId,
} from "@offisims/shared";
import { appState } from "./state.js";
import { setStatus } from "./main.js";
import { loadTilesetImage, getCachedTilesetImage } from "./tileset-picker.js";

// ─── DOM elements ─────────────────────────────────────────────────

const sheetSelect = document.getElementById("char-sheet-select") as HTMLSelectElement;
const sheetInfo = document.getElementById("char-sheet-info") as HTMLDivElement;

const frameWInput = document.getElementById("char-frame-w") as HTMLInputElement;
const frameHInput = document.getElementById("char-frame-h") as HTMLInputElement;

const zoomSelect = document.getElementById("char-zoom") as HTMLSelectElement;
const gridToggle = document.getElementById("char-grid-toggle") as HTMLInputElement;
const hintDiv = document.getElementById("char-hint") as HTMLDivElement;

const idleCanvas = document.getElementById("char-idle-canvas") as HTMLCanvasElement;
const walkCanvas = document.getElementById("char-walk-canvas") as HTMLCanvasElement;
const idleDragOverlay = document.getElementById("char-idle-drag") as HTMLDivElement;
const walkDragOverlay = document.getElementById("char-walk-drag") as HTMLDivElement;

const assignForm = document.getElementById("char-assign-form") as HTMLDivElement;
const assignHint = document.getElementById("char-assign-hint") as HTMLDivElement;
const assignFamilySelect = document.getElementById("char-assign-family") as HTMLSelectElement;
const assignFamilyCustom = document.getElementById("char-assign-family-custom") as HTMLInputElement;
const assignDirSelect = document.getElementById("char-assign-dir") as HTMLSelectElement;
const assignInfoSpan = document.getElementById("char-assign-info") as HTMLSpanElement;
const assignBtn = document.getElementById("char-assign-btn") as HTMLButtonElement;
const assignCancelBtn = document.getElementById("char-assign-cancel-btn") as HTMLButtonElement;

const animListDiv = document.getElementById("char-anim-list") as HTMLDivElement;
const animSpeedRange = document.getElementById("char-anim-speed") as HTMLInputElement;
const animSpeedLabel = document.getElementById("char-anim-speed-label") as HTMLSpanElement;
const previewArea = document.getElementById("char-preview-area") as HTMLDivElement;

const charNameInput = document.getElementById("char-name") as HTMLInputElement;
const saveStatusDiv = document.getElementById("char-save-status") as HTMLDivElement;
const saveBtn = document.getElementById("char-save-btn") as HTMLButtonElement;
const savedCountSpan = document.getElementById("char-saved-count") as HTMLSpanElement;
const savedListDiv = document.getElementById("char-saved-list") as HTMLDivElement;

// Sequence builder DOM elements
const seqFamilySelect = document.getElementById("char-seq-family") as HTMLSelectElement;
const seqDirSelect = document.getElementById("char-seq-dir") as HTMLSelectElement;
const seqNameInput = document.getElementById("char-seq-name") as HTMLInputElement;
const seqAddBtn = document.getElementById("char-seq-add-btn") as HTMLButtonElement;
const seqListDiv = document.getElementById("char-seq-list") as HTMLDivElement;

// ─── State ────────────────────────────────────────────────────────

let currentSheetId = "adam";
let currentZoom = 4;
let showGrid = true;

/** Mutable frame dimensions (configurable via UI) */
let frameW = 16;
let frameH = 32;

/** Grid dimensions for each sheet */
let idleCols = 0;
let idleRows = 0;
let walkCols = 0;
let walkRows = 0;

/** Current drag-selection state */
interface DragState {
  sheet: CharacterSheet;
  startCol: number;
  startRow: number;
  endCol: number;
  endRow: number;
  active: boolean;
}

let drag: DragState = { sheet: "idle", startCol: 0, startRow: 0, endCol: 0, endRow: 0, active: false };

/** Pending selection (after drag completes, before assignment) */
interface PendingSelection {
  sheet: CharacterSheet;
  row: number;
  startFrame: number;
  frameCount: number;
}

let pendingSelection: PendingSelection | null = null;

/**
 * Animation entries for the current character (what we're building).
 * Each entry mirrors CharacterAnimation but with an internal id for UI tracking.
 */
interface AnimEntry {
  id: string;
  family: string;
  direction: CharacterDirection;
  variant: number;
  strip: AnimationStrip;
}

/** Per-character animation state (keyed by sheetId) */
interface CharAnimState {
  entries: AnimEntry[];
  familySpeeds: Record<string, number>;
  variantSequences: VariantSequence[];
}

const animStates: Map<string, CharAnimState> = new Map();

/** Currently selected animation entry (for highlighting) */
let selectedAnimId: string | null = null;

/** Animation previews */
interface AnimPreview {
  label: string;
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  frames: { sx: number; sy: number; tilesetId: string }[];
  currentFrame: number;
}

let animPreviews: AnimPreview[] = [];
let animTimer: number | null = null;

// ─── Helpers ──────────────────────────────────────────────────────

function getAnimState(sheetId: string): CharAnimState {
  let state = animStates.get(sheetId);
  if (!state) {
    state = { entries: [], familySpeeds: { idle: 4, walk: 8 }, variantSequences: [] };
    animStates.set(sheetId, state);
  }
  return state;
}

function newEntryId(): string {
  return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function getFamilyColor(family: string): string {
  switch (family) {
    case "idle": return "#4ade80";
    case "walk": return "#60a5fa";
    case "sit_office": return "#f472b6";
    case "sit_couch": return "#c084fc";
    default: return "#fbbf24";
  }
}

function getDirectionLabel(dir: CharacterDirection): string {
  return dir.charAt(0).toUpperCase() + dir.slice(1);
}

function getSheetImage(sheet: CharacterSheet): HTMLImageElement | null {
  return getCachedTilesetImage(charTilesetId(currentSheetId, sheet)) ?? null;
}

function getSheetCols(sheet: CharacterSheet): number {
  return sheet === "idle" ? idleCols : walkCols;
}

function getSheetRows(sheet: CharacterSheet): number {
  return sheet === "idle" ? idleRows : walkRows;
}

/** Get the image for a strip's tileset (via the tileset cache) */
function getStripImage(strip: AnimationStrip): HTMLImageElement | null {
  return getCachedTilesetImage(strip.tilesetId) ?? null;
}

/** Derive the CharacterSheet kind from a tileset ID (for UI routing) */
function sheetFromTilesetId(tilesetId: string): CharacterSheet {
  return tilesetId.endsWith("_walk") ? "walk" : "idle";
}

/** Compute next variant number for a given family+direction */
function nextVariant(entries: AnimEntry[], family: string, dir: CharacterDirection): number {
  const existing = entries.filter((e) => e.family === family && e.direction === dir);
  if (existing.length === 0) return 0;
  return Math.max(...existing.map((e) => e.variant)) + 1;
}

// ─── Sheet loading ────────────────────────────────────────────────

async function loadSheets(): Promise<void> {
  sheetInfo.textContent = "Loading...";

  try {
    // Build tileset IDs for this character's sheets
    const idleId = charTilesetId(currentSheetId, "idle");
    const walkId = charTilesetId(currentSheetId, "walk");

    // Ensure tileset definitions exist (with placeholder cols/rows — updated after load)
    if (!appState.getTileset(idleId)) {
      appState.addTileset(makeCharTileset(currentSheetId, "idle", frameW, frameH, 0, 0));
    }
    if (!appState.getTileset(walkId)) {
      appState.addTileset(makeCharTileset(currentSheetId, "walk", frameW, frameH, 0, 0));
    }

    const [idle, walk] = await Promise.all([
      loadTilesetImage(idleId),
      loadTilesetImage(walkId),
    ]);

    idleCols = Math.floor(idle.width / frameW);
    idleRows = Math.floor(idle.height / frameH);
    walkCols = Math.floor(walk.width / frameW);
    walkRows = Math.floor(walk.height / frameH);

    // Update tileset definitions with actual image dimensions
    appState.addTileset(makeCharTileset(currentSheetId, "idle", frameW, frameH, idle.width, idle.height));
    appState.addTileset(makeCharTileset(currentSheetId, "walk", frameW, frameH, walk.width, walk.height));

    sheetInfo.textContent =
      `Idle: ${idle.width}x${idle.height} (${idleCols}x${idleRows}) · ` +
      `Walk: ${walk.width}x${walk.height} (${walkCols}x${walkRows}) · ` +
      `Frame: ${frameW}x${frameH}`;

    clearSelection();
    drawSheets();
    renderAnimList();
    updatePreviews();
    updateSaveState();
  } catch (e) {
    sheetInfo.textContent = `Error: ${e}`;
  }
}

// ─── Sheet canvas rendering ──────────────────────────────────────

function drawSheets(): void {
  drawSheet("idle");
  drawSheet("walk");
}

function drawSheet(sheet: CharacterSheet): void {
  const img = getSheetImage(sheet);
  const canvas = sheet === "idle" ? idleCanvas : walkCanvas;
  if (!img) {
    canvas.width = 0;
    canvas.height = 0;
    return;
  }

  const z = currentZoom;
  const w = img.width * z;
  const h = img.height * z;
  const cols = getSheetCols(sheet);
  const rows = getSheetRows(sheet);

  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Draw sprite sheet
  ctx.drawImage(img, 0, 0, w, h);

  // Draw assigned animation overlays
  const state = getAnimState(currentSheetId);
  for (const entry of state.entries) {
    if (sheetFromTilesetId(entry.strip.tilesetId) !== sheet) continue;

    const color = getFamilyColor(entry.family);
    const isSelected = entry.id === selectedAnimId;

    const x = entry.strip.startFrame * frameW * z;
    const y = entry.strip.row * frameH * z;
    const fw = entry.strip.frameCount * frameW * z;
    const fh = frameH * z;

    ctx.fillStyle = color + (isSelected ? "40" : "20");
    ctx.fillRect(x, y, fw, fh);

    ctx.strokeStyle = color;
    ctx.lineWidth = isSelected ? 3 : 1.5;
    ctx.strokeRect(x + 0.5, y + 0.5, fw - 1, fh - 1);

    // Label
    ctx.fillStyle = color;
    ctx.font = `bold ${Math.max(10, z * 3)}px monospace`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    const varLabel = entry.variant > 0 ? ` #${entry.variant}` : "";
    ctx.fillText(`${entry.family} ${entry.direction}${varLabel}`, x + 3, y + 2);
  }

  // Grid
  if (showGrid) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.15)";
    ctx.lineWidth = 1;
    for (let c = 0; c <= cols; c++) {
      ctx.beginPath();
      ctx.moveTo(c * frameW * z + 0.5, 0);
      ctx.lineTo(c * frameW * z + 0.5, h);
      ctx.stroke();
    }
    for (let r = 0; r <= rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * frameH * z + 0.5);
      ctx.lineTo(w, r * frameH * z + 0.5);
      ctx.stroke();
    }
    // Thicker row separators
    ctx.strokeStyle = "rgba(255, 255, 255, 0.4)";
    ctx.lineWidth = 2;
    for (let r = 0; r <= rows; r++) {
      ctx.beginPath();
      ctx.moveTo(0, r * frameH * z + 0.5);
      ctx.lineTo(w, r * frameH * z + 0.5);
      ctx.stroke();
    }
  }
}

// ─── Drag selection on canvases ──────────────────────────────────

function setupCanvasDrag(
  canvas: HTMLCanvasElement,
  overlay: HTMLDivElement,
  sheet: CharacterSheet,
): void {
  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = getGridPos(e, canvas, sheet);
    if (!pos) return;

    drag = {
      sheet,
      startCol: pos.col,
      startRow: pos.row,
      endCol: pos.col,
      endRow: pos.row,
      active: true,
    };
    updateDragOverlay(overlay, sheet);
  });

  canvas.addEventListener("mousemove", (e) => {
    if (!drag.active || drag.sheet !== sheet) return;
    const pos = getGridPos(e, canvas, sheet);
    if (!pos) return;
    drag.endCol = pos.col;
    drag.endRow = pos.row;
    updateDragOverlay(overlay, sheet);
  });

  // mouseup is global to handle drag that ends outside canvas
}

function getGridPos(
  e: MouseEvent,
  canvas: HTMLCanvasElement,
  sheet: CharacterSheet,
): { col: number; row: number } | null {
  const rect = canvas.getBoundingClientRect();
  const x = e.clientX - rect.left;
  const y = e.clientY - rect.top;
  const z = currentZoom;
  const cols = getSheetCols(sheet);
  const rows = getSheetRows(sheet);
  const col = Math.floor(x / (frameW * z));
  const row = Math.floor(y / (frameH * z));
  if (col < 0 || col >= cols || row < 0 || row >= rows) return null;
  return { col, row };
}

function updateDragOverlay(overlay: HTMLDivElement, sheet: CharacterSheet): void {
  if (!drag.active || drag.sheet !== sheet) {
    overlay.style.display = "none";
    return;
  }
  const z = currentZoom;
  const minCol = Math.min(drag.startCol, drag.endCol);
  const maxCol = Math.max(drag.startCol, drag.endCol);
  const row = drag.startRow; // Lock to start row (strips are single-row)

  overlay.style.display = "block";
  overlay.style.left = `${minCol * frameW * z}px`;
  overlay.style.top = `${row * frameH * z}px`;
  overlay.style.width = `${(maxCol - minCol + 1) * frameW * z}px`;
  overlay.style.height = `${frameH * z}px`;
}

function handleMouseUp(): void {
  if (!drag.active) return;

  const sheet = drag.sheet;
  const row = drag.startRow; // Single row
  const minCol = Math.min(drag.startCol, drag.endCol);
  const maxCol = Math.max(drag.startCol, drag.endCol);
  const frameCount = maxCol - minCol + 1;

  drag.active = false;

  // Clear both overlays
  idleDragOverlay.style.display = "none";
  walkDragOverlay.style.display = "none";

  if (frameCount < 1) return;

  // Set pending selection and show assignment form
  pendingSelection = { sheet, row, startFrame: minCol, frameCount };
  showAssignForm();
}

window.addEventListener("mouseup", handleMouseUp);

// ─── Selection / Assignment ──────────────────────────────────────

function showAssignForm(): void {
  if (!pendingSelection) return;
  const sel = pendingSelection;

  assignForm.style.display = "block";
  assignHint.style.display = "none";
  assignInfoSpan.textContent =
    `${sel.sheet} sheet, row ${sel.row}, frames ${sel.startFrame}–${sel.startFrame + sel.frameCount - 1} (${sel.frameCount} frames)`;

  // Auto-select family based on sheet
  assignFamilySelect.value = sel.sheet === "idle" ? "idle" : "walk";
  assignFamilyCustom.value = "";
}

function clearSelection(): void {
  pendingSelection = null;
  selectedAnimId = null;
  assignForm.style.display = "none";
  assignHint.style.display = "block";
  idleDragOverlay.style.display = "none";
  walkDragOverlay.style.display = "none";
}

function assignSelection(): void {
  if (!pendingSelection) return;

  const customFamily = assignFamilyCustom.value.trim();
  const family = customFamily || assignFamilySelect.value;
  const direction = assignDirSelect.value as CharacterDirection;

  if (!family) return;

  const state = getAnimState(currentSheetId);
  const variant = nextVariant(state.entries, family, direction);

  state.entries.push({
    id: newEntryId(),
    family,
    direction,
    variant,
    strip: {
      tilesetId: charTilesetId(currentSheetId, pendingSelection.sheet),
      row: pendingSelection.row,
      startFrame: pendingSelection.startFrame,
      frameCount: pendingSelection.frameCount,
    },
  });

  // Ensure family has a default speed
  if (!state.familySpeeds[family]) {
    state.familySpeeds[family] = family === "walk" ? 8 : 4;
  }

  clearSelection();
  drawSheets();
  renderAnimList();
  updatePreviews();
  updateSaveState();
  setStatus(`Assigned ${family} ${direction}${variant > 0 ? ` #${variant}` : ""}`);
}

// ─── Animation list rendering ────────────────────────────────────

function renderAnimList(): void {
  animListDiv.innerHTML = "";
  const state = getAnimState(currentSheetId);

  if (state.entries.length === 0) {
    const hint = document.createElement("div");
    hint.style.cssText = "color: var(--text-dim); font-size: 11px; padding: 4px 0;";
    hint.textContent = "No animations assigned yet. Drag on the sheet to select frames.";
    animListDiv.appendChild(hint);
    return;
  }

  // Group by family
  const families = new Map<string, AnimEntry[]>();
  for (const entry of state.entries) {
    let arr = families.get(entry.family);
    if (!arr) {
      arr = [];
      families.set(entry.family, arr);
    }
    arr.push(entry);
  }

  for (const [family, entries] of families) {
    // Family header with speed input
    const header = document.createElement("div");
    header.className = "char-family-header";

    const nameSpan = document.createElement("span");
    nameSpan.textContent = family;
    header.appendChild(nameSpan);

    const speedDiv = document.createElement("span");
    speedDiv.className = "speed-input";
    speedDiv.textContent = "fps: ";
    const speedInput = document.createElement("input");
    speedInput.type = "number";
    speedInput.min = "1";
    speedInput.max = "30";
    speedInput.value = String(state.familySpeeds[family] || 4);
    speedInput.addEventListener("change", () => {
      const v = Math.max(1, Math.min(30, parseInt(speedInput.value) || 4));
      state.familySpeeds[family] = v;
      speedInput.value = String(v);
      updatePreviews();
    });
    speedDiv.appendChild(speedInput);
    header.appendChild(speedDiv);

    animListDiv.appendChild(header);

    // Sort entries: by direction order then variant
    const dirOrder: Record<string, number> = { down: 0, up: 1, left: 2, right: 3 };
    entries.sort((a, b) => {
      const da = dirOrder[a.direction] ?? 99;
      const db = dirOrder[b.direction] ?? 99;
      if (da !== db) return da - db;
      return a.variant - b.variant;
    });

    for (const entry of entries) {
      const item = document.createElement("div");
      item.className = "char-anim-item" + (entry.id === selectedAnimId ? " selected" : "");

      // Mini thumbnail
      const thumb = document.createElement("canvas");
      const thumbFrames = Math.min(4, entry.strip.frameCount);
      const thumbScale = 2;
      thumb.width = thumbFrames * frameW * thumbScale;
      thumb.height = frameH * thumbScale;
      thumb.style.width = `${thumb.width}px`;
      thumb.style.height = `${thumb.height}px`;
      const img = getStripImage(entry.strip);
      if (img) {
        const tctx = thumb.getContext("2d")!;
        tctx.imageSmoothingEnabled = false;
        for (let f = 0; f < thumbFrames; f++) {
          tctx.drawImage(
            img,
            (entry.strip.startFrame + f) * frameW, entry.strip.row * frameH, frameW, frameH,
            f * frameW * thumbScale, 0, frameW * thumbScale, frameH * thumbScale,
          );
        }
      }

      const info = document.createElement("div");
      info.className = "info";
      const varLabel = entry.variant > 0 ? ` #${entry.variant}` : "";
      info.innerHTML = `
        <div class="name" style="color: ${getFamilyColor(entry.family)}">${entry.direction}${varLabel}</div>
        <div class="meta">${sheetFromTilesetId(entry.strip.tilesetId)} r${entry.strip.row} f${entry.strip.startFrame}–${entry.strip.startFrame + entry.strip.frameCount - 1}</div>
      `;

      const delBtn = document.createElement("button");
      delBtn.className = "delete-btn";
      delBtn.textContent = "\u00d7";
      delBtn.title = "Remove";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        state.entries = state.entries.filter((a) => a.id !== entry.id);
        if (selectedAnimId === entry.id) selectedAnimId = null;
        drawSheets();
        renderAnimList();
        updatePreviews();
        updateSaveState();
      });

      item.addEventListener("click", (e) => {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "BUTTON" || tag === "INPUT") return;
        selectedAnimId = selectedAnimId === entry.id ? null : entry.id;
        drawSheets();
        renderAnimList();
      });

      item.appendChild(thumb);
      item.appendChild(info);
      item.appendChild(delBtn);
      animListDiv.appendChild(item);
    }
  }

  // Also update the sequence builder UI
  updateSeqFamilyDropdown();
  renderSeqList();
}

// ─── Variant Sequence Builder ───────────────────────────────────

/** Populate the family dropdown in the sequence creator with families that have multi-variant directions */
function updateSeqFamilyDropdown(): void {
  const state = getAnimState(currentSheetId);
  seqFamilySelect.innerHTML = "";

  // Find all family+direction combos that have >1 variant
  const familiesWithVariants = new Set<string>();
  const countMap = new Map<string, number>();
  for (const entry of state.entries) {
    const key = `${entry.family}:${entry.direction}`;
    countMap.set(key, (countMap.get(key) || 0) + 1);
  }
  for (const [key, count] of countMap) {
    if (count > 1) {
      familiesWithVariants.add(key.split(":")[0]);
    }
  }

  if (familiesWithVariants.size === 0) {
    const opt = document.createElement("option");
    opt.value = "";
    opt.textContent = "(no multi-variant families)";
    seqFamilySelect.appendChild(opt);
    seqAddBtn.disabled = true;
    return;
  }

  seqAddBtn.disabled = false;
  for (const family of familiesWithVariants) {
    const opt = document.createElement("option");
    opt.value = family;
    opt.textContent = family;
    seqFamilySelect.appendChild(opt);
  }
}

/** Get all variants for a family+direction from current anim state */
function getVariantsForFamilyDir(family: string, dir: CharacterDirection): number[] {
  const state = getAnimState(currentSheetId);
  return state.entries
    .filter((e) => e.family === family && e.direction === dir)
    .map((e) => e.variant)
    .sort((a, b) => a - b);
}

function addNewSequence(): void {
  const family = seqFamilySelect.value;
  const dir = seqDirSelect.value as CharacterDirection;
  let name = seqNameInput.value.trim();

  if (!family) return;

  const variants = getVariantsForFamilyDir(family, dir);
  if (variants.length < 2) {
    setStatus(`${family} ${dir} has only ${variants.length} variant(s) — need at least 2`);
    return;
  }

  if (!name) {
    // Auto-generate a name
    const state = getAnimState(currentSheetId);
    const existing = state.variantSequences.filter((s) => s.family === family && s.direction === dir);
    name = `${family}_${dir}_seq${existing.length + 1}`;
  }

  const state = getAnimState(currentSheetId);

  // Default: each variant plays once
  const steps: VariantSequenceStep[] = variants.map((v) => ({ variant: v, repeats: 1 }));

  state.variantSequences.push({
    name,
    family,
    direction: dir,
    steps,
  });

  seqNameInput.value = "";
  renderSeqList();
  updateSaveState();
  setStatus(`Created sequence "${name}" for ${family} ${dir}`);
}

function renderSeqList(): void {
  seqListDiv.innerHTML = "";
  const state = getAnimState(currentSheetId);

  if (state.variantSequences.length === 0) {
    return;
  }

  for (let si = 0; si < state.variantSequences.length; si++) {
    const seq = state.variantSequences[si];
    const item = document.createElement("div");
    item.className = "char-seq-item";

    // Header
    const header = document.createElement("div");
    header.className = "seq-header";

    const nameSpan = document.createElement("span");
    nameSpan.className = "seq-name";
    nameSpan.textContent = seq.name;
    header.appendChild(nameSpan);

    const metaSpan = document.createElement("span");
    metaSpan.className = "seq-meta";
    metaSpan.textContent = `${seq.family} ${seq.direction}`;
    header.appendChild(metaSpan);

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Remove sequence";
    delBtn.addEventListener("click", () => {
      state.variantSequences.splice(si, 1);
      renderSeqList();
      updateSaveState();
    });
    header.appendChild(delBtn);
    item.appendChild(header);

    // Steps
    for (let sti = 0; sti < seq.steps.length; sti++) {
      const step = seq.steps[sti];
      const stepDiv = document.createElement("div");
      stepDiv.className = "char-seq-step";

      const label = document.createElement("span");
      label.className = "step-label";
      label.textContent = `variant #${step.variant}`;
      stepDiv.appendChild(label);

      const timesLabel = document.createElement("span");
      timesLabel.style.cssText = "font-size: 10px; color: var(--text-dim);";
      timesLabel.textContent = "\u00d7";
      stepDiv.appendChild(timesLabel);

      const repeatsInput = document.createElement("input");
      repeatsInput.type = "number";
      repeatsInput.min = "1";
      repeatsInput.max = "99";
      repeatsInput.value = String(step.repeats);
      repeatsInput.addEventListener("change", () => {
        const v = Math.max(1, Math.min(99, parseInt(repeatsInput.value) || 1));
        step.repeats = v;
        repeatsInput.value = String(v);
        updateSaveState();
      });
      stepDiv.appendChild(repeatsInput);

      const stepDel = document.createElement("button");
      stepDel.className = "delete-btn";
      stepDel.textContent = "\u00d7";
      stepDel.title = "Remove step";
      stepDel.addEventListener("click", () => {
        seq.steps.splice(sti, 1);
        renderSeqList();
        updateSaveState();
      });
      stepDiv.appendChild(stepDel);

      item.appendChild(stepDiv);
    }

    // Add step button
    const addStepBtn = document.createElement("button");
    addStepBtn.className = "char-seq-add-step";
    addStepBtn.textContent = "+ add variant step";
    addStepBtn.addEventListener("click", () => {
      const variants = getVariantsForFamilyDir(seq.family, seq.direction);
      // Find a variant not yet in steps, or just add variant 0
      const usedVariants = new Set(seq.steps.map((s) => s.variant));
      const nextVar = variants.find((v) => !usedVariants.has(v)) ?? variants[0] ?? 0;
      seq.steps.push({ variant: nextVar, repeats: 1 });
      renderSeqList();
      updateSaveState();
    });
    item.appendChild(addStepBtn);

    seqListDiv.appendChild(item);
  }
}

seqAddBtn.addEventListener("click", addNewSequence);

// ─── Animation preview ──────────────────────────────────────────

function updatePreviews(): void {
  if (animTimer !== null) {
    clearInterval(animTimer);
    animTimer = null;
  }
  animPreviews = [];
  previewArea.innerHTML = "";

  const state = getAnimState(currentSheetId);
  if (state.entries.length === 0) {
    previewArea.innerHTML = '<div style="color: var(--text-dim); font-size: 11px;">Assign animations to preview.</div>';
    return;
  }

  const previewScale = 3;
  const fps = parseInt(animSpeedRange.value);

  // Show one preview per unique family+direction (variant 0 only)
  const seen = new Set<string>();
  for (const entry of state.entries) {
    const key = `${entry.family}:${entry.direction}`;
    if (seen.has(key)) continue;
    // Only show variant 0 in preview
    if (entry.variant !== 0) continue;
    seen.add(key);

    const img = getStripImage(entry.strip);
    if (!img) continue;

    const box = document.createElement("div");
    box.className = "char-preview-box";

    const canvas = document.createElement("canvas");
    canvas.width = frameW * previewScale;
    canvas.height = frameH * previewScale;
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = `${entry.family} ${entry.direction}`;
    label.style.color = getFamilyColor(entry.family);

    box.appendChild(canvas);
    box.appendChild(label);
    previewArea.appendChild(box);

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    const frames: { sx: number; sy: number; tilesetId: string }[] = [];
    for (let f = 0; f < entry.strip.frameCount; f++) {
      frames.push({
        sx: (entry.strip.startFrame + f) * frameW,
        sy: entry.strip.row * frameH,
        tilesetId: entry.strip.tilesetId,
      });
    }

    animPreviews.push({
      label: key,
      canvas,
      ctx,
      frames,
      currentFrame: 0,
    });
  }

  // Show one preview per variant sequence (cycles through steps with repeats)
  for (const seq of state.variantSequences) {
    // Build combined frame list: for each step, repeat its variant's strip N times
    const seqFrames: { sx: number; sy: number; tilesetId: string }[] = [];
    for (const step of seq.steps) {
      const entry = state.entries.find(
        (e) => e.family === seq.family && e.direction === seq.direction && e.variant === step.variant,
      );
      if (!entry) continue;
      const stripImg = getStripImage(entry.strip);
      if (!stripImg) continue;

      for (let rep = 0; rep < step.repeats; rep++) {
        for (let f = 0; f < entry.strip.frameCount; f++) {
          seqFrames.push({
            sx: (entry.strip.startFrame + f) * frameW,
            sy: entry.strip.row * frameH,
            tilesetId: entry.strip.tilesetId,
          });
        }
      }
    }

    if (seqFrames.length === 0) continue;

    const box = document.createElement("div");
    box.className = "char-preview-box";

    const canvas = document.createElement("canvas");
    canvas.width = frameW * previewScale;
    canvas.height = frameH * previewScale;
    canvas.style.width = `${canvas.width}px`;
    canvas.style.height = `${canvas.height}px`;

    const label = document.createElement("div");
    label.className = "label";
    label.textContent = `\u266B ${seq.name}`;
    label.style.color = getFamilyColor(seq.family);

    box.appendChild(canvas);
    box.appendChild(label);
    previewArea.appendChild(box);

    const ctx = canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    animPreviews.push({
      label: `seq:${seq.name}`,
      canvas,
      ctx,
      frames: seqFrames,
      currentFrame: 0,
    });
  }

  const tick = () => {
    for (const preview of animPreviews) {
      if (preview.frames.length === 0) continue;
      const frame = preview.frames[preview.currentFrame];
      const img = getCachedTilesetImage(frame.tilesetId);
      if (!img) continue;
      preview.ctx.clearRect(0, 0, preview.canvas.width, preview.canvas.height);
      preview.ctx.drawImage(
        img,
        frame.sx, frame.sy, frameW, frameH,
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
  const name = charNameInput.value.trim();
  const state = getAnimState(currentSheetId);

  if (!name) {
    saveStatusDiv.textContent = "Enter a character name.";
    saveStatusDiv.style.color = "var(--text-dim)";
    saveBtn.disabled = true;
    return;
  }

  if (state.entries.length === 0) {
    saveStatusDiv.textContent = "No animations assigned.";
    saveStatusDiv.style.color = "var(--text-dim)";
    saveBtn.disabled = true;
    return;
  }

  // Check for minimum: at least idle+walk with all 4 directions (variant 0)
  const missingRequired: string[] = [];
  for (const family of ["idle", "walk"]) {
    for (const dir of CHARACTER_DIRECTIONS) {
      const has = state.entries.some(
        (e) => e.family === family && e.direction === dir && e.variant === 0,
      );
      if (!has) missingRequired.push(`${family} ${dir}`);
    }
  }

  if (missingRequired.length > 0) {
    saveStatusDiv.textContent = `Missing: ${missingRequired.join(", ")}`;
    saveStatusDiv.style.color = "var(--yellow)";
    // Still allow saving -- just warn. User might want partial definitions.
    saveBtn.disabled = false;
    return;
  }

  const families = new Set(state.entries.map((e) => e.family));
  const totalAnims = state.entries.length;
  saveStatusDiv.textContent = `Ready: ${totalAnims} animations across ${families.size} families.`;
  saveStatusDiv.style.color = "var(--green)";
  saveBtn.disabled = false;
}

function saveCharacter(): void {
  const name = charNameInput.value.trim();
  if (!name) return;

  const state = getAnimState(currentSheetId);
  if (state.entries.length === 0) return;

  const existing = appState.characters.find((c) => c.sheetId === currentSheetId);

  const animations: CharacterAnimation[] = state.entries.map((e) => ({
    family: e.family,
    direction: e.direction,
    variant: e.variant,
    strip: { ...e.strip },
  }));

  const charDef: CharacterDefinition = {
    id: existing?.id || generateId(),
    name,
    sheetId: currentSheetId,
    frameWidth: frameW,
    frameHeight: frameH,
    animations,
    familySpeeds: { ...state.familySpeeds },
    variantSequences: state.variantSequences.map((s) => ({ ...s, steps: s.steps.map((st) => ({ ...st })) })),
  };

  appState.addCharacter(charDef);
  setStatus(`Saved character "${name}" (${currentSheetId})`);
  renderSavedList();
}

// ─── Saved characters list ──────────────────────────────────────

function renderSavedList(): void {
  savedCountSpan.textContent = String(appState.characters.length);
  savedListDiv.innerHTML = "";

  for (const char of appState.characters) {
    const item = document.createElement("div");
    item.className = "char-saved-item";

    const info = document.createElement("div");
    info.className = "info";
    const families = new Set(char.animations.map((a) => a.family));
    const familyStr = [...families].join(", ");
    info.innerHTML = `
      <div class="name">${char.name}</div>
      <div class="meta">${char.sheetId} · ${char.frameWidth}x${char.frameHeight} · ${char.animations.length} anims · ${familyStr}</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.title = "Delete character";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      appState.removeCharacter(char.id);
      renderSavedList();
      setStatus(`Deleted character "${char.name}"`);
    });

    item.addEventListener("click", () => {
      loadCharacterDef(char);
    });

    item.appendChild(info);
    item.appendChild(delBtn);
    savedListDiv.appendChild(item);
  }
}

function loadCharacterDef(char: CharacterDefinition): void {
  currentSheetId = char.sheetId;
  sheetSelect.value = char.sheetId;
  charNameInput.value = char.name;

  // Restore frame dimensions
  frameW = char.frameWidth;
  frameH = char.frameHeight;
  frameWInput.value = String(frameW);
  frameHInput.value = String(frameH);

  // Rebuild animation state from definition
  const state = getAnimState(char.sheetId);
  state.entries = char.animations.map((a) => ({
    id: newEntryId(),
    family: a.family,
    direction: a.direction,
    variant: a.variant,
    strip: { ...a.strip },
  }));
  state.familySpeeds = { ...char.familySpeeds };
  state.variantSequences = (char.variantSequences || []).map((s) => ({
    ...s,
    steps: s.steps.map((st) => ({ ...st })),
  }));

  loadSheets();
  setStatus(`Loaded character "${char.name}" for editing`);
}

// ─── Canvas click to select existing animation ──────────────────

function setupCanvasClick(canvas: HTMLCanvasElement, sheet: CharacterSheet): void {
  canvas.addEventListener("click", (e) => {
    // Only handle single-clicks (no drag)
    if (pendingSelection) return;

    const pos = getGridPos(e, canvas, sheet);
    if (!pos) return;

    const state = getAnimState(currentSheetId);
    const hit = state.entries.find(
      (a) =>
        sheetFromTilesetId(a.strip.tilesetId) === sheet &&
        a.strip.row === pos.row &&
        pos.col >= a.strip.startFrame &&
        pos.col < a.strip.startFrame + a.strip.frameCount,
    );

    if (hit) {
      selectedAnimId = selectedAnimId === hit.id ? null : hit.id;
      drawSheets();
      renderAnimList();
    }
  });
}

// ─── Event listeners ────────────────────────────────────────────

sheetSelect.addEventListener("change", () => {
  currentSheetId = sheetSelect.value;
  charNameInput.value = currentSheetId.charAt(0).toUpperCase() + currentSheetId.slice(1);
  clearSelection();
  loadSheets();
});

zoomSelect.addEventListener("change", () => {
  currentZoom = parseInt(zoomSelect.value);
  drawSheets();
});

gridToggle.addEventListener("change", () => {
  showGrid = gridToggle.checked;
  drawSheets();
});

frameWInput.addEventListener("change", () => {
  const v = Math.max(1, Math.min(128, parseInt(frameWInput.value) || 16));
  frameW = v;
  frameWInput.value = String(v);
  recalcGridAndRedraw();
});

frameHInput.addEventListener("change", () => {
  const v = Math.max(1, Math.min(128, parseInt(frameHInput.value) || 32));
  frameH = v;
  frameHInput.value = String(v);
  recalcGridAndRedraw();
});

function recalcGridAndRedraw(): void {
  const idleImg = getSheetImage("idle");
  const walkImg = getSheetImage("walk");
  if (idleImg) {
    idleCols = Math.floor(idleImg.width / frameW);
    idleRows = Math.floor(idleImg.height / frameH);
  }
  if (walkImg) {
    walkCols = Math.floor(walkImg.width / frameW);
    walkRows = Math.floor(walkImg.height / frameH);
  }
  if (idleImg || walkImg) {
    sheetInfo.textContent =
      `Idle: ${idleImg?.width ?? 0}x${idleImg?.height ?? 0} (${idleCols}x${idleRows}) · ` +
      `Walk: ${walkImg?.width ?? 0}x${walkImg?.height ?? 0} (${walkCols}x${walkRows}) · ` +
      `Frame: ${frameW}x${frameH}`;

    // Update tileset definitions with new frame dimensions
    if (idleImg) {
      appState.addTileset(makeCharTileset(currentSheetId, "idle", frameW, frameH, idleImg.width, idleImg.height));
    }
    if (walkImg) {
      appState.addTileset(makeCharTileset(currentSheetId, "walk", frameW, frameH, walkImg.width, walkImg.height));
    }
  }
  drawSheets();
  renderAnimList();
  updatePreviews();
  updateSaveState();
}

animSpeedRange.addEventListener("input", () => {
  const fps = parseInt(animSpeedRange.value);
  animSpeedLabel.textContent = `${fps} fps`;
  updatePreviews();
});

charNameInput.addEventListener("input", updateSaveState);
saveBtn.addEventListener("click", saveCharacter);

assignBtn.addEventListener("click", assignSelection);
assignCancelBtn.addEventListener("click", clearSelection);

appState.subscribe(() => {
  renderSavedList();
});

// Set up drag on both canvases
setupCanvasDrag(idleCanvas, idleDragOverlay, "idle");
setupCanvasDrag(walkCanvas, walkDragOverlay, "walk");
setupCanvasClick(idleCanvas, "idle");
setupCanvasClick(walkCanvas, "walk");

// ─── Init ────────────────────────────────────────────────────────

export function initCharacterTab(): void {
  charNameInput.value = currentSheetId.charAt(0).toUpperCase() + currentSheetId.slice(1);
  loadSheets();
  renderSavedList();
}
