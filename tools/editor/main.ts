/**
 * Floor Plan Editor Tool
 *
 * Create room layouts by:
 * 1. Painting floor tiles onto a grid
 * 2. Painting wall tiles
 * 3. Placing composite objects (loaded from annotator output)
 * 4. Saving/loading room plans as JSON
 */

import {
  CompositeDefinition,
  RoomPlan,
  PlacedComposite,
  SpriteRef,
  TILE_SIZE,
  OFFICE_SINGLES_COUNT,
  getOfficeSinglePath,
} from "../../src/shared/types";

// ─── Types ───────────────────────────────────────────────────────────────────

type Tool = "floor" | "wall" | "object" | "erase" | "select";

// Known floor tile sprite IDs (common floor patterns from the singles set)
// These are a starting set; users can type any sprite ID
const FLOOR_TILE_IDS = [
  10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27,
  28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
  80, 81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96,
];

// Known wall tile sprite IDs
const WALL_TILE_IDS = [
  1, 2, 3, 4, 5, 6, 7, 8, 9,
  41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59,
  60, 61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79,
];

// ─── State ───────────────────────────────────────────────────────────────────

interface AppState {
  room: RoomPlan;
  composites: CompositeDefinition[];
  tool: Tool;
  selectedFloorTile: SpriteRef | null;
  selectedWallTile: SpriteRef | null;
  selectedComposite: string | null; // composite id
  zoom: number;
  showGrid: boolean;
  showOccupancy: boolean;
  isDragging: boolean;
}

const state: AppState = {
  room: {
    name: "Office",
    width: 16,
    height: 12,
    floor: [],
    walls: [],
    objects: [],
  },
  composites: [],
  tool: "floor",
  selectedFloorTile: null,
  selectedWallTile: null,
  selectedComposite: null,
  zoom: 2,
  showGrid: true,
  showOccupancy: false,
  isDragging: false,
};

// Initialize empty grid
function initGrid() {
  state.room.floor = [];
  state.room.walls = [];
  for (let y = 0; y < state.room.height; y++) {
    state.room.floor.push(new Array(state.room.width).fill(null));
    state.room.walls.push(new Array(state.room.width).fill(null));
  }
}
initGrid();

// ─── DOM refs ────────────────────────────────────────────────────────────────

const roomCanvas = document.getElementById("room-canvas")!;
const ghostPreview = document.getElementById("ghost-preview")!;
const objectsList = document.getElementById("objects-list")!;
const statusBar = document.getElementById("status")!;

const inputRoomName = document.getElementById("room-name") as HTMLInputElement;
const inputRoomW = document.getElementById("room-w") as HTMLInputElement;
const inputRoomH = document.getElementById("room-h") as HTMLInputElement;
const zoomSelect = document.getElementById("zoom-level") as HTMLSelectElement;
const showGridCheck = document.getElementById("show-grid") as HTMLInputElement;
const showOccupancyCheck = document.getElementById("show-occupancy") as HTMLInputElement;

const floorSection = document.getElementById("floor-section")!;
const wallSection = document.getElementById("wall-section")!;
const objectSection = document.getElementById("object-section")!;

// ─── Tool Selection ──────────────────────────────────────────────────────────

const toolButtons = {
  floor: document.getElementById("tool-floor")!,
  wall: document.getElementById("tool-wall")!,
  object: document.getElementById("tool-object")!,
  erase: document.getElementById("tool-erase")!,
  select: document.getElementById("tool-select")!,
};

function setTool(tool: Tool) {
  state.tool = tool;
  Object.values(toolButtons).forEach((b) => b.classList.remove("active"));
  toolButtons[tool].classList.add("active");

  floorSection.style.display = tool === "floor" ? "" : "none";
  wallSection.style.display = tool === "wall" ? "" : "none";
  objectSection.style.display = tool === "object" ? "" : "none";
  document.getElementById("composite-list-palette")!.style.display =
    tool === "object" ? "" : "none";

  ghostPreview.style.display = "none";
  setStatus(`Tool: ${tool}`);
}

for (const [tool, btn] of Object.entries(toolButtons)) {
  btn.addEventListener("click", () => setTool(tool as Tool));
}

// ─── Floor/Wall Tile Pickers ─────────────────────────────────────────────────

