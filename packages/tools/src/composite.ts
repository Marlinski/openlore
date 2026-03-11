/**
 * Tab 1: Composite Builder
 *
 * Assemble tileset regions into composite objects by selecting from
 * a tileset picker and dropping onto a workspace grid.
 *
 * Flow:
 *   1. Select a tileset and click/drag a region on the tileset
 *   2. The selected region appears as a "brush" — click on workspace to place it
 *   3. Click placed parts to select, drag to reposition, Delete to remove
 *   4. Name the composite, set category, then Save
 *
 * The workspace is a tile-based canvas. Parts snap to tile positions.
 */

import {
  TILE_SIZE,
  generateId,
  type TilesetId,
  type TilesetRegion,
  type CompositeObject,
  type CompositePart,
  type SpriteCategory,
} from "@offisims/shared";
import { appState } from "./state.js";
import { setStatus } from "./main.js";
import { TilesetPicker, loadTilesetImage, getCachedTilesetImage, populateTilesetList } from "./tileset-picker.js";

// ─── Constants ────────────────────────────────────────────────────

/** Workspace grid size in tiles */
const WORKSPACE_COLS = 20;
const WORKSPACE_ROWS = 16;

// ─── DOM elements ─────────────────────────────────────────────────

const tilesetSelectContainer = document.getElementById("comp-tileset-select") as HTMLDivElement;
const tilesetZoom = document.getElementById("comp-tileset-zoom") as HTMLSelectElement;
const tilesetGridToggle = document.getElementById("comp-tileset-grid") as HTMLInputElement;
const tilesetContainer = document.getElementById("comp-tileset-container") as HTMLDivElement;
const selectionInfo = document.getElementById("comp-selection-info") as HTMLDivElement;

const zoomSelect = document.getElementById("comp-zoom") as HTMLSelectElement;
const gridToggle = document.getElementById("comp-grid-toggle") as HTMLInputElement;
const clearBtn = document.getElementById("comp-clear-btn") as HTMLButtonElement;

const canvas = document.getElementById("comp-canvas") as HTMLCanvasElement;
const canvasWrap = document.getElementById("comp-canvas-wrap") as HTMLDivElement;
const canvasInner = document.getElementById("comp-canvas-inner") as HTMLDivElement;
const overlaysDiv = document.getElementById("comp-overlays") as HTMLDivElement;

const nameInput = document.getElementById("comp-name") as HTMLInputElement;
const categorySelect = document.getElementById("comp-category") as HTMLSelectElement;
const partsInfo = document.getElementById("comp-parts-info") as HTMLDivElement;
const partsListDiv = document.getElementById("comp-parts-list") as HTMLDivElement;
const saveBtn = document.getElementById("comp-save-btn") as HTMLButtonElement;

const savedSearch = document.getElementById("comp-saved-search") as HTMLInputElement;
const savedList = document.getElementById("comp-saved-list") as HTMLDivElement;
const savedCount = document.getElementById("comp-saved-count") as HTMLSpanElement;

// ─── State ────────────────────────────────────────────────────────

let currentZoom = 1;
let showGrid = true;

/** Parts placed on the workspace */
interface WorkspacePart {
  uid: string;
  region: TilesetRegion;
  /** Grid X position (tile col in workspace) */
  gridX: number;
  /** Grid Y position (tile row in workspace) */
  gridY: number;
  /** Manual z-bias for render-time sorting override (default 0) */
  zBias: number;
}

let parts: WorkspacePart[] = [];
let selectedPartUid: string | null = null;

/** Currently selected brush (region from tileset picker) */
let selectedBrush: TilesetRegion | null = null;

/** When editing an existing composite, store its id for overwrite */
let editingCompositeId: string | null = null;

// ─── Drag state ───────────────────────────────────────────────────

let dragPartUid: string | null = null;
let dragOffset: { x: number; y: number } = { x: 0, y: 0 };
let isDragging = false;

// ─── Tileset Picker ───────────────────────────────────────────────

// FilterableList instance — created during init, used for change events
let tilesetList: ReturnType<typeof populateTilesetList>;

const picker = new TilesetPicker(tilesetContainer, (region) => {
  selectedBrush = region;
  selectedPartUid = null;
  selectionInfo.textContent = `Selected: ${region.w}×${region.h} from (${region.srcCol},${region.srcRow})`;
  drawWorkspace();
});

// tilesetList change is handled via onSelect callback (see initCompositeTab)

tilesetZoom.addEventListener("change", () => {
  picker.setZoom(parseInt(tilesetZoom.value));
});

