/**
 * CutterCanvas — tileset rendering + drag FSM + cut overlays + resize/move.
 *
 * Renders the tileset on a <canvas> with:
 *   - Pixel-art crisp scaling at arbitrary zoom
 *   - Grid overlay (toggleable)
 *   - Cut overlays: semi-transparent fills, borders, frame dividers, labels
 *   - Pending selection overlay + sequence overlay (HTML divs)
 *   - Drag state machine: idle → dragging → locked (Shift for frame sequences)
 *   - Resize handles: 8-compass logical hit-testing (no visual handles)
 *   - Move: drag a cut to reposition it
 *   - Cursor management (crosshair / grab / resize)
 *   - Cmd/Ctrl+scroll zoom
 *
 * All interaction state lives in the cutter Zustand store.
 * Mutable transient state (image ref, animation frame) uses useRef.
 */

import { useRef, useEffect, useCallback, useMemo } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import type { Resource } from '@offisims/pack'
import { useResources } from '../../api/resources'
import { loadImage } from '../TilesetPicker'
import {
  useCutterStore,
  findCutAtTile,
  getCutColor,
  type CutEntry,
  type ResizeHandle,
  type DragState,
} from '../../store/cutter'

// ─── Constants ──────────────────────────────────────────────────

const HANDLE_HIT = 8 // pixels, resize handle hit-test radius
const MAX_CANVAS_DIM = 16384 // max canvas dimension (browser GPU texture limit)

// ─── Component ──────────────────────────────────────────────────

export interface CutterCanvasProps {
  tileset: TilesetMeta | null
}