function renderTilePicker(
  container: HTMLElement,
  tileIds: number[],
  selectedRef: SpriteRef | null,
  onSelect: (ref: SpriteRef) => void
) {
  container.innerHTML = "";
  for (const id of tileIds) {
    const div = document.createElement("div");
    div.className = "floor-tile-thumb";
    if (selectedRef?.id === id) div.classList.add("selected");

    const img = document.createElement("img");
    img.src = getOfficeSinglePath(id);
    img.loading = "lazy";
    div.appendChild(img);

    div.addEventListener("click", () => {
      onSelect({ id, collection: "office_singles" });
    });

    container.appendChild(div);
  }
}

function renderFloorPicker() {
  renderTilePicker(
    document.getElementById("floor-tiles")!,
    FLOOR_TILE_IDS,
    state.selectedFloorTile,
    (ref) => {
      state.selectedFloorTile = ref;
      renderFloorPicker();
      setStatus(`Selected floor tile #${ref.id}`);
    }
  );
}

function renderWallPicker() {
  renderTilePicker(
    document.getElementById("wall-tiles")!,
    WALL_TILE_IDS,
    state.selectedWallTile,
    (ref) => {
      state.selectedWallTile = ref;
      renderWallPicker();
      setStatus(`Selected wall tile #${ref.id}`);
    }
  );
}

// ─── Composite Picker ────────────────────────────────────────────────────────

function renderCompositePicker() {
  const container = document.getElementById("composite-list-palette")!;
  container.innerHTML = "";

  const catFilter = (document.getElementById("comp-cat-filter") as HTMLSelectElement).value;
  const nameFilter = (document.getElementById("comp-name-filter") as HTMLInputElement).value
    .toLowerCase()
    .trim();

  for (const comp of state.composites) {
    if (catFilter !== "all" && comp.category !== catFilter) continue;
    if (nameFilter && !comp.name.toLowerCase().includes(nameFilter)) continue;

    // Skip floor/wall composites from object placement
    if (comp.category === "floor" || comp.category === "wall") continue;

    const div = document.createElement("div");
    div.className = "comp-palette-item";
    if (state.selectedComposite === comp.id) div.classList.add("selected");

    // Build a small preview
    const preview = document.createElement("div");
    preview.className = "preview";
    const previewScale = 48 / (Math.max(comp.displaySize.w, comp.displaySize.h) * TILE_SIZE);
    for (const tile of comp.tiles) {
      const img = document.createElement("img");
      img.src = getOfficeSinglePath(tile.sprite.id);
      img.style.left = `${tile.dx * TILE_SIZE * previewScale}px`;
      img.style.top = `${tile.dy * TILE_SIZE * previewScale}px`;
      img.style.width = `${TILE_SIZE * previewScale}px`;
      img.style.height = `${TILE_SIZE * previewScale}px`;
      preview.appendChild(img);
    }

    const info = document.createElement("div");
    info.className = "info";
    info.innerHTML = `
      <span class="name">${comp.name}</span>
      <span class="meta">${comp.category} | ${comp.displaySize.w}x${comp.displaySize.h} | occ ${comp.occupancy.w}x${comp.occupancy.h}</span>
    `;

    div.appendChild(preview);
    div.appendChild(info);

    div.addEventListener("click", () => {
      state.selectedComposite = comp.id;
      renderCompositePicker();
      setStatus(`Selected composite: ${comp.name}`);
    });

    container.appendChild(div);
  }

  if (container.children.length === 0) {
    container.innerHTML =
      '<div style="padding:12px; font-size:11px; color:#666;">No composites loaded. Import from Annotator first.</div>';
  }
}

document.getElementById("comp-cat-filter")!.addEventListener("change", renderCompositePicker);
document.getElementById("comp-name-filter")!.addEventListener("input", renderCompositePicker);

// ─── Room Canvas Rendering ───────────────────────────────────────────────────

