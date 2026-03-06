/**
 * Sprite Annotator Tool (v2)
 *
 * Each office single sprite is a 96x144 image (2x3 tiles at 48px).
 * This tool lets you:
 *   - Browse all 339 sprites
 *   - Drag-drop (or click) a sprite onto the workspace
 *   - See it at full resolution with a tile grid overlay
 *   - Click occupancy cells to toggle which floor tiles are blocked
 *   - Auto-detect content bounds to suggest occupancy
 *   - Name, categorize, and save as a composite definition
 */

import {
  CompositeDefinition,
  CompositeSprite,
  CompositeCategory,
  SpriteRef,
  TILE_SIZE,
  SPRITE_TILES_W,
  SPRITE_TILES_H,
  SPRITE_PX_W,
  SPRITE_PX_H,
  OFFICE_SINGLES_COUNT,
  getOfficeSinglePath,
} from "../../src/shared/types";

// ─── Constants ───────────────────────────────────────────────────────────────

const PREVIEW_SCALE = 3; // Show the sprite at 3x zoom
const CELL_PX = TILE_SIZE * PREVIEW_SCALE;

// ─── State ───────────────────────────────────────────────────────────────────

interface AppState {
  composites: CompositeDefinition[];
  /** Currently loaded sprite ID in the workspace (null = nothing) */
  currentSpriteId: number | null;
  /** Occupancy grid: [row][col] bottom-left = [0][0] */
  occupancy: boolean[][];
  /** Currently editing composite id (null = new) */
  editingId: string | null;
  autosave: boolean;
}

const state: AppState = {
  composites: [],
  currentSpriteId: null,
  occupancy: initOccupancy(),
  editingId: null,
  autosave: true,
};

function initOccupancy(): boolean[][] {
  const grid: boolean[][] = [];
  for (let row = 0; row < SPRITE_TILES_H; row++) {
    grid.push(new Array(SPRITE_TILES_W).fill(false));
  }
  return grid;
}

// ─── DOM refs ────────────────────────────────────────────────────────────────

const spriteGrid = document.getElementById("sprite-grid")!;
const previewArea = document.getElementById("preview-area")!;
const dropHint = document.getElementById("drop-hint")!;
const compositesContainer = document.getElementById("composites-container")!;
const compCount = document.getElementById("comp-count")!;
const statusBar = document.getElementById("status")!;

const inputName = document.getElementById("comp-name") as HTMLInputElement;
const inputCategory = document.getElementById("comp-category") as HTMLSelectElement;
const inputOW = document.getElementById("comp-ow") as HTMLInputElement;
const inputOH = document.getElementById("comp-oh") as HTMLInputElement;
const inputOX = document.getElementById("comp-ox") as HTMLInputElement;
const inputOY = document.getElementById("comp-oy") as HTMLInputElement;
const inputWalkable = document.getElementById("comp-walkable") as HTMLInputElement;
const filterSearch = document.getElementById("filter-search") as HTMLInputElement;
const filterUsed = document.getElementById("filter-used") as HTMLSelectElement;
const compListSearch = document.getElementById("comp-list-search") as HTMLInputElement;
const compListCat = document.getElementById("comp-list-cat") as HTMLSelectElement;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getAnnotatedSpriteIds(): Set<number> {
  const ids = new Set<number>();
  for (const comp of state.composites) {
    for (const cs of comp.sprites) {
      if (cs.sprite.collection === "office_singles") {
        ids.add(cs.sprite.id);
      }
    }
  }
  return ids;
}

function getCompositeForSprite(spriteId: number): CompositeDefinition | undefined {
  return state.composites.find((c) =>
    c.sprites.some((s) => s.sprite.id === spriteId && s.sprite.collection === "office_singles")
  );
}

