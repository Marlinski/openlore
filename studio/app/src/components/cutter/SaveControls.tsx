/**
 * SaveControls — save resources button + status message.
 *
 * "Save Resources" converts all pending cuts into Resource objects
 * and saves them via the API. Shows save status/progress.
 */

import { useState, useCallback } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import type { Resource, ResourceFrame } from '@offisims/pack'
import { generateId } from '../../lib/pack'
import { useSaveResource } from '../../api/resources'
import { useCutterStore } from '../../store/cutter'

export interface SaveControlsProps {
  tileset: TilesetMeta | null
}

export function SaveControls({ tileset }: SaveControlsProps) {
  const cuts = useCutterStore((s) => s.cuts)
  const tilesetId = useCutterStore((s) => s.tilesetId)
  const sharedTags = useCutterStore((s) => s.sharedTags)
  const clearCuts = useCutterStore((s) => s.clearCuts)
  const clearSelection = useCutterStore((s) => s.clearSelection)

  const [status, setStatus] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const saveResource = useSaveResource()

  const showStatus = useCallback((msg: string) => {
    setStatus(msg)
    const id = setTimeout(() => setStatus(null), 3000)
    return () => clearTimeout(id)
  }, [])

  const handleSave = useCallback(async () => {
    if (cuts.length === 0 || !tilesetId) return

    setSaving(true)
    setStatus('Saving…')

    try {
      for (const cut of cuts) {
        const frames: ResourceFrame[] = []

        if (cut.frameCount === 1) {
          frames.push({
            tilesetId,
            srcCol: cut.col,
            srcRow: cut.row,
            w: cut.frameWidth,
            h: cut.frameHeight,
          } as ResourceFrame)
        } else {
          for (let f = 0; f < cut.frameCount; f++) {
            frames.push({
              tilesetId,
              srcCol: cut.col + f * cut.frameWidth,
              srcRow: cut.row,
              w: cut.frameWidth,
              h: cut.frameHeight,
            } as ResourceFrame)
          }
        }

        const resource = {
          id: generateId(),
          name: cut.name,
          tags: [...sharedTags, ...cut.tags],
          frames,
        } as Resource

        await saveResource.mutateAsync(resource)
      }

      const count = cuts.length
      clearCuts()
      clearSelection()
      showStatus(`Saved ${count} resource${count === 1 ? '' : 's'}`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error'
      showStatus(`Error: ${msg}`)
    } finally {
      setSaving(false)
    }
  }, [cuts, tilesetId, sharedTags, clearCuts, clearSelection, saveResource, showStatus])

  const disabled = cuts.length === 0 || !tilesetId || saving

  return (
    <div class="cutter-save-controls">
      <div class="cutter-section-header">Save</div>
      <button
        class="btn btn-primary"
        disabled={disabled}
        onClick={handleSave}
      >
        {saving ? 'Saving…' : `Save Resources (${cuts.length})`}
      </button>
      {status && <div class="cutter-save-status">{status}</div>}
    </div>
  )
}
