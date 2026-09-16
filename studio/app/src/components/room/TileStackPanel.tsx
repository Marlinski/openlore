/**
 * TileStackPanel — Tile inspector showing all placements at the inspected tile.
 *
 * Shows per-placement info, zBias up/down buttons, layer switch, delete,
 * and multi-select actions.
 */

import { useCallback, useMemo, useRef, useEffect } from 'preact/hooks'
import { TILE_SIZE, getPlacementSize, isFloor, isObject } from '../../lib/pack'
import type { TexturePlacement, CompositeObject } from '@openlore/pack'
import { useRoomStore } from '../../store/room'
import type { LayerTab } from '../../store/room'
import { useComposites } from '../../api/composites'
import { getCachedImage } from '../TilesetPicker'

export function TileStackPanel() {
  const inspectedTile = useRoomStore((s) => s.inspectedTile)
  const placements = useRoomStore((s) => s.placements)
  const selectedPlacements = useRoomStore((s) => s.selectedPlacements)
  const layerTab = useRoomStore((s) => s.layerTab)
  const { data: composites = [] } = useComposites()

  const getComposite = useCallback(
    (id: string) => composites.find((c) => c.id === id),
    [composites],
  )

  if (!inspectedTile) {
    return (
      <div class="room-tile-stack">
        <div class="room-tile-stack-hint">Click a tile to inspect its stack.</div>
      </div>
    )
  }

  const { col, row } = inspectedTile

  // Get all placement indices at this tile, filtered by layer
  const indicesAtTile = useMemo(() => {
    const result: number[] = []
    for (let i = 0; i < placements.length; i++) {
      const p = placements[i]
      const size = getPlacementSize(p, getComposite)
      if (!size) continue
      if (col >= (p.gridX || 0) && col < (p.gridX || 0) + size.w && row >= (p.gridY || 0) && row < (p.gridY || 0) + size.h) {
        // Filter by layer tab
        if (layerTab === 'floor' && !isFloor(p)) continue
        if (layerTab === 'object' && !isObject(p)) continue
        result.push(i)
      }
    }
    return result
  }, [placements, col, row, layerTab, getComposite])

  // Sort in render order: floors first (row-major), then objects (anchor Y)
  const sorted = useMemo(() => {
    const floors = indicesAtTile.filter((i) => isFloor(placements[i]))
    const objects = indicesAtTile.filter((i) => isObject(placements[i]))

    floors.sort((a, b) => {
      const pa = placements[a], pb = placements[b]
      if ((pa.gridY || 0) !== (pb.gridY || 0)) return (pa.gridY || 0) - (pb.gridY || 0)
      return (pa.gridX || 0) - (pb.gridX || 0)
    })

    objects.sort((a, b) => {
      const pa = placements[a], pb = placements[b]
      const sizeA = getPlacementSize(pa, getComposite)
      const sizeB = getPlacementSize(pb, getComposite)
      const anchorA = (pa.gridY || 0) + (sizeA?.h ?? 1) + (pa.zBias ?? 0)
      const anchorB = (pb.gridY || 0) + (sizeB?.h ?? 1) + (pb.zBias ?? 0)
      if (anchorA !== anchorB) return anchorA - anchorB
      return (pa.gridX || 0) - (pb.gridX || 0)
    })

    return [...floors, ...objects]
  }, [indicesAtTile, placements, getComposite])

  return (
    <div class="room-tile-stack">
      <div class="room-tile-stack-header">
        <span class="room-tile-stack-pos">
          Tile ({col}, {row})
        </span>
        <span class="room-tile-stack-count">{sorted.length} items</span>
      </div>

      {/* Selection actions */}
      {selectedPlacements.size > 0 && (
        <SelectionActions getComposite={getComposite} />
      )}

      {/* Stack items */}
      {sorted.length === 0 ? (
        <div class="room-tile-stack-empty">No placements at this tile.</div>
      ) : (
        <div class="room-tile-stack-items">
          {sorted.map((idx, order) => (
            <StackItem
              key={idx}
              idx={idx}
              order={order}
              placement={placements[idx]}
              isSelected={selectedPlacements.has(idx)}
              getComposite={getComposite}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Selection Actions ──────────────────────────────────────────────

function SelectionActions({
  getComposite,
}: {
  getComposite: (id: string) => CompositeObject | undefined
}) {
  const selectedPlacements = useRoomStore((s) => s.selectedPlacements)
  const placements = useRoomStore((s) => s.placements)
  const deletePlacements = useRoomStore((s) => s.deletePlacements)
  const changeLayer = useRoomStore((s) => s.changeLayer)

  const indices = [...selectedPlacements]
  const hasFloor = indices.some((i) => isFloor(placements[i]))
  const hasObject = indices.some((i) => isObject(placements[i]))

  return (
    <div class="room-stack-actions">
      <span class="room-stack-actions-count">{indices.length} selected</span>
      {hasFloor && (
        <button
          class="btn"
          onClick={() =>
            changeLayer(
              indices.filter((i) => isFloor(placements[i])),
              'object',
            )
          }
        >
          To Object
        </button>
      )}
      {hasObject && (
        <button
          class="btn"
          onClick={() =>
            changeLayer(
              indices.filter((i) => isObject(placements[i])),
              'floor',
            )
          }
        >
          To Floor
        </button>
      )}
      <button class="btn btn-danger" onClick={() => deletePlacements(indices)}>
        Delete
      </button>
    </div>
  )
}

// ─── Stack Item ─────────────────────────────────────────────────────

interface StackItemProps {
  idx: number
  order: number
  placement: TexturePlacement
  isSelected: boolean
  getComposite: (id: string) => CompositeObject | undefined
}

function StackItem({ idx, order, placement, isSelected, getComposite }: StackItemProps) {
  const selectPlacement = useRoomStore((s) => s.selectPlacement)
  const adjustZBias = useRoomStore((s) => s.adjustZBias)
  const deletePlacements = useRoomStore((s) => s.deletePlacements)
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const comp = placement.compositeId
    ? getComposite(placement.compositeId)
    : null

  // Draw thumbnail
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    ctx.imageSmoothingEnabled = false
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    if (comp) {
      // Composite thumbnail
      const dw = comp.displayWidth || 1
      const dh = comp.displayHeight || 1
      const maxDim = Math.max(dw, dh)
      const scale = Math.min(24 / (maxDim * TILE_SIZE), 2)
      canvas.width = Math.ceil(dw * TILE_SIZE * scale)
      canvas.height = Math.ceil(dh * TILE_SIZE * scale)

      const sorted = [...comp.parts].sort((a, b) => {
        const anchorA = (a.offsetY || 0) + (a.region!.h || 1) + (a.zBias || 0)
        const anchorB = (b.offsetY || 0) + (b.region!.h || 1) + (b.zBias || 0)
        if (anchorA !== anchorB) return anchorA - anchorB
        return (a.offsetX || 0) - (b.offsetX || 0)
      })

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
    } else if (placement.region) {
      // Region thumbnail
      const r = placement.region
      const rw = r.w || 1
      const rh = r.h || 1
      const maxDim = Math.max(rw, rh)
      const scale = Math.min(24 / (maxDim * TILE_SIZE), 2)
      canvas.width = Math.ceil(rw * TILE_SIZE * scale)
      canvas.height = Math.ceil(rh * TILE_SIZE * scale)

      const img = getCachedImage(r.tilesetId)
      if (img) {
        ctx.drawImage(
          img,
          (r.srcCol || 0) * TILE_SIZE,
          (r.srcRow || 0) * TILE_SIZE,
          rw * TILE_SIZE,
          rh * TILE_SIZE,
          0,
          0,
          canvas.width,
          canvas.height,
        )
      }
    }
  }, [placement, comp])

  const bias = placement.zBias ?? 0
  const biasStr = bias !== 0 ? ` zBias:${bias > 0 ? '+' : ''}${bias}` : ''

  const label = comp
    ? `[C] ${comp.name}`
    : placement.region
      ? `[T] ${placement.region.w || 1}\u00d7${placement.region.h || 1}`
      : '?'

  const meta = `${placement.layer} \u00b7 (${placement.gridX || 0},${placement.gridY || 0})${biasStr}`

  return (
    <div
      class={`room-stack-item${isSelected ? ' selected' : ''}`}
      onClick={(e) => selectPlacement(idx, e.shiftKey)}
    >
      <span class="room-stack-order">{order}</span>
      <canvas ref={canvasRef} class="room-stack-thumb" />
      <div class="room-stack-info">
        <span class="room-stack-label">{label}</span>
        <span class="room-stack-meta">{meta}</span>
      </div>
      <div class="room-stack-item-actions">
        <button onClick={(e) => { e.stopPropagation(); adjustZBias(idx, -1) }}>&#9650;</button>
        <button onClick={(e) => { e.stopPropagation(); adjustZBias(idx, 1) }}>&#9660;</button>
      </div>
      <button
        class="room-stack-delete"
        onClick={(e) => {
          e.stopPropagation()
          deletePlacements([idx])
        }}
      >
        &times;
      </button>
    </div>
  )
}
