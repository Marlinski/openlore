/**
 * CutPreviews — animated canvas previews for multi-frame cuts + speed slider.
 *
 * Renders a small canvas per animated cut (frameCount > 1), ticked
 * by a shared animation timer at the global FPS from the cutter store.
 * Static cuts are skipped.
 *
 * Also includes the FPS speed slider.
 */

import { useRef, useEffect, useCallback } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import { getCachedImage } from '../TilesetPicker'
import { useCutterStore, getCutColor, type CutEntry } from '../../store/cutter'

export interface CutPreviewsProps {
  tileset: TilesetMeta | null
}

// Max preview height in pixels
const MAX_PREVIEW_H = 48

export function CutPreviews({ tileset }: CutPreviewsProps) {
  const cuts = useCutterStore((s) => s.cuts)
  const previewFps = useCutterStore((s) => s.previewFps)
  const setPreviewFps = useCutterStore((s) => s.setPreviewFps)

  // Only show animated cuts
  const animatedCuts = cuts.filter((c) => c.frameCount > 1)

  // Refs for preview canvases and animation state
  const canvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map())
  const frameIndices = useRef<Map<string, number>>(new Map())
  const timerRef = useRef<number | null>(null)

  // Register canvas ref
  const setCanvasRef = useCallback(
    (id: string) => (el: HTMLCanvasElement | null) => {
      if (el) {
        canvasRefs.current.set(id, el)
      } else {
        canvasRefs.current.delete(id)
      }
    },
    [],
  )

  // Animation loop
  useEffect(() => {
    if (timerRef.current !== null) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }

    if (animatedCuts.length === 0 || !tileset) return

    const img = getCachedImage(tileset.id)
    if (!img) return

    const tw = tileset.tileWidth || 1
    const th = tileset.tileHeight || 1

    // Initial draw
    for (const cut of animatedCuts) {
      frameIndices.current.set(cut.id, 0)
      drawPreviewFrame(canvasRefs.current.get(cut.id), img, cut, 0, tw, th)
    }

    // Tick
    timerRef.current = window.setInterval(() => {
      for (const cut of animatedCuts) {
        const prev = frameIndices.current.get(cut.id) ?? 0
        const next = (prev + 1) % cut.frameCount
        frameIndices.current.set(cut.id, next)
        drawPreviewFrame(canvasRefs.current.get(cut.id), img, cut, next, tw, th)
      }
    }, 1000 / previewFps)

    return () => {
      if (timerRef.current !== null) {
        clearInterval(timerRef.current)
        timerRef.current = null
      }
    }
  }, [animatedCuts.length, tileset, previewFps, cuts])

  // Size canvases when cuts change
  useEffect(() => {
    if (!tileset) return
    const tw = tileset.tileWidth || 1
    const th = tileset.tileHeight || 1

    for (const cut of animatedCuts) {
      const cvs = canvasRefs.current.get(cut.id)
      if (!cvs) continue
      const fw = cut.frameWidth * tw
      const fh = cut.frameHeight * th
      const scale = fh > MAX_PREVIEW_H ? MAX_PREVIEW_H / fh : 1
      cvs.width = Math.round(fw * scale)
      cvs.height = Math.round(fh * scale)
      cvs.style.width = `${cvs.width}px`
      cvs.style.height = `${cvs.height}px`
    }
  }, [animatedCuts.length, tileset, cuts])

  if (cuts.length === 0) return null

  return (
    <div class="cutter-previews">
      <div class="cutter-section-header">
        Previews
        <label class="cutter-fps-label">
          {previewFps} fps
          <input
            type="range"
            min="1"
            max="24"
            value={previewFps}
            onInput={(e) => setPreviewFps(parseInt((e.target as HTMLInputElement).value) || 4)}
            class="cutter-fps-slider"
          />
        </label>
      </div>
      {animatedCuts.length === 0 ? (
        <div class="cutter-previews__empty">No animated cuts</div>
      ) : (
        <div class="cutter-previews__grid">
          {animatedCuts.map((cut, idx) => (
            <div key={cut.id} class="cutter-preview-item">
              <canvas
                ref={setCanvasRef(cut.id)}
                class="cutter-preview-canvas"
                style={{ imageRendering: 'pixelated' }}
              />
              <span class="cutter-preview-label">
                {cut.name || `cut ${idx + 1}`}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Draw a single preview frame ────────────────────────────────

function drawPreviewFrame(
  canvas: HTMLCanvasElement | undefined,
  img: HTMLImageElement,
  cut: CutEntry,
  frameIdx: number,
  tw: number,
  th: number,
) {
  if (!canvas) return
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.imageSmoothingEnabled = false

  const fw = cut.frameWidth * tw
  const fh = cut.frameHeight * th
  const sx = (cut.col + frameIdx * cut.frameWidth) * tw
  const sy = cut.row * th

  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, sx, sy, fw, fh, 0, 0, canvas.width, canvas.height)
}
