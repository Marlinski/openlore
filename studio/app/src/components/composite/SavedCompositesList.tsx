/**
 * SavedCompositesList — searchable list of saved composites.
 * Click to load into workspace for editing, delete button to remove.
 */

import { useState, useCallback } from 'preact/hooks'
import { generateId } from '../../lib/pack'
import type { CompositeObject } from '@offisims/pack'
import { useComposites, useDeleteComposite } from '../../api/composites'
import { useCompositeStore } from '../../store/composite'
import type { WorkspacePart } from '../../store/composite'
import { useUIStore } from '../../store/ui'

export function SavedCompositesList() {
  const { data: composites = [] } = useComposites()
  const deleteComposite = useDeleteComposite()
  const loadComposite = useCompositeStore((s) => s.loadComposite)
  const parts = useCompositeStore((s) => s.parts)
  const setStatusText = useUIStore((s) => s.setStatusText)

  const [search, setSearch] = useState('')

  const filtered = composites.filter((c) => {
    const q = search.toLowerCase()
    return (
      c.name.toLowerCase().includes(q) ||
      
      c.id.toLowerCase().includes(q)
    )
  })

  const handleLoad = useCallback(
    (comp: CompositeObject) => {
      // Warn if workspace has unsaved changes
      if (parts.length > 0) {
        if (!confirm('Discard current workspace and load this composite?')) return
      }

      // Convert CompositeParts to WorkspaceParts, offset at (1,1) for padding
      // Guard against protojson zero-value omission (offsetX/offsetY/zBias = 0 → undefined)
      const wsParts: WorkspacePart[] = comp.parts.map((p) => {
        const r = p.region!
        return {
          uid: generateId(),
          region: {
            ...r,
            srcCol: r.srcCol || 0,
            srcRow: r.srcRow || 0,
            w: r.w || 1,
            h: r.h || 1,
          },
          gridX: 1 + (p.offsetX || 0),
          gridY: 1 + (p.offsetY || 0),
          zBias: p.zBias || 0,
        }
      })

      loadComposite(comp.id, comp.name, '', wsParts)
      setStatusText(`Loaded "${comp.name}" for editing`)
    },
    [parts.length, loadComposite, setStatusText],
  )

  const handleDelete = useCallback(
    (comp: CompositeObject) => {
      deleteComposite.mutate(comp.id, {
        onSuccess: () => setStatusText(`Deleted "${comp.name}"`),
      })
    },
    [deleteComposite, setStatusText],
  )

  return (
    <div class="composite-saved">
      <div class="composite-saved-header">
        <span class="composite-field-label">
          Saved ({composites.length})
        </span>
      </div>
      <input
        type="text"
        class="composite-saved-search"
        placeholder="Search composites..."
        value={search}
        onInput={(e) => setSearch((e.target as HTMLInputElement).value)}
      />
      <div class="composite-saved-list">
        {filtered.length === 0 ? (
          <div class="composite-saved-empty">No composites found.</div>
        ) : (
          filtered.map((comp) => (
            <div
              key={comp.id}
              class="composite-saved-item"
              onClick={() => handleLoad(comp)}
            >
              <div class="composite-saved-info">
                <div class="composite-saved-name">{comp.name}</div>
                <div class="composite-saved-meta">
                   {comp.displayWidth}&times;{comp.displayHeight} &middot; {comp.parts.length} parts
                </div>
              </div>
              <button
                class="composite-saved-delete"
                title="Delete composite"
                onClick={(e) => {
                  e.stopPropagation()
                  handleDelete(comp)
                }}
              >
                &times;
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
