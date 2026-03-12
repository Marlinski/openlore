/**
 * DetailsPanel — form for naming/categorizing the composite,
 * interactive parts list with z-bias adjustment, and Save button.
 */

import { useCallback } from 'preact/hooks'
import { generateId, TILE_SIZE } from '../../lib/pack'
import type { CompositeObject, CompositePart } from '@offisims/pack'
import { useCompositeStore } from '../../store/composite'
import { useSaveComposite } from '../../api/composites'
import { useUIStore } from '../../store/ui'

export function DetailsPanel() {
  const parts = useCompositeStore((s) => s.parts)
  const selectedPartUid = useCompositeStore((s) => s.selectedPartUid)
  const name = useCompositeStore((s) => s.name)
  const category = useCompositeStore((s) => s.category)
  const editingCompositeId = useCompositeStore((s) => s.editingCompositeId)
  const getBBox = useCompositeStore((s) => s.getBBox)
  const getSortedParts = useCompositeStore((s) => s.getSortedParts)

  const setName = useCompositeStore((s) => s.setName)
  const setCategory = useCompositeStore((s) => s.setCategory)
  const selectPart = useCompositeStore((s) => s.selectPart)
  const adjustZBias = useCompositeStore((s) => s.adjustZBias)
  const removePart = useCompositeStore((s) => s.removePart)
  const clearWorkspace = useCompositeStore((s) => s.clearWorkspace)

  const setStatusText = useUIStore((s) => s.setStatusText)
  const saveComposite = useSaveComposite()

  const bbox = getBBox()
  const sortedParts = getSortedParts()

  const handleSave = useCallback(() => {
    if (parts.length === 0 || !bbox) return

    const compositeParts = parts.map((p) => {
      const part = {
        region: { ...p.region },
        offsetX: p.gridX - bbox.minX,
        offsetY: p.gridY - bbox.minY,
      } as CompositePart
      if (p.zBias !== 0) part.zBias = p.zBias
      return part
    })

    const composite: CompositeObject = {
      id: editingCompositeId || `comp_${generateId()}`,
      name: name.trim() || `composite_${generateId()}`,
      parts: compositeParts,
      displayWidth: bbox.w,
      displayHeight: bbox.h,
    } as CompositeObject

    saveComposite.mutate(composite, {
      onSuccess: () => {
        setStatusText(`Saved composite "${composite.name}"`)
        clearWorkspace()
      },
      onError: (err) => {
        setStatusText(`Failed to save: ${err instanceof Error ? err.message : 'Unknown error'}`)
      },
    })
  }, [parts, bbox, name, category, editingCompositeId, saveComposite, clearWorkspace, setStatusText])

  return (
    <div class="composite-details">
      <div class="composite-details-section">
        <label class="composite-field-label">Name</label>
        <input
          type="text"
          class="composite-name-input"
          placeholder="composite name..."
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="composite-details-section">
        <label class="composite-field-label">Category</label>
        <input
          type="text"
          class="composite-category-input"
          placeholder="e.g. furniture, decoration..."
          value={category}
          onInput={(e) => setCategory((e.target as HTMLInputElement).value)}
        />
      </div>

      <div class="composite-details-section">
        <div class="composite-parts-header">
          <span class="composite-field-label">
            Parts ({parts.length})
            {bbox && ` \u2014 ${bbox.w}\u00d7${bbox.h}`}
          </span>
        </div>

        {parts.length === 0 ? (
          <div class="composite-parts-empty">No parts placed yet.</div>
        ) : (
          <PartsList
            sortedParts={sortedParts}
            selectedPartUid={selectedPartUid}
            onSelect={selectPart}
            onAdjustZBias={adjustZBias}
            onRemove={removePart}
          />
        )}
      </div>

      <button
        class="btn btn--accent composite-save-btn"
        disabled={parts.length === 0 || saveComposite.isPending}
        onClick={handleSave}
      >
        {saveComposite.isPending
          ? 'Saving...'
          : editingCompositeId
            ? 'Update Composite'
            : 'Save Composite'}
      </button>
    </div>
  )
}

// ─── Parts List ─────────────────────────────────────────────────────

interface PartsListProps {
  sortedParts: ReturnType<typeof useCompositeStore.getState>['parts']
  selectedPartUid: string | null
  onSelect: (uid: string) => void
  onAdjustZBias: (uid: string, delta: number) => void
  onRemove: (uid: string) => void
}

function PartsList(props: PartsListProps) {
  const { sortedParts, selectedPartUid, onSelect, onAdjustZBias, onRemove } = props

  return (
    <div class="composite-parts-list">
      {sortedParts.map((part, idx) => {
        const biasStr =
          part.zBias !== 0
            ? ` z:${part.zBias > 0 ? '+' : ''}${part.zBias}`
            : ''

        return (
          <div
            key={part.uid}
            class={`composite-part-item${part.uid === selectedPartUid ? ' selected' : ''}`}
            onClick={() => onSelect(part.uid)}
          >
            <span class="composite-part-idx">{idx}</span>
            <span class="composite-part-info">
              {part.region.w}&times;{part.region.h} ({part.gridX},{part.gridY}){biasStr}
            </span>
            <span class="composite-part-actions">
              <button
                title="Move forward (increase z-bias)"
                onClick={(e) => {
                  e.stopPropagation()
                  onAdjustZBias(part.uid, 1)
                }}
              >
                &#9650;
              </button>
              <button
                title="Move behind (decrease z-bias)"
                onClick={(e) => {
                  e.stopPropagation()
                  onAdjustZBias(part.uid, -1)
                }}
              >
                &#9660;
              </button>
            </span>
            <button
              class="composite-part-delete"
              title="Remove part"
              onClick={(e) => {
                e.stopPropagation()
                onRemove(part.uid)
              }}
            >
              &times;
            </button>
          </div>
        )
      })}
    </div>
  )
}
