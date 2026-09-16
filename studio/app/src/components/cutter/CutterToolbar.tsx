/**
 * CutterToolbar — toolbar above the canvas.
 *
 * Row 1 (left):   [GRID] [RESOURCES] [CUTS] toggle buttons
 * Row 1 (right):  Fixed-width TagInput (no inline pills) + Save Mask + Load Mask
 * Row 2:          Tag bar — shared tag pills rendered horizontally (only when tags exist)
 */

import { useState, useRef, useCallback, useEffect, useMemo } from 'preact/hooks'
import type { TilesetMeta } from '../../api/tilesets'
import type { Mask, MaskCut } from '@openlore/pack'
import { generateId } from '../../lib/pack'
import { useMasks, useSaveMask, useDeleteMask } from '../../api/masks'
import { useCutterStore, type CutEntry, getSharedTags } from '../../store/cutter'
import { TagInput, parseTagString } from '../TagInput'

export interface CutterToolbarProps {
  tileset: TilesetMeta | null
}

export function CutterToolbar({ tileset }: CutterToolbarProps) {
  const showGrid = useCutterStore((s) => s.showGrid)
  const showCuts = useCutterStore((s) => s.showCuts)
  const showResources = useCutterStore((s) => s.showResources)
  const setShowGrid = useCutterStore((s) => s.setShowGrid)
  const setShowCuts = useCutterStore((s) => s.setShowCuts)
  const setShowResources = useCutterStore((s) => s.setShowResources)

  const addSharedTag = useCutterStore((s) => s.addSharedTag)
  const removeSharedTag = useCutterStore((s) => s.removeSharedTag)
  const cuts = useCutterStore((s) => s.cuts)
  const sharedTags = useMemo(() => getSharedTags(cuts), [cuts])
  const tilesetId = useCutterStore((s) => s.tilesetId)
  const setCuts = useCutterStore((s) => s.setCuts)
  const clearCuts = useCutterStore((s) => s.clearCuts)
  const clearSelection = useCutterStore((s) => s.clearSelection)

  const { data: masks = [] } = useMasks()
  const saveMask = useSaveMask()
  const deleteMask = useDeleteMask()

  // ─── Popup state ──────────────────────────────────────────────

  const [saveOpen, setSaveOpen] = useState(false)
  const [loadOpen, setLoadOpen] = useState(false)
  const [maskName, setMaskName] = useState('')
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const saveRef = useRef<HTMLDivElement>(null)
  const loadRef = useRef<HTMLDivElement>(null)

  // Build name→mask lookup for overwrite detection
  const maskByName = useMemo(() => {
    const map = new Map<string, Mask>()
    for (const m of masks) map.set(m.name.toLowerCase(), m)
    return map
  }, [masks])

  // Check if current name matches an existing mask
  const existingMask = maskName.trim()
    ? maskByName.get(maskName.trim().toLowerCase()) ?? null
    : null

  // Close popups on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (saveRef.current && !saveRef.current.contains(e.target as Node)) {
        setSaveOpen(false)
      }
      if (loadRef.current && !loadRef.current.contains(e.target as Node)) {
        setLoadOpen(false)
        setConfirmDeleteId(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // ─── Save Mask (with overwrite support) ───────────────────────

  const handleSaveMask = useCallback(async () => {
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

    // Reuse existing ID if overwriting by name
    const existing = maskByName.get(name.toLowerCase())
    const id = existing ? existing.id : generateId()

    const mask = {
      id,
      name,
      tileWidth: tileset.tileWidth,
      tileHeight: tileset.tileHeight,
      cuts: maskCuts,
    } as Mask

    await saveMask.mutateAsync(mask)
    setMaskName('')
    setSaveOpen(false)
  }, [cuts, tileset, maskName, maskByName, saveMask])

  // ─── Apply Mask ───────────────────────────────────────────────

  const handleApplyMask = useCallback(
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
      setLoadOpen(false)
    },
    [tilesetId, setCuts, clearSelection],
  )

  // ─── Clear Cuts ───────────────────────────────────────────────

  const handleClearCuts = useCallback(() => {
    clearCuts()
    clearSelection()
  }, [clearCuts, clearSelection])

  // ─── Delete Mask (with confirmation) ──────────────────────────

  const handleDeleteMask = useCallback(
    async (e: Event, id: string) => {
      e.stopPropagation()
      if (confirmDeleteId === id) {
        // Second click: actually delete
        await deleteMask.mutateAsync(id)
        setConfirmDeleteId(null)
      } else {
        // First click: show confirmation
        setConfirmDeleteId(id)
      }
    },
    [confirmDeleteId, deleteMask],
  )

  // ─── Handle tag input changes (add/remove shared tags) ─────────

  const handleSharedTagsChange = useCallback(
    (newTags: string[]) => {
      // Detect added tags
      for (const t of newTags) {
        if (!sharedTags.includes(t)) addSharedTag(t)
      }
      // Detect removed tags
      for (const t of sharedTags) {
        if (!newTags.includes(t)) removeSharedTag(t)
      }
    },
    [sharedTags, addSharedTag, removeSharedTag],
  )

  // ─── Remove a single shared tag ───────────────────────────────

  const handleRemoveTag = useCallback(
    (tag: string) => {
      removeSharedTag(tag)
    },
    [removeSharedTag],
  )

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div class="cutter-toolbar-wrap">
      {/* Row 1: controls */}
      <div class="cutter-toolbar">
        {/* Left: toggle buttons */}
        <div class="cutter-toolbar__group">
          <button
            class={`cutter-toolbar__toggle${showGrid ? ' active' : ''}`}
            onClick={() => setShowGrid(!showGrid)}
            title="Toggle grid"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="1" y="1" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.2" />
              <rect x="8" y="1" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.2" />
              <rect x="1" y="8" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.2" />
              <rect x="8" y="8" width="5" height="5" rx="0.5" stroke="currentColor" stroke-width="1.2" />
            </svg>
            Grid
          </button>

          <button
            class={`cutter-toolbar__toggle${showResources ? ' active' : ''}`}
            onClick={() => setShowResources(!showResources)}
            title="Toggle saved resource overlays"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <rect x="2" y="3" width="10" height="8" rx="1" stroke="currentColor" stroke-width="1.2" />
              <path d="M5 3V2a1 1 0 0 1 1-1h2a1 1 0 0 1 1 1v1" stroke="currentColor" stroke-width="1.2" />
            </svg>
            Resources
          </button>

          <button
            class={`cutter-toolbar__toggle${showCuts ? ' active' : ''}`}
            onClick={() => setShowCuts(!showCuts)}
            title="Toggle cuts overlay"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M2 4h10M2 7h10M2 10h10" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
            Cuts
          </button>
        </div>

        {/* Right: tag input + mask controls */}
        <div class="cutter-toolbar__group">
          {tileset && (
            <TagInput
              tags={sharedTags}
              onChange={handleSharedTagsChange}
              placeholder="tag"
              class="cutter-toolbar__tag-input"
              showPills={false}
            />
          )}

          {/* Clear cuts */}
          {cuts.length > 0 && (
            <button class="btn" onClick={handleClearCuts}>
              Clear Cuts
            </button>
          )}

          {/* Save Mask */}
          <div class="cutter-toolbar__popup-anchor" ref={saveRef}>
            <button
              class="btn"
              disabled={cuts.length === 0 || !tileset}
              onClick={() => setSaveOpen(!saveOpen)}
            >
              Save Mask
            </button>
            {saveOpen && (
              <div class="cutter-toolbar__popup">
                <div class="cutter-toolbar__popup-title">Save as Mask</div>
                <input
                  type="text"
                  class="cutter-toolbar__popup-input"
                  placeholder="Mask name..."
                  value={maskName}
                  onInput={(e) => setMaskName((e.target as HTMLInputElement).value)}
                  onKeyDown={(e) => {
                    if ((e as KeyboardEvent).key === 'Enter') handleSaveMask()
                  }}
                />
                {existingMask && (
                  <div class="cutter-toolbar__popup-hint">
                    Overwrite existing "{existingMask.name}" ({existingMask.cuts.length} cuts)
                  </div>
                )}
                <button
                  class="btn btn-primary"
                  style={{ width: '100%' }}
                  onClick={handleSaveMask}
                >
                  {existingMask ? 'Overwrite' : 'Save'}
                </button>
              </div>
            )}
          </div>

          {/* Load Mask */}
          <div class="cutter-toolbar__popup-anchor" ref={loadRef}>
            <button
              class="btn"
              disabled={!tilesetId}
              onClick={() => {
                setLoadOpen(!loadOpen)
                setConfirmDeleteId(null)
              }}
            >
              Load Mask
              {masks.length > 0 && (
                <span class="cutter-toolbar__badge">{masks.length}</span>
              )}
            </button>
            {loadOpen && (
              <div class="cutter-toolbar__popup cutter-toolbar__popup--wide">
                <div class="cutter-toolbar__popup-title">
                  Masks ({masks.length})
                </div>
                {masks.length === 0 && (
                  <div class="cutter-toolbar__popup-empty">No saved masks</div>
                )}
                {masks.map((mask: Mask) => (
                  <div key={mask.id} class="cutter-toolbar__mask-item">
                    <span class="cutter-toolbar__mask-name">{mask.name}</span>
                    <span class="cutter-toolbar__mask-info">
                      {mask.cuts.length} cut{mask.cuts.length === 1 ? '' : 's'}
                    </span>
                    <button
                      class="btn"
                      onClick={() => handleApplyMask(mask)}
                    >
                      Apply
                    </button>
                    {confirmDeleteId === mask.id ? (
                      <button
                        class="btn btn-danger"
                        onClick={(e: Event) => handleDeleteMask(e, mask.id)}
                      >
                        Confirm?
                      </button>
                    ) : (
                      <button
                        class="btn btn-danger cutter-toolbar__mask-delete"
                        onClick={(e: Event) => handleDeleteMask(e, mask.id)}
                        title="Delete mask"
                      >
                        &times;
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Row 2: tag bar — shared tag pills (only when tags exist) */}
      {sharedTags.length > 0 && (
        <div class="cutter-toolbar__tagbar">
          {sharedTags.map((tag) => {
            const { key, value } = parseTagString(tag)
            return (
              <span key={tag} class="tag-input-pill">
                {key && <span class="tag-input-pill-key">{key}</span>}
                {key && <span class="tag-input-pill-sep">:</span>}
                <span class="tag-input-pill-value">{value}</span>
                <span
                  class="tag-input-pill-remove"
                  onClick={() => handleRemoveTag(tag)}
                >
                  &times;
                </span>
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
