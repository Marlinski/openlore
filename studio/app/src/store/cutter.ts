/**
 * CutterStore — Zustand store for the Tile Cutter tab.
 *
 * Holds all shared state for the cutter: tileset selection, drag FSM,
 * pending selection, cut entries, resize/move state, shared tags,
 * editing state, and preview FPS.
 *
 * Components subscribe to slices of this store via selectors.
 * Canvas-only transient state (mouse pixel coords, animation frame indices)
 * lives in component-local refs, not here.
 */

import { create } from 'zustand'
import { generateId } from '../lib/pack'

// ─── Drag FSM ───────────────────────────────────────────────────────

export type DragMode = 'idle' | 'dragging' | 'locked'

export interface DragState {
  mode: DragMode
  /** Drag origin in tile coords */
  anchorCol: number
  anchorRow: number
  /** Current mouse tile coords (updated during drag) */
  currentCol: number
  currentRow: number
  /** Locked frame template (set when entering "locked" mode) */
  frameRect: { col: number; row: number; w: number; h: number } | null
  /** Number of frames in the sequence */
  frameCount: number
}

const INITIAL_DRAG: DragState = {
  mode: 'idle',
  anchorCol: 0,
  anchorRow: 0,
  currentCol: 0,
  currentRow: 0,
  frameRect: null,
  frameCount: 1,
}

// ─── Pending Selection ──────────────────────────────────────────────

export interface PendingSelection {
  col: number
  row: number
  frameWidth: number
  frameHeight: number
  frameCount: number
}

// ─── Cut Entry ──────────────────────────────────────────────────────

export interface CutEntry {
  id: string
  name: string
  tags: string[]
  col: number
  row: number
  frameWidth: number
  frameHeight: number
  frameCount: number
}

// ─── Resize / Move ──────────────────────────────────────────────────

export type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

export interface ResizeState {
  cutId: string
  handle: ResizeHandle
  originalCol: number
  originalRow: number
  originalFrameWidth: number
  originalFrameHeight: number
  originalFrameCount: number
}

export interface MoveState {
  cutId: string
  offsetCol: number
  offsetRow: number
  didMove: boolean
}

// ─── Cut colors ─────────────────────────────────────────────────────

const CUT_COLORS = [
  '#e06c75', '#e5c07b', '#61afef', '#c678dd', '#56b6c2',
  '#98c379', '#d19a66', '#be5046', '#7ec8e3', '#c8ccd4',
]

export function getCutColor(idx: number): string {
  return CUT_COLORS[idx % CUT_COLORS.length]
}

// ─── Store Shape ────────────────────────────────────────────────────

interface CutterStoreState {
  // --- Tileset ---
  tilesetId: string | null
  zoom: number
  showGrid: boolean
  showCuts: boolean
  showResources: boolean

  // --- Drag FSM ---
  drag: DragState

  // --- Pending selection ---
  pendingSelection: PendingSelection | null

  // --- Cuts ---
  cuts: CutEntry[]
  selectedCutId: string | null
  editingCutId: string | null

  // --- Editing existing resource ---
  editingResourceId: string | null

  // --- Resize / Move (transient interaction state) ---
  resizing: ResizeState | null
  moving: MoveState | null

  // --- Preview FPS ---
  previewFps: number
}

interface CutterStoreActions {
  // --- Tileset ---
  setTilesetId: (id: string | null) => void
  setZoom: (zoom: number) => void
  setShowGrid: (show: boolean) => void
  setShowCuts: (show: boolean) => void
  setShowResources: (show: boolean) => void

  // --- Drag FSM ---
  startDrag: (anchorCol: number, anchorRow: number) => void
  updateDrag: (col: number, row: number) => void
  lockDrag: () => void
  lockFromSelection: () => void
  updateLockedDrag: (mouseCol: number, totalCols: number) => void
  resetDrag: () => void

  // --- Pending selection ---
  setPendingSelection: (sel: PendingSelection | null) => void
  commitDragAsSelection: (totalCols: number) => void

  // --- Cuts ---
  addCut: (name: string, tags: string[], sel: PendingSelection) => void
  updateCut: (id: string, patch: Partial<Omit<CutEntry, 'id'>>) => void
  removeCut: (id: string) => void
  setCuts: (cuts: CutEntry[]) => void
  clearCuts: () => void
  selectCut: (id: string | null) => void

  // --- Editing ---
  setEditingCutId: (id: string | null) => void
  setEditingResourceId: (id: string | null) => void

  // --- Resize / Move ---
  startResize: (state: ResizeState) => void
  stopResize: () => void
  startMove: (state: MoveState) => void
  updateMove: (col: number, row: number) => void
  stopMove: () => void

  // --- Shared tags (derived from intersection of all cuts' tags) ---
  addSharedTag: (tag: string) => void
  removeSharedTag: (tag: string) => void

