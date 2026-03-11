/**
 * Reusable Tileset Picker component.
 *
 * Renders a tileset image on a canvas with a grid overlay.
 * Supports click (1×1 tile) and drag (N×M region) selection.
 * Emits the selected TilesetRegion via a callback.
 *
 * Tileset metadata is resolved dynamically from appState.tilesets
 * rather than a hardcoded TILESETS constant, so user-added tilesets
 * work automatically.
 *
 * Usage:
 *   const picker = new TilesetPicker(container, onSelect);
 *   picker.setTileset("office_combined");
 *   picker.setZoom(2);
 */

import { type TilesetId, type TilesetRegion, type TilesetDefinition } from "@offisims/shared";
import { appState } from "./state.js";

/** Global tileset image cache shared across all pickers */
const imageCache: Map<string, HTMLImageElement> = new Map();

export function loadTilesetImage(tilesetId: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(tilesetId);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const info = appState.getTileset(tilesetId);
    if (!info) { reject(new Error(`Unknown tileset ${tilesetId}`)); return; }
    const img = new Image();
    img.onload = () => {
      imageCache.set(tilesetId, img);
      // Lazily compute cols/rows from actual image dimensions if not yet known
      if (info.cols === 0 || info.rows === 0) {
        info.cols = Math.floor(img.naturalWidth / info.tileWidth);
        info.rows = Math.floor(img.naturalHeight / info.tileHeight);
      }
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load ${info.path}`));
    img.src = info.path;
  });
}

export function getCachedTilesetImage(tilesetId: string): HTMLImageElement | undefined {
  return imageCache.get(tilesetId);
}

/** Invalidate a cached image (e.g. when tileset is re-imported) */
export function invalidateTilesetCache(tilesetId: string): void {
  imageCache.delete(tilesetId);
}

export type OnSelectRegion = (region: TilesetRegion) => void;

export class TilesetPicker {
  private container: HTMLElement;
  private canvas: HTMLCanvasElement;
  private selectionOverlay: HTMLDivElement;
  private onSelect: OnSelectRegion;

  private tilesetId: TilesetId = "office_combined";
  private zoom = 1;
  private showGrid = true;
  private img: HTMLImageElement | null = null;

  // Drag state
  private dragging = false;
  private dragStartCol = 0;
  private dragStartRow = 0;
  private dragEndCol = 0;
  private dragEndRow = 0;

  /** Currently highlighted selection (persists after drag) */
  private selection: TilesetRegion | null = null;

  constructor(container: HTMLElement, onSelect: OnSelectRegion) {
    this.container = container;
    this.onSelect = onSelect;

    // Create inner wrapper for positioning
    const inner = document.createElement("div");
    inner.style.cssText = "position: relative; display: inline-block;";
    container.appendChild(inner);

    // Canvas
    this.canvas = document.createElement("canvas");
    this.canvas.style.cssText = "display: block; image-rendering: pixelated; cursor: crosshair;";
    inner.appendChild(this.canvas);

    // Selection overlay
    this.selectionOverlay = document.createElement("div");
    this.selectionOverlay.style.cssText =
      "position: absolute; border: 2px solid #e94560; background: rgba(233,69,96,0.2); pointer-events: none; display: none; z-index: 10;";
    inner.appendChild(this.selectionOverlay);

    // Mouse events
    this.canvas.addEventListener("mousedown", (e) => this.handleMouseDown(e));
    this.canvas.addEventListener("mousemove", (e) => this.handleMouseMove(e));
    window.addEventListener("mouseup", () => this.handleMouseUp());
  }

  /** Get the TilesetDefinition for the current tileset, or undefined */
  private getInfo(): TilesetDefinition | undefined {
    return appState.getTileset(this.tilesetId);
  }

  setTileset(id: TilesetId): void {
    this.tilesetId = id;
    this.selection = null;
    this.selectionOverlay.style.display = "none";
    loadTilesetImage(id).then((img) => {
      this.img = img;
      this.draw();
    });
  }

  setZoom(z: number): void {
    this.zoom = z;
    this.draw();
  }

  setShowGrid(show: boolean): void {
    this.showGrid = show;
    this.draw();
  }

  getTilesetId(): TilesetId {
    return this.tilesetId;
  }

  getSelection(): TilesetRegion | null {
    return this.selection;
  }

  clearSelection(): void {
    this.selection = null;
    this.selectionOverlay.style.display = "none";
  }

  draw(): void {
    if (!this.img) return;
    const info = this.getInfo();
    if (!info) return;

    const tw = info.tileWidth * this.zoom;
    const th = info.tileHeight * this.zoom;
    const w = info.cols * tw;
    const h = info.rows * th;

    this.canvas.width = w;
    this.canvas.height = h;
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;

    const ctx = this.canvas.getContext("2d")!;
    ctx.imageSmoothingEnabled = false;

    // Draw tileset
    ctx.drawImage(this.img, 0, 0, w, h);

    // Grid
    if (this.showGrid) {
      ctx.strokeStyle = "rgba(255, 255, 255, 0.12)";
      ctx.lineWidth = 1;
      for (let x = 0; x <= info.cols; x++) {
        ctx.beginPath();
        ctx.moveTo(x * tw + 0.5, 0);
        ctx.lineTo(x * tw + 0.5, h);
        ctx.stroke();
      }
      for (let y = 0; y <= info.rows; y++) {
        ctx.beginPath();
        ctx.moveTo(0, y * th + 0.5);
        ctx.lineTo(w, y * th + 0.5);
        ctx.stroke();
      }
    }

    // Update selection overlay position
    this.updateSelectionOverlay();
  }

  private getGridPos(e: MouseEvent): { col: number; row: number } | null {
    const info = this.getInfo();
    if (!info) return null;
    const rect = this.canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const tw = info.tileWidth * this.zoom;
    const th = info.tileHeight * this.zoom;
    const col = Math.floor(x / tw);
    const row = Math.floor(y / th);
    if (col < 0 || col >= info.cols || row < 0 || row >= info.rows) return null;
    return { col, row };
  }

  private handleMouseDown(e: MouseEvent): void {
    if (e.button !== 0) return;
    e.preventDefault();
    const pos = this.getGridPos(e);
    if (!pos) return;

    this.dragging = true;
    this.dragStartCol = pos.col;
    this.dragStartRow = pos.row;
    this.dragEndCol = pos.col;
    this.dragEndRow = pos.row;
    this.updateDragOverlay();
  }

  private handleMouseMove(e: MouseEvent): void {
    if (!this.dragging) return;
    const pos = this.getGridPos(e);
    if (!pos) return;

    this.dragEndCol = pos.col;
    this.dragEndRow = pos.row;
    this.updateDragOverlay();
  }

  private handleMouseUp(): void {
    if (!this.dragging) return;
    this.dragging = false;

    const minCol = Math.min(this.dragStartCol, this.dragEndCol);
    const minRow = Math.min(this.dragStartRow, this.dragEndRow);
    const maxCol = Math.max(this.dragStartCol, this.dragEndCol);
    const maxRow = Math.max(this.dragStartRow, this.dragEndRow);

    const region: TilesetRegion = {
      tilesetId: this.tilesetId,
      srcCol: minCol,
      srcRow: minRow,
      w: maxCol - minCol + 1,
      h: maxRow - minRow + 1,
    };

    this.selection = region;
    this.updateSelectionOverlay();
    this.onSelect(region);
  }

  private updateDragOverlay(): void {
    const info = this.getInfo();
    if (!info) return;
    const tw = info.tileWidth * this.zoom;
    const th = info.tileHeight * this.zoom;
    const minCol = Math.min(this.dragStartCol, this.dragEndCol);
    const minRow = Math.min(this.dragStartRow, this.dragEndRow);
    const maxCol = Math.max(this.dragStartCol, this.dragEndCol);
    const maxRow = Math.max(this.dragStartRow, this.dragEndRow);

    this.selectionOverlay.style.display = "block";
    this.selectionOverlay.style.left = `${minCol * tw}px`;
    this.selectionOverlay.style.top = `${minRow * th}px`;
    this.selectionOverlay.style.width = `${(maxCol - minCol + 1) * tw}px`;
    this.selectionOverlay.style.height = `${(maxRow - minRow + 1) * th}px`;
  }

  private updateSelectionOverlay(): void {
    if (!this.selection) {
      this.selectionOverlay.style.display = "none";
      return;
    }

    const info = this.getInfo();
    if (!info) return;
    const tw = info.tileWidth * this.zoom;
    const th = info.tileHeight * this.zoom;
    const r = this.selection;
    this.selectionOverlay.style.display = "block";
    this.selectionOverlay.style.left = `${r.srcCol * tw}px`;
    this.selectionOverlay.style.top = `${r.srcRow * th}px`;
    this.selectionOverlay.style.width = `${r.w * tw}px`;
    this.selectionOverlay.style.height = `${r.h * th}px`;
  }
}

// ─── Helpers for populating tileset filterable lists ───────────────

import { FilterableList } from "./filterable-list.js";
export { FilterableList } from "./filterable-list.js";

/**
 * Create (or update) a FilterableList of tilesets inside a container element.
 *
 * On first call, creates the FilterableList and populates it.
 * On subsequent calls with the same container, updates the item list
 * (preserving selection & filter text).
 *
 * @param container The DOM element that will contain the filterable list.
 * @param defaultId Optional tileset id to select by default.
 * @param filter Optional predicate to include only matching tilesets.
 * @returns The FilterableList instance.
 */
const listInstances = new Map<HTMLElement, FilterableList>();

export function populateTilesetList(
  container: HTMLElement,
  defaultId?: string,
  filter?: (ts: TilesetDefinition) => boolean,
): FilterableList {
  let list = listInstances.get(container);
  if (!list) {
    list = new FilterableList(container);
    listInstances.set(container, list);
  }

  const tilesets = filter ? appState.tilesets.filter(filter) : appState.tilesets;
  const items = tilesets.map((ts) => ({
    id: ts.id,
    label: ts.label,
    meta: ts.path, // include path for search matching
  }));
  list.setItems(items);

  if (defaultId) {
    list.setDefault(defaultId);
  } else if (!list.getValue() && tilesets.length > 0) {
    list.setDefault(tilesets[0].id);
  }

  return list;
}