tilesetGridToggle.addEventListener("change", () => {
  picker.setShowGrid(tilesetGridToggle.checked);
});

// ─── Workspace canvas drawing ─────────────────────────────────────

function drawWorkspace(): void {
  const ts = TILE_SIZE * currentZoom;
  const w = WORKSPACE_COLS * ts;
  const h = WORKSPACE_ROWS * ts;

  canvas.width = w;
  canvas.height = h;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Background
  ctx.fillStyle = "#111827";
  ctx.fillRect(0, 0, w, h);

  // Grid
  if (showGrid) {
    ctx.strokeStyle = "rgba(255, 255, 255, 0.08)";
    ctx.lineWidth = 1;
    for (let x = 0; x <= WORKSPACE_COLS; x++) {
      ctx.beginPath();
      ctx.moveTo(x * ts + 0.5, 0);
      ctx.lineTo(x * ts + 0.5, h);
      ctx.stroke();
    }
    for (let y = 0; y <= WORKSPACE_ROWS; y++) {
      ctx.beginPath();
      ctx.moveTo(0, y * ts + 0.5);
      ctx.lineTo(w, y * ts + 0.5);
      ctx.stroke();
    }
  }

  // Draw placed parts in render-time z-order:
  // Sorted by anchor Y (bottom edge = gridY + h + zBias), then X
  const sortedParts = [...parts].sort((a, b) => {
    const anchorA = a.gridY + a.region.h + a.zBias;
    const anchorB = b.gridY + b.region.h + b.zBias;
    if (anchorA !== anchorB) return anchorA - anchorB;
    return a.gridX - b.gridX;
  });
  for (const part of sortedParts) {
    drawRegionOnCanvas(ctx, part.region, part.gridX * ts, part.gridY * ts, ts);
  }

  updateOverlays();
  updateDetails();
}

