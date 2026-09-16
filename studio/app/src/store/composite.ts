/**
 * Composite builder Zustand store.
 *
 * Manages workspace parts, selected brush, drag state, and editing mode.
 * Workspace is a WORKSPACE_COLS x WORKSPACE_ROWS tile grid.
 */

import { create } from 'zustand'
import { generateId } from '../lib/pack'
import type { TilesetRegion } from '@openlore/pack'

// ─── Constants ──────────────────────────────────────────────────────

export const WORKSPACE_COLS = 20
export const WORKSPACE_ROWS = 16

// ─── Types ──────────────────────────────────────────────────────────

export interface WorkspacePart {
  uid: string
  region: TilesetRegion
  /** Grid X position (tile col in workspace) */
  gridX: number
  /** Grid Y position (tile row in workspace) */
  gridY: number
  /** Manual z-bias for render-time sorting (default 0) */
  zBias: number
}

export interface BBox {
  minX: number
  minY: number
  maxX: number
  maxY: number
  w: number
  h: number
}

interface DragState {
  partUid: string
  offsetX: number
  offsetY: number
}

interface CompositeState {
  // Workspace
  parts: WorkspacePart[]
  selectedPartUid: string | null
  selectedBrush: TilesetRegion | null

  // Editing mode
  editingCompositeId: string | null
  name: string
  category: string

  // Canvas
  zoom: number
  showGrid: boolean

  // Drag state
  drag: DragState | null

  // Actions
  placeBrush: (gridX: number, gridY: number) => void
  selectPart: (uid: string | null) => void
  setBrush: (region: TilesetRegion | null) => void
  removePart: (uid: string) => void
  removeSelectedPart: () => void
  movePart: (uid: string, gridX: number, gridY: number) => void
  adjustZBias: (uid: string, delta: number) => void
  setZoom: (zoom: number) => void
  setShowGrid: (show: boolean) => void
  setName: (name: string) => void
  setCategory: (cat: string) => void
  startDrag: (partUid: string, offsetX: number, offsetY: number) => void
  endDrag: () => void
  clearWorkspace: () => void
  loadComposite: (
    id: string,
    name: string,
    category: string,
    parts: WorkspacePart[],
  ) => void

  // Computed
  getBBox: () => BBox | null
  getSortedParts: () => WorkspacePart[]
}

// ─── Store ──────────────────────────────────────────────────────────

export const useCompositeStore = create<CompositeState>()((set, get) => ({
  parts: [],
  selectedPartUid: null,
  selectedBrush: null,
  editingCompositeId: null,
  name: '',
  category: 'other',
  zoom: 1,
  showGrid: true,
  drag: null,

  placeBrush: (gridX, gridY) => {
    const { selectedBrush, parts } = get()
    if (!selectedBrush) return

    // Clamp to workspace
    const gx = Math.max(0, Math.min(WORKSPACE_COLS - selectedBrush.w, gridX))
    const gy = Math.max(0, Math.min(WORKSPACE_ROWS - selectedBrush.h, gridY))

    const newPart: WorkspacePart = {
      uid: generateId(),
      region: { ...selectedBrush },
      gridX: gx,
      gridY: gy,
      zBias: 0,
    }
    set({
      parts: [...parts, newPart],
      selectedPartUid: newPart.uid,
    })
  },

  selectPart: (uid) =>
    set({ selectedPartUid: uid, selectedBrush: uid ? null : get().selectedBrush }),

  setBrush: (region) =>
    set({ selectedBrush: region, selectedPartUid: null }),

  removePart: (uid) => {
    const { parts, selectedPartUid } = get()
    set({
      parts: parts.filter((p) => p.uid !== uid),
      selectedPartUid: selectedPartUid === uid ? null : selectedPartUid,
    })
  },

  removeSelectedPart: () => {
    const { selectedPartUid } = get()
    if (selectedPartUid) get().removePart(selectedPartUid)
  },

  movePart: (uid, gridX, gridY) => {
    set({
      parts: get().parts.map((p) =>
        p.uid === uid ? { ...p, gridX, gridY } : p,
      ),
    })
  },

  adjustZBias: (uid, delta) => {
    set({
      parts: get().parts.map((p) =>
        p.uid === uid ? { ...p, zBias: p.zBias + delta } : p,
      ),
    })
  },

  setZoom: (zoom) => set({ zoom: Math.min(Math.max(zoom, 0.05), 8) }),
  setShowGrid: (show) => set({ showGrid: show }),
  setName: (name) => set({ name }),
  setCategory: (cat) => set({ category: cat }),

  startDrag: (partUid, offsetX, offsetY) =>
    set({ drag: { partUid, offsetX, offsetY }, selectedPartUid: partUid, selectedBrush: null }),

  endDrag: () => set({ drag: null }),

  clearWorkspace: () =>
    set({
      parts: [],
      selectedPartUid: null,
      selectedBrush: null,
      editingCompositeId: null,
      name: '',
      category: 'other',
      drag: null,
    }),

  loadComposite: (id, name, category, parts) =>
    set({
      parts,
      selectedPartUid: null,
      selectedBrush: null,
      editingCompositeId: id,
      name,
      category,
      drag: null,
    }),

  getBBox: () => {
    const { parts } = get()
    if (parts.length === 0) return null
    let minX = Infinity, minY = Infinity
    let maxX = -Infinity, maxY = -Infinity
    for (const p of parts) {
      minX = Math.min(minX, p.gridX)
      minY = Math.min(minY, p.gridY)
      maxX = Math.max(maxX, p.gridX + (p.region.w || 1))
      maxY = Math.max(maxY, p.gridY + (p.region.h || 1))
    }
    return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY }
  },

  getSortedParts: () => {
    return [...get().parts].sort((a, b) => {
      const anchorA = a.gridY + (a.region.h || 1) + a.zBias
      const anchorB = b.gridY + (b.region.h || 1) + b.zBias
      if (anchorA !== anchorB) return anchorA - anchorB
      return a.gridX - b.gridX
    })
  },
}))