function renderRoomCanvas() {
  // Clear existing cells (keep ghost preview)
  const cells = roomCanvas.querySelectorAll(".room-cell, .placed-composite");
  cells.forEach((c) => c.remove());

  const cellPx = TILE_SIZE * state.zoom;
  roomCanvas.style.width = `${state.room.width * cellPx}px`;
  roomCanvas.style.height = `${state.room.height * cellPx}px`;

  // Render floor and wall cells
  for (let y = 0; y < state.room.height; y++) {
    for (let x = 0; x < state.room.width; x++) {
      const cell = document.createElement("div");
      cell.className = "room-cell";
      cell.style.left = `${x * cellPx}px`;
      cell.style.top = `${y * cellPx}px`;
      cell.style.width = `${cellPx}px`;
      cell.style.height = `${cellPx}px`;

      if (!state.showGrid) {
        cell.style.border = "none";
      }

      // Floor layer
      const floorRef = state.room.floor[y]?.[x];
      if (floorRef) {
        cell.classList.add("has-floor");
        const img = document.createElement("img");
        img.className = "floor-img";
        img.src = getOfficeSinglePath(floorRef.id);
        cell.appendChild(img);
      }

      // Wall layer
      const wallRef = state.room.walls[y]?.[x];
      if (wallRef) {
        cell.classList.add("has-wall");
        const img = document.createElement("img");
        img.className = "wall-img";
        img.src = getOfficeSinglePath(wallRef.id);
        cell.appendChild(img);
      }

      // Mouse events for painting
      cell.dataset.x = String(x);
      cell.dataset.y = String(y);

      cell.addEventListener("mousedown", (e) => {
        e.preventDefault();
        state.isDragging = true;
        handleCellAction(x, y, e);
      });

      cell.addEventListener("mouseenter", (e) => {
        if (state.isDragging) {
          handleCellAction(x, y, e);
        }
        updateGhostPreview(x, y);
      });

      cell.addEventListener("mouseleave", () => {
        if (state.tool === "object") {
          // keep ghost visible while on canvas
        }
      });

      roomCanvas.appendChild(cell);
    }
  }

  // Render placed composites
  renderPlacedComposites();
}

function handleCellAction(x: number, y: number, e: MouseEvent) {
  switch (state.tool) {
    case "floor":
      if (e.button === 2 || e.shiftKey) {
        state.room.floor[y][x] = null;
      } else if (state.selectedFloorTile) {
        state.room.floor[y][x] = { ...state.selectedFloorTile };
      }
      renderRoomCanvas();
      break;

    case "wall":
      if (e.button === 2 || e.shiftKey) {
        state.room.walls[y][x] = null;
      } else if (state.selectedWallTile) {
        state.room.walls[y][x] = { ...state.selectedWallTile };
      }
      renderRoomCanvas();
      break;

    case "erase":
      state.room.floor[y][x] = null;
      state.room.walls[y][x] = null;
      // Also remove any composite whose occupancy covers this cell
      state.room.objects = state.room.objects.filter((placed) => {
        const comp = state.composites.find((c) => c.id === placed.compositeId);
        if (!comp) return true;
        for (let oy = 0; oy < comp.occupancy.h; oy++) {
          for (let ox = 0; ox < comp.occupancy.w; ox++) {
            if (placed.gridX + ox === x && placed.gridY - oy === y) return false;
          }
        }
        return true;
      });
      renderRoomCanvas();
      renderObjectsList();
      break;

    case "object":
      if (!state.isDragging || e.type !== "mousedown") break;
      if (state.selectedComposite) {
        placeComposite(x, y);
      }
      break;
  }

  autosave();
}

function placeComposite(gridX: number, gridY: number) {
  const comp = state.composites.find((c) => c.id === state.selectedComposite);
  if (!comp) return;

  // gridX, gridY = bottom-left of occupancy
  // Check bounds
  if (gridX + comp.occupancy.w > state.room.width) return;
  if (gridY - comp.occupancy.h + 1 < 0) return;

  // Check if occupancy area overlaps with existing composites
  // (optional - could allow overlap for layering)

  const placed: PlacedComposite = {
    compositeId: comp.id,
    gridX,
    gridY,
  };

  state.room.objects.push(placed);

  // Sort objects by render order (top to bottom, left to right)
  state.room.objects.sort((a, b) => {
    if (a.gridY !== b.gridY) return a.gridY - b.gridY;
    return a.gridX - b.gridX;
  });

  renderRoomCanvas();
  renderObjectsList();
  setStatus(`Placed ${comp.name} at (${gridX}, ${gridY})`);
}

