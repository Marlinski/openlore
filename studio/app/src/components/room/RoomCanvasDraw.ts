/**
 * RoomCanvasDraw — Pure drawing functions for the room canvas.
 *
 * Separated from the component so drawing logic is testable and
 * the canvas component stays focused on event handling.
 */

import { TILE_SIZE, getPlacementSize, isFloor, isObject } from '../../lib/pack'
import type {
  DoorDefinition,
  TexturePlacement,
  CompositeObject,
  CompositePart,
} from '@offisims/pack'
import { getCachedImage, loadImage } from '../TilesetPicker'
import type { LayerTab } from '../../store/room'

// ─── Types ──────────────────────────────────────────────────────────

export interface DrawContext {
  ctx: CanvasRenderingContext2D
  ts: number // TILE_SIZE * zoom
  roomWidth: number
  roomHeight: number
}

// ─── Layout Mode ────────────────────────────────────────────────────

export function drawLayoutMode(
  dc: DrawContext,
  walkability: boolean[],
  doors: DoorDefinition[],
  selectedDoorId: string | null,
) {
  const { ctx, ts, roomWidth } = dc

  // Walkability cells
  for (let i = 0; i < walkability.length; i++) {
    const col = i % roomWidth
    const row = Math.floor(i / roomWidth)
    ctx.fillStyle = walkability[i]
      ? 'rgba(74, 222, 128, 0.25)'
      : 'rgba(239, 68, 68, 0.3)'
    ctx.fillRect(col * ts, row * ts, ts, ts)
  }

  // Door markers
  for (const door of doors) {
    const isSelected = door.id === selectedDoorId
    const hasTarget = door.target.length > 0
    const x = door.col * ts
    const y = door.row * ts

    // Fill
    ctx.fillStyle = isSelected
      ? 'rgba(147, 130, 255, 0.5)'
      : 'rgba(147, 130, 255, 0.3)'
    ctx.fillRect(x, y, ts, ts)

    // Border
    ctx.strokeStyle = isSelected ? '#9382ff' : 'rgba(147, 130, 255, 0.6)'
    ctx.lineWidth = isSelected ? 2 : 1
    ctx.strokeRect(x + 0.5, y + 0.5, ts - 1, ts - 1)

    // Label
    ctx.fillStyle = '#fff'
    ctx.font = `bold ${Math.max(9, ts / 5)}px monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(
      door.id.replace('door-', 'D'),
      x + ts / 2,
      y + ts / 2 - ts / 8,
    )

    // Linked/unlinked dot
    const dotRadius = Math.max(3, ts / 14)
    ctx.beginPath()
    ctx.arc(x + ts / 2, y + ts / 2 + ts / 6, dotRadius, 0, Math.PI * 2)
    ctx.fillStyle = hasTarget ? '#4ade80' : '#666'
    ctx.fill()
  }
}

// ─── Texture Mode ───────────────────────────────────────────────────

export function drawTextureMode(
  dc: DrawContext,
  placements: TexturePlacement[],
  walkability: boolean[],
  doors: DoorDefinition[],
  layerTab: LayerTab,
  getComposite: (id: string) => CompositeObject | undefined,
  onImageMissing: () => void,
) {
  const { ctx, ts, roomWidth, roomHeight } = dc

  // Filter by layer tab
  const indexed = placements.map((p, i) => ({ p, i }))
  const visible = indexed.filter(({ p }) => {
    if (layerTab === 'floor') return isFloor(p)
    if (layerTab === 'object') return isObject(p)
    return true
  })

  // Separate into floors and objects
  const floors = visible.filter(({ p }) => isFloor(p))
  const objects = visible.filter(({ p }) => isObject(p))

  // Sort floors: row-major (top-to-bottom, left-to-right)
  floors.sort((a, b) => {
    if (a.p.gridY !== b.p.gridY) return a.p.gridY - b.p.gridY
    return a.p.gridX - b.p.gridX
  })

  // Sort objects: by anchor Y (bottom edge + zBias), then X
  objects.sort((a, b) => {
    const sizeA = getPlacementSize(a.p, getComposite)
    const sizeB = getPlacementSize(b.p, getComposite)
    const anchorA = (a.p.gridY || 0) + (sizeA?.h ?? 1) + (a.p.zBias || 0)
    const anchorB = (b.p.gridY || 0) + (sizeB?.h ?? 1) + (b.p.zBias || 0)
    if (anchorA !== anchorB) return anchorA - anchorB
    return (a.p.gridX || 0) - (b.p.gridX || 0)
  })

  // Draw floors first, then objects
  for (const { p } of floors) {
    drawPlacement(ctx, p, ts, getComposite, onImageMissing)
  }
  for (const { p } of objects) {
    drawPlacement(ctx, p, ts, getComposite, onImageMissing)
  }

  // Ghost overlays — blocked tiles
  for (let i = 0; i < walkability.length; i++) {
    if (!walkability[i]) {
      const col = i % roomWidth
      const row = Math.floor(i / roomWidth)
      ctx.fillStyle = 'rgba(239, 68, 68, 0.12)'
      ctx.fillRect(col * ts, row * ts, ts, ts)
    }
  }

  // Ghost overlays — doors
  for (const door of doors) {
    ctx.fillStyle = 'rgba(147, 130, 255, 0.15)'
    ctx.fillRect(door.col * ts, door.row * ts, ts, ts)
  }
}

// ─── Single Placement Drawing ───────────────────────────────────────

function drawPlacement(
  ctx: CanvasRenderingContext2D,
  p: TexturePlacement,
  ts: number,
  getComposite: (id: string) => CompositeObject | undefined,
  onImageMissing: () => void,
) {
  if (p.compositeId) {
    const comp = getComposite(p.compositeId)
    if (!comp) return

    // Sort parts by anchor Y, then X (same as legacy)
    const sorted = [...comp.parts].sort((a, b) => {
      const anchorA = (a.offsetY || 0) + (a.region!.h || 1) + (a.zBias || 0)
      const anchorB = (b.offsetY || 0) + (b.region!.h || 1) + (b.zBias || 0)
      if (anchorA !== anchorB) return anchorA - anchorB
      return (a.offsetX || 0) - (b.offsetX || 0)
    })

    for (const part of sorted) {
      drawRegionAt(
        ctx,
        part.region!.tilesetId,
        part.region!.srcCol || 0,
        part.region!.srcRow || 0,
        part.region!.w || 1,
        part.region!.h || 1,
        ((p.gridX || 0) + (part.offsetX || 0)) * ts,
        ((p.gridY || 0) + (part.offsetY || 0)) * ts,
        ts,
        onImageMissing,
      )
    }
  } else if (p.region) {
    drawRegionAt(
      ctx,
      p.region.tilesetId,
      p.region.srcCol || 0,
      p.region.srcRow || 0,
      p.region.w || 1,
      p.region.h || 1,
      (p.gridX || 0) * ts,
      (p.gridY || 0) * ts,
      ts,
      onImageMissing,
    )
  }
}

function drawRegionAt(
  ctx: CanvasRenderingContext2D,
  tilesetId: string,
  srcCol: number,
  srcRow: number,
  w: number,
  h: number,
  px: number,
  py: number,
  tileSize: number,
  onImageMissing: () => void,
) {
  const img = getCachedImage(tilesetId)
  if (!img) {
    loadImage(tilesetId).then(onImageMissing).catch(() => {})
    return
  }
  ctx.drawImage(
    img,
    srcCol * TILE_SIZE,
    srcRow * TILE_SIZE,
    w * TILE_SIZE,
    h * TILE_SIZE,
    px,
    py,
    w * tileSize,
    h * tileSize,
  )
}

// ─── Grid Overlay ───────────────────────────────────────────────────

export function drawGrid(dc: DrawContext) {
  const { ctx, ts, roomWidth, roomHeight } = dc
  const w = roomWidth * ts
  const h = roomHeight * ts

  ctx.strokeStyle = 'rgba(255, 255, 255, 0.08)'
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = 0; x <= roomWidth; x++) {
    ctx.moveTo(x * ts + 0.5, 0)
    ctx.lineTo(x * ts + 0.5, h)
  }
  for (let y = 0; y <= roomHeight; y++) {
    ctx.moveTo(0, y * ts + 0.5)
    ctx.lineTo(w, y * ts + 0.5)
  }
  ctx.stroke()
}

// ─── Thumbnail drawing (for TileStackPanel) ─────────────────────────

/** Draw a region thumbnail on a canvas at a given scale. */
export function drawRegionThumbnail(
  ctx: CanvasRenderingContext2D,
  tilesetId: string,
  srcCol: number,
  srcRow: number,
  w: number,
  h: number,
  canvasW: number,
  canvasH: number,
) {
  const img = getCachedImage(tilesetId)
  if (!img) return
  ctx.imageSmoothingEnabled = false
  ctx.drawImage(
    img,
    (srcCol || 0) * TILE_SIZE,
    (srcRow || 0) * TILE_SIZE,
    (w || 1) * TILE_SIZE,
    (h || 1) * TILE_SIZE,
    0,
    0,
    canvasW,
    canvasH,
  )
}

/** Draw a composite thumbnail on a canvas. */
export function drawCompositeThumbnail(
  ctx: CanvasRenderingContext2D,
  comp: CompositeObject,
  canvasW: number,
  canvasH: number,
) {
  const scale = Math.min(
    canvasW / ((comp.displayWidth || 1) * TILE_SIZE),
    canvasH / ((comp.displayHeight || 1) * TILE_SIZE),
    2,
  )

  // Sort parts by anchor Y
  const sorted = [...comp.parts].sort((a, b) => {
    const anchorA = (a.offsetY || 0) + (a.region!.h || 1) + (a.zBias || 0)
    const anchorB = (b.offsetY || 0) + (b.region!.h || 1) + (b.zBias || 0)
    if (anchorA !== anchorB) return anchorA - anchorB
    return (a.offsetX || 0) - (b.offsetX || 0)
  })

  ctx.imageSmoothingEnabled = false
  for (const part of sorted) {
    const img = getCachedImage(part.region!.tilesetId)
    if (!img) continue
    ctx.drawImage(
      img,
      (part.region!.srcCol || 0) * TILE_SIZE,
      (part.region!.srcRow || 0) * TILE_SIZE,
      (part.region!.w || 1) * TILE_SIZE,
      (part.region!.h || 1) * TILE_SIZE,
      (part.offsetX || 0) * TILE_SIZE * scale,
      (part.offsetY || 0) * TILE_SIZE * scale,
      (part.region!.w || 1) * TILE_SIZE * scale,
      (part.region!.h || 1) * TILE_SIZE * scale,
    )
  }
}
