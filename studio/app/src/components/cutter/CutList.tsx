/**
 * CutList — sidebar list of pending cuts with color-coded entries.
 *
 * Each entry shows:
 *   - Color dot matching the canvas overlay
 *   - Name and frame info
 *   - Click to select for editing
 *   - Small "x" button to remove
 */

import { useCallback } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import { useCutterStore, getCutColor } from '../../store/cutter'

export interface CutListProps {
  tileset: TilesetMeta | null
}

export function CutList({ tileset }: CutListProps) {
  const cuts = useCutterStore((s) => s.cuts)
  const selectedCutId = useCutterStore((s) => s.selectedCutId)
  const editingCutId = useCutterStore((s) => s.editingCutId)
  const selectCut = useCutterStore((s) => s.selectCut)
  const setEditingCutId = useCutterStore((s) => s.setEditingCutId)
  const setPendingSelection = useCutterStore((s) => s.setPendingSelection)
  const removeCut = useCutterStore((s) => s.removeCut)
  const clearSelection = useCutterStore((s) => s.clearSelection)

  const handleSelect = useCallback(
    (cutId: string) => {
      // Toggle: clicking the same cut deselects
      if (editingCutId === cutId) {
        clearSelection()
        return
      }

      const cut = cuts.find((c) => c.id === cutId)
      if (!cut) return

      setEditingCutId(cutId)
      selectCut(cutId)
      setPendingSelection({
        col: cut.col,
        row: cut.row,
        frameWidth: cut.frameWidth,
        frameHeight: cut.frameHeight,
        frameCount: cut.frameCount,
      })
    },
    [cuts, editingCutId, selectCut, setEditingCutId, setPendingSelection, clearSelection],
  )

  const handleRemove = useCallback(
    (e: Event, cutId: string) => {
      e.stopPropagation()
      removeCut(cutId)
      if (editingCutId === cutId) clearSelection()
    },
    [removeCut, editingCutId, clearSelection],
  )

  if (cuts.length === 0) {
    return (
      <div class="cutter-cut-list">
        <div class="cutter-section-header">
          Cuts <span class="cutter-count">0</span>
        </div>
        <div class="cutter-cut-list__empty">No cuts yet</div>
      </div>
    )
  }

  return (
    <div class="cutter-cut-list">
      <div class="cutter-section-header">
        Cuts <span class="cutter-count">{cuts.length}</span>
      </div>
      <div class="cutter-cut-list__items">
        {cuts.map((cut, idx) => {
          const isSelected = cut.id === selectedCutId
          const color = getCutColor(idx)
          const frameInfo =
            cut.frameCount === 1
              ? `${cut.frameWidth}x${cut.frameHeight}`
              : `${cut.frameCount}f ${cut.frameWidth}x${cut.frameHeight}`

          return (
            <div
              key={cut.id}
              class={`cutter-cut-item ${isSelected ? 'cutter-cut-item--selected' : ''}`}
              onClick={() => handleSelect(cut.id)}
            >
              <span
                class="cutter-cut-dot"
                style={{ backgroundColor: color }}
              />
              <span class="cutter-cut-name">{cut.name || `cut ${idx + 1}`}</span>
              <span class="cutter-cut-info">{frameInfo}</span>
              <button
                class="cutter-cut-remove"
                onClick={(e: Event) => handleRemove(e, cut.id)}
                title="Remove cut"
              >
                x
              </button>
            </div>
          )
        })}
      </div>
    </div>
  )
}