function renderPlacedComposites() {
  const cellPx = TILE_SIZE * state.zoom;

  for (const placed of state.room.objects) {
    const comp = state.composites.find((c) => c.id === placed.compositeId);
    if (!comp) continue;

    const container = document.createElement("div");
    container.className = "placed-composite";

    // Display rect: top-left is at (gridX, gridY - displayH + 1)
    const displayTopLeftX = placed.gridX;
    const displayTopLeftY = placed.gridY - (comp.displaySize.h - 1);

    container.style.left = `${displayTopLeftX * cellPx}px`;
    container.style.top = `${displayTopLeftY * cellPx}px`;
    container.style.width = `${comp.displaySize.w * cellPx}px`;
    container.style.height = `${comp.displaySize.h * cellPx}px`;

    for (const tile of comp.tiles) {
      const img = document.createElement("img");
      img.src = getOfficeSinglePath(tile.sprite.id);
      img.style.left = `${tile.dx * cellPx}px`;
      img.style.top = `${tile.dy * cellPx}px`;
      img.style.width = `${cellPx}px`;
      img.style.height = `${cellPx}px`;
      container.appendChild(img);
    }

    // Occupancy overlay
    if (state.showOccupancy) {
      for (let oy = 0; oy < comp.occupancy.h; oy++) {
        for (let ox = 0; ox < comp.occupancy.w; ox++) {
          const overlay = document.createElement("div");
          overlay.className = "occupancy-overlay";
          // Occupancy is anchored at bottom-left of display
          const occDX = ox;
          const occDY = comp.displaySize.h - 1 - oy;
          overlay.style.left = `${occDX * cellPx}px`;
          overlay.style.top = `${occDY * cellPx}px`;
          overlay.style.width = `${cellPx}px`;
          overlay.style.height = `${cellPx}px`;
          container.appendChild(overlay);
        }
      }
    }

    roomCanvas.appendChild(container);
  }
}

function updateGhostPreview(gridX: number, gridY: number) {
  if (state.tool !== "object" || !state.selectedComposite) {
    ghostPreview.style.display = "none";
    return;
  }

  const comp = state.composites.find((c) => c.id === state.selectedComposite);
  if (!comp) return;

  const cellPx = TILE_SIZE * state.zoom;
  const displayTopLeftX = gridX;
  const displayTopLeftY = gridY - (comp.displaySize.h - 1);

  ghostPreview.innerHTML = "";
  ghostPreview.style.display = "";
  ghostPreview.style.left = `${displayTopLeftX * cellPx}px`;
  ghostPreview.style.top = `${displayTopLeftY * cellPx}px`;
  ghostPreview.style.width = `${comp.displaySize.w * cellPx}px`;
  ghostPreview.style.height = `${comp.displaySize.h * cellPx}px`;

  for (const tile of comp.tiles) {
    const img = document.createElement("img");
    img.src = getOfficeSinglePath(tile.sprite.id);
    img.style.left = `${tile.dx * cellPx}px`;
    img.style.top = `${tile.dy * cellPx}px`;
    img.style.width = `${cellPx}px`;
    img.style.height = `${cellPx}px`;
    ghostPreview.appendChild(img);
  }
}

// ─── Objects List ────────────────────────────────────────────────────────────

function renderObjectsList() {
  objectsList.innerHTML = "";
  for (let i = 0; i < state.room.objects.length; i++) {
    const placed = state.room.objects[i];
    const comp = state.composites.find((c) => c.id === placed.compositeId);

    const div = document.createElement("div");
    div.className = "placed-obj-item";
    div.innerHTML = `
      <span>${comp?.name ?? placed.compositeId} @ (${placed.gridX}, ${placed.gridY})</span>
      <button data-idx="${i}">Del</button>
    `;

    div.querySelector("button")!.addEventListener("click", () => {
      state.room.objects.splice(i, 1);
      renderRoomCanvas();
      renderObjectsList();
      autosave();
    });

    objectsList.appendChild(div);
  }
}

// ─── Persistence ─────────────────────────────────────────────────────────────

const STORAGE_KEY_ROOM = "offisims_room";
const STORAGE_KEY_COMPOSITES = "offisims_composites";

function autosave() {
  localStorage.setItem(STORAGE_KEY_ROOM, JSON.stringify(state.room));
}

function loadFromStorage() {
  try {
    const roomRaw = localStorage.getItem(STORAGE_KEY_ROOM);
    if (roomRaw) {
      state.room = JSON.parse(roomRaw);
      inputRoomName.value = state.room.name;
      inputRoomW.value = String(state.room.width);
      inputRoomH.value = String(state.room.height);
    }
  } catch (e) {
    console.warn("Failed to load room:", e);
  }

  try {
    const compRaw = localStorage.getItem(STORAGE_KEY_COMPOSITES);
    if (compRaw) {
      state.composites = JSON.parse(compRaw);
    }
  } catch (e) {
    console.warn("Failed to load composites:", e);
  }
}

