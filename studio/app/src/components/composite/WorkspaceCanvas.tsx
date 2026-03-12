/**
 * WorkspaceCanvas — tile-based workspace for placing composite parts.
 *
 * Draws the workspace grid, all placed parts (z-sorted), and selection
 * overlay divs. Handles click-to-place, click-to-select, and drag-to-move.
 */

import { useRef, useEffect, useCallback } from 'preact/hooks'
import { TILE_SIZE } from '../../lib/pack'
import {
  useCompositeStore,
  WORKSPACE_COLS,
  WORKSPACE_ROWS,
} from '../../store/composite'
import type { WorkspacePart } from '../../store/composite'
import { getCachedImage, loadImage } from '../TilesetPicker'

export function WorkspaceCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)

  const parts = useCompositeStore((s) => s.parts)
  const selectedPartUid = useCompositeStore((s) => s.selectedPartUid)
  const selectedBrush = useCompositeStore((s) => s.selectedBrush)
  const zoom = useCompositeStore((s) => s.zoom)
  const showGrid = useCompositeStore((s) => s.showGrid)
  const drag = useCompositeStore((s) => s.drag)

  const placeBrush = useCompositeStore((s) => s.placeBrush)
  const selectPart = useCompositeStore((s) => s.selectPart)
  const startDrag = useCompositeStore((s) => s.startDrag)
  const endDrag = useCompositeStore((s) => s.endDrag)
  const movePart = useCompositeStore((s) => s.movePart)
  const setZoom = useCompositeStore((s) => s.setZoom)

  // ─── Draw ─────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const ts = TILE_SIZE * zoom
    const w = WORKSPACE_COLS * ts
    const h = WORKSPACE_ROWS * ts

    canvas.width = w
    canvas.height = h
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    // Background
    ctx.fillStyle = '#111827'
    ctx.fillRect(0, 0, w, h)

    // Grid
    if (showGrid) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
      ctx.lineWidth = 1
      for (let x = 0; x <= WORKSPACE_COLS; x++) {
        ctx.beginPath()
        ctx.moveTo(x * ts + 0.5, 0)
        ctx.lineTo(x * ts + 0.5, h)
        ctx.stroke()
      }
      for (let y = 0; y <= WORKSPACE_ROWS; y++) {
        ctx.beginPath()
        ctx.moveTo(0, y * ts + 0.5)
        ctx.lineTo(w, y * ts + 0.5)
        ctx.stroke()
      }
    }

    // Draw parts in render order (sorted by anchor Y)
    const sorted = [...parts].sort((a, b) => {
      const anchorA = a.gridY + a.region.h + a.zBias
      const anchorB = b.gridY + b.region.h + b.zBias
      if (anchorA !== anchorB) return anchorA - anchorB
      return a.gridX - b.gridX
    })

    for (const part of sorted) {
      drawRegion(ctx, part, ts)
    }
  }, [parts, zoom, showGrid])

  // Draw on state changes
  useEffect(() => {
    draw()
  }, [draw])

  // ─── Draw a single region ─────────────────────────────────────

  function drawRegion(
    ctx: CanvasRenderingContext2D,
    part: WorkspacePart,
    tileSize: number,
  ) {
    const img = getCachedImage(part.region.tilesetId)
    if (!img) {
      loadImage(part.region.tilesetId).then(() => draw())
      return
    }
    ctx.drawImage(
      img,
      part.region.srcCol * TILE_SIZE,
      part.region.srcRow * TILE_SIZE,
      part.region.w * TILE_SIZE,
      part.region.h * TILE_SIZE,
      part.gridX * tileSize,
      part.gridY * tileSize,
      part.region.w * tileSize,
      part.region.h * tileSize,
    )
  }

  // ─── Canvas click: place brush or deselect ────────────────────

  const handleCanvasMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return
      const ts = TILE_SIZE * zoom
      const rect = canvasRef.current?.getBoundingClientRect()
      if (!rect) return
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const gridX = Math.floor(x / ts)
      const gridY = Math.floor(y / ts)

      if (selectedBrush) {
        placeBrush(gridX, gridY)
      } else {
        selectPart(null)
      }
    },
    [selectedBrush, zoom, placeBrush, selectPart],
  )

  // ─── Overlay mousedown: select/drag existing part or place brush over it

  const handleOverlayMouseDown = useCallback(
    (e: MouseEvent, part: WorkspacePart) => {
      e.stopPropagation()
      e.preventDefault()

      const ts = TILE_SIZE * zoom
      const rect = canvasRef.current?.parentElement?.getBoundingClientRect()
      if (!rect) return

      if (selectedBrush) {
        // Place brush on top of existing part (allows stacking)
        const x = e.clientX - rect.left
        const y = e.clientY - rect.top
        placeBrush(Math.floor(x / ts), Math.floor(y / ts))
        return
      }

      // Select and start drag
      const ox = e.clientX - rect.left - part.gridX * ts
      const oy = e.clientY - rect.top - part.gridY * ts
      startDrag(part.uid, ox, oy)
    },
    [selectedBrush, zoom, placeBrush, startDrag],
  )

  // ─── Mouse move for dragging ──────────────────────────────────

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!drag) return
      const part = parts.find((p) => p.uid === drag.partUid)
      if (!part) return

      const ts = TILE_SIZE * zoom
      const rect = canvasRef.current?.parentElement?.getBoundingClientRect()
      if (!rect) return

      const x = e.clientX - rect.left - drag.offsetX
      const y = e.clientY - rect.top - drag.offsetY

      let gridX = Math.round(x / ts)
      let gridY = Math.round(y / ts)
      gridX = Math.max(0, Math.min(WORKSPACE_COLS - part.region.w, gridX))
      gridY = Math.max(0, Math.min(WORKSPACE_ROWS - part.region.h, gridY))

      if (part.gridX !== gridX || part.gridY !== gridY) {
        movePart(part.uid, gridX, gridY)
      }
    },
    [drag, parts, zoom, movePart],
  )

  // ─── Mouse up: end drag ───────────────────────────────────────

  useEffect(() => {
    if (!drag) return
    const handleUp = () => endDrag()
    window.addEventListener('mouseup', handleUp)
    return () => window.removeEventListener('mouseup', handleUp)
  }, [drag, endDrag])

  // ─── Scroll-to-zoom ───────────────────────────────────────────

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      const delta = -e.deltaY * 0.001
      setZoom(zoom * (1 + delta))
    },
    [zoom, setZoom],
  )

  // ─── Keyboard (Delete / Escape) ───────────────────────────────

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Only handle when no input is focused
      const tag = (document.activeElement as HTMLElement)?.tagName
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return

      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedPartUid) {
        e.preventDefault()
        useCompositeStore.getState().removePart(selectedPartUid)
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        useCompositeStore.getState().selectPart(null)
        useCompositeStore.getState().setBrush(null)
      }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [selectedPartUid])

  // ─── Render ───────────────────────────────────────────────────

  const ts = TILE_SIZE * zoom

  return (
    <div
      ref={wrapRef}
      class="composite-workspace"
      onMouseMove={handleMouseMove as any}
      onWheel={handleWheel as any}
    >
      <div class="composite-workspace-toolbar">
        <label class="composite-ws-label">
          <input
            type="checkbox"
            checked={showGrid}
            onChange={(e) =>
              useCompositeStore.getState().setShowGrid((e.target as HTMLInputElement).checked)
            }
          />
          Grid
        </label>
        <button
          class="btn"
          onClick={() => useCompositeStore.getState().clearWorkspace()}
        >
          Clear
        </button>
      </div>
      <div class="composite-canvas-scroll">
        <div class="composite-canvas-inner" style={{ position: 'relative', display: 'inline-block' }}>
          <canvas
            ref={canvasRef}
            class="composite-canvas"
            onMouseDown={handleCanvasMouseDown as any}
          />
          {/* Part overlays for hit testing */}
          {parts.map((part) => (
            <div
              key={part.uid}
              class={`composite-part-overlay${part.uid === selectedPartUid ? ' selected' : ''}`}
              style={{
                position: 'absolute',
                left: `${part.gridX * ts}px`,
                top: `${part.gridY * ts}px`,
                width: `${part.region.w * ts}px`,
                height: `${part.region.h * ts}px`,
              }}
              onMouseDown={(e) => handleOverlayMouseDown(e as any, part)}
            />
          ))}
        </div>
      </div>
    </div>
  )
}
