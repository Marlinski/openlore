/**
 * SavedResourceList — filtered list of saved resources for the current tileset.
 *
 * Shows resources that reference the current tileset. Click to edit,
 * button to delete. Filter input for searching by name/tags.
 * "Clear All" button removes all resources for this tileset.
 */

import { useState, useMemo, useCallback } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import type { Resource } from '@offisims/pack'
import { useResources, useDeleteResource } from '../../api/resources'
import { useCutterStore } from '../../store/cutter'

export interface SavedResourceListProps {
  tileset: TilesetMeta | null
}

export function SavedResourceList({ tileset }: SavedResourceListProps) {
  const [filter, setFilter] = useState('')

  const tilesetId = useCutterStore((s) => s.tilesetId)
  const editingResourceId = useCutterStore((s) => s.editingResourceId)
  const setEditingResourceId = useCutterStore((s) => s.setEditingResourceId)
  const setPendingSelection = useCutterStore((s) => s.setPendingSelection)
  const selectCut = useCutterStore((s) => s.selectCut)
  const setEditingCutId = useCutterStore((s) => s.setEditingCutId)
  const clearSelection = useCutterStore((s) => s.clearSelection)

  const { data: allResources } = useResources()
  const deleteMutation = useDeleteResource()

  /** Resources whose first frame references this tileset */
  const tilesetResources = useMemo(() => {
    if (!allResources || !tilesetId) return []
    return allResources.filter(
      (r) => r.frames.length > 0 && r.frames[0].tilesetId === tilesetId,
    )
  }, [allResources, tilesetId])

  /** Apply text filter against name and tags */
  const filtered = useMemo(() => {
    if (!filter.trim()) return tilesetResources
    const q = filter.toLowerCase()
    return tilesetResources.filter(
      (r) =>
        r.name.toLowerCase().includes(q) ||
        r.tags.some((t) => t.toLowerCase().includes(q)),
    )
  }, [tilesetResources, filter])

  const handleEdit = useCallback(
    (res: Resource) => {
      // Toggle: clicking same resource deselects
      if (editingResourceId === res.id) {
        clearSelection()
        return
      }
      setEditingResourceId(res.id)
      setEditingCutId(null)
      selectCut(null)
      const f0 = res.frames[0]
      setPendingSelection({
        col: f0.srcCol,
        row: f0.srcRow,
        frameWidth: f0.w,
        frameHeight: f0.h,
        frameCount: res.frames.length,
      })
    },
    [editingResourceId, clearSelection, setEditingResourceId, setEditingCutId, selectCut, setPendingSelection],
  )

  const handleDelete = useCallback(
    (e: Event, id: string) => {
      e.stopPropagation()
      deleteMutation.mutateAsync(id)
      if (editingResourceId === id) clearSelection()
    },
    [deleteMutation, editingResourceId, clearSelection],
  )

  const handleClearAll = useCallback(() => {
    for (const r of tilesetResources) {
      deleteMutation.mutateAsync(r.id)
    }
    clearSelection()
  }, [tilesetResources, deleteMutation, clearSelection])

  if (!tileset) return null

  return (
    <div class="cutter-saved-resources">
      <div class="cutter-section-header">
        Saved Resources <span class="cutter-count">{tilesetResources.length}</span>
      </div>

      {tilesetResources.length > 0 && (
        <input
          type="text"
          class="cutter-filter-input"
          placeholder="Filter by name or tag..."
          value={filter}
          onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
        />
      )}

      <div class="cutter-saved-resources__items">
        {filtered.map((res) => {
          const isSelected = res.id === editingResourceId
          const frameInfo =
            res.frames.length === 1
              ? `${res.frames[0].w}x${res.frames[0].h}`
              : `${res.frames.length}f ${res.frames[0].w}x${res.frames[0].h}`

          return (
            <div
              key={res.id}
              class={`cutter-resource-item ${isSelected ? 'cutter-resource-item--selected' : ''}`}
              onClick={() => handleEdit(res)}
            >
              <span class="cutter-resource-name">{res.name}</span>
              <span class="cutter-resource-info">
                {frameInfo}
                {res.tags.length > 0 && ` · ${res.tags.length} tag${res.tags.length !== 1 ? 's' : ''}`}
              </span>
              <button
                class="cutter-resource-remove"
                onClick={(e: Event) => handleDelete(e, res.id)}
                title="Delete resource"
              >
                x
              </button>
            </div>
          )
        })}
      </div>

      {tilesetResources.length > 0 && (
        <button
          class="btn btn-danger"
          onClick={handleClearAll}
        >
          Clear All
        </button>
      )}
    </div>
  )
}