/** Draw a TilesetRegion at pixel position on a canvas */
function drawRegionOnCanvas(
  ctx: CanvasRenderingContext2D,
  region: TilesetRegion,
  px: number,
  py: number,
  tileSize: number
): void {
  const img = getCachedTilesetImage(region.tilesetId);
  if (!img) {
    loadTilesetImage(region.tilesetId).then(() => drawWorkspace());
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

// ─── Overlays (part selection highlights) ─────────────────────────

function updateOverlays(): void {
  overlaysDiv.innerHTML = "";
  overlaysDiv.style.pointerEvents = "auto";
  const ts = TILE_SIZE * currentZoom;

  for (const part of parts) {
    const el = document.createElement("div");
    el.className = "comp-part-overlay" + (part.uid === selectedPartUid ? " selected" : "");
    el.style.left = `${part.gridX * ts}px`;
    el.style.top = `${part.gridY * ts}px`;
    el.style.width = `${part.region.w * ts}px`;
    el.style.height = `${part.region.h * ts}px`;
    el.dataset.uid = part.uid;

    // Click to select — but if brush is active, place instead (allows stacking)
    el.addEventListener("mousedown", (e) => {
      // If a brush is active, place it on the workspace instead of selecting
      // the existing part. This allows stacking multiple parts on the same tile.
      if (selectedBrush && e.button === 0) {
        e.stopPropagation();
        e.preventDefault();
        const placeTs = TILE_SIZE * currentZoom;
        const rect = canvasInner.getBoundingClientRect();
        const x = e.clientX - rect.left;
        const y = e.clientY - rect.top;

        let gridX = Math.floor(x / placeTs);
        let gridY = Math.floor(y / placeTs);
        gridX = Math.max(0, Math.min(WORKSPACE_COLS - selectedBrush.w, gridX));
        gridY = Math.max(0, Math.min(WORKSPACE_ROWS - selectedBrush.h, gridY));

        const newPart: WorkspacePart = {
          uid: generateId(),
          region: { ...selectedBrush },
          gridX,
          gridY,
          zBias: 0,
        };
        parts.push(newPart);
        selectedPartUid = newPart.uid;
        drawWorkspace();
        setStatus(`Placed ${selectedBrush.w}×${selectedBrush.h} region at (${gridX}, ${gridY})`);
        return;
      }

      e.stopPropagation();
      e.preventDefault();
      selectedPartUid = part.uid;
      selectedBrush = null;

      // Start drag within workspace
      isDragging = true;
      dragPartUid = part.uid;
      const rect = canvasInner.getBoundingClientRect();
      dragOffset = {
        x: e.clientX - rect.left - part.gridX * ts,
        y: e.clientY - rect.top - part.gridY * ts,
      };

      drawWorkspace();
    });

    overlaysDiv.appendChild(el);
  }
}

// ─── Canvas click to place brush or deselect ──────────────────────

canvas.addEventListener("mousedown", (e) => {
  if (selectedBrush && e.button === 0) {
    // Place the brush
    const ts = TILE_SIZE * currentZoom;
    const rect = canvasInner.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    let gridX = Math.floor(x / ts);
    let gridY = Math.floor(y / ts);

    // Clamp to workspace
    gridX = Math.max(0, Math.min(WORKSPACE_COLS - selectedBrush.w, gridX));
    gridY = Math.max(0, Math.min(WORKSPACE_ROWS - selectedBrush.h, gridY));

    const newPart: WorkspacePart = {
      uid: generateId(),
      region: { ...selectedBrush },
      gridX,
      gridY,
      zBias: 0,
    };

    parts.push(newPart);
    selectedPartUid = newPart.uid;
    drawWorkspace();
    setStatus(`Placed ${selectedBrush.w}×${selectedBrush.h} region at (${gridX}, ${gridY})`);
  } else {
    // Deselect
    selectedPartUid = null;
    selectedBrush = null;
    drawWorkspace();
  }
});

// ─── Mouse move/up for workspace dragging ─────────────────────────

canvasWrap.addEventListener("mousemove", (e) => {
  if (!isDragging || !dragPartUid) return;

  const part = parts.find((p) => p.uid === dragPartUid);
  if (!part) return;

  const ts = TILE_SIZE * currentZoom;
  const rect = canvasInner.getBoundingClientRect();
  const x = e.clientX - rect.left - dragOffset.x;
  const y = e.clientY - rect.top - dragOffset.y;

  let gridX = Math.round(x / ts);
  let gridY = Math.round(y / ts);

  gridX = Math.max(0, Math.min(WORKSPACE_COLS - part.region.w, gridX));
  gridY = Math.max(0, Math.min(WORKSPACE_ROWS - part.region.h, gridY));

  if (part.gridX !== gridX || part.gridY !== gridY) {
    part.gridX = gridX;
    part.gridY = gridY;
    drawWorkspace();
  }
});

window.addEventListener("mouseup", () => {
  if (isDragging && dragPartUid) {
    // No need to re-sort — render-time sorting handles draw order
    isDragging = false;
    dragPartUid = null;
    drawWorkspace();
  }
});

// ─── Keyboard (Delete to remove selected part) ───────────────────

window.addEventListener("keydown", (e) => {
  const compositeTab = document.getElementById("tab-composite")!;
  if (!compositeTab.classList.contains("active")) return;

  // Don't capture when typing in inputs
  if (
    document.activeElement === nameInput ||
    document.activeElement === savedSearch
  ) return;

  if ((e.key === "Delete" || e.key === "Backspace") && selectedPartUid) {
    e.preventDefault();
    parts = parts.filter((p) => p.uid !== selectedPartUid);
    selectedPartUid = null;
    drawWorkspace();
    setStatus("Removed part");
  }

  if (e.key === "Escape") {
    e.preventDefault();
    selectedPartUid = null;
    selectedBrush = null;
    picker.clearSelection();
    selectionInfo.textContent = "Click/drag on the tileset to select a region.";
    drawWorkspace();
  }
});

// ─── Compute bounding box ─────────────────────────────────────────

interface BBox {
  minX: number; minY: number;
  maxX: number; maxY: number;
  w: number; h: number;
}

function computeBBox(): BBox | null {
  if (parts.length === 0) return null;

  let minX = Infinity, minY = Infinity;
  let maxX = -Infinity, maxY = -Infinity;

  for (const part of parts) {
    minX = Math.min(minX, part.gridX);
    minY = Math.min(minY, part.gridY);
    maxX = Math.max(maxX, part.gridX + part.region.w);
    maxY = Math.max(maxY, part.gridY + part.region.h);
  }

  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// ─── Details panel ────────────────────────────────────────────────

function updateDetails(): void {
  const bbox = computeBBox();

  if (parts.length === 0) {
    partsInfo.textContent = "No parts placed yet.";
    partsListDiv.innerHTML = "";
    saveBtn.disabled = true;
    return;
  }

  partsInfo.innerHTML = `
    <div><strong>Parts:</strong> ${parts.length}</div>
    <div><strong>Bounding box:</strong> ${bbox ? `${bbox.w}×${bbox.h}` : "N/A"}</div>
  `;

  renderPartsList();
  saveBtn.disabled = false;
}

/** Render the interactive parts list with z-bias adjust, select, delete.
 *  Parts are displayed in render-time sort order (by anchor Y + zBias, then X). */
function renderPartsList(): void {
  partsListDiv.innerHTML = "";

  // Sort parts by render order for display
  const sortedParts = parts
    .map((part, idx) => ({ part, idx }))
    .sort((a, b) => {
      const anchorA = a.part.gridY + a.part.region.h + a.part.zBias;
      const anchorB = b.part.gridY + b.part.region.h + b.part.zBias;
      if (anchorA !== anchorB) return anchorA - anchorB;
      return a.part.gridX - b.part.gridX;
    });

  for (let listIdx = 0; listIdx < sortedParts.length; listIdx++) {
    const { part } = sortedParts[listIdx];

    const item = document.createElement("div");
    item.className = "comp-part-item" + (part.uid === selectedPartUid ? " selected" : "");

    // Z-index label (render order)
    const zLabel = document.createElement("div");
    zLabel.style.cssText = "width: 18px; text-align: center; font-size: 10px; color: var(--text-dim); flex-shrink: 0;";
    zLabel.textContent = String(listIdx);

    // Thumbnail
    const thumb = document.createElement("canvas");
    const thumbSize = 24;
    const thumbScale = Math.min(thumbSize / (Math.max(part.region.w, part.region.h) * TILE_SIZE), 1);
    thumb.width = part.region.w * TILE_SIZE * thumbScale;
    thumb.height = part.region.h * TILE_SIZE * thumbScale;
    thumb.style.width = `${thumb.width}px`;
    thumb.style.height = `${thumb.height}px`;
    drawRegionThumbnail(part.region, thumb);

    // Info
    const info = document.createElement("div");
    info.className = "info";
    const biasStr = part.zBias !== 0 ? ` zBias:${part.zBias > 0 ? "+" : ""}${part.zBias}` : "";
    info.innerHTML = `
      <div class="name">[T] ${part.region.w}\u00d7${part.region.h}</div>
      <div class="meta">(${part.gridX}, ${part.gridY})${biasStr}</div>
    `;

    // Up/Down buttons for z-bias adjustment
    const actions = document.createElement("div");
    actions.className = "stack-actions";

    const upBtn = document.createElement("button");
    upBtn.textContent = "\u25B2";
    upBtn.title = "Increase z-bias (render more in front)";
    upBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      part.zBias += 1;
      drawWorkspace();
    });

    const downBtn = document.createElement("button");
    downBtn.textContent = "\u25BC";
    downBtn.title = "Decrease z-bias (render more behind)";
    downBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      part.zBias -= 1;
      drawWorkspace();
    });

    actions.appendChild(upBtn);
    actions.appendChild(downBtn);

    // Delete button
    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "\u00d7";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      parts = parts.filter((p) => p.uid !== part.uid);
      if (selectedPartUid === part.uid) selectedPartUid = null;
      drawWorkspace();
      setStatus("Removed part");
    });

    // Click to select
    item.addEventListener("click", () => {
      selectedPartUid = part.uid;
      selectedBrush = null;
      drawWorkspace();
    });

    item.appendChild(zLabel);
    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(actions);
    item.appendChild(delBtn);
    partsListDiv.appendChild(item);
  }
}