export function CutterCanvas({ tileset }: CutterCanvasProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const dragOverlayRef = useRef<HTMLDivElement>(null)
  const seqOverlayRef = useRef<HTMLDivElement>(null)
  const pendingOverlayRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  // ── Store selectors ──
  const zoom = useCutterStore((s) => s.zoom)
  const showGrid = useCutterStore((s) => s.showGrid)
  const showCuts = useCutterStore((s) => s.showCuts)
  const showResources = useCutterStore((s) => s.showResources)
  const cuts = useCutterStore((s) => s.cuts)
  const selectedCutId = useCutterStore((s) => s.selectedCutId)
  const pendingSelection = useCutterStore((s) => s.pendingSelection)
  const drag = useCutterStore((s) => s.drag)
  const resizing = useCutterStore((s) => s.resizing)
  const moving = useCutterStore((s) => s.moving)
  const tilesetId = useCutterStore((s) => s.tilesetId)

  // Saved resources for this tileset (for RESOURCES overlay)
  const { data: allResources } = useResources()
  const tilesetResources = useMemo(() => {
    if (!allResources || !tilesetId) return []
    return allResources.filter(
      (r) => r.frames.length > 0 && r.frames[0].tilesetId === tilesetId,
    )
  }, [allResources, tilesetId])

  // ── Store actions (stable references) ──
  const storeRef = useRef(useCutterStore.getState())
  useEffect(() => {
    return useCutterStore.subscribe((s) => {
      storeRef.current = s
    })
  }, [])

  // ─── Effective zoom (handle "fit" sentinel) ───────────────────

  const effectiveZoom = useEffectiveZoom(tileset, zoom, wrapRef, imgRef)

  // ─── Draw ─────────────────────────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !tileset) return

    const z = effectiveZoom
    const tw = (tileset.tileWidth || 1) * z
    const th = (tileset.tileHeight || 1) * z
    let w = (tileset.cols || 1) * tw
    let h = (tileset.rows || 1) * th

    // Safety: clamp canvas to GPU texture limit to avoid drawImage errors
    if (w > MAX_CANVAS_DIM || h > MAX_CANVAS_DIM) {
      const scale = Math.min(MAX_CANVAS_DIM / w, MAX_CANVAS_DIM / h)
      w = Math.floor(w * scale)
      h = Math.floor(h * scale)
    }

    canvas.width = w
    canvas.height = h
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    // Tileset image
    ctx.drawImage(img, 0, 0, w, h)

    // Saved resource overlays (drawn below cuts so cuts appear on top)
    if (showResources && tilesetResources.length > 0) {
      drawResourceOverlays(ctx, tilesetResources, tw, th, z)
    }

    // Cut overlays
    if (showCuts) {
      drawCutOverlays(ctx, cuts, selectedCutId, tw, th, z)
    }

    // Grid
    if (showGrid) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
      ctx.lineWidth = 1
      for (let c = 0; c <= (tileset.cols || 1); c++) {
        ctx.beginPath()
        ctx.moveTo(c * tw + 0.5, 0)
        ctx.lineTo(c * tw + 0.5, h)
        ctx.stroke()
      }
      for (let r = 0; r <= (tileset.rows || 1); r++) {
        ctx.beginPath()
        ctx.moveTo(0, r * th + 0.5)
        ctx.lineTo(w, r * th + 0.5)
        ctx.stroke()
      }
    }
  }, [tileset, effectiveZoom, showGrid, showCuts, showResources, tilesetResources, cuts, selectedCutId])

  // ─── Update overlays ──────────────────────────────────────────

  const updateOverlays = useCallback(() => {
    if (!tileset) return
    const z = effectiveZoom
    const tw = (tileset.tileWidth || 1) * z
    const th = (tileset.tileHeight || 1) * z
    const st = storeRef.current

    // Drag overlay
    updateDragOverlayDiv(dragOverlayRef.current, seqOverlayRef.current, st.drag, tw, th)

    // Pending selection overlay
    updatePendingOverlayDiv(pendingOverlayRef.current, st.pendingSelection, tw, th)
  }, [tileset, effectiveZoom])

  // ─── Load image on tileset change ─────────────────────────────

  useEffect(() => {
    if (!tileset) {
      imgRef.current = null
      return
    }
    let cancelled = false
    loadImage(tileset.id).then((img) => {
      if (cancelled) return
      imgRef.current = img
      draw()
      updateOverlays()
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tileset?.id])

  // ─── Redraw on state changes ──────────────────────────────────

  useEffect(() => {
    draw()
    updateOverlays()
  }, [draw, updateOverlays, drag, pendingSelection])

  // ─── Grid position helper ─────────────────────────────────────

  const getGridPos = useCallback(
    (e: MouseEvent): { col: number; row: number } | null => {
      const canvas = canvasRef.current
      if (!canvas || !tileset) return null
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const tw = (tileset.tileWidth || 1) * effectiveZoom
      const th = (tileset.tileHeight || 1) * effectiveZoom
      const col = Math.floor(x / tw)
      const row = Math.floor(y / th)
      if (col < 0 || col >= (tileset.cols || 1) || row < 0 || row >= (tileset.rows || 1)) return null
      return { col, row }
    },
    [tileset, effectiveZoom],
  )

  const getPixelPos = useCallback(
    (e: MouseEvent): { x: number; y: number } | null => {
      const canvas = canvasRef.current
      if (!canvas) return null
      const rect = canvas.getBoundingClientRect()
      return { x: e.clientX - rect.left, y: e.clientY - rect.top }
    },
    [],
  )

  // ─── Mouse down ───────────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0 || !tileset) return
      const st = storeRef.current
      if (st.drag.mode === 'locked') return
      e.preventDefault()

      // Check resize handle hit
      const px = getPixelPos(e)
      if (px && st.cuts.length > 0) {
        const hit = hitTestHandle(px.x, px.y, st.cuts, tileset, effectiveZoom)
        if (hit) {
          const cut = st.cuts.find((c) => c.id === hit.cutId)
          if (cut) {
            st.startResize({
              cutId: hit.cutId,
              handle: hit.handle,
              originalCol: cut.col,
              originalRow: cut.row,
              originalFrameWidth: cut.frameWidth,
              originalFrameHeight: cut.frameHeight,
              originalFrameCount: cut.frameCount,
            })
            st.selectCut(cut.id)
            return
          }
        }
      }

      const pos = getGridPos(e)
      if (!pos) return

      // Check for move (click on existing cut)
      const clickedCut = findCutAtTile(st.cuts, pos.col, pos.row)
      if (clickedCut) {
        st.startMove({
          cutId: clickedCut.id,
          offsetCol: pos.col - clickedCut.col,
          offsetRow: pos.row - clickedCut.row,
          didMove: false,
        })
        st.selectCut(clickedCut.id)
        return
      }

      // Clear selection and start a new drag
      if (st.pendingSelection) st.clearSelection()
      st.startDrag(pos.col, pos.row)
    },
    [tileset, effectiveZoom, getGridPos, getPixelPos],
  )

  // ─── Mouse move ───────────────────────────────────────────────

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!tileset) return
      const st = storeRef.current
      const pos = getGridPos(e)

      // Resize drag
      if (st.resizing && pos) {
        handleResizeDrag(st, pos.col, pos.row, tileset)
        return
      }

      // Move drag
      if (st.moving && pos) {
        st.updateMove(pos.col, pos.row)
        return
      }

      // Drag FSM
      if (st.drag.mode === 'dragging' && pos) {
        st.updateDrag(pos.col, pos.row)
        return
      }
      if (st.drag.mode === 'locked' && pos) {
        st.updateLockedDrag(pos.col, tileset.cols)
        return
      }

      // Idle: update cursor
      if (st.drag.mode === 'idle') {
        const canvas = canvasRef.current
        if (!canvas) return

        const px = getPixelPos(e)
        if (px) {
          const hit = hitTestHandle(px.x, px.y, st.cuts, tileset, effectiveZoom)
          if (hit) {
            canvas.style.cursor = getResizeCursor(hit.handle)
            return
          }
        }

        if (pos && findCutAtTile(st.cuts, pos.col, pos.row)) {
          canvas.style.cursor = 'grab'
        } else {
          canvas.style.cursor = 'crosshair'
        }
      }
    },
    [tileset, effectiveZoom, getGridPos, getPixelPos],
  )

  // ─── Mouse up (global) ───────────────────────────────────────

  const handleMouseUp = useCallback(() => {
    const st = storeRef.current
    if (!tileset) return

    // Resize end
    if (st.resizing) {
      st.stopResize()
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = 'crosshair'
      return
    }

    // Move end
    if (st.moving) {
      const cutId = st.moving.cutId
      const didMove = st.moving.didMove
      st.stopMove()
      const canvas = canvasRef.current
      if (canvas) canvas.style.cursor = 'grab'

      if (!didMove) {
        // Click without move: toggle selection for editing
        selectCutForEditing(st, cutId)
      }
      return
    }

    // Drag FSM: commit static rect on mouseup (if not locked)
    if (st.drag.mode === 'dragging') {
      st.commitDragAsSelection(tileset.cols)
    }
    // In locked mode, mouseup does nothing — wait for Shift release
  }, [tileset])

  // ─── Key handlers (Shift for FSM transitions) ────────────────

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Shift') return
      const st = storeRef.current
      if (st.drag.mode === 'dragging') {
        st.lockDrag()
      } else if (st.drag.mode === 'idle' && st.pendingSelection) {
        st.lockFromSelection()
      }
    },
    [],
  )

  const handleKeyUp = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Shift' || !tileset) return
      const st = storeRef.current
      if (st.drag.mode === 'locked' && st.drag.frameRect) {
        st.commitDragAsSelection(tileset.cols)
      }
    },
    [tileset],
  )

  // ─── Scroll-to-zoom ───────────────────────────────────────────

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      if (!tileset) return
      e.preventDefault()
      const delta = -e.deltaY * 0.001
      const st = storeRef.current
      const curZoom = st.zoom === -1 ? effectiveZoom : st.zoom
      let next = Math.min(Math.max(curZoom * (1 + delta), 0.1), 8)
      // Clamp so canvas doesn't exceed GPU texture limit
      const imgW = (tileset.cols || 1) * (tileset.tileWidth || 1)
      const imgH = (tileset.rows || 1) * (tileset.tileHeight || 1)
      const maxZoom = Math.min(MAX_CANVAS_DIM / imgW, MAX_CANVAS_DIM / imgH)
      next = Math.min(next, maxZoom)
      st.setZoom(next)
    },
    [tileset, effectiveZoom],
  )

  // ─── Register global listeners ────────────────────────────────

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [handleMouseUp, handleKeyDown, handleKeyUp])

  // ─── Render ───────────────────────────────────────────────────

  if (!tileset) {
    return <div class="cutter-canvas-empty">Select a tileset to begin</div>
  }

  return (
    <div
      class="cutter-canvas-wrap"
      ref={wrapRef}
      onWheel={handleWheel as any}
    >
      <div class="cutter-canvas-inner">
        <canvas
          ref={canvasRef}
          class="cutter-canvas"
          onMouseDown={handleMouseDown as any}
          onMouseMove={handleMouseMove as any}
        />
        <div ref={dragOverlayRef} class="cutter-drag-overlay" />
        <div ref={seqOverlayRef} class="cutter-seq-overlay" />
        <div ref={pendingOverlayRef} class="cutter-pending-overlay" />
      </div>
    </div>
  )
}

