/**
 * TilesetPicker — canvas-based tileset viewer with grid overlay and drag-to-select.
 *
 * Renders a tileset image on a <canvas> inside a scrollable container.
 * Supports:
 *   - Click to select a 1x1 tile
 *   - Drag to select an NxM region
 *   - Cmd/Ctrl+scroll to zoom
 *   - Optional grid overlay
 *
 * Props:
 *   tilesetHash — which tileset to display (hash ID from the Go server)
 *   zoom        — zoom multiplier (default 1)
 *   showGrid    — whether to draw grid lines (default true)
 *   selection   — externally controlled selection highlight
 *   onSelect    — callback when the user selects a region
 *   onZoomChange — callback when zoom changes via scroll
 */

import { useRef, useEffect, useCallback } from 'preact/hooks'
import type { TilesetRegion } from '@openlore/pack'
import { useTileset, tilesetImageUrl } from '../api/tilesets'
import type { TilesetMeta } from '../api/tilesets'

export interface TilesetPickerProps {
  tilesetHash: string | null
  zoom?: number
  showGrid?: boolean
  selection?: TilesetRegion | null
  onSelect?: (region: TilesetRegion) => void
  onZoomChange?: (zoom: number) => void
  /** Additional CSS class for the outer wrapper */
  class?: string
}

/** Global image cache — shared across all TilesetPicker instances. */
const imageCache = new Map<string, HTMLImageElement>()

/** Hashes that failed to load — prevents infinite retry loops. */
const failedHashes = new Set<string>()

/** In-flight load promises — deduplicates concurrent requests for the same hash. */
const pendingLoads = new Map<string, Promise<HTMLImageElement>>()

/** Load a tileset image by hash, caching the result. Failed loads are cached to prevent infinite retries. */
export function loadImage(hash: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(hash)
  if (cached) return Promise.resolve(cached)

  if (failedHashes.has(hash)) {
    return Promise.reject(new Error(`Tileset image ${hash} previously failed to load`))
  }

  const pending = pendingLoads.get(hash)
  if (pending) return pending

  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      imageCache.set(hash, img)
      pendingLoads.delete(hash)
      resolve(img)
    }
    img.onerror = () => {
      failedHashes.add(hash)
      pendingLoads.delete(hash)
      reject(new Error(`Failed to load tileset image ${hash}`))
    }
    img.src = tilesetImageUrl(hash)
  })
  pendingLoads.set(hash, p)
  return p
}

/** Get a cached image synchronously (returns undefined if not yet loaded). */
export function getCachedImage(hash: string): HTMLImageElement | undefined {
  return imageCache.get(hash)
}