function exportRoom() {
  state.room.name = inputRoomName.value.trim() || "room";
  const json = JSON.stringify(state.room, null, 2);
  const blob = new Blob([json], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${state.room.name}.room.json`;
  a.click();
  URL.revokeObjectURL(url);
  setStatus(`Exported room: ${state.room.name}`);
}

function loadRoom() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".json";
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const text = await file.text();
      state.room = JSON.parse(text);
      inputRoomName.value = state.room.name;
      inputRoomW.value = String(state.room.width);
      inputRoomH.value = String(state.room.height);
      renderAll();
      autosave();
      setStatus(`Loaded room: ${state.room.name}`);
    } catch (e) {
      setStatus(`Load error: ${e}`);
    }
  };
  input.click();
}

function importComposites() {
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
      localStorage.setItem(STORAGE_KEY_COMPOSITES, JSON.stringify(state.composites));
      renderCompositePicker();
      setStatus(`Loaded ${state.composites.length} composites`);
    } catch (e) {
      setStatus(`Import error: ${e}`);
    }
  };
  input.click();
}

// ─── Controls ────────────────────────────────────────────────────────────────

document.getElementById("btn-resize")!.addEventListener("click", () => {
  const newW = Math.max(4, parseInt(inputRoomW.value) || 16);
  const newH = Math.max(4, parseInt(inputRoomH.value) || 12);

  // Resize preserving existing data
  const newFloor: (SpriteRef | null)[][] = [];
  const newWalls: (SpriteRef | null)[][] = [];
  for (let y = 0; y < newH; y++) {
    const floorRow: (SpriteRef | null)[] = [];
    const wallRow: (SpriteRef | null)[] = [];
    for (let x = 0; x < newW; x++) {
      floorRow.push(state.room.floor[y]?.[x] ?? null);
      wallRow.push(state.room.walls[y]?.[x] ?? null);
    }
    newFloor.push(floorRow);
    newWalls.push(wallRow);
  }

  state.room.width = newW;
  state.room.height = newH;
  state.room.floor = newFloor;
  state.room.walls = newWalls;

  // Remove objects that are out of bounds
  state.room.objects = state.room.objects.filter(
    (o) => o.gridX < newW && o.gridY < newH
  );

  renderAll();
  autosave();
  setStatus(`Resized to ${newW}x${newH}`);
});

zoomSelect.addEventListener("change", () => {
  state.zoom = parseInt(zoomSelect.value);
  renderRoomCanvas();
});

showGridCheck.addEventListener("change", () => {
  state.showGrid = showGridCheck.checked;
  renderRoomCanvas();
});

showOccupancyCheck.addEventListener("change", () => {
  state.showOccupancy = showOccupancyCheck.checked;
  renderRoomCanvas();
});

document.getElementById("btn-export-room")!.addEventListener("click", exportRoom);
document.getElementById("btn-load-room")!.addEventListener("click", loadRoom);
document.getElementById("btn-save-room")!.addEventListener("click", () => {
  state.room.name = inputRoomName.value.trim() || "room";
  autosave();
  setStatus(`Saved room to browser storage: ${state.room.name}`);
});
document.getElementById("btn-import-composites")!.addEventListener("click", importComposites);

// Global mouse up to stop dragging
document.addEventListener("mouseup", () => {
  state.isDragging = false;
});

// Prevent context menu on canvas
roomCanvas.addEventListener("contextmenu", (e) => e.preventDefault());

// ─── Rendering ───────────────────────────────────────────────────────────────

function renderAll() {
  renderFloorPicker();
  renderWallPicker();
  renderCompositePicker();
  renderRoomCanvas();
  renderObjectsList();
}

function setStatus(msg: string) {
  statusBar.textContent = msg;
}

// ─── Init ────────────────────────────────────────────────────────────────────

loadFromStorage();
renderAll();
setStatus(
  `Room: ${state.room.name} (${state.room.width}x${state.room.height}). ` +
  `${state.composites.length} composites loaded. ` +
  `Select a tool and start editing.`
);
