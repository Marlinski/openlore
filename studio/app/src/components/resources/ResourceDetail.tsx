/**
 * ResourceDetail — right-side panel for viewing/editing a selected resource.
 *
 * Shows animated preview, editable name, editable tags (via TagInput),
 * and Save/Delete/Close actions.
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import type { Resource, ResourceFrame } from '@openlore/pack'
import { useTileset } from '../../api/tilesets'
import { useSaveResource, useDeleteResource } from '../../api/resources'
import { loadImage } from '../TilesetPicker'
import { TagInput } from '../TagInput'

const ANIM_FPS = 8
const MAX_PREVIEW = 96

interface ResourceDetailProps {
  resource: Resource
  onClose: () => void
}

export function ResourceDetail({ resource, onClose }: ResourceDetailProps) {
  const frame0 = resource.frames[0]
  const { data: meta } = useTileset(frame0?.tilesetId ?? null)

  const saveMutation = useSaveResource()
  const deleteMutation = useDeleteResource()

  const [name, setName] = useState(resource.name)
  const [tags, setTags] = useState<string[]>([...resource.tags])
  const [confirmDelete, setConfirmDelete] = useState(false)

  const canvasRef = useRef<HTMLCanvasElement>(null)

  // Reset form when resource changes
  useEffect(() => {
    setName(resource.name)
    setTags([...resource.tags])
    setConfirmDelete(false)
  }, [resource.id])

  // ─── Animated preview ─────────────────────────────────────────

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !frame0 || !meta) return

    const tw = meta.tileWidth || 1
    const th = meta.tileHeight || 1
    const fw = (frame0.w || 1) * tw
    const fh = (frame0.h || 1) * th
    const scale = fh > MAX_PREVIEW ? MAX_PREVIEW / fh : 1
    canvas.width = Math.round(fw * scale)
    canvas.height = Math.round(fh * scale)
    canvas.style.width = `${canvas.width}px`
    canvas.style.height = `${canvas.height}px`

    let cancelled = false
    let timerId: number | null = null

    loadImage(frame0.tilesetId).then((img) => {
      if (!img) return
      if (cancelled) return
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.imageSmoothingEnabled = false

      const drawF = (f: ResourceFrame) => {
        const w = (f.w || 1) * tw
        const h = (f.h || 1) * th
        ctx.clearRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, (f.srcCol || 0) * tw, (f.srcRow || 0) * th, w, h, 0, 0, canvas.width, canvas.height)
      }

      drawF(frame0)

      if (resource.frames.length > 1) {
        let idx = 0
        timerId = window.setInterval(() => {
          idx = (idx + 1) % resource.frames.length
          drawF(resource.frames[idx])
        }, 1000 / ANIM_FPS)
      }
    }).catch(() => {})

    return () => {
      cancelled = true
      if (timerId !== null) clearInterval(timerId)
    }
  }, [resource.id, resource.frames, frame0, meta])

  // ─── Handlers ─────────────────────────────────────────────────

  const isDirty = name !== resource.name || !tagsEqual(tags, resource.tags)

  const handleSave = useCallback(async () => {
    const trimmed = name.trim()
    if (!trimmed) return
    await saveMutation.mutateAsync({
      ...resource,
      name: trimmed,
      tags,
    })
  }, [resource, name, tags, saveMutation])

  const handleDelete = useCallback(async () => {
    if (!confirmDelete) {
      setConfirmDelete(true)
      return
    }
    await deleteMutation.mutateAsync(resource.id)
    onClose()
  }, [resource.id, confirmDelete, deleteMutation, onClose])

  const handleCancel = useCallback(() => {
    setName(resource.name)
    setTags([...resource.tags])
    setConfirmDelete(false)
  }, [resource])

  // ─── Info line ────────────────────────────────────────────────

  const infoText = frame0
    ? `${resource.frames.length} frame${resource.frames.length !== 1 ? 's' : ''} · ${(frame0.w || 1)}x${(frame0.h || 1)} tiles`
    : 'No frames'

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div class="resources-detail">
      <div class="resources-detail__header">
        <span class="resources-detail__title">Resource</span>
        <button class="resources-detail__close" onClick={onClose} title="Close">&times;</button>
      </div>

      <div class="resources-detail__body">
        {/* Preview */}
        <div class="resources-detail__preview">
          <canvas
            ref={canvasRef}
            style={{ imageRendering: 'pixelated' }}
          />
        </div>

        <div class="resources-detail__info">{infoText}</div>

        {/* Name */}
        <label class="resources-detail__field">
          <span>Name</span>
          <input
            type="text"
            value={name}
            onInput={(e) => setName((e.target as HTMLInputElement).value)}
            placeholder="Resource name"
          />
        </label>

        {/* Tags */}
        <label class="resources-detail__field">
          <span>Tags</span>
          <TagInput
            tags={tags}
            onChange={setTags}
            placeholder="Add tags..."
          />
        </label>
      </div>

      {/* Actions */}
      <div class="resources-detail__actions">
        <button
          class="btn btn-primary"
          onClick={handleSave}
          disabled={!isDirty || saveMutation.isPending}
        >
          {saveMutation.isPending ? 'Saving...' : 'Save'}
        </button>
        <button
          class="btn"
          onClick={handleCancel}
          disabled={!isDirty}
        >
          Cancel
        </button>
        <button
          class={`btn ${confirmDelete ? 'btn-danger' : ''}`}
          onClick={handleDelete}
          disabled={deleteMutation.isPending}
        >
          {deleteMutation.isPending
            ? 'Deleting...'
            : confirmDelete
              ? 'Confirm Delete'
              : 'Delete'}
        </button>
      </div>
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────

function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}