  // --- Preview ---
  setPreviewFps: (fps: number) => void

  // --- Bulk ---
  clearSelection: () => void
  switchTileset: (id: string | null) => void
}

export type CutterStore = CutterStoreState & CutterStoreActions

// ─── Helpers ────────────────────────────────────────────────────────

/** Get the normalized rectangle from anchor -> current (handles any drag direction) */
function getDragRect(drag: DragState): { col: number; row: number; w: number; h: number } {
  const minCol = Math.min(drag.anchorCol, drag.currentCol)
  const maxCol = Math.max(drag.anchorCol, drag.currentCol)
  const minRow = Math.min(drag.anchorRow, drag.currentRow)
  const maxRow = Math.max(drag.anchorRow, drag.currentRow)
  return { col: minCol, row: minRow, w: maxCol - minCol + 1, h: maxRow - minRow + 1 }
}

/** Compute frame count from mouse position in locked mode */
function computeFrameCount(
  mouseCol: number,
  frameRect: { col: number; w: number },
  totalCols: number,
): number {
  const offset = mouseCol - frameRect.col + 1
  const count = Math.max(1, Math.ceil(offset / frameRect.w))
  const maxFrames = Math.floor((totalCols - frameRect.col) / frameRect.w)
  return Math.min(count, Math.max(1, maxFrames))
}

// ─── Store ──────────────────────────────────────────────────────────

export const useCutterStore = create<CutterStore>()((set, get) => ({
  // --- Initial state ---
  tilesetId: null,
  zoom: 1,
  showGrid: true,
  showCuts: true,
  showResources: false,
  drag: { ...INITIAL_DRAG },
  pendingSelection: null,
  cuts: [],
  selectedCutId: null,
  editingCutId: null,
  editingResourceId: null,
  resizing: null,
  moving: null,
  previewFps: 4,

  // --- Tileset ---
  setTilesetId: (id) => set({ tilesetId: id }),
  setZoom: (zoom) => set({ zoom }),
  setShowGrid: (show) => set({ showGrid: show }),
  setShowCuts: (show) => set({ showCuts: show }),
  setShowResources: (show) => set({ showResources: show }),

  // --- Drag FSM ---
  startDrag: (anchorCol, anchorRow) =>
    set({
      drag: {
        mode: 'dragging',
        anchorCol,
        anchorRow,
        currentCol: anchorCol,
        currentRow: anchorRow,
        frameRect: null,
        frameCount: 1,
      },
    }),

  updateDrag: (col, row) =>
    set((s) => ({
      drag: { ...s.drag, currentCol: col, currentRow: row },
    })),

  lockDrag: () =>
    set((s) => {
      if (s.drag.mode !== 'dragging') return s
      const rect = getDragRect(s.drag)
      return {
        drag: {
          ...s.drag,
          mode: 'locked',
          frameRect: rect,
          frameCount: 1,
        },
      }
    }),

  lockFromSelection: () =>
    set((s) => {
      if (s.drag.mode !== 'idle' || !s.pendingSelection) return s
      const sel = s.pendingSelection
      const rect = { col: sel.col, row: sel.row, w: sel.frameWidth, h: sel.frameHeight }
      return {
        drag: {
          mode: 'locked' as DragMode,
          anchorCol: sel.col,
          anchorRow: sel.row,
          currentCol: sel.col + sel.frameWidth - 1,
          currentRow: sel.row + sel.frameHeight - 1,
          frameRect: rect,
          frameCount: sel.frameCount,
        },
        pendingSelection: null,
      }
    }),

  updateLockedDrag: (mouseCol, totalCols) =>
    set((s) => {
      if (s.drag.mode !== 'locked' || !s.drag.frameRect) return s
      const frameCount = computeFrameCount(mouseCol, s.drag.frameRect, totalCols)
      return {
        drag: { ...s.drag, currentCol: mouseCol, frameCount },
      }
    }),

  resetDrag: () => set({ drag: { ...INITIAL_DRAG } }),

  // --- Pending selection ---
  setPendingSelection: (sel) => set({ pendingSelection: sel }),

  commitDragAsSelection: (totalCols) =>
    set((s) => {
      const { drag } = s
      if (drag.mode === 'idle') return s

      let sel: PendingSelection
      if (drag.mode === 'locked' && drag.frameRect) {
        const fr = drag.frameRect
        const fc = computeFrameCount(drag.currentCol, fr, totalCols)
        sel = {
          col: fr.col,
          row: fr.row,
          frameWidth: fr.w,
          frameHeight: fr.h,
          frameCount: fc,
        }
      } else {
        const rect = getDragRect(drag)
        sel = {
          col: rect.col,
          row: rect.row,
          frameWidth: rect.w,
          frameHeight: rect.h,
          frameCount: 1,
        }
      }

      return {
        pendingSelection: sel,
        drag: { ...INITIAL_DRAG },
        editingCutId: null,
        editingResourceId: null,
        selectedCutId: null,
      }
    }),

  // --- Cuts ---
  addCut: (name, tags, sel) =>
    set((s) => ({
      cuts: [
        ...s.cuts,
        {
          id: generateId(),
          name,
          tags,
          col: sel.col,
          row: sel.row,
          frameWidth: sel.frameWidth,
          frameHeight: sel.frameHeight,
          frameCount: sel.frameCount,
        },
      ],
    })),

  updateCut: (id, patch) =>
    set((s) => ({
      cuts: s.cuts.map((c) => (c.id === id ? { ...c, ...patch } : c)),
    })),

  removeCut: (id) =>
    set((s) => ({
      cuts: s.cuts.filter((c) => c.id !== id),
      selectedCutId: s.selectedCutId === id ? null : s.selectedCutId,
      editingCutId: s.editingCutId === id ? null : s.editingCutId,
    })),

  setCuts: (cuts) => set({ cuts }),

  clearCuts: () =>
    set({ cuts: [], selectedCutId: null, editingCutId: null }),

  selectCut: (id) => set({ selectedCutId: id }),

  // --- Editing ---
  setEditingCutId: (id) => set({ editingCutId: id }),
  setEditingResourceId: (id) => set({ editingResourceId: id }),

  // --- Resize / Move ---
  startResize: (state) => set({ resizing: state }),
  stopResize: () => set({ resizing: null }),

  startMove: (state) => set({ moving: state }),
  updateMove: (col, row) =>
    set((s) => {
      if (!s.moving) return s
      const cut = s.cuts.find((c) => c.id === s.moving!.cutId)
      if (!cut) return { moving: null }
      const newCol = col - s.moving.offsetCol
      const newRow = row - s.moving.offsetRow
      if (newCol === cut.col && newRow === cut.row) return s
      return {
        moving: { ...s.moving, didMove: true },
        cuts: s.cuts.map((c) =>
          c.id === s.moving!.cutId
            ? { ...c, col: Math.max(0, newCol), row: Math.max(0, newRow) }
            : c,
        ),
      }
    }),
  stopMove: () => set({ moving: null }),

  // --- Shared tags (derived — mutate all cuts) ---
  addSharedTag: (tag) =>
    set((s) => ({
      cuts: s.cuts.map((c) =>
        c.tags.includes(tag) ? c : { ...c, tags: [...c.tags, tag] },
      ),
    })),

  removeSharedTag: (tag) =>
    set((s) => ({
      cuts: s.cuts.map((c) => ({
        ...c,
        tags: c.tags.filter((t) => t !== tag),
      })),
    })),

  // --- Preview ---
  setPreviewFps: (fps) => set({ previewFps: fps }),

  // --- Bulk actions ---
  clearSelection: () =>
    set({
      pendingSelection: null,
      selectedCutId: null,
      editingCutId: null,
      editingResourceId: null,
      drag: { ...INITIAL_DRAG },
    }),

  switchTileset: (id) =>
    set({
      tilesetId: id,
      cuts: [],
      selectedCutId: null,
      editingCutId: null,
      editingResourceId: null,
      pendingSelection: null,
      drag: { ...INITIAL_DRAG },
      resizing: null,
      moving: null,
    }),
}))

