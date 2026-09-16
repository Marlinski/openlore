/**
 * Room editor Zustand store.
 *
 * Manages all state for the Room tab: two modes (layout/texture),
 * walkability grid, doors, texture placements, drag/painting state,
 * and localStorage auto-save/restore.
 */

import { create } from 'zustand'
import {
  TILE_SIZE,
  PlacementLayer,
  createWalkabilityGrid,
  getPlacementSize,
  toPlacementLayer,
  isFloor,
  isObject,
} from '../lib/pack'
import type {
  DoorDefinition,
  TexturePlacement,
  TilesetRegion,
  RoomDefinition,
  CompositeObject,
} from '@openlore/pack'

// ─── Types ──────────────────────────────────────────────────────────

export type EditorMode = 'layout' | 'texture'
export type LayoutTool = 'walk' | 'door'
export type LayerTab = 'floor' | 'object' | 'both'

export type Brush =
  | { type: 'region'; region: TilesetRegion }
  | { type: 'composite'; compositeId: string }

// ─── Constants ──────────────────────────────────────────────────────

const EDITOR_STATE_KEY = 'openlore_room_editor_state'
const DEFAULT_WIDTH = 16
const DEFAULT_HEIGHT = 12
const MIN_SIZE = 4
const MAX_SIZE = 50

// ─── Store Shape ────────────────────────────────────────────────────

interface RoomState {
  // Editor mode
  mode: EditorMode
  layoutTool: LayoutTool
  layerTab: LayerTab

  // Room data
  roomWidth: number
  roomHeight: number
  walkability: boolean[]
  doors: DoorDefinition[]
  placements: TexturePlacement[]
  editingRoomName: string | null
  doorIdCounter: number

  // Selection / interaction
  selectedDoorId: string | null
  selectedBrush: Brush | null
  selectedPlacements: Set<number>
  inspectedTile: { col: number; row: number } | null
  lastUsedLayer: 'floor' | 'object'

  // Layout painting
  layoutPainting: boolean
  layoutPaintValue: boolean

  // Texture painting
  shiftPainting: boolean
  shiftPaintedCells: Set<string>

  // Drag
  draggingPlacementIdx: number | null
  dragOffset: { x: number; y: number }

  // Canvas
  zoom: number
  showGrid: boolean

  // Actions — mode/tool/layer
  setMode: (mode: EditorMode) => void
  setLayoutTool: (tool: LayoutTool) => void
  setLayerTab: (tab: LayerTab) => void
  setZoom: (zoom: number) => void
  setShowGrid: (show: boolean) => void

  // Actions — layout painting
  startLayoutPaint: (col: number, row: number, button: number) => void
  continueLayoutPaint: (col: number, row: number) => void
  stopLayoutPaint: () => void

  // Actions — door
  placeDoor: (col: number, row: number) => void
  selectDoor: (id: string | null) => void
  removeDoor: (id: string) => void
  setDoorTarget: (id: string, target: string) => void

  // Actions — texture
  setBrush: (brush: Brush | null) => void
  placeBrushAt: (
    col: number,
    row: number,
    getComposite: (id: string) => CompositeObject | undefined,
  ) => void
  startShiftPaint: () => void
  stampBrushAt: (
    col: number,
    row: number,
    getComposite: (id: string) => CompositeObject | undefined,
  ) => void
  stopShiftPaint: () => void
  setInspectedTile: (tile: { col: number; row: number } | null) => void
  selectPlacement: (idx: number, shift: boolean) => void
  clearSelection: () => void

  // Actions — drag
  startDrag: (idx: number, offsetX: number, offsetY: number) => void
  moveDrag: (
    mouseX: number,
    mouseY: number,
    getComposite: (id: string) => CompositeObject | undefined,
  ) => void
  endDrag: () => void

  // Actions — placement manipulation
  deletePlacements: (indices: number[]) => void
  changeLayer: (indices: number[], layer: 'floor' | 'object') => void
  adjustZBias: (idx: number, delta: number) => void

  // Actions — room management
  resizeRoom: (w: number, h: number, getComposite: (id: string) => CompositeObject | undefined) => void
  loadRoom: (room: RoomDefinition) => void
  clearRoom: () => void
  setEditingRoomName: (name: string | null) => void
  buildRoomDefinition: (name: string) => RoomDefinition

  // Actions — persistence
  autoSave: () => void
  restoreState: () => boolean
  clearSavedState: () => void