function generateId(): string {
  return "comp_" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// ─── Sprite Browser ──────────────────────────────────────────────────────────

function renderSpriteBrowser() {
  const annotatedIds = getAnnotatedSpriteIds();
  const search = filterSearch.value.trim();
  const usedFilter = filterUsed.value;

  spriteGrid.innerHTML = "";

  for (let i = 1; i <= OFFICE_SINGLES_COUNT; i++) {
    if (search && !String(i).includes(search)) continue;
    const isAnnotated = annotatedIds.has(i);
    if (usedFilter === "annotated" && !isAnnotated) continue;
    if (usedFilter === "unannotated" && isAnnotated) continue;

    const div = document.createElement("div");
    div.className = "sprite-thumb";
    if (isAnnotated) div.classList.add("annotated");
    if (state.currentSpriteId === i) div.classList.add("selected");

    // Drag support
    div.draggable = true;
    div.dataset.spriteId = String(i);

    const img = document.createElement("img");
    img.src = getOfficeSinglePath(i);
    img.alt = `Sprite ${i}`;
    img.loading = "lazy";
    div.appendChild(img);

    const idLabel = document.createElement("span");
    idLabel.className = "sprite-id";
    idLabel.textContent = String(i);
    div.appendChild(idLabel);

    // Show name if annotated
    if (isAnnotated) {
      const comp = getCompositeForSprite(i);
      if (comp) {
        const label = document.createElement("span");
        label.className = "sprite-label";
        label.textContent = comp.name;
        div.appendChild(label);
      }
    }

    // Click to load
    div.addEventListener("click", () => {
      loadSpriteIntoWorkspace(i);
    });

    // Drag start
    div.addEventListener("dragstart", (e) => {
      e.dataTransfer!.setData("text/plain", String(i));
      e.dataTransfer!.effectAllowed = "copy";
    });

    spriteGrid.appendChild(div);
  }
}

// ─── Workspace / Preview ─────────────────────────────────────────────────────

function loadSpriteIntoWorkspace(spriteId: number) {
  state.currentSpriteId = spriteId;

  // Check if this sprite is already annotated
  const existing = getCompositeForSprite(spriteId);
  if (existing) {
    state.editingId = existing.id;
    inputName.value = existing.name;
    inputCategory.value = existing.category;
    inputOW.value = String(existing.occupancy.w);
    inputOH.value = String(existing.occupancy.h);
    inputOX.value = String(existing.occupancyOffset.x);
    inputOY.value = String(existing.occupancyOffset.y);
    inputWalkable.checked = existing.walkable;
    // Rebuild occupancy grid from the saved data
    rebuildOccupancyFromComposite(existing);
  } else {
    state.editingId = null;
    inputName.value = "";
    inputCategory.value = "furniture";
    inputWalkable.checked = false;
    state.occupancy = initOccupancy();
    // Auto-detect
    autoDetectOccupancy(spriteId);
  }

  renderPreview();
  renderSpriteBrowser();
  renderCompositeList();
  setStatus(`Sprite #${spriteId} loaded. ${existing ? `Editing: ${existing.name}` : "Click occupancy cells to mark blocked tiles, then save."}`);
}

function rebuildOccupancyFromComposite(comp: CompositeDefinition) {
  state.occupancy = initOccupancy();
  // Occupancy is defined by w, h, offset from bottom-left
  // In our grid, row 0 = bottom, row 2 = top
  for (let oh = 0; oh < comp.occupancy.h; oh++) {
    for (let ow = 0; ow < comp.occupancy.w; ow++) {
      const row = oh + comp.occupancyOffset.y;
      const col = ow + comp.occupancyOffset.x;
      if (row >= 0 && row < SPRITE_TILES_H && col >= 0 && col < SPRITE_TILES_W) {
        state.occupancy[row][col] = true;
      }
    }
  }
}

function computeOccupancyFromGrid(): { w: number; h: number; ox: number; oy: number } {
  let minR = SPRITE_TILES_H, maxR = -1, minC = SPRITE_TILES_W, maxC = -1;
  for (let r = 0; r < SPRITE_TILES_H; r++) {
    for (let c = 0; c < SPRITE_TILES_W; c++) {
      if (state.occupancy[r][c]) {
        minR = Math.min(minR, r);
        maxR = Math.max(maxR, r);
        minC = Math.min(minC, c);
        maxC = Math.max(maxC, c);
      }
    }
  }
  if (maxR === -1) {
    return { w: 1, h: 1, ox: 0, oy: 0 };
  }
  return {
    w: maxC - minC + 1,
    h: maxR - minR + 1,
    ox: minC,
    oy: minR,
  };
}

function renderPreview() {
  previewArea.innerHTML = "";
  previewArea.classList.toggle("has-sprite", state.currentSpriteId !== null);

  if (state.currentSpriteId === null) {
    const hint = document.createElement("span");
    hint.id = "drop-hint";
    hint.textContent = "Drag a sprite here or click one";
    previewArea.appendChild(hint);
    return;
  }

  const pw = SPRITE_TILES_W * CELL_PX;
  const ph = SPRITE_TILES_H * CELL_PX;
  previewArea.style.width = `${pw}px`;
  previewArea.style.height = `${ph}px`;

  // Sprite image
  const img = document.createElement("img");
  img.id = "sprite-img-preview";
  img.src = getOfficeSinglePath(state.currentSpriteId);
  img.style.width = `${pw}px`;
  img.style.height = `${ph}px`;
  img.style.position = "absolute";
  img.style.top = "0";
  img.style.left = "0";
  img.style.zIndex = "1";
  previewArea.appendChild(img);

  // Grid overlay
  const gridDiv = document.createElement("div");
  gridDiv.className = "preview-grid";
  gridDiv.style.width = `${pw}px`;
  gridDiv.style.height = `${ph}px`;

  for (let y = 1; y < SPRITE_TILES_H; y++) {
    const line = document.createElement("div");
    line.className = "grid-line h";
    line.style.top = `${y * CELL_PX}px`;
    gridDiv.appendChild(line);
  }
  for (let x = 1; x < SPRITE_TILES_W; x++) {
    const line = document.createElement("div");
    line.className = "grid-line v";
    line.style.left = `${x * CELL_PX}px`;
    gridDiv.appendChild(line);
  }
  previewArea.appendChild(gridDiv);

  // Occupancy cells (clickable)
  // Our grid: row 0 = bottom of image, row 2 = top
  // But on screen: top of image is y=0
  // So screen row = (SPRITE_TILES_H - 1 - row)
  for (let row = 0; row < SPRITE_TILES_H; row++) {
    for (let col = 0; col < SPRITE_TILES_W; col++) {
      const cell = document.createElement("div");
      cell.className = "occ-cell";
      if (state.occupancy[row][col]) cell.classList.add("active");

      // Screen position: row 0 (bottom) = screen bottom
      const screenRow = SPRITE_TILES_H - 1 - row;
      cell.style.left = `${col * CELL_PX}px`;
      cell.style.top = `${screenRow * CELL_PX}px`;
      cell.style.width = `${CELL_PX}px`;
      cell.style.height = `${CELL_PX}px`;

      cell.addEventListener("click", () => {
        state.occupancy[row][col] = !state.occupancy[row][col];
        const occ = computeOccupancyFromGrid();
        inputOW.value = String(occ.w);
        inputOH.value = String(occ.h);
        inputOX.value = String(occ.ox);
        inputOY.value = String(occ.oy);
        renderPreview();
      });

      // Show row,col label
      const label = document.createElement("span");
      label.style.cssText = "position:absolute;bottom:2px;right:4px;font-size:9px;color:rgba(255,255,255,0.3);pointer-events:none;";
      label.textContent = `${col},${row}`;
      cell.appendChild(label);

      previewArea.appendChild(cell);
    }
  }
}

// ─── Auto-detection ──────────────────────────────────────────────────────────

function autoDetectOccupancy(spriteId: number) {
  const img = new Image();
  img.crossOrigin = "anonymous";
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0);

    const tileW = img.naturalWidth / SPRITE_TILES_W;
    const tileH = img.naturalHeight / SPRITE_TILES_H;

    state.occupancy = initOccupancy();

    // Check each tile cell for non-transparent content
    // We consider the bottom row(s) as potential occupancy
    // A tile has content if it has significant non-transparent pixels
    const contentGrid: boolean[][] = [];
    for (let screenRow = 0; screenRow < SPRITE_TILES_H; screenRow++) {
      contentGrid.push([]);
      for (let col = 0; col < SPRITE_TILES_W; col++) {
        const x = col * tileW;
        const y = screenRow * tileH;
        const data = ctx.getImageData(x, y, tileW, tileH).data;
        let opaquePixels = 0;
        for (let i = 3; i < data.length; i += 4) {
          if (data[i] > 20) opaquePixels++;
        }
        // A tile "has content" if more than 5% of pixels are opaque
        const threshold = (tileW * tileH) * 0.05;
        contentGrid[screenRow].push(opaquePixels > threshold);
      }
    }

    // Default occupancy: bottom-most row(s) that have content
    // Screen row 2 = bottom = our row 0
    // Screen row 1 = middle = our row 1
    // Screen row 0 = top = our row 2
    for (let screenRow = SPRITE_TILES_H - 1; screenRow >= 0; screenRow--) {
      const logicalRow = SPRITE_TILES_H - 1 - screenRow;
      for (let col = 0; col < SPRITE_TILES_W; col++) {
        if (contentGrid[screenRow][col]) {
          state.occupancy[logicalRow][col] = true;
        }
      }
      // Only mark the bottom-most row with content as occupancy
      if (state.occupancy[logicalRow].some((v) => v)) {
        break;
      }
    }

    const occ = computeOccupancyFromGrid();
    inputOW.value = String(occ.w);
    inputOH.value = String(occ.h);
    inputOX.value = String(occ.ox);
    inputOY.value = String(occ.oy);

    renderPreview();
    setStatus(`Auto-detected occupancy for sprite #${spriteId}: ${occ.w}x${occ.h} at offset (${occ.ox}, ${occ.oy})`);
  };
  img.src = getOfficeSinglePath(spriteId);
}