/** Draw a region thumbnail for the parts list */
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

// ─── Save composite ───────────────────────────────────────────────

saveBtn.addEventListener("click", () => {
  if (parts.length === 0) return;

  const bbox = computeBBox();
  if (!bbox) return;

  const name = nameInput.value.trim() || `composite_${generateId()}`;
  const category = categorySelect.value as SpriteCategory;

  // Build parts list with offsets relative to bounding box origin
  const compositeParts: CompositePart[] = parts.map((p) => {
    const part: CompositePart = {
      region: { ...p.region },
      offsetX: p.gridX - bbox.minX,
      offsetY: p.gridY - bbox.minY,
    };
    if (p.zBias !== 0) part.zBias = p.zBias;
    return part;
  });

  const composite: CompositeObject = {
    id: editingCompositeId || `comp_${generateId()}`,
    name,
    category,
    parts: compositeParts,
    displaySize: { w: bbox.w, h: bbox.h },
  };

  appState.addComposite(composite);
  setStatus(`Saved composite "${name}" (${bbox.w}×${bbox.h}, ${parts.length} parts)`);

  // Clear workspace
  clearWorkspace();
  renderSavedComposites();
});

// ─── Clear workspace ──────────────────────────────────────────────

/** Check if the workspace has unsaved changes */
function hasUnsavedChanges(): boolean {
  return parts.length > 0;
}

