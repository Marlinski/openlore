/**
 * SavedResourceList — thumbnail grid of saved resources for the current tileset.
 *
 * Shows small animated canvas previews for each resource that references
 * the current tileset. Click a preview to select/edit that resource.
 * "Clear All" button removes all resources for this tileset.
 */

import { useRef, useEffect, useMemo, useCallback, useState } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import type { Resource } from '@offisims/pack'
import { loadImage } from '../TilesetPicker'
import { useResources, useDeleteResource } from '../../api/resources'
import { useCutterStore } from '../../store/cutter'

export interface SavedResourceListProps {
  tileset: TilesetMeta | null
}

const MAX_THUMB = 48 // max thumbnail height in px

export function SavedResourceList({ tileset }: SavedResourceListProps) {
  const tilesetId = useCutterStore((s) => s.tilesetId)
  const editingResourceId = useCutterStore((s) => s.editingResourceId)
  const setEditingResourceId = useCutterStore((s) => s.setEditingResourceId)
  const setPendingSelection = useCutterStore((s) => s.setPendingSelection)
  const selectCut = useCutterStore((s) => s.selectCut)
  const setEditingCutId = useCutterStore((s) => s.setEditingCutId)
  const clearSelection = useCutterStore((s) => s.clearSelection)
  const previewFps = useCutterStore((s) => s.previewFps)

  const { data: allResources } = useResources()
  const deleteMutation = useDeleteResource()

  /** Resources whose first frame references this tileset */
  const tilesetResources = useMemo(() => {
    if (!allResources || !tilesetId) return []
    return allResources.filter(
      (r) => r.frames.length > 0 && r.frames[0].tilesetId === tilesetId,
    )
  }, [allResources, tilesetId])

  // ─── Canvas refs + animation ──────────────────────────────────

  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const frameIndices = useRef<Map<string, number>>(new Map())
  const timerRef = useRef<number | null>(null)

  const setCanvasRef = useCallback(
    (id: string) => (el: HTMLCanvasElement | null) => {
      if (el) canvasRefs.current.set(id, el)
      else canvasRefs.current.delete(id)
    },
    [],
  )

  // Size canvases
  useEffect(() => {
    if (!tileset) return
    const tw = tileset.tileWidth
    const th = tileset.tileHeight

    for (const res of tilesetResources) {
      const cvs = canvasRefs.current.get(res.id)
      if (!cvs || res.frames.length === 0) continue
      const f0 = res.frames[0]
      const fw = (f0.w || 1) * tw
      const fh = (f0.h || 1) * th
      const scale = fh > MAX_THUMB ? MAX_THUMB / fh : 1
      cvs.width = Math.round(fw * scale)
      cvs.height = Math.round(fh * scale)
      cvs.style.width = `${cvs.width}px`
      cvs.style.height = `${cvs.height}px`
    }
  }, [tilesetResources, tileset])

  // Animation timer — uses loadImage() to wait for the tileset image
  useEffect(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (tilesetResources.length === 0 || !tileset) return

    let cancelled = false

    loadImage(tileset.id).then((img) => {
      if (cancelled) return

      const tw = tileset.tileWidth
      const th = tileset.tileHeight

      // Initial draw
      for (const res of tilesetResources) {
        frameIndices.current.set(res.id, 0)
        drawFrame(canvasRefs.current.get(res.id), img, res, 0, tw, th)
      }

      // Only tick if there are multi-frame resources
      const hasAnimated = tilesetResources.some((r) => r.frames.length > 1)
      if (hasAnimated && !cancelled) {
        timerRef.current = window.setInterval(() => {
          for (const res of tilesetResources) {
            if (res.frames.length <= 1) continue
            const prev = frameIndices.current.get(res.id) ?? 0
            const next = (prev + 1) % res.frames.length
            frameIndices.current.set(res.id, next)
            drawFrame(canvasRefs.current.get(res.id), img, res, next, tw, th)
          }
        }, 1000 / previewFps)
      }
    }).catch(() => {})

    return () => {
      cancelled = true
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [tilesetResources, tileset, previewFps])

  // ─── Handlers ─────────────────────────────────────────────────

  const handleClick = useCallback(
    (res: Resource) => {
      if (editingResourceId === res.id) {
        clearSelection()
        return
      }
      setEditingResourceId(res.id)
      setEditingCutId(null)
      selectCut(null)
      const f0 = res.frames[0]
      setPendingSelection({
        col: f0.srcCol || 0,
        row: f0.srcRow || 0,
        frameWidth: f0.w || 1,
        frameHeight: f0.h || 1,
        frameCount: res.frames.length,
      })
    },
    [editingResourceId, clearSelection, setEditingResourceId, setEditingCutId, selectCut, setPendingSelection],
  )

  const handleClearAll = useCallback(() => {
    for (const r of tilesetResources) {
      deleteMutation.mutateAsync(r.id)
    }
    clearSelection()
  }, [tilesetResources, deleteMutation, clearSelection])

  if (!tileset) return null

  /** Build a short label from tags that distinguish this resource.
   *  We strip the namespace prefix and only keep the values,
   *  skipping entity/name tags since those are usually shared. */
  const thumbLabel = (res: Resource): string => {
    const skip = new Set(['entity', 'name'])
    return res.tags
      .map((t) => {
        const idx = t.indexOf(':')
        const key = idx > 0 ? t.slice(0, idx) : ''
        const val = idx > 0 ? t.slice(idx + 1) : t
        return skip.has(key) ? '' : val
      })
      .filter(Boolean)
      // deduplicate (some resources have duplicate tags from before the fix)
      .filter((v, i, a) => a.indexOf(v) === i)
      .join(' ')
  }

  return (
    <div class="cutter-saved-resources">
      <div class="cutter-section-header">
        Saved <span class="cutter-count">{tilesetResources.length}</span>
      </div>

      {tilesetResources.length > 0 && (
        <div class="cutter-saved-resources__grid">
          {tilesetResources.map((res) => {
            const isSelected = res.id === editingResourceId
            const label = thumbLabel(res)
            return (
              <div
                key={res.id}
                class={`cutter-saved-thumb${isSelected ? ' cutter-saved-thumb--selected' : ''}`}
                onClick={() => handleClick(res)}
                title={res.name + (res.tags.length ? '\n' + res.tags.join(', ') : '')}
              >
                <canvas
                  ref={setCanvasRef(res.id)}
                  class="cutter-saved-thumb__canvas"
                  style={{ imageRendering: 'pixelated' }}
                />
                {label && <span class="cutter-saved-thumb__label">{label}</span>}
              </div>
            )
          })}
        </div>
      )}

      {tilesetResources.length > 0 && (
        <button class="btn btn-danger" style={{ marginTop: '4px' }} onClick={handleClearAll}>
          Clear All
        </button>
      )}
    </div>
  )
}

// ─── Draw a single frame of a resource ──────────────────────────

function drawFrame(
  canvas: HTMLCanvasElement | undefined,
  img: HTMLImageElement,
  res: Resource,
  frameIdx: number,
  tw: number,
  th: number,
) {
  if (!canvas || res.frames.length === 0) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false

  const frame = res.frames[Math.min(frameIdx, res.frames.length - 1)]
  const w = (frame.w || 1) * tw
  const h = (frame.h || 1) * th
  const sx = (frame.srcCol || 0) * tw
  const sy = (frame.srcRow || 0) * th

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, sx, sy, w, h, 0, 0, canvas.width, canvas.height)
}