// ─── Drag & Drop ─────────────────────────────────────────────────────────────

previewArea.addEventListener("dragover", (e) => {
  e.preventDefault();
  e.dataTransfer!.dropEffect = "copy";
  previewArea.classList.add("drag-over");
});

previewArea.addEventListener("dragleave", () => {
  previewArea.classList.remove("drag-over");
});

previewArea.addEventListener("drop", (e) => {
  e.preventDefault();
  previewArea.classList.remove("drag-over");
  const spriteId = parseInt(e.dataTransfer!.getData("text/plain"));
  if (spriteId >= 1 && spriteId <= OFFICE_SINGLES_COUNT) {
    loadSpriteIntoWorkspace(spriteId);
  }
});

// ─── Composite List ──────────────────────────────────────────────────────────

function renderCompositeList() {
  compositesContainer.innerHTML = "";
  const search = compListSearch.value.toLowerCase().trim();
  const catFilter = compListCat.value;

  let count = 0;
  for (const comp of state.composites) {
    if (catFilter !== "all" && comp.category !== catFilter) continue;
    if (search && !comp.name.toLowerCase().includes(search) && !comp.id.includes(search)) continue;

    count++;
    const div = document.createElement("div");
    div.className = "composite-item";
    if (state.editingId === comp.id) div.classList.add("active");

    // Thumbnail
    const thumb = document.createElement("div");
    thumb.className = "thumb";
    if (comp.sprites.length > 0) {
      const img = document.createElement("img");
      img.src = getOfficeSinglePath(comp.sprites[0].sprite.id);
      thumb.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `
      <div class="name">${comp.name} <span style="color:#666;font-weight:normal">#${comp.sprites[0]?.sprite.id ?? "?"}</span></div>
      <div class="meta">${comp.category} | occ ${comp.occupancy.w}x${comp.occupancy.h} ${comp.walkable ? "| walkable" : ""}</div>
    `;

    const actions = document.createElement("div");
    actions.className = "actions";
    actions.innerHTML = `<button class="edit">Edit</button><button class="delete">Del</button>`;

    actions.querySelector(".edit")!.addEventListener("click", (e) => {
      e.stopPropagation();
      if (comp.sprites.length > 0) {
        loadSpriteIntoWorkspace(comp.sprites[0].sprite.id);
      }
    });

    actions.querySelector(".delete")!.addEventListener("click", (e) => {
      e.stopPropagation();
      if (confirm(`Delete "${comp.name}"?`)) {
        state.composites = state.composites.filter((c) => c.id !== comp.id);
        if (state.editingId === comp.id) {
          state.editingId = null;
        }
        persist();
        renderAll();
      }
    });

    div.appendChild(thumb);
    div.appendChild(info);
    div.appendChild(actions);

    div.addEventListener("click", () => {
      if (comp.sprites.length > 0) {
        loadSpriteIntoWorkspace(comp.sprites[0].sprite.id);
      }
    });

    compositesContainer.appendChild(div);
  }

  compCount.textContent = `${count}/${state.composites.length}`;
}

// ─── Save / Actions ──────────────────────────────────────────────────────────

function saveComposite() {
  if (state.currentSpriteId === null) {
    setStatus("Nothing to save — load a sprite first.");
    return;
  }

  const name = inputName.value.trim();
  if (!name) {
    setStatus("Give the composite a name first!");
    inputName.focus();
    return;
  }

  const occ = computeOccupancyFromGrid();

  const comp: CompositeDefinition = {
    id: state.editingId ?? generateId(),
    name,
    category: inputCategory.value as CompositeCategory,
    displaySize: { w: SPRITE_TILES_W, h: SPRITE_TILES_H },
    occupancy: { w: occ.w, h: occ.h },
    occupancyOffset: { x: occ.ox, y: occ.oy },
    sprites: [
      {
        sprite: { id: state.currentSpriteId, collection: "office_singles" },
        offsetX: 0,
        offsetY: 0,
      },
    ],
    walkable: inputWalkable.checked,
  };

  if (state.editingId) {
    const idx = state.composites.findIndex((c) => c.id === state.editingId);
    if (idx >= 0) {
      state.composites[idx] = comp;
      setStatus(`Updated: ${name}`);
    }
  } else {
    state.composites.push(comp);
    state.editingId = comp.id;
    setStatus(`Saved new composite: ${name}`);
  }

  persist();
  renderAll();
}

function newComposite() {
  state.currentSpriteId = null;
  state.editingId = null;
  state.occupancy = initOccupancy();
  inputName.value = "";
  inputCategory.value = "furniture";
  inputWalkable.checked = false;
  inputOW.value = "1";
  inputOH.value = "1";
  inputOX.value = "0";
  inputOY.value = "0";
  previewArea.style.width = "";
  previewArea.style.height = "";
  renderAll();
  setStatus("New — drag or click a sprite to start.");
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY = "offisims_composites";

function persist() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.composites));
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) state.composites = JSON.parse(raw);
  } catch (e) {
    console.warn("Failed to load:", e);
  }
}

