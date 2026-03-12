/**
 * ResourceCard — thumbnail card for a resource with animated canvas preview.
 *
 * Renders frame 0 immediately. If the resource has multiple frames,
 * registers with a shared requestAnimationFrame loop at 8fps.
 *
 * The shared rAF loop is module-level — all visible ResourceCards share one
 * timer. Cards register/unregister on mount/unmount.
 *
 * Props:
 *   resource — the Resource to display
 *   selected — whether this card is highlighted
 *   onClick  — card click handler
 */

import { useRef, useEffect } from 'preact/hooks'
import type { Resource, ResourceFrame } from '@offisims/pack'
import { useTileset, tilesetImageUrl } from '../api/tilesets'
import { getCachedImage } from './TilesetPicker'

// ─── Shared animation loop ──────────────────────────────────────────

interface AnimEntry {
  canvas: HTMLCanvasElement
  ctx: CanvasRenderingContext2D
  img: HTMLImageElement
  frames: ResourceFrame[]
  tw: number
  th: number
  frameIdx: number
}

const animEntries = new Set<AnimEntry>()
let animId = 0
let lastAnimTime = 0
const ANIM_FPS = 8
const MS_PER_FRAME = 1000 / ANIM_FPS

function animLoop(time: number) {
  if (animEntries.size === 0) {
    animId = 0
    return
  }

  if (time - lastAnimTime >= MS_PER_FRAME) {
    lastAnimTime = time
    for (const entry of animEntries) {
      entry.frameIdx = (entry.frameIdx + 1) % entry.frames.length
      const f = entry.frames[entry.frameIdx]
      const fw = f.w * entry.tw
      const fh = f.h * entry.th
      entry.ctx.clearRect(0, 0, entry.canvas.width, entry.canvas.height)
      entry.ctx.drawImage(
        entry.img,
        f.srcCol * entry.tw,
        f.srcRow * entry.th,
        fw,
        fh,
        0,
        0,
        entry.canvas.width,
        entry.canvas.height,
      )
    }
  }

  animId = requestAnimationFrame(animLoop)
}

function startLoop() {
  if (animId) return
  lastAnimTime = 0
  animId = requestAnimationFrame(animLoop)
}

function registerAnim(entry: AnimEntry) {
  animEntries.add(entry)
  startLoop()
}

function unregisterAnim(entry: AnimEntry) {
  animEntries.delete(entry)
  if (animEntries.size === 0 && animId) {
    cancelAnimationFrame(animId)
    animId = 0
  }
}

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
  const animRef = useRef<AnimEntry | null>(null)

  const frame0 = resource.frames[0]
  const { data: meta } = useTileset(frame0?.tilesetId ?? null)

  // ─── Draw initial frame + register animation ─────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !frame0 || !meta) return

    const img = getCachedImage(frame0.tilesetId)
    if (!img) {
      // Image not cached — load it then re-trigger via dependency change
      const tempImg = new Image()
      tempImg.onload = () => {
        // Store in the TilesetPicker's cache so getCachedImage works next time
        // We do a minimal trick: just re-draw once loaded
        drawFrame(canvas, tempImg, frame0, meta.tileWidth, meta.tileHeight)
        if (resource.frames.length > 1) {
          const entry: AnimEntry = {
            canvas,
            ctx: canvas.getContext('2d')!,
            img: tempImg,
            frames: resource.frames,
            tw: meta.tileWidth,
            th: meta.tileHeight,
            frameIdx: 0,
          }
          animRef.current = entry
          registerAnim(entry)
        }
      }
      tempImg.src = tilesetImageUrl(frame0.tilesetId)
      return () => {
        if (animRef.current) unregisterAnim(animRef.current)
        animRef.current = null
      }
    }

    drawFrame(canvas, img, frame0, meta.tileWidth, meta.tileHeight)

    // Multi-frame: register for animation
    if (resource.frames.length > 1) {
      const entry: AnimEntry = {
        canvas,
        ctx: canvas.getContext('2d')!,
        img,
        frames: resource.frames,
        tw: meta.tileWidth,
        th: meta.tileHeight,
        frameIdx: 0,
      }
      animRef.current = entry
      registerAnim(entry)
    }

    return () => {
      if (animRef.current) unregisterAnim(animRef.current)
      animRef.current = null
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

  // Compute canvas size — scale to max 64px height
  const tw = meta?.tileWidth ?? 48
  const th = meta?.tileHeight ?? 48
  const fw = frame0.w * tw
  const fh = frame0.h * th
  const maxH = 64
  const scale = fh > maxH ? maxH / fh : 1
  const cw = Math.round(fw * scale)
  const ch = Math.round(fh * scale)

  return (
    <div
      class={`resource-card ${selected ? 'selected' : ''} ${props.class ?? ''}`}
      onClick={onClick}
    >
      <canvas
        ref={canvasRef}
        class="resource-card-canvas"
        width={cw}
        height={ch}
        style={{ width: `${cw}px`, height: `${ch}px` }}
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
  canvas: HTMLCanvasElement,
  img: HTMLImageElement,
  frame: ResourceFrame,
  tw: number,
  th: number,
) {
  const ctx = canvas.getContext('2d')!
  ctx.imageSmoothingEnabled = false
  const fw = frame.w * tw
  const fh = frame.h * th
  ctx.clearRect(0, 0, canvas.width, canvas.height)
  ctx.drawImage(
    img,
    frame.srcCol * tw,
    frame.srcRow * th,
    fw,
    fh,
    0,
    0,
    canvas.width,
    canvas.height,
  )
}