/** Prompt user to confirm discarding unsaved changes. Returns true if ok to proceed. */
function confirmDiscardChanges(): boolean {
  if (!hasUnsavedChanges()) return true;
  return confirm("You have unsaved changes in the composite workspace. Discard them?");
}

function clearWorkspace(): void {
  parts = [];
  selectedPartUid = null;
  selectedBrush = null;
  editingCompositeId = null;
  nameInput.value = "";
  categorySelect.value = "other";
  picker.clearSelection();
  selectionInfo.textContent = "Click/drag on the tileset to select a region.";
  drawWorkspace();
}

clearBtn.addEventListener("click", () => {
  if (!confirmDiscardChanges()) return;
  clearWorkspace();
  setStatus("Workspace cleared");
});

// ─── Saved composites list ────────────────────────────────────────

function renderSavedComposites(): void {
  const search = savedSearch.value.toLowerCase();
  const composites = appState.composites.filter(
    (c) =>
      c.id.toLowerCase().includes(search) ||
      c.name.toLowerCase().includes(search) ||
      c.category.includes(search)
  );

  savedCount.textContent = String(appState.composites.length);
  savedList.innerHTML = "";

  for (const comp of composites) {
    const item = document.createElement("div");
    item.className = "comp-saved-item";

    // Thumbnail canvas
    const thumb = document.createElement("canvas");
    const maxDim = Math.max(comp.displaySize.w, comp.displaySize.h);
    const thumbScale = Math.min(40 / (maxDim * TILE_SIZE), 2);
    thumb.width = comp.displaySize.w * TILE_SIZE * thumbScale;
    thumb.height = comp.displaySize.h * TILE_SIZE * thumbScale;
    thumb.style.width = `${thumb.width}px`;
    thumb.style.height = `${thumb.height}px`;
    drawCompositeThumbnail(comp, thumb, thumbScale);

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `
      <div class="name">${comp.name}</div>
      <div class="meta">${comp.category} · ${comp.displaySize.w}×${comp.displaySize.h} · ${comp.parts.length} parts</div>
    `;

    const delBtn = document.createElement("button");
    delBtn.className = "delete-btn";
    delBtn.textContent = "×";
    delBtn.title = "Delete composite";
    delBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      appState.removeComposite(comp.id);
      renderSavedComposites();
      setStatus(`Deleted composite "${comp.name}"`);
    });

    // Click to load into workspace
    item.addEventListener("click", () => {
      loadCompositeIntoWorkspace(comp);
    });

    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(delBtn);
    savedList.appendChild(item);
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

function loadCompositeIntoWorkspace(comp: CompositeObject): void {
  if (!confirmDiscardChanges()) return;

  // Place parts in workspace, offset so they start at (1,1) for some padding
  const startX = 1;
  const startY = 1;

  parts = comp.parts.map((p) => ({
    uid: generateId(),
    region: { ...p.region },
    gridX: startX + p.offsetX,
    gridY: startY + p.offsetY,
    zBias: p.zBias ?? 0,
  }));

  selectedPartUid = null;
  selectedBrush = null;
  editingCompositeId = comp.id;
  nameInput.value = comp.name;
  categorySelect.value = comp.category;

  drawWorkspace();
  setStatus(`Loaded composite "${comp.name}" for editing`);
}

// ─── Control listeners ────────────────────────────────────────────

zoomSelect.addEventListener("change", () => {
  currentZoom = parseInt(zoomSelect.value);
  drawWorkspace();
});

gridToggle.addEventListener("change", () => {
  showGrid = gridToggle.checked;
  drawWorkspace();
});

savedSearch.addEventListener("input", () => {
  renderSavedComposites();
});

appState.subscribe(() => {
  renderSavedComposites();
});

// ─── Init ─────────────────────────────────────────────────────────

export function initCompositeTab(): void {
  // Populate tileset filterable list
  tilesetList = populateTilesetList(tilesetSelectContainer, "office_combined");

  tilesetList.onSelect((id) => {
    picker.setTileset(id as TilesetId);
    selectedBrush = null;
    selectionInfo.textContent = "Click/drag on the tileset to select a region.";
  });

  // Preload all tileset images
  const loadPromises = appState.tilesets.map((ts) => loadTilesetImage(ts.id));

  Promise.all(loadPromises).then(() => {
    const selected = tilesetList.getValue();
    if (selected) picker.setTileset(selected as TilesetId);
    renderSavedComposites();
    drawWorkspace();
    setStatus("Composite Builder ready");
  });
}
