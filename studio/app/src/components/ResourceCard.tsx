/**
 * ResourceCard — thumbnail card for a resource with animated canvas preview.
 *
 * Uses loadImage() (async, cached) to avoid the getCachedImage() race condition
 * that caused flickering and blank canvases. Each card manages its own
 * setInterval for animation — simple, predictable, no shared rAF complexity.
 *
 * Props:
 *   resource — the Resource to display
 *   selected — whether this card is highlighted
 *   onClick  — card click handler
 */

import { useRef, useEffect } from 'preact/hooks'
import type { Resource, ResourceFrame } from '@openlore/pack'
import { useTileset } from '../api/tilesets'
import { loadImage } from './TilesetPicker'

const ANIM_FPS = 8

// ─── Component ──────────────────────────────────────────────────────

export interface ResourceCardProps {
  resource: Resource
  selected?: boolean
  onClick?: () => void
  class?: string
}

export function ResourceCard(props: ResourceCardProps) {
  const { resource, selected = false, onClick } = props
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const frame0 = resource.frames[0]
  const { data: meta } = useTileset(frame0?.tilesetId ?? null)

  // ─── Size canvas + draw + animate ────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !frame0 || !meta) return

    const tw = meta.tileWidth || 1
    const th = meta.tileHeight || 1

    // Size the canvas based on frame0 dimensions
    const fw = (frame0.w || 1) * tw
    const fh = (frame0.h || 1) * th
    const maxH = 64
    const scale = fh > maxH ? maxH / fh : 1
    canvas.width = Math.round(fw * scale)
    canvas.height = Math.round(fh * scale)
    canvas.style.width = `${canvas.width}px`
    canvas.style.height = `${canvas.height}px`

    let cancelled = false
    let timerId: number | null = null

    loadImage(frame0.tilesetId).then((img) => {
      if (cancelled) return

      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.imageSmoothingEnabled = false

      // Draw first frame immediately
      drawFrame(ctx, canvas, img, frame0, tw, th)

      // Animate if multi-frame
      if (resource.frames.length > 1) {
        let frameIdx = 0
        timerId = window.setInterval(() => {
          frameIdx = (frameIdx + 1) % resource.frames.length
          const f = resource.frames[frameIdx]
          drawFrame(ctx, canvas, img, f, tw, th)
        }, 1000 / ANIM_FPS)
      }
    }).catch(() => {})

    return () => {
      cancelled = true
      if (timerId !== null) {
        clearInterval(timerId)
      }
    }
  }, [frame0, meta, resource.frames])

  if (!frame0) {
    return (
      <div class={`resource-card ${selected ? 'selected' : ''} ${props.class ?? ''}`} onClick={onClick}>
        <div class="resource-card-empty">No frames</div>
        <div class="resource-card-name">{resource.name}</div>
      </div>
    )
  }

  return (
    <div
      class={`resource-card ${selected ? 'selected' : ''} ${props.class ?? ''}`}
      onClick={onClick}
    >
      <canvas
        ref={canvasRef}
        class="resource-card-canvas"
      />
      <div class="resource-card-name" title={resource.name}>
        {resource.name}
      </div>
      <div class="resource-card-tags" title={resource.tags.join('\n')}>
        {resource.tags.join(', ')}
      </div>
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────

function drawFrame(
  ctx: CanvasRenderingContext2D,
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  frame: ResourceFrame,
  tw: number,
  th: number,
) {
  const fw = (frame.w || 1) * tw
  const fh = (frame.h || 1) * th
  const sx = (frame.srcCol || 0) * tw
  const sy = (frame.srcRow || 0) * th
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(img, sx, sy, fw, fh, 0, 0, canvas.width, canvas.height)
}
