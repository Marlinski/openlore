/**
 * MaskPanel — save/apply/delete masks for the current tileset.
 *
 * "Save as Mask" captures the current cut pattern as a reusable Mask.
 * "Apply Mask" applies a mask to the current tileset, creating cuts.
 * Lists existing masks with delete buttons.
 */

import { useState, useCallback } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import type { Mask, MaskCut } from '@openlore/pack'
import { generateId } from '../../lib/pack'
import { useMasks, useSaveMask, useDeleteMask } from '../../api/masks'
import { useCutterStore, type CutEntry } from '../../store/cutter'

export interface MaskPanelProps {
  tileset: TilesetMeta | null
}

export function MaskPanel({ tileset }: MaskPanelProps) {
  const cuts = useCutterStore((s) => s.cuts)
  const tilesetId = useCutterStore((s) => s.tilesetId)
  const setCuts = useCutterStore((s) => s.setCuts)
  const clearSelection = useCutterStore((s) => s.clearSelection)

  const { data: masks = [] } = useMasks()
  const saveMask = useSaveMask()
  const deleteMask = useDeleteMask()

  const [maskName, setMaskName] = useState('')

  // ─── Save as Mask ──────────────────────────────────────────────────

  const handleSave = useCallback(async () => {
    if (cuts.length === 0 || !tileset) return

    const name = maskName.trim() || 'untitled'

    const maskCuts = cuts.map((cut: CutEntry) => ({
      tags: cut.tags,
      row: cut.row,
      startFrame: cut.col,
      frameCount: cut.frameCount,
      frameWidth: cut.frameWidth,
      frameHeight: cut.frameHeight,
    } as MaskCut))

    const mask = {
      id: generateId(),
      name,
      tileWidth: tileset.tileWidth,
      tileHeight: tileset.tileHeight,
      cuts: maskCuts,
    } as Mask

    await saveMask.mutateAsync(mask)
    setMaskName('')
  }, [cuts, tileset, maskName, saveMask])

  // ─── Apply Mask ────────────────────────────────────────────────────

  const handleApply = useCallback(
    (mask: Mask) => {
      if (!tilesetId) return

      const newCuts: CutEntry[] = mask.cuts.map((mc: MaskCut) => ({
        id: generateId(),
        name: mc.tags.join('_') || 'cut',
        tags: [...mc.tags],
        col: mc.startFrame || 0,
        row: mc.row || 0,
        frameWidth: mc.frameWidth || 1,
        frameHeight: mc.frameHeight || 1,
        frameCount: mc.frameCount || 1,
      }))

      setCuts(newCuts)
      clearSelection()
    },
    [tilesetId, setCuts, clearSelection],
  )

  // ─── Delete Mask ───────────────────────────────────────────────────

  const handleDelete = useCallback(
    async (e: Event, id: string) => {
      e.stopPropagation()
      await deleteMask.mutateAsync(id)
    },
    [deleteMask],
  )

  // ─── Render ────────────────────────────────────────────────────────

  return (
    <div class="cutter-mask-panel">
      <div class="cutter-section-header">
        Masks <span class="cutter-count">{masks.length}</span>
      </div>

      {/* Save current cuts as a new mask */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '8px' }}>
        <input
          type="text"
          placeholder="Mask name"
          value={maskName}
          onInput={(e) => setMaskName((e.target as HTMLInputElement).value)}
          style={{ flex: 1, minWidth: 0 }}
        />
        <button
          class="btn btn-primary"
          disabled={cuts.length === 0 || !tileset}
          onClick={handleSave}
        >
          Save as Mask
        </button>
      </div>

      {/* Existing masks */}
      {masks.map((mask: Mask) => (
        <div key={mask.id} class="cutter-mask-item">
          <span class="cutter-mask-name">{mask.name}</span>
          <span class="cutter-mask-info">
            {mask.cuts.length} cut{mask.cuts.length === 1 ? '' : 's'}
          </span>
          <button
            class="btn"
            disabled={!tilesetId}
            onClick={() => handleApply(mask)}
          >
            Apply
          </button>
          <button
            class="btn btn-danger"
            onClick={(e: Event) => handleDelete(e, mask.id)}
          >
            x
          </button>
        </div>
      ))}
    </div>
  )
}