export function TilesetPicker(props: TilesetPickerProps) {
  const {
    tilesetHash,
    zoom = 1,
    showGrid = true,
    selection = null,
    onSelect,
    onZoomChange,
  } = props

  const { data: meta } = useTileset(tilesetHash)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const overlayRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement | null>(null)

  // Drag state kept in refs to avoid stale closures in event handlers
  const dragRef = useRef({
    active: false,
    startCol: 0,
    startRow: 0,
    endCol: 0,
    endRow: 0,
  })

  // ─── Draw the tileset + grid ──────────────────────────────────

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    const img = imgRef.current
    if (!canvas || !img || !meta) return

    const tw = (meta.tileWidth || 1) * zoom
    const th = (meta.tileHeight || 1) * zoom
    const w = (meta.cols || 1) * tw
    const h = (meta.rows || 1) * th

    canvas.width = w
    canvas.height = h
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`

    const ctx = canvas.getContext('2d')!
    ctx.imageSmoothingEnabled = false
    ctx.drawImage(img, 0, 0, w, h)

    if (showGrid) {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.12)'
      ctx.lineWidth = 1
      for (let x = 0; x <= (meta.cols || 1); x++) {
        ctx.beginPath()
        ctx.moveTo(x * tw + 0.5, 0)
        ctx.lineTo(x * tw + 0.5, h)
        ctx.stroke()
      }
      for (let y = 0; y <= (meta.rows || 1); y++) {
        ctx.beginPath()
        ctx.moveTo(0, y * th + 0.5)
        ctx.lineTo(w, y * th + 0.5)
        ctx.stroke()
      }
    }
  }, [meta, zoom, showGrid])

  // ─── Update selection overlay position ────────────────────────

  const updateOverlay = useCallback(
    (region: TilesetRegion | null) => {
      const el = overlayRef.current
      if (!el || !meta) {
        if (el) el.style.display = 'none'
        return
      }
      if (!region) {
        el.style.display = 'none'
        return
      }
      const tw = (meta.tileWidth || 1) * zoom
      const th = (meta.tileHeight || 1) * zoom
      el.style.display = 'block'
      el.style.left = `${(region.srcCol || 0) * tw}px`
      el.style.top = `${(region.srcRow || 0) * th}px`
      el.style.width = `${(region.w || 1) * tw}px`
      el.style.height = `${(region.h || 1) * th}px`
    },
    [meta, zoom],
  )

  // ─── Load image when tileset changes ──────────────────────────

  useEffect(() => {
    if (!tilesetHash) {
      imgRef.current = null
      return
    }
    let cancelled = false
    loadImage(tilesetHash).then((img) => {
      if (cancelled) return
      imgRef.current = img
      draw()
      updateOverlay(selection)
    }).catch(() => {})
    return () => {
      cancelled = true
    }
  }, [tilesetHash])

  // ─── Redraw when zoom/grid/selection changes ─────────────────

  useEffect(() => {
    draw()
    updateOverlay(selection)
  }, [draw, updateOverlay, selection])

  // ─── Grid position from mouse event ───────────────────────────

  const getGridPos = useCallback(
    (e: MouseEvent): { col: number; row: number } | null => {
      const canvas = canvasRef.current
      if (!canvas || !meta) return null
      const rect = canvas.getBoundingClientRect()
      const x = e.clientX - rect.left
      const y = e.clientY - rect.top
      const tw = (meta.tileWidth || 1) * zoom
      const th = (meta.tileHeight || 1) * zoom
      const col = Math.floor(x / tw)
      const row = Math.floor(y / th)
      if (col < 0 || col >= (meta.cols || 1) || row < 0 || row >= (meta.rows || 1)) return null
      return { col, row }
    },
    [meta, zoom],
  )

  // ─── Mouse handlers ───────────────────────────────────────────

  const handleMouseDown = useCallback(
    (e: MouseEvent) => {
      if (e.button !== 0) return
      e.preventDefault()
      const pos = getGridPos(e)
      if (!pos) return

      const d = dragRef.current
      d.active = true
      d.startCol = pos.col
      d.startRow = pos.row
      d.endCol = pos.col
      d.endRow = pos.row

      updateDragOverlay(meta!)
    },
    [getGridPos, meta],
  )

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const d = dragRef.current
      if (!d.active) return
      const pos = getGridPos(e)
      if (!pos) return
      d.endCol = pos.col
      d.endRow = pos.row
      updateDragOverlay(meta!)
    },
    [getGridPos, meta],
  )

  const handleMouseUp = useCallback(() => {
    const d = dragRef.current
    if (!d.active) return
    d.active = false

    if (!tilesetHash) return

    const minCol = Math.min(d.startCol, d.endCol)
    const minRow = Math.min(d.startRow, d.endRow)
    const maxCol = Math.max(d.startCol, d.endCol)
    const maxRow = Math.max(d.startRow, d.endRow)

    const region = {
      tilesetId: tilesetHash,
      srcCol: minCol,
      srcRow: minRow,
      w: maxCol - minCol + 1,
      h: maxRow - minRow + 1,
    } as TilesetRegion

    updateOverlay(region)
    onSelect?.(region)
  }, [tilesetHash, onSelect, updateOverlay])

  // Helper: update drag overlay during dragging
  function updateDragOverlay(m: TilesetMeta) {
    const el = overlayRef.current
    if (!el) return
    const d = dragRef.current
    const tw = (m.tileWidth || 1) * zoom
    const th = (m.tileHeight || 1) * zoom
    const minCol = Math.min(d.startCol, d.endCol)
    const minRow = Math.min(d.startRow, d.endRow)
    const maxCol = Math.max(d.startCol, d.endCol)
    const maxRow = Math.max(d.startRow, d.endRow)
    el.style.display = 'block'
    el.style.left = `${minCol * tw}px`
    el.style.top = `${minRow * th}px`
    el.style.width = `${(maxCol - minCol + 1) * tw}px`
    el.style.height = `${(maxRow - minRow + 1) * th}px`
  }

  // ─── Scroll-to-zoom ───────────────────────────────────────────

  const handleWheel = useCallback(
    (e: WheelEvent) => {
      if (!e.metaKey && !e.ctrlKey) return
      e.preventDefault()
      const delta = -e.deltaY * 0.001
      const next = Math.min(Math.max(zoom * (1 + delta), 0.1), 8)
      onZoomChange?.(next)
    },
    [zoom, onZoomChange],
  )

  // ─── Global mouseup listener ──────────────────────────────────

  useEffect(() => {
    window.addEventListener('mouseup', handleMouseUp)
    return () => window.removeEventListener('mouseup', handleMouseUp)
  }, [handleMouseUp])

  // ─── Render ───────────────────────────────────────────────────

  if (!tilesetHash) {
    return (
      <div class={`tileset-picker ${props.class ?? ''}`}>
        <div class="tileset-picker-empty">No tileset selected</div>
      </div>
    )
  }

  return (
    <div
      class={`tileset-picker ${props.class ?? ''}`}
      onWheel={handleWheel as any}
    >
      <div class="tileset-picker-inner">
        <canvas
          ref={canvasRef}
          class="tileset-picker-canvas"
          onMouseDown={handleMouseDown as any}
          onMouseMove={handleMouseMove as any}
        />
        <div ref={overlayRef} class="tileset-picker-overlay" />
      </div>
    </div>
  )
}
