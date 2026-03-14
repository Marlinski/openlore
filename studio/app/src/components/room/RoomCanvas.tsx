/**
 * RoomCanvas — Main canvas + overlay divs for the room editor.
 *
 * Handles all mouse events for both layout and texture modes.
 * Delegates drawing to RoomCanvasDraw pure functions.
 */

import { useRef, useEffect, useCallback, useMemo } from 'preact/hooks'
import { TILE_SIZE, getPlacementSize, isFloor, isObject } from '../../lib/pack'
import type { CompositeObject } from '@offisims/pack'
import { useRoomStore } from '../../store/room'
import { useComposites } from '../../api/composites'
import {
  drawLayoutMode,
  drawTextureMode,
  drawGrid,
} from './RoomCanvasDraw'
import type { DrawContext } from './RoomCanvasDraw'

export function RoomCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLDivElement>(null)
  const paintCursorRef = useRef<HTMLDivElement>(null)

  // Store state
  const mode = useRoomStore((s) => s.mode)
  const layoutTool = useRoomStore((s) => s.layoutTool)
  const layerTab = useRoomStore((s) => s.layerTab)
  const roomWidth = useRoomStore((s) => s.roomWidth)
  const roomHeight = useRoomStore((s) => s.roomHeight)
  const walkability = useRoomStore((s) => s.walkability)
  const doors = useRoomStore((s) => s.doors)
  const placements = useRoomStore((s) => s.placements)
  const selectedDoorId = useRoomStore((s) => s.selectedDoorId)
  const selectedBrush = useRoomStore((s) => s.selectedBrush)
  const selectedPlacements = useRoomStore((s) => s.selectedPlacements)
  const zoom = useRoomStore((s) => s.zoom)
  const showGrid = useRoomStore((s) => s.showGrid)
  const draggingPlacementIdx = useRoomStore((s) => s.draggingPlacementIdx)
  const shiftPainting = useRoomStore((s) => s.shiftPainting)

  const { data: composites = [] } = useComposites()

  const getComposite = useCallback(
    (id: string): CompositeObject | undefined =>
      composites.find((c) => c.id === id),
    [composites],
  )

  // ─── Draw ─────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ts = TILE_SIZE * zoom
    const w = roomWidth * ts
    const h = roomHeight * ts

    canvas.width = w
    canvas.height = h
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    if (innerRef.current) {
      innerRef.current.style.width = `${w}px`
      innerRef.current.style.height = `${h}px`
    }

    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    // Background
    ctx.fillStyle = '#1a1a2e'
    ctx.fillRect(0, 0, w, h)

    const dc: DrawContext = { ctx, ts, roomWidth, roomHeight }

    if (mode === 'layout') {
      drawLayoutMode(dc, walkability, doors, selectedDoorId)
    } else {
      drawTextureMode(dc, placements, walkability, doors, layerTab, getComposite, () => {
        // Re-draw when a missing image loads
        requestAnimationFrame(() => draw())
      })
    }

    if (showGrid) {
      drawGrid(dc)
    }

    // Auto-save after every render
    useRoomStore.getState().autoSave()
  }, [
    mode,
    roomWidth,
    roomHeight,
    walkability,
    doors,
    placements,
    selectedDoorId,
    layerTab,
    zoom,
    showGrid,
    getComposite,
  ])

  useEffect(() => {
    draw()
  }, [draw])

  // ─── Grid position helper ─────────────────────────────────────

  const getGridPos = useCallback(
    (e: MouseEvent): { col: number; row: number } | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const ts = TILE_SIZE * zoom
      const col = Math.floor(x / ts)
      const row = Math.floor(y / ts)
      if (col < 0 || col >= roomWidth || row < 0 || row >= roomHeight) return null
      return { col, row }
    },
    [zoom, roomWidth, roomHeight],
  )

  // ─── Layout mode mouse handlers ───────────────────────────────

  const handleLayoutMouseDown = useCallback(
    (e: MouseEvent) => {
      e.preventDefault()
      const pos = getGridPos(e)
      if (!pos) return

      if (layoutTool === 'walk') {
        useRoomStore.getState().startLayoutPaint(pos.col, pos.row, e.button)
      } else if (layoutTool === 'door') {
        useRoomStore.getState().placeDoor(pos.col, pos.row)
      }
    },
    [getGridPos, layoutTool],
  )

  const handleLayoutMouseMove = useCallback(
    (e: MouseEvent) => {
      if (layoutTool !== 'walk') return
      const pos = getGridPos(e)
      if (!pos) return
      useRoomStore.getState().continueLayoutPaint(pos.col, pos.row)
    },
    [getGridPos, layoutTool],
  )

  // ─── Texture mode mouse handlers ──────────────────────────────

  const handleTextureMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const pos = getGridPos(e)
      if (!pos) return

      const store = useRoomStore.getState()
      store.setInspectedTile(pos)

      if (e.shiftKey && store.selectedBrush) {
        store.startShiftPaint()
        store.stampBrushAt(pos.col, pos.row, getComposite)
        return
      }

      if (store.selectedBrush) {
        store.placeBrushAt(pos.col, pos.row, getComposite)
      } else {
        // Click empty area → clear
        store.clearSelection()
      }
    },
    [getGridPos, getComposite],
  )

  const handleTextureMouseMove = useCallback(
    (e: MouseEvent) => {
      const store = useRoomStore.getState()

      // Shift painting
      if (store.shiftPainting && store.selectedBrush) {
        const pos = getGridPos(e)
        if (pos) store.stampBrushAt(pos.col, pos.row, getComposite)
        return
      }

      // Paint cursor
      const cursor = paintCursorRef.current
      if (cursor && store.selectedBrush) {
        const pos = getGridPos(e)
        if (pos) {
          const ts = TILE_SIZE * zoom
          const size = store.getBrushSize(store.selectedBrush, getComposite)
          cursor.style.display = 'block'
          cursor.style.left = `${pos.col * ts}px`
          cursor.style.top = `${pos.row * ts}px`
          cursor.style.width = `${size.w * ts}px`
          cursor.style.height = `${size.h * ts}px`
        } else {
          cursor.style.display = 'none'
        }
      } else if (cursor) {
        cursor.style.display = 'none'
      }
    },
    [getGridPos, getComposite, zoom],
  )

  // ─── Overlay mousedown: select/drag placements ────────────────

  const handleOverlayMouseDown = useCallback(
    (e: MouseEvent, placementIdx: number) => {
      e.stopPropagation()
      e.preventDefault()

      const store = useRoomStore.getState()
      const pos = getGridPos(e)
      if (pos) store.setInspectedTile(pos)

      // If shift+brush active, paint instead of select
      if (e.shiftKey && store.selectedBrush) {
        store.startShiftPaint()
        if (pos) store.stampBrushAt(pos.col, pos.row, getComposite)
        return
      }

      // If brush active, place on top (stacking)
      if (store.selectedBrush && e.button === 0) {
        if (pos) store.placeBrushAt(pos.col, pos.row, getComposite)
        return
      }

      // Select
      if (e.shiftKey) {
        store.selectPlacement(placementIdx, true)
      } else {
        store.selectPlacement(placementIdx, false)
      }

      // Start drag (if selection non-empty and not shift-toggling)
      if (!e.shiftKey && store.selectedPlacements.size > 0) {
        const ts = TILE_SIZE * zoom
        const p = store.placements[placementIdx]
        const rect = innerRef.current?.getBoundingClientRect()
        if (rect && p) {
          const ox = e.clientX - rect.left - p.gridX * ts
          const oy = e.clientY - rect.top - p.gridY * ts
          store.startDrag(placementIdx, ox, oy)
        }
      }
    },
    [getGridPos, getComposite, zoom],
  )

  // ─── Drag movement ────────────────────────────────────────────

  const handleDragMove = useCallback(
    (e: MouseEvent) => {
      if (draggingPlacementIdx === null) return
      const rect = innerRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      useRoomStore.getState().moveDrag(x, y, getComposite)
    },
    [draggingPlacementIdx, getComposite],
  )

  // ─── Global mouseup ───────────────────────────────────────────

  useEffect(() => {
    const handler = () => {
      const store = useRoomStore.getState()
      store.stopLayoutPaint()
      store.stopShiftPaint()
      if (store.draggingPlacementIdx !== null) {
        store.endDrag()
      }
      const cursor = paintCursorRef.current
      if (cursor) cursor.style.display = 'none'
    }
    window.addEventListener('mouseup', handler)
    return () => window.removeEventListener('mouseup', handler)
  }, [])

  // ─── Keyboard ─────────────────────────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      const store = useRoomStore.getState()

      if (mode === 'texture') {
        if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedPlacements.size > 0) {
          e.preventDefault()
          store.deletePlacements([...store.selectedPlacements])
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          store.clearSelection()
        }
      }

      if (mode === 'layout') {
        if (e.key === 'Escape') {
          e.preventDefault()
          store.stopLayoutPaint()
          store.selectDoor(null)
        }
        if ((e.key === 'Delete' || e.key === 'Backspace') && store.selectedDoorId) {
          e.preventDefault()
          store.removeDoor(store.selectedDoorId)
        }
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [mode])

  // ─── Context menu prevention ──────────────────────────────────

  const handleContextMenu = useCallback((e: Event) => {
    e.preventDefault()
  }, [])

  // ─── Scroll-to-zoom ───────────────────────────────────────────

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      const delta = -e.deltaY * 0.001
      useRoomStore.getState().setZoom(zoom * (1 + delta))
    },
    [zoom],
  )

  // ─── Canvas mouse leave ───────────────────────────────────────

  const handleMouseLeave = useCallback(() => {
    const cursor = paintCursorRef.current
    if (cursor) cursor.style.display = 'none'
  }, [])

  // ─── Placement overlays ───────────────────────────────────────

  const ts = TILE_SIZE * zoom

  // Only show overlays in texture mode
  const visibleOverlays = useMemo(() => {
    if (mode !== 'texture') return []
    return placements
      .map((p, i) => {
        // Filter by layer tab
        if (layerTab === 'floor' && !isFloor(p)) return null
        if (layerTab === 'object' && !isObject(p)) return null
        const size = getPlacementSize(p, getComposite)
        if (!size) return null
        return { p, i, size }
      })
      .filter(Boolean) as { p: typeof placements[0]; i: number; size: { w: number; h: number } }[]
  }, [mode, placements, layerTab, getComposite])

  // ─── Mouse event dispatcher ───────────────────────────────────

  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent) => {
      if (mode === 'layout') {
        handleLayoutMouseDown(e)
      } else {
        handleTextureMouseDown(e)
      }
    },
    [mode, handleLayoutMouseDown, handleTextureMouseDown],
  )

  const handleCanvasMouseMove = useCallback(
    (e: MouseEvent) => {
      if (mode === 'layout') {
        handleLayoutMouseMove(e)
      } else {
        handleTextureMouseMove(e)
      }
    },
    [mode, handleLayoutMouseMove, handleTextureMouseMove],
  )

  return (
    <div
      ref={wrapRef}
      class="room-canvas-wrap"
      onContextMenu={handleContextMenu as any}
      onWheel={handleWheel as any}
      onMouseMove={draggingPlacementIdx !== null ? (handleDragMove as any) : undefined}
    >
      <div ref={innerRef} class="room-canvas-inner" style={{ position: 'relative', display: 'inline-block' }}>
        <canvas
          ref={canvasRef}
          class="room-canvas"
          onMouseDown={handleCanvasMouseDown as any}
          onMouseMove={handleCanvasMouseMove as any}
          onMouseLeave={handleMouseLeave as any}
        />

        {/* Placement overlays (texture mode only) */}
        {visibleOverlays.map(({ p, i, size }) => (
          <div
            key={i}
            class={`room-item-overlay${selectedPlacements.has(i) ? ' selected' : ''}`}
            style={{
              position: 'absolute',
              left: `${(p.gridX || 0) * ts}px`,
              top: `${(p.gridY || 0) * ts}px`,
              width: `${(size.w || 1) * ts}px`,
              height: `${(size.h || 1) * ts}px`,
              pointerEvents: mode === 'layout' ? 'none' : 'auto',
            }}
            onMouseDown={(e) => handleOverlayMouseDown(e as any, i)}
          />
        ))}

        {/* Paint cursor (texture mode) */}
        <div
          ref={paintCursorRef}
          class="room-paint-cursor"
          style={{ display: 'none' }}
        />
      </div>
    </div>
  )
}

/** Compute fit zoom for the room canvas (exported for RoomToolbar). */
export function computeFitZoom(wrapEl: HTMLElement | null, roomWidth: number): number {
  if (!wrapEl) return 1
  const available = wrapEl.clientWidth - 24
  const natural = roomWidth * TILE_SIZE
  return Math.max(0.05, Math.min(8, available / natural))
}