  // Helpers
  getDoorAt: (col: number, row: number) => DoorDefinition | undefined
  getPlacementsAtTile: (
    col: number,
    row: number,
    getComposite: (id: string) => CompositeObject | undefined,
  ) => number[]
  getBrushSize: (
    brush: Brush,
    getComposite: (id: string) => CompositeObject | undefined,
  ) => { w: number; h: number }
}

// ─── Store ──────────────────────────────────────────────────────────

export const useRoomStore = create<RoomState>()((set, get) => ({
  // Initial values
  mode: 'layout',
  layoutTool: 'walk',
  layerTab: 'floor',
  roomWidth: DEFAULT_WIDTH,
  roomHeight: DEFAULT_HEIGHT,
  walkability: createWalkabilityGrid(DEFAULT_WIDTH, DEFAULT_HEIGHT, true),
  doors: [],
  placements: [],
  editingRoomName: null,
  doorIdCounter: 1,
  selectedDoorId: null,
  selectedBrush: null,
  selectedPlacements: new Set<number>(),
  inspectedTile: null,
  lastUsedLayer: 'floor',
  layoutPainting: false,
  layoutPaintValue: false,
  shiftPainting: false,
  shiftPaintedCells: new Set<string>(),
  draggingPlacementIdx: null,
  dragOffset: { x: 0, y: 0 },
  zoom: 1,
  showGrid: true,

  // ─── Mode / Tool / Layer ──────────────────────────────────────

  setMode: (mode) =>
    set({
      mode,
      selectedPlacements: new Set(),
      selectedBrush: null,
      selectedDoorId: null,
      layoutPainting: false,
      shiftPainting: false,
      inspectedTile: null,
    }),

  setLayoutTool: (tool) =>
    set({ layoutTool: tool, selectedDoorId: null }),

  setLayerTab: (tab) =>
    set({
      layerTab: tab,
      selectedPlacements: new Set(),
      inspectedTile: null,
    }),

  setZoom: (zoom) => set({ zoom: Math.max(0.05, Math.min(8, zoom)) }),
  setShowGrid: (show) => set({ showGrid: show }),

  // ─── Layout Painting ──────────────────────────────────────────

  startLayoutPaint: (col, row, button) => {
    const { roomWidth, roomHeight, walkability } = get()
    if (col < 0 || col >= roomWidth || row < 0 || row >= roomHeight) return
    const paintValue = button === 2 // right-click = walkable
    const idx = row * roomWidth + col
    const newWalk = [...walkability]
    newWalk[idx] = paintValue
    set({ layoutPainting: true, layoutPaintValue: paintValue, walkability: newWalk })
  },

  continueLayoutPaint: (col, row) => {
    const { layoutPainting, layoutPaintValue, roomWidth, roomHeight, walkability } = get()
    if (!layoutPainting) return
    if (col < 0 || col >= roomWidth || row < 0 || row >= roomHeight) return
    const idx = row * roomWidth + col
    if (walkability[idx] === layoutPaintValue) return
    const newWalk = [...walkability]
    newWalk[idx] = layoutPaintValue
    set({ walkability: newWalk })
  },

  stopLayoutPaint: () => set({ layoutPainting: false }),

  // ─── Door Actions ─────────────────────────────────────────────

  placeDoor: (col, row) => {
    const { doors, doorIdCounter, roomWidth, roomHeight, walkability } = get()
    if (col < 0 || col >= roomWidth || row < 0 || row >= roomHeight) return

    // Check if door already exists at tile
    const existing = doors.find((d) => d.col === col && d.row === row)
    if (existing) {
      set({ selectedDoorId: existing.id })
      return
    }

    const id = `door-${doorIdCounter}`
    const newDoor = { id, col, row, target: '' } as DoorDefinition
    const idx = row * roomWidth + col
    const newWalk = [...walkability]
    newWalk[idx] = true // door tiles are always walkable

    set({
      doors: [...doors, newDoor],
      doorIdCounter: doorIdCounter + 1,
      walkability: newWalk,
      selectedDoorId: id,
    })
  },

  selectDoor: (id) => set({ selectedDoorId: id }),

  removeDoor: (id) => {
    const { doors, selectedDoorId } = get()
    set({
      doors: doors.filter((d) => d.id !== id),
      selectedDoorId: selectedDoorId === id ? null : selectedDoorId,
    })
  },

  setDoorTarget: (id, target) => {
    set({
      doors: get().doors.map((d) => (d.id === id ? { ...d, target } : d)),
    })
  },

  // ─── Texture — Brush & Placement ──────────────────────────────

  setBrush: (brush) =>
    set({ selectedBrush: brush, selectedPlacements: new Set() }),

  placeBrushAt: (col, row, getComposite) => {
    const { selectedBrush, roomWidth, roomHeight, layerTab, lastUsedLayer, placements } = get()
    if (!selectedBrush) return

    const size = get().getBrushSize(selectedBrush, getComposite)
    const gridX = Math.min(Math.max(col, 0), roomWidth - size.w)
    const gridY = Math.min(Math.max(row, 0), roomHeight - size.h)
    if (gridX < 0 || gridY < 0) return

    let layer: 'floor' | 'object'
    if (layerTab === 'floor') layer = 'floor'
    else if (layerTab === 'object') layer = 'object'
    else layer = lastUsedLayer

    const placementLayer = toPlacementLayer(layer)

    const placement =
      selectedBrush.type === 'region'
        ? ({ gridX, gridY, layer: placementLayer, region: { ...selectedBrush.region } } as TexturePlacement)
        : ({ gridX, gridY, layer: placementLayer, compositeId: selectedBrush.compositeId } as TexturePlacement)

    const newPlacements = [...placements, placement]
    const newIdx = newPlacements.length - 1

    set({
      placements: newPlacements,
      selectedPlacements: new Set([newIdx]),
      lastUsedLayer: layer,
    })
  },

  startShiftPaint: () =>
    set({ shiftPainting: true, shiftPaintedCells: new Set() }),

  stampBrushAt: (col, row, getComposite) => {
    const { shiftPaintedCells } = get()
    const key = `${col},${row}`
    if (shiftPaintedCells.has(key)) return
    const newCells = new Set(shiftPaintedCells)
    newCells.add(key)
    set({ shiftPaintedCells: newCells })
    get().placeBrushAt(col, row, getComposite)
  },

  stopShiftPaint: () =>
    set({ shiftPainting: false, shiftPaintedCells: new Set() }),

  setInspectedTile: (tile) => set({ inspectedTile: tile }),

  selectPlacement: (idx, shift) => {
    const { selectedPlacements } = get()
    if (shift) {
      const next = new Set(selectedPlacements)
      if (next.has(idx)) next.delete(idx)
      else next.add(idx)
      set({ selectedPlacements: next, selectedBrush: null })
    } else {
      if (!selectedPlacements.has(idx)) {
        set({ selectedPlacements: new Set([idx]), selectedBrush: null })
      }
      // If already selected (might be multi-select), keep for drag
    }
  },

  clearSelection: () =>
    set({ selectedPlacements: new Set(), selectedBrush: null, inspectedTile: null }),

  // ─── Drag ─────────────────────────────────────────────────────

  startDrag: (idx, offsetX, offsetY) =>
    set({ draggingPlacementIdx: idx, dragOffset: { x: offsetX, y: offsetY } }),

  moveDrag: (mouseX, mouseY, getComposite) => {
    const { draggingPlacementIdx, dragOffset, placements, selectedPlacements, roomWidth, roomHeight, zoom } = get()
    if (draggingPlacementIdx === null) return

    const anchor = placements[draggingPlacementIdx]
    if (!anchor) return

    const ts = TILE_SIZE * zoom
    const anchorSize = getPlacementSize(anchor, getComposite) ?? { w: 1, h: 1 }

    let newX = Math.round((mouseX - dragOffset.x) / ts)
    let newY = Math.round((mouseY - dragOffset.y) / ts)
    newX = Math.max(0, Math.min(roomWidth - anchorSize.w, newX))
    newY = Math.max(0, Math.min(roomHeight - anchorSize.h, newY))

    const dx = newX - (anchor.gridX || 0)
    const dy = newY - (anchor.gridY || 0)
    if (dx === 0 && dy === 0) return

    const newPlacements = placements.map((p, i) => {
      if (!selectedPlacements.has(i)) return p
      const size = getPlacementSize(p, getComposite) ?? { w: 1, h: 1 }
      let gx = (p.gridX || 0) + dx
      let gy = (p.gridY || 0) + dy
      gx = Math.max(0, Math.min(roomWidth - size.w, gx))
      gy = Math.max(0, Math.min(roomHeight - size.h, gy))
      return { ...p, gridX: gx, gridY: gy }
    })

    set({ placements: newPlacements })
  },

  endDrag: () => set({ draggingPlacementIdx: null, dragOffset: { x: 0, y: 0 } }),

  // ─── Placement Manipulation ───────────────────────────────────

  deletePlacements: (indices) => {
    const sorted = [...indices].sort((a, b) => b - a) // reverse order
    const { placements, selectedPlacements } = get()
    const newPlacements = [...placements]
    for (const i of sorted) {
      newPlacements.splice(i, 1)
    }
    // Rebuild selection: shift indices above removed ones
    const newSel = new Set<number>()
    for (const selIdx of selectedPlacements) {
      if (indices.includes(selIdx)) continue
      let shifted = selIdx
      for (const removedIdx of sorted) {
        if (removedIdx < selIdx) shifted--
      }
      newSel.add(shifted)
    }
    set({ placements: newPlacements, selectedPlacements: newSel, inspectedTile: null })
  },

  changeLayer: (indices, layer) => {
    set({
      placements: get().placements.map((p, i) =>
        indices.includes(i) ? { ...p, layer: toPlacementLayer(layer) } : p,
      ),
    })
  },

  adjustZBias: (idx, delta) => {
    set({
      placements: get().placements.map((p, i) =>
        i === idx ? { ...p, zBias: (p.zBias ?? 0) + delta } : p,
      ),
    })
  },

  // ─── Room Management ──────────────────────────────────────────

  resizeRoom: (w, h, getComposite) => {
    const newW = Math.max(MIN_SIZE, Math.min(MAX_SIZE, w))
    const newH = Math.max(MIN_SIZE, Math.min(MAX_SIZE, h))
    const { roomWidth, roomHeight, walkability, doors, placements } = get()

    // Preserve existing walkability
    const newWalk = createWalkabilityGrid(newW, newH, true)
    for (let row = 0; row < Math.min(newH, roomHeight); row++) {
      for (let col = 0; col < Math.min(newW, roomWidth); col++) {
        newWalk[row * newW + col] = walkability[row * roomWidth + col]
      }
    }

    // Remove out-of-bounds doors
    const newDoors = doors.filter((d) => d.col < newW && d.row < newH)

    // Remove out-of-bounds placements
    const newPlacements = placements.filter((p) => {
      const size = getPlacementSize(p, getComposite)
      if (!size) return false
      return (p.gridX || 0) + size.w <= newW && (p.gridY || 0) + size.h <= newH
    })

    set({
      roomWidth: newW,
      roomHeight: newH,
      walkability: newWalk,
      doors: newDoors,
      placements: newPlacements,
      selectedPlacements: new Set(),
      inspectedTile: null,
    })
  },

  loadRoom: (room) => {
    // Parse door IDs to reset counter
    let maxDoorNum = 0
    for (const d of room.doors) {
      const m = d.id.match(/^door-(\d+)$/)
      if (m) maxDoorNum = Math.max(maxDoorNum, parseInt(m[1], 10))
    }

    set({
      roomWidth: room.width,
      roomHeight: room.height,
      walkability: [...room.walkability],
      doors: room.doors.map((d) => ({ ...d })),
      placements: room.placements.map((p) => ({
        ...p,
        gridX: p.gridX || 0,
        gridY: p.gridY || 0,
      })),
      doorIdCounter: maxDoorNum + 1,
      editingRoomName: room.name,
      selectedDoorId: null,
      selectedBrush: null,
      selectedPlacements: new Set(),
      inspectedTile: null,
      layoutPainting: false,
      shiftPainting: false,
      shiftPaintedCells: new Set(),
      draggingPlacementIdx: null,
    })
  },

  clearRoom: () =>
    set({
      roomWidth: DEFAULT_WIDTH,
      roomHeight: DEFAULT_HEIGHT,
      walkability: createWalkabilityGrid(DEFAULT_WIDTH, DEFAULT_HEIGHT, true),
      doors: [],
      placements: [],
      doorIdCounter: 1,
      editingRoomName: null,
      selectedDoorId: null,
      selectedBrush: null,
      selectedPlacements: new Set(),
      inspectedTile: null,
      layoutPainting: false,
      shiftPainting: false,
    }),

  setEditingRoomName: (name) => set({ editingRoomName: name }),

  buildRoomDefinition: (name) => {
    const { roomWidth, roomHeight, walkability, doors, placements } = get()
    return {
      name,
      width: roomWidth,
      height: roomHeight,
      walkability: [...walkability],
      doors: doors.map((d) => ({ ...d })),
      placements: placements.map((p) => ({ ...p })),
    } as RoomDefinition
  },

  // ─── Persistence ──────────────────────────────────────────────

  autoSave: () => {
    const s = get()
    try {
      const data = {
        roomWidth: s.roomWidth,
        roomHeight: s.roomHeight,
        walkability: [...s.walkability],
        doors: s.doors.map((d) => ({ ...d })),
        doorIdCounter: s.doorIdCounter,
        placements: s.placements.map((p) => ({ ...p })),
        editingRoomName: s.editingRoomName,
        mode: s.mode,
        layoutTool: s.layoutTool,
        layerTab: s.layerTab,
      }
      localStorage.setItem(EDITOR_STATE_KEY, JSON.stringify(data))
    } catch {
      // silently ignore
    }
  },

  restoreState: () => {
    try {
      const raw = localStorage.getItem(EDITOR_STATE_KEY)
      if (!raw) return false
      const data = JSON.parse(raw)

      if (typeof data.roomWidth !== 'number' || typeof data.roomHeight !== 'number') return false
      if (!Array.isArray(data.walkability) || !Array.isArray(data.doors) || !Array.isArray(data.placements)) return false

      // Filter stale placements
      const placements = data.placements.filter(
        (p: any) => p.region || p.compositeId,
      )

      let maxDoorNum = 0
      for (const d of data.doors) {
        const m = d.id?.match?.(/^door-(\d+)$/)
        if (m) maxDoorNum = Math.max(maxDoorNum, parseInt(m[1], 10))
      }

      const mode: EditorMode =
        data.mode === 'layout' || data.mode === 'texture' ? data.mode : 'layout'
      const layoutTool: LayoutTool =
        data.layoutTool === 'walk' || data.layoutTool === 'door' ? data.layoutTool : 'walk'
      const layerTab: LayerTab =
        data.layerTab === 'floor' || data.layerTab === 'object' || data.layerTab === 'both'
          ? data.layerTab : 'floor'

      set({
        roomWidth: data.roomWidth,
        roomHeight: data.roomHeight,
        walkability: data.walkability,
        doors: data.doors,
        placements,
        doorIdCounter: data.doorIdCounter ?? maxDoorNum + 1,
        editingRoomName: data.editingRoomName ?? null,
        mode,
        layoutTool,
        layerTab,
        selectedDoorId: null,
        selectedBrush: null,
        selectedPlacements: new Set(),
        inspectedTile: null,
      })
      return true
    } catch {
      return false
    }
  },

  clearSavedState: () => {
    try {
      localStorage.removeItem(EDITOR_STATE_KEY)
    } catch {
      // ignore
    }
  },

  // ─── Helpers ──────────────────────────────────────────────────

  getDoorAt: (col, row) =>
    get().doors.find((d) => d.col === col && d.row === row),

  getPlacementsAtTile: (col, row, getComposite) => {
    const { placements } = get()
    const indices: number[] = []
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]
      const size = getPlacementSize(p, getComposite)
      if (!size) continue
      if (col >= (p.gridX || 0) && col < (p.gridX || 0) + size.w && row >= (p.gridY || 0) && row < (p.gridY || 0) + size.h) {
        indices.push(i)
      }
    }
    return indices
  },

  getBrushSize: (brush, getComposite) => {
    if (brush.type === 'region') {
      return { w: brush.region.w || 1, h: brush.region.h || 1 }
    }
    const comp = getComposite(brush.compositeId)
    return comp ? { w: comp.displayWidth || 1, h: comp.displayHeight || 1 } : { w: 1, h: 1 }
  },
}))

// ─── Selectors (convenience) ────────────────────────────────────────

/** Compute room stats for display. */
export function computeRoomStats(state: RoomState) {
  const total = state.roomWidth * state.roomHeight
  const walkableCount = state.walkability.filter(Boolean).length
  const floorCount = state.placements.filter((p) => isFloor(p)).length
  const objectCount = state.placements.filter((p) => isObject(p)).length
  return { total, walkableCount, floorCount, objectCount }
}

/** Parse a door target string "roomName#doorId". */
export function parseDoorTarget(target: string): [string, string] {
  if (!target || !target.includes('#')) return ['', '']
  const parts = target.split('#', 2)
  return [parts[0], parts[1]]
}

/** Check if there are unsaved changes. */
export function hasUnsavedChanges(state: RoomState): boolean {
  return (
    state.placements.length > 0 ||
    state.doors.length > 0 ||
    state.walkability.some((v) => !v)
  )
}
