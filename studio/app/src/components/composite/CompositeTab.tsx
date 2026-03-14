/**
 * CompositeTab — shell layout for the Composite Builder.
 *
 * 3-column layout:
 *   Left: Tileset selector + TilesetPicker (region brush selection)
 *   Center: WorkspaceCanvas (grid workspace to place parts)
 *   Right: DetailsPanel (name/category form, parts list, save) + SavedCompositesList
 */

import { useState, useCallback } from 'preact/hooks'
import type { TilesetRegion } from '@offisims/pack'
import { useTilesets } from '../../api/tilesets'
import { TilesetPicker } from '../TilesetPicker'
import { FilterableList } from '../FilterableList'
import { ResizablePanel } from '../ResizablePanel'
import { WorkspaceCanvas } from './WorkspaceCanvas'
import { DetailsPanel } from './DetailsPanel'
import { SavedCompositesList } from './SavedCompositesList'
import { useCompositeStore } from '../../store/composite'

export function CompositeTab() {
  const { data: tilesets = [] } = useTilesets()

  // Tileset picker state — local since only used by the picker column
  const [selectedTileset, setSelectedTileset] = useState<string | null>(null)
  const [pickerZoom, setPickerZoom] = useState(1)
  const [pickerGrid, setPickerGrid] = useState(true)

  const setBrush = useCompositeStore((s) => s.setBrush)
  const selectedBrush = useCompositeStore((s) => s.selectedBrush)

  const handleTilesetSelect = useCallback((id: string) => {
    setSelectedTileset(id)
    setBrush(null)
  }, [setBrush])

  const handleRegionSelect = useCallback(
    (region: TilesetRegion) => {
      setBrush(region)
    },
    [setBrush],
  )

  // Build items for the FilterableList
  const tilesetItems = tilesets.map((t) => ({
    id: t.id,
    label: t.label,
    path: t.path,
    meta: `${t.tileWidth}x${t.tileHeight} ${t.cols}x${t.rows}`,
  }))

  return (
    <div class="composite-tab">
      {/* Left column: tileset selector + picker */}
      <ResizablePanel side="right" defaultWidth={200} minWidth={160} maxWidth={420}>
        <div class="composite-left">
          <div class="composite-tileset-select">
            <FilterableList
              items={tilesetItems}
              value={selectedTileset}
              onSelect={handleTilesetSelect}
              placeholder="Filter tilesets..."
            />
          </div>
          <div class="composite-picker-toolbar">
            <label class="composite-picker-label">
              <input
                type="checkbox"
                checked={pickerGrid}
                onChange={(e) => setPickerGrid((e.target as HTMLInputElement).checked)}
              />
              Grid
            </label>
            {selectedBrush && (
              <span class="composite-selection-info">
                {selectedBrush.w}&times;{selectedBrush.h} from ({selectedBrush.srcCol},{selectedBrush.srcRow})
              </span>
            )}
          </div>
          <TilesetPicker
            tilesetHash={selectedTileset}
            zoom={pickerZoom}
            showGrid={pickerGrid}
            selection={selectedBrush}
            onSelect={handleRegionSelect}
            onZoomChange={setPickerZoom}
            class="composite-tileset-picker"
          />
        </div>
      </ResizablePanel>

      {/* Center: workspace canvas */}
      <WorkspaceCanvas />

      {/* Right column: details + saved list */}
      <ResizablePanel side="left" defaultWidth={220} minWidth={180} maxWidth={400}>
        <div class="composite-right">
          <DetailsPanel />
          <SavedCompositesList />
        </div>
      </ResizablePanel>
    </div>
  )
}