// ─── Hook: compute effective zoom ───────────────────────────────

function useEffectiveZoom(
  tileset: TilesetMeta | null,
  zoom: number,
  wrapRef: { current: HTMLDivElement | null },
  imgRef: { current: HTMLImageElement | null },
): number {
  if (zoom !== -1 || !tileset) return zoom === -1 ? 1 : zoom

  // "Fit" mode: compute zoom to fit container width
  const wrap = wrapRef.current
  if (!wrap) return 1
  const available = wrap.clientWidth - 24
  const imgW = (tileset.cols || 1) * (tileset.tileWidth || 1)
  const imgH = (tileset.rows || 1) * (tileset.tileHeight || 1)
  if (imgW <= 0) return 1
  let z = Math.min(Math.max(available / imgW, 0.05), 8)
  // Clamp so neither dimension exceeds browser GPU texture limit
  if (imgW * z > MAX_CANVAS_DIM) z = MAX_CANVAS_DIM / imgW
  if (imgH * z > MAX_CANVAS_DIM) z = Math.min(z, MAX_CANVAS_DIM / imgH)
  return z
}

// ─── Pure helpers: canvas drawing ───────────────────────────────

const RESOURCE_COLOR = '#56b6c2' // distinct teal for saved resources

function drawResourceOverlays(
  ctx: CanvasRenderingContext2D,
  resources: Resource[],
  tw: number,
  th: number,
  z: number,
) {
  for (const res of resources) {
    if (res.frames.length === 0) continue
    const f0 = res.frames[0]
    const x = (f0.srcCol || 0) * tw
    const y = (f0.srcRow || 0) * th
    const w = f0.w || 1
    const h = f0.h || 1
    const totalW = w * res.frames.length * tw
    const totalH = h * th

    // Semi-transparent fill
    ctx.fillStyle = RESOURCE_COLOR + '15'
    ctx.fillRect(x, y, totalW, totalH)

    // Dashed border
    ctx.strokeStyle = RESOURCE_COLOR + '60'
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeRect(x + 0.5, y + 0.5, totalW - 1, totalH - 1)
    ctx.setLineDash([])

    // Label
    ctx.fillStyle = RESOURCE_COLOR + '80'
    ctx.font = `${Math.max(9, z * 2.5)}px monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'bottom'
    const label = res.name || res.tags.join(', ') || 'resource'
    ctx.fillText(label, x + 2, y + totalH - 2)
  }
}

function drawCutOverlays(
  ctx: CanvasRenderingContext2D,
  cuts: CutEntry[],
  selectedCutId: string | null,
  tw: number,
  th: number,
  z: number,
) {
  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]
    const color = getCutColor(i)
    const isSelected = cut.id === selectedCutId

    const x = cut.col * tw
    const y = cut.row * th
    const totalW = cut.frameWidth * cut.frameCount * tw
    const totalH = cut.frameHeight * th

    // Semi-transparent fill
    ctx.fillStyle = color + (isSelected ? '40' : '20')
    ctx.fillRect(x, y, totalW, totalH)

    // Outer border
    ctx.strokeStyle = color
    ctx.lineWidth = isSelected ? 3 : 1.5
    ctx.strokeRect(x + 0.5, y + 0.5, totalW - 1, totalH - 1)

    // Frame dividers for sequences
    if (cut.frameCount > 1) {
      ctx.strokeStyle = color + '80'
      ctx.lineWidth = 1
      ctx.setLineDash([3, 3])
      for (let f = 1; f < cut.frameCount; f++) {
        const fx = x + f * cut.frameWidth * tw
        ctx.beginPath()
        ctx.moveTo(fx + 0.5, y)
        ctx.lineTo(fx + 0.5, y + totalH)
        ctx.stroke()
      }
      ctx.setLineDash([])
    }

    // Label
    ctx.fillStyle = color
    ctx.font = `bold ${Math.max(10, z * 3)}px monospace`
    ctx.textAlign = 'left'
    ctx.textBaseline = 'top'
    const label = cut.name || cut.tags.join(', ') || `cut ${i + 1}`
    ctx.fillText(label, x + 3, y + 2)
  }
}

// ─── Overlay div updates ────────────────────────────────────────

function updateDragOverlayDiv(
  dragEl: HTMLDivElement | null,
  seqEl: HTMLDivElement | null,
  drag: DragState,
  tw: number,
  th: number,
) {
  if (!dragEl || !seqEl) return

  if (drag.mode === 'dragging') {
    const minCol = Math.min(drag.anchorCol, drag.currentCol)
    const maxCol = Math.max(drag.anchorCol, drag.currentCol)
    const minRow = Math.min(drag.anchorRow, drag.currentRow)
    const maxRow = Math.max(drag.anchorRow, drag.currentRow)
    dragEl.style.display = 'block'
    dragEl.style.left = `${minCol * tw}px`
    dragEl.style.top = `${minRow * th}px`
    dragEl.style.width = `${(maxCol - minCol + 1) * tw}px`
    dragEl.style.height = `${(maxRow - minRow + 1) * th}px`
    seqEl.style.display = 'none'
  } else if (drag.mode === 'locked' && drag.frameRect) {
    const fr = drag.frameRect
    dragEl.style.display = 'block'
    dragEl.style.left = `${fr.col * tw}px`
    dragEl.style.top = `${fr.row * th}px`
    dragEl.style.width = `${fr.w * tw}px`
    dragEl.style.height = `${fr.h * th}px`
    if (drag.frameCount > 1) {
      seqEl.style.display = 'block'
      seqEl.style.left = `${(fr.col + fr.w) * tw}px`
      seqEl.style.top = `${fr.row * th}px`
      seqEl.style.width = `${fr.w * (drag.frameCount - 1) * tw}px`
      seqEl.style.height = `${fr.h * th}px`
    } else {
      seqEl.style.display = 'none'
    }
  } else {
    dragEl.style.display = 'none'
    seqEl.style.display = 'none'
  }
}

function updatePendingOverlayDiv(
  el: HTMLDivElement | null,
  sel: { col: number; row: number; frameWidth: number; frameHeight: number; frameCount: number } | null,
  tw: number,
  th: number,
) {
  if (!el) return
  if (!sel) {
    el.style.display = 'none'
    return
  }
  el.style.display = 'block'
  el.style.left = `${sel.col * tw}px`
  el.style.top = `${sel.row * th}px`
  el.style.width = `${sel.frameWidth * sel.frameCount * tw}px`
  el.style.height = `${sel.frameHeight * th}px`
}

// ─── Hit testing ────────────────────────────────────────────────

function hitTestHandle(
  pixelX: number,
  pixelY: number,
  cuts: CutEntry[],
  meta: TilesetMeta,
  zoom: number,
): { cutId: string; handle: ResizeHandle } | null {
  const tw = (meta.tileWidth || 1) * zoom
  const th = (meta.tileHeight || 1) * zoom

  let best: { cutId: string; handle: ResizeHandle; dist: number } | null = null

  for (let i = 0; i < cuts.length; i++) {
    const cut = cuts[i]
    const x = cut.col * tw
    const y = cut.row * th
    const w = cut.frameWidth * cut.frameCount * tw
    const h = cut.frameHeight * th

    const pad = HANDLE_HIT
    if (pixelX < x - pad || pixelX > x + w + pad || pixelY < y - pad || pixelY > y + h + pad) continue

    const dLeft = Math.abs(pixelX - x)
    const dRight = Math.abs(pixelX - (x + w))
    const dTop = Math.abs(pixelY - y)
    const dBottom = Math.abs(pixelY - (y + h))

    const nearLeft = dLeft < pad
    const nearRight = dRight < pad
    const nearTop = dTop < pad
    const nearBottom = dBottom < pad

    type Candidate = { handle: ResizeHandle; dist: number }
    const candidates: Candidate[] = []

    // Corners
    if (nearLeft && nearTop) candidates.push({ handle: 'nw', dist: Math.max(dLeft, dTop) })
    if (nearRight && nearTop) candidates.push({ handle: 'ne', dist: Math.max(dRight, dTop) })
    if (nearLeft && nearBottom) candidates.push({ handle: 'sw', dist: Math.max(dLeft, dBottom) })
    if (nearRight && nearBottom) candidates.push({ handle: 'se', dist: Math.max(dRight, dBottom) })

    // Sides (exclude corner zones)
    if (nearTop && pixelX > x + pad && pixelX < x + w - pad)
      candidates.push({ handle: 'n', dist: dTop })
    if (nearBottom && pixelX > x + pad && pixelX < x + w - pad)
      candidates.push({ handle: 's', dist: dBottom })
    if (nearLeft && pixelY > y + pad && pixelY < y + h - pad)
      candidates.push({ handle: 'w', dist: dLeft })
    if (nearRight && pixelY > y + pad && pixelY < y + h - pad)
      candidates.push({ handle: 'e', dist: dRight })

    for (const c of candidates) {
      if (!best || c.dist < best.dist) {
        best = { cutId: cut.id, handle: c.handle, dist: c.dist }
      }
    }
  }

  return best ? { cutId: best.cutId, handle: best.handle } : null
}

function getResizeCursor(handle: ResizeHandle): string {
  switch (handle) {
    case 'nw':
    case 'se':
      return 'nwse-resize'
    case 'ne':
    case 'sw':
      return 'nesw-resize'
    case 'n':
    case 's':
      return 'ns-resize'
    case 'e':
    case 'w':
      return 'ew-resize'
  }
}

// ─── Resize drag application ────────────────────────────────────

function handleResizeDrag(
  st: ReturnType<typeof useCutterStore.getState>,
  col: number,
  row: number,
  meta: TilesetMeta,
) {
  if (!st.resizing) return
  const cut = st.cuts.find((c) => c.id === st.resizing!.cutId)
  if (!cut) {
    st.stopResize()
    return
  }

  const orig = st.resizing
  const origRight = orig.originalCol + orig.originalFrameWidth * orig.originalFrameCount
  const origBottom = orig.originalRow + orig.originalFrameHeight

  const clampCol = Math.max(0, Math.min(col, meta.cols - 1))
  const clampRow = Math.max(0, Math.min(row, meta.rows - 1))

  let newCol = cut.col
  let newRow = cut.row
  let newRight = origRight
  let newBottom = origBottom

  const handle = orig.handle

  // Top edges
  if (handle === 'nw' || handle === 'n' || handle === 'ne') {
    newRow = Math.min(clampRow, origBottom - 1)
  }
  // Bottom edges
  if (handle === 'sw' || handle === 's' || handle === 'se') {
    newBottom = Math.max(clampRow + 1, orig.originalRow + 1)
  }
  // Left edges
  if (handle === 'nw' || handle === 'w' || handle === 'sw') {
    newCol = Math.min(clampCol, origRight - 1)
  }
  // Right edges
  if (handle === 'ne' || handle === 'e' || handle === 'se') {
    newRight = Math.max(clampCol + 1, orig.originalCol + 1)
  }

  // Pure horizontal handles: keep top/bottom
  if (handle === 'e' || handle === 'w') {
    newRow = orig.originalRow
    newBottom = origBottom
  }
  // Pure vertical handles: keep left/right
  if (handle === 'n' || handle === 's') {
    newCol = orig.originalCol
    newRight = origRight
  }

  const totalWidth = newRight - newCol
  const totalHeight = newBottom - newRow
  if (totalWidth < 1 || totalHeight < 1) return

  // Compute new frame dimensions
  let newFrameWidth = totalWidth
  let newFrameCount = 1
  if (cut.frameCount > 1) {
    newFrameWidth = cut.frameWidth
    newFrameCount = Math.max(1, Math.round(totalWidth / cut.frameWidth))
  }

  st.updateCut(cut.id, {
    col: newCol,
    row: newRow,
    frameWidth: newFrameWidth,
    frameHeight: totalHeight,
    frameCount: newFrameCount,
  })

  // Update pending selection if editing this cut
  if (st.editingCutId === cut.id) {
    st.setPendingSelection({
      col: newCol,
      row: newRow,
      frameWidth: newFrameWidth,
      frameHeight: totalHeight,
      frameCount: newFrameCount,
    })
  }
}

// ─── Select cut for editing (toggle) ────────────────────────────

function selectCutForEditing(
  st: ReturnType<typeof useCutterStore.getState>,
  cutId: string,
) {
  // Toggle: clicking same cut deselects
  if (st.editingCutId === cutId) {
    st.clearSelection()
    return
  }

  const cut = st.cuts.find((c) => c.id === cutId)
  if (!cut) return

  st.setEditingCutId(cutId)
  st.selectCut(cutId)
  st.setPendingSelection({
    col: cut.col,
    row: cut.row,
    frameWidth: cut.frameWidth,
    frameHeight: cut.frameHeight,
    frameCount: cut.frameCount,
  })
}
