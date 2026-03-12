/**
 * CutterTab — shell layout for the Tile Cutter tab.
 *
 * Three-column layout:
 *   Left:   Tileset selector (FilterableList) + SharedTags + CutList
 *   Center: CutterToolbar + CutterCanvas
 *   Right:  AssignForm + CutPreviews + SaveControls + MaskPanel + SavedResourceList
 *
 * Wires the tileset selector to the cutter store and provides
 * shared tileset metadata to child components via context.
 */

import { useMemo, useCallback } from 'preact/hooks'
import { useCutterStore } from '../../store/cutter'
import { useTilesets } from '../../api/tilesets'
import type { TilesetMeta } from '../../api/tilesets'
import { FilterableList } from '../FilterableList'
import type { FilterableItem } from '../FilterableList'
import { CutterToolbar } from './CutterToolbar'
import { CutterCanvas } from './CutterCanvas'
import { AssignForm } from './AssignForm'
import { CutList } from './CutList'
import { CutPreviews } from './CutPreviews'
import { SharedTags } from './SharedTags'
import { MaskPanel } from './MaskPanel'
import { SavedResourceList } from './SavedResourceList'
import { SaveControls } from './SaveControls'

export function CutterTab() {
  const tilesetId = useCutterStore((s) => s.tilesetId)
  const switchTileset = useCutterStore((s) => s.switchTileset)

  // Fetch tileset list from server
  const { data: tilesets } = useTilesets()

  // Build FilterableList items from tilesets
  const tilesetItems: FilterableItem[] = useMemo(() => {
    if (!tilesets) return []
    return tilesets.map((t: TilesetMeta) => ({
      id: t.id,
      label: t.label,
      meta: `${t.cols}x${t.rows} ${t.tileWidth}x${t.tileHeight}`,
      area: t.cols * t.rows,
    }))
  }, [tilesets])

  // Current tileset metadata (for child components)
  const currentTileset: TilesetMeta | null = useMemo(() => {
    if (!tilesetId || !tilesets) return null
    return tilesets.find((t: TilesetMeta) => t.id === tilesetId) ?? null
  }, [tilesetId, tilesets])

  const handleTilesetSelect = useCallback(
    (id: string) => {
      switchTileset(id)
    },
    [switchTileset],
  )

  return (
    <div class="cutter-layout">
      {/* ── Left sidebar ── */}
      <div class="cutter-left">
        <div class="cutter-left__tilesets">
          <FilterableList
            items={tilesetItems}
            value={tilesetId}
            onSelect={handleTilesetSelect}
            placeholder="Search tilesets..."
            showAreaFilter
          />
        </div>
        <SharedTags tileset={currentTileset} />
        <CutList tileset={currentTileset} />
      </div>

      {/* ── Center: canvas area ── */}
      <div class="cutter-center">
        <CutterToolbar />
        <CutterCanvas tileset={currentTileset} />
      </div>

      {/* ── Right sidebar ── */}
      <div class="cutter-right">
        <AssignForm tileset={currentTileset} />
        <CutPreviews tileset={currentTileset} />
        <SaveControls tileset={currentTileset} />
        <MaskPanel tileset={currentTileset} />
        <SavedResourceList tileset={currentTileset} />
      </div>
    </div>
  )
}
