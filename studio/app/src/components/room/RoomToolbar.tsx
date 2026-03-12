/**
 * RoomToolbar — Mode toggle, layer tabs, grid toggle, zoom control.
 *
 * Sits at the top of the center canvas area.
 */

import { useCallback } from 'preact/hooks'
import { useRoomStore } from '../../store/room'
import type { EditorMode, LayerTab } from '../../store/room'

const ZOOM_OPTIONS = [
  { label: 'Fit', value: 'fit' },
  { label: '25%', value: '0.25' },
  { label: '50%', value: '0.5' },
  { label: '75%', value: '0.75' },
  { label: '100%', value: '1' },
  { label: '150%', value: '1.5' },
  { label: '200%', value: '2' },
  { label: '300%', value: '3' },
]

export interface RoomToolbarProps {
  /** Called to compute fit zoom when "Fit" is selected. */
  onFitZoom: () => number
}

export function RoomToolbar({ onFitZoom }: RoomToolbarProps) {
  const mode = useRoomStore((s) => s.mode)
  const layerTab = useRoomStore((s) => s.layerTab)
  const showGrid = useRoomStore((s) => s.showGrid)
  const zoom = useRoomStore((s) => s.zoom)
  const setMode = useRoomStore((s) => s.setMode)
  const setLayerTab = useRoomStore((s) => s.setLayerTab)
  const setShowGrid = useRoomStore((s) => s.setShowGrid)
  const setZoom = useRoomStore((s) => s.setZoom)

  const handleModeChange = useCallback(
    (m: EditorMode) => setMode(m),
    [setMode],
  )

  const handleZoomChange = useCallback(
    (e: Event) => {
      const val = (e.target as HTMLSelectElement).value
      if (val === 'fit') {
        setZoom(onFitZoom())
      } else {
        setZoom(parseFloat(val))
      }
    },
    [setZoom, onFitZoom],
  )

  const handleLayerChange = useCallback(
    (tab: LayerTab) => setLayerTab(tab),
    [setLayerTab],
  )

  // Find closest zoom option
  const closestZoom = ZOOM_OPTIONS.reduce((prev, opt) => {
    if (opt.value === 'fit') return prev
    const diff = Math.abs(parseFloat(opt.value) - zoom)
    const prevDiff = Math.abs(parseFloat(prev) - zoom)
    return diff < prevDiff ? opt.value : prev
  }, '1')

  return (
    <div class="room-toolbar">
      <div class="room-toolbar-group">
        <button
          class={`btn room-mode-btn${mode === 'layout' ? ' btn--accent' : ''}`}
          onClick={() => handleModeChange('layout')}
        >
          Layout
        </button>
        <button
          class={`btn room-mode-btn${mode === 'texture' ? ' btn--accent' : ''}`}
          onClick={() => handleModeChange('texture')}
        >
          Texture
        </button>
      </div>

      {mode === 'texture' && (
        <div class="room-toolbar-group room-layer-tabs">
          {(['floor', 'object', 'both'] as LayerTab[]).map((tab) => (
            <button
              key={tab}
              class={`btn room-layer-btn${layerTab === tab ? ' btn--accent' : ''}`}
              onClick={() => handleLayerChange(tab)}
            >
              {tab[0].toUpperCase() + tab.slice(1)}
            </button>
          ))}
        </div>
      )}

      <div class="room-toolbar-spacer" />

      <label class="room-toolbar-label">
        <input
          type="checkbox"
          checked={showGrid}
          onChange={(e) => setShowGrid((e.target as HTMLInputElement).checked)}
        />
        Grid
      </label>

      <select
        class="room-zoom-select"
        value={closestZoom}
        onChange={handleZoomChange}
      >
        {ZOOM_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      <span class="room-mode-hint">
        {mode === 'layout'
          ? 'Left=block Right=walk'
          : 'Click to place, Shift+drag to paint'}
      </span>
    </div>
  )
}
