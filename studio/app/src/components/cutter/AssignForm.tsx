/**
 * AssignForm — name/tag form for the pending selection or cut being edited.
 *
 * Visible when:
 *   - A new pending selection exists (after drag)
 *   - An existing cut is selected for editing
 *   - An existing saved resource is loaded for editing
 *
 * Features:
 *   - Name input (auto-suggested for new cuts)
 *   - Tag input (per-cut tags, excluding shared tags)
 *   - Info line (dimensions, position)
 *   - Pending preview (animated canvas for multi-frame)
 *   - Add Cut / Edit Cut / Update + Cancel + Delete buttons
 */

import { useState, useEffect, useRef, useCallback } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import { getCachedImage } from '../TilesetPicker'
import { TagInput } from '../TagInput'
import {
  useCutterStore,
  suggestCutName,
  type PendingSelection,
} from '../../store/cutter'

export interface AssignFormProps {
  tileset: TilesetMeta | null
}

export function AssignForm({ tileset }: AssignFormProps) {
  const pendingSelection = useCutterStore((s) => s.pendingSelection)
  const editingCutId = useCutterStore((s) => s.editingCutId)
  const editingResourceId = useCutterStore((s) => s.editingResourceId)
  const cuts = useCutterStore((s) => s.cuts)
  const sharedTags = useCutterStore((s) => s.sharedTags)
  const previewFps = useCutterStore((s) => s.previewFps)

  const addCut = useCutterStore((s) => s.addCut)
  const updateCut = useCutterStore((s) => s.updateCut)
  const removeCut = useCutterStore((s) => s.removeCut)
  const clearSelection = useCutterStore((s) => s.clearSelection)

  const [name, setName] = useState('')
  const [tags, setTags] = useState<string[]>([])
  const previewCanvasRef = useRef<HTMLCanvasElement>(null)
  const animRef = useRef<number | null>(null)

  // Whether we're editing an existing cut
  const editingCut = editingCutId
    ? cuts.find((c) => c.id === editingCutId) ?? null
    : null

  // Determine if form should be visible
  const isVisible = !!pendingSelection || !!editingCut || !!editingResourceId

  // ─── Populate form when editing state changes ─────────────────

  useEffect(() => {
    if (editingCut) {
      setName(editingCut.name)
      // Show per-cut tags (exclude shared tags)
      const perCutTags = editingCut.tags.filter((t) => !sharedTags.includes(t))
      setTags(perCutTags)
    } else if (pendingSelection && !editingResourceId) {
      // Auto-suggest name for new selections
      setName(suggestCutName(tileset?.label, pendingSelection.row, pendingSelection.col))
      setTags([])
    }
  }, [editingCutId, pendingSelection?.col, pendingSelection?.row])

  // ─── Animated preview ─────────────────────────────────────────

  useEffect(() => {
    if (animRef.current !== null) {
      clearInterval(animRef.current)
      animRef.current = null
    }

    const cvs = previewCanvasRef.current
    if (!cvs || !pendingSelection || !tileset) return

    const img = getCachedImage(tileset.id)
    if (!img) return

    const sel = pendingSelection
    const tw = tileset.tileWidth
    const th = tileset.tileHeight
    const fw = sel.frameWidth * tw
    const fh = sel.frameHeight * th

    const maxH = 64
    const scale = fh > maxH ? maxH / fh : 1
    cvs.width = Math.round(fw * scale)
    cvs.height = Math.round(fh * scale)
    cvs.style.width = `${cvs.width}px`
    cvs.style.height = `${cvs.height}px`

    const ctx = cvs.getContext('2d')!
    ctx.imageSmoothingEnabled = false

    // Build frames
    const frames: { sx: number; sy: number }[] = []
    for (let f = 0; f < sel.frameCount; f++) {
      frames.push({
        sx: (sel.col + f * sel.frameWidth) * tw,
        sy: sel.row * th,
      })
    }

    let current = 0
    const drawFrame = () => {
      const frame = frames[current]
      ctx.clearRect(0, 0, cvs.width, cvs.height)
      ctx.drawImage(img, frame.sx, frame.sy, fw, fh, 0, 0, cvs.width, cvs.height)
    }

    drawFrame()
    if (frames.length > 1) {
      animRef.current = window.setInterval(() => {
        current = (current + 1) % frames.length
        drawFrame()
      }, 1000 / previewFps)
    }

    return () => {
      if (animRef.current !== null) {
        clearInterval(animRef.current)
        animRef.current = null
      }
    }
  }, [pendingSelection, tileset, previewFps])

  // ─── Info line ────────────────────────────────────────────────

  const infoText = pendingSelection
    ? pendingSelection.frameCount === 1
      ? `Static ${pendingSelection.frameWidth}x${pendingSelection.frameHeight} at (${pendingSelection.col}, ${pendingSelection.row})`
      : `${pendingSelection.frameCount} frames of ${pendingSelection.frameWidth}x${pendingSelection.frameHeight} at (${pendingSelection.col}, ${pendingSelection.row})`
    : ''

  // ─── Submit handler ───────────────────────────────────────────

  const handleSubmit = useCallback(() => {
    if (!pendingSelection) return
    const trimmedName = name.trim()
    if (!trimmedName) return

    // Merge shared tags with per-cut tags
    const mergedTags = [...sharedTags]
    for (const t of tags) {
      if (!mergedTags.includes(t)) mergedTags.push(t)
    }

    if (editingCutId) {
      // Update existing cut
      updateCut(editingCutId, {
        name: trimmedName,
        tags: mergedTags,
        col: pendingSelection.col,
        row: pendingSelection.row,
        frameWidth: pendingSelection.frameWidth,
        frameHeight: pendingSelection.frameHeight,
        frameCount: pendingSelection.frameCount,
      })
    } else {
      // Add new cut
      addCut(trimmedName, mergedTags, pendingSelection)
    }

    clearSelection()
    setName('')
    setTags([])
  }, [name, tags, pendingSelection, editingCutId, sharedTags, addCut, updateCut, clearSelection])

  // ─── Delete handler ───────────────────────────────────────────

  const handleDelete = useCallback(() => {
    if (editingCutId) {
      removeCut(editingCutId)
      clearSelection()
      setName('')
      setTags([])
    }
  }, [editingCutId, removeCut, clearSelection])

  // ─── Cancel handler ───────────────────────────────────────────

  const handleCancel = useCallback(() => {
    clearSelection()
    setName('')
    setTags([])
  }, [clearSelection])

  // ─── Button label ─────────────────────────────────────────────

  const submitLabel = editingResourceId
    ? 'Update'
    : editingCutId
      ? 'Edit Cut'
      : 'Add Cut'

  // ─── Render ───────────────────────────────────────────────────

  if (!isVisible) {
    return (
      <div class="cutter-assign-form">
        <div class="cutter-assign-hint">
          Drag on the tileset to select a region, or click an existing cut to edit it.
        </div>
      </div>
    )
  }

  return (
    <div class="cutter-assign-form cutter-assign-form--active">
      <div class="cutter-assign-info">{infoText}</div>

      <canvas
        ref={previewCanvasRef}
        class="cutter-assign-preview"
        style={{ imageRendering: 'pixelated' }}
      />

      <label class="cutter-assign-field">
        <span>Name</span>
        <input
          type="text"
          value={name}
          onInput={(e) => setName((e.target as HTMLInputElement).value)}
          placeholder="Resource name"
        />
      </label>

      <label class="cutter-assign-field">
        <span>Tags</span>
        <TagInput
          tags={tags}
          onChange={setTags}
          placeholder="Per-cut tags..."
        />
      </label>

      <div class="cutter-assign-actions">
        <button class="btn btn-primary" onClick={handleSubmit}>
          {submitLabel}
        </button>
        <button class="btn" onClick={handleCancel}>
          Cancel
        </button>
        {editingCutId && (
          <button class="btn btn-danger" onClick={handleDelete}>
            Delete
          </button>
        )}
      </div>
    </div>
  )
}