// ─── Derived selectors (for use in components) ─────────────────────

/** Compute shared tags = strict intersection of all cuts' tags.
 *  Returns empty array when there are 0 cuts. */
export function getSharedTags(cuts: CutEntry[]): string[] {
  if (cuts.length === 0) return []
  // Start with the first cut's tag set, intersect with each subsequent cut
  let shared = new Set(cuts[0].tags)
  for (let i = 1; i < cuts.length; i++) {
    const cutTags = new Set(cuts[i].tags)
    shared = new Set([...shared].filter((t) => cutTags.has(t)))
    if (shared.size === 0) return []
  }
  return [...shared]
}

/** Find a cut that contains the given tile coordinate */
export function findCutAtTile(
  cuts: CutEntry[],
  col: number,
  row: number,
): CutEntry | null {
  // Search in reverse so topmost (last added) wins
  for (let i = cuts.length - 1; i >= 0; i--) {
    const cut = cuts[i]
    const totalCols = cut.frameWidth * cut.frameCount
    if (
      col >= cut.col &&
      col < cut.col + totalCols &&
      row >= cut.row &&
      row < cut.row + cut.frameHeight
    ) {
      return cut
    }
  }
  return null
}

/** Auto-suggest a name from the tileset label and position */
export function suggestCutName(
  label: string | undefined,
  row: number,
  col: number,
): string {
  const shortLabel = (label ?? 'tileset')
    .replace(/[^a-zA-Z0-9]/g, '_')
    .toLowerCase()
    .slice(0, 20)
  return `${shortLabel}_r${row}_c${col}`
}