function exportJSON() {
  const json = JSON.stringify(state.composites, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "composites.json";
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported ${state.composites.length} composites`);
}

function importJSON() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      if (Array.isArray(data)) {
        state.composites = data;
      } else if (data.composites) {
        state.composites = data.composites;
      }
      persist();
      renderAll();
      setStatus(`Imported ${state.composites.length} composites`);
    } catch (e) {
      setStatus(`Import error: ${e}`);
    }
  };
  input.click();
}

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderAll() {
  renderSpriteBrowser();
  renderPreview();
  renderCompositeList();
}

function setStatus(msg: string) {
  statusBar.textContent = msg;
}

// ─── Event Binding ───────────────────────────────────────────────────────────

// Toolbar inputs that update occupancy from number fields
function onOccupancyInputChange() {
  const ow = Math.max(1, Math.min(SPRITE_TILES_W, parseInt(inputOW.value) || 1));
  const oh = Math.max(1, Math.min(SPRITE_TILES_H, parseInt(inputOH.value) || 1));
  const ox = Math.max(0, Math.min(SPRITE_TILES_W - ow, parseInt(inputOX.value) || 0));
  const oy = Math.max(0, Math.min(SPRITE_TILES_H - oh, parseInt(inputOY.value) || 0));

  inputOW.value = String(ow);
  inputOH.value = String(oh);
  inputOX.value = String(ox);
  inputOY.value = String(oy);

  // Rebuild occupancy grid
  state.occupancy = initOccupancy();
  for (let r = 0; r < oh; r++) {
    for (let c = 0; c < ow; c++) {
      state.occupancy[r + oy][c + ox] = true;
    }
  }
  renderPreview();
}

inputOW.addEventListener("change", onOccupancyInputChange);
inputOH.addEventListener("change", onOccupancyInputChange);
inputOX.addEventListener("change", onOccupancyInputChange);
inputOY.addEventListener("change", onOccupancyInputChange);

filterSearch.addEventListener("input", renderSpriteBrowser);
filterUsed.addEventListener("change", renderSpriteBrowser);
compListSearch.addEventListener("input", renderCompositeList);
compListCat.addEventListener("change", renderCompositeList);

document.getElementById("btn-save-comp")!.addEventListener("click", saveComposite);
document.getElementById("btn-new-comp")!.addEventListener("click", newComposite);
document.getElementById("btn-auto-detect")!.addEventListener("click", () => {
  if (state.currentSpriteId !== null) {
    autoDetectOccupancy(state.currentSpriteId);
  }
});
document.getElementById("btn-export")!.addEventListener("click", exportJSON);
document.getElementById("btn-import")!.addEventListener("click", importJSON);

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    newComposite();
  }
  if ((e.ctrlKey || e.metaKey) && e.key === "s") {
    e.preventDefault();
    saveComposite();
  }
  // Arrow keys to navigate sprites
  if (state.currentSpriteId !== null) {
    if (e.key === "ArrowRight" && state.currentSpriteId < OFFICE_SINGLES_COUNT) {
      e.preventDefault();
      loadSpriteIntoWorkspace(state.currentSpriteId + 1);
    }
    if (e.key === "ArrowLeft" && state.currentSpriteId > 1) {
      e.preventDefault();
      loadSpriteIntoWorkspace(state.currentSpriteId - 1);
    }
  }
});

// ─── Init ────────────────────────────────────────────────────────────────────

loadFromStorage();
renderAll();
setStatus(
  `${state.composites.length} composites loaded. ` +
  `Drag or click a sprite to annotate. Arrow keys to navigate. Ctrl+S to save.`
);
