/**
 * TexturePanel — Left sidebar for Texture mode.
 *
 * Shows tileset list + TilesetPicker for region brush selection,
 * plus a composite list for composite brush selection.
 */

import { useState, useCallback } from 'preact/hooks'
import { TILE_SIZE } from '../../lib/pack'
import type { TilesetRegion, CompositeObject } from '@openlore/pack'
import { useTilesets } from '../../api/tilesets'
import { useComposites } from '../../api/composites'
import { TilesetPicker, getCachedImage } from '../TilesetPicker'
import { FilterableList } from '../FilterableList'
import { useRoomStore } from '../../store/room'
import type { Brush } from '../../store/room'
import { useRef, useEffect } from 'preact/hooks'

export function TexturePanel() {
  const { data: tilesets = [] } = useTilesets()
  const { data: composites = [] } = useComposites()

  const selectedBrush = useRoomStore((s) => s.selectedBrush)
  const setBrush = useRoomStore((s) => s.setBrush)

  const [selectedTileset, setSelectedTileset] = useState<string | null>(null)
  const [pickerZoom, setPickerZoom] = useState(1)
  const [pickerGrid, setPickerGrid] = useState(true)
  const [navCollapsed, setNavCollapsed] = useState(false)

  // Current region selection for the picker
  const pickerSelection =
    selectedBrush?.type === 'region' ? selectedBrush.region : null

  const handleTilesetSelect = useCallback(
    (id: string) => {
      setSelectedTileset(id)
      setBrush(null)
    },
    [setBrush],
  )

  const handleRegionSelect = useCallback(
    (region: TilesetRegion) => {
      setBrush({ type: 'region', region })
    },
    [setBrush],
  )

  const handleCompositeSelect = useCallback(
    (comp: CompositeObject) => {
      setBrush({ type: 'composite', compositeId: comp.id })
      // Clear tileset picker selection when composite is chosen
      setSelectedTileset((prev) => prev) // keep tileset visible but deselect region
    },
    [setBrush],
  )

  const tilesetItems = tilesets.map((t) => ({
    id: t.id,
    label: t.label,
    path: t.path,
    meta: `${t.tileWidth}x${t.tileHeight} ${t.cols}x${t.rows}`,
  }))

  return (
    <div class="room-texture-panel">
      {/* Tileset selector */}
      {!navCollapsed && (
        <div class="room-tileset-select">
          <FilterableList
            items={tilesetItems}
            value={selectedTileset}
            onSelect={handleTilesetSelect}
            placeholder="Filter tilesets..."
          />
        </div>
      )}

      {/* Collapse/expand toggle */}
      <button
        class="panel-collapse-toggle"
        onClick={() => setNavCollapsed((c) => !c)}
        title={navCollapsed ? 'Expand tileset nav' : 'Collapse tileset nav'}
      >
        <span class={`panel-collapse-arrow${navCollapsed ? ' down' : ''}`}>&#9650;</span>
      </button>

      {/* Picker toolbar */}
      <div class="room-picker-toolbar">
        <label class="room-picker-label">
          <input
            type="checkbox"
            checked={pickerGrid}
            onChange={(e) => setPickerGrid((e.target as HTMLInputElement).checked)}
          />
          Grid
        </label>
        {selectedBrush?.type === 'region' && (
          <span class="room-selection-info">
            {selectedBrush.region.w}&times;{selectedBrush.region.h} from (
            {selectedBrush.region.srcCol},{selectedBrush.region.srcRow})
          </span>
        )}
      </div>

      {/* Tileset picker */}
      <TilesetPicker
        tilesetHash={selectedTileset}
        zoom={pickerZoom}
        showGrid={pickerGrid}
        selection={pickerSelection}
        onSelect={handleRegionSelect}
        onZoomChange={setPickerZoom}
        class="room-tileset-picker"
      />

      {/* Composite list */}
      <div class="room-composite-section">
        <div class="room-panel-header">
          Composites <span class="room-count">{composites.length}</span>
        </div>
        {composites.length === 0 ? (
          <div class="room-composite-empty">No composites yet.</div>
        ) : (
          <div class="room-composite-list">
            {composites.map((comp) => (
              <CompositeItem
                key={comp.id}
                comp={comp}
                isSelected={
                  selectedBrush?.type === 'composite' &&
                  selectedBrush.compositeId === comp.id
                }
                onSelect={handleCompositeSelect}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Composite Item ─────────────────────────────────────────────────

interface CompositeItemProps {
  comp: CompositeObject
  isSelected: boolean
  onSelect: (comp: CompositeObject) => void
}

function CompositeItem({ comp, isSelected, onSelect }: CompositeItemProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return

    const dw = comp.displayWidth || 1
    const dh = comp.displayHeight || 1
    const maxDim = Math.max(dw, dh)
    const thumbScale = Math.min(32 / (maxDim * TILE_SIZE), 2)
    const cw = Math.ceil(dw * TILE_SIZE * thumbScale)
    const ch = Math.ceil(dh * TILE_SIZE * thumbScale)
    canvas.width = cw
    canvas.height = ch

    const ctx = canvas.getContext('2d')
    if (!ctx) return

    // Sort parts by anchor Y (guard all proto int fields with || 0 / || 1)
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
      const sc = part.region!.srcCol || 0
      const sr = part.region!.srcRow || 0
      const rw = part.region!.w || 1
      const rh = part.region!.h || 1
      const ox = part.offsetX || 0
      const oy = part.offsetY || 0
      ctx.drawImage(
        img,
        sc * TILE_SIZE,
        sr * TILE_SIZE,
        rw * TILE_SIZE,
        rh * TILE_SIZE,
        ox * TILE_SIZE * thumbScale,
        oy * TILE_SIZE * thumbScale,
        rw * TILE_SIZE * thumbScale,
        rh * TILE_SIZE * thumbScale,
      )
    }
  }, [comp])

  return (
    <div
      class={`room-palette-item${isSelected ? ' selected' : ''}`}
      onClick={() => onSelect(comp)}
    >
      <canvas ref={canvasRef} class="room-palette-thumb" />
      <div class="room-palette-info">
        <span class="room-palette-name">[C] {comp.name}</span>
        <span class="room-palette-meta">
          {comp.displayWidth || 1}&times;{comp.displayHeight || 1}
        </span>
      </div>
    </div>
  )
}
