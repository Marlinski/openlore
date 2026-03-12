/**
 * TesterToolbar — Room/character selection, overlays, zoom.
 *
 * Sits at the top of the tester tab.
 */

import { useCallback } from 'preact/hooks'
import { useTesterStore } from '../../store/tester'

const ZOOM_OPTIONS = [
  { label: '0.25x', value: '0.25' },
  { label: '0.5x', value: '0.5' },
  { label: '1x', value: '1' },
  { label: '2x', value: '2' },
  { label: '4x', value: '4' },
  { label: 'Fit', value: 'fit' },
]

export interface TesterToolbarProps {
  onFitZoom: () => number
}

export function TesterToolbar({ onFitZoom }: TesterToolbarProps) {
  const manifest = useTesterStore((s) => s.manifest)
  const selectedRoom = useTesterStore((s) => s.selectedRoom)
  const selectedChar = useTesterStore((s) => s.selectedChar)
  const zoom = useTesterStore((s) => s.zoom)
  const showGrid = useTesterStore((s) => s.showGrid)
  const showWalkability = useTesterStore((s) => s.showWalkability)
  const loaded = useTesterStore((s) => s.loaded)
  const loading = useTesterStore((s) => s.loading)
  const currentRoom = useTesterStore((s) => s.currentRoom)
  const setSelectedRoom = useTesterStore((s) => s.setSelectedRoom)
  const setSelectedChar = useTesterStore((s) => s.setSelectedChar)
  const setZoom = useTesterStore((s) => s.setZoom)
  const toggleGrid = useTesterStore((s) => s.toggleGrid)
  const toggleWalkability = useTesterStore((s) => s.toggleWalkability)
  const loadRoom = useTesterStore((s) => s.loadRoom)

  const rooms = manifest?.rooms ?? []
  const characters = manifest?.resources.filter((r) =>
    r.tags.some((t) => t === 'type:character'),
  ) ?? []
  // Deduplicate character names
  const charNames = [...new Set(characters.map((c) => c.name))]

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

  const closestZoom = ZOOM_OPTIONS.reduce((prev, opt) => {
    if (opt.value === 'fit') return prev
    const diff = Math.abs(parseFloat(opt.value) - zoom)
    const prevDiff = Math.abs(parseFloat(prev) - zoom)
    return diff < prevDiff ? opt.value : prev
  }, '1')

  return (
    <div class="tester-toolbar">
      <select
        class="tester-select"
        value={selectedRoom}
        onChange={(e) => setSelectedRoom((e.target as HTMLSelectElement).value)}
      >
        <option value="">-- Room --</option>
        {rooms.map((r) => (
          <option key={r.name} value={r.name}>
            {r.name}
          </option>
        ))}
      </select>

      <select
        class="tester-select"
        value={selectedChar}
        onChange={(e) => setSelectedChar((e.target as HTMLSelectElement).value)}
      >
        <option value="">-- Character --</option>
        {charNames.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>

      <button
        class="btn btn--accent"
        disabled={loading || !selectedRoom}
        onClick={() => loadRoom()}
      >
        {loading ? 'Loading...' : 'Load Room'}
      </button>

      <div class="tester-toolbar-spacer" />

      <label class="tester-toolbar-label">
        <input
          type="checkbox"
          checked={showGrid}
          onChange={() => toggleGrid()}
        />
        Grid
      </label>

      <label class="tester-toolbar-label">
        <input
          type="checkbox"
          checked={showWalkability}
          onChange={() => toggleWalkability()}
        />
        Walkability
      </label>

      <select
        class="tester-select"
        value={closestZoom}
        onChange={handleZoomChange}
      >
        {ZOOM_OPTIONS.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>

      {loaded && currentRoom && (
        <span class="tester-mode-hint">
          {currentRoom.name} — {currentRoom.width}x{currentRoom.height}
          {selectedChar ? ` — ${selectedChar}` : ''}
        </span>
      )}
    </div>
  )
}
