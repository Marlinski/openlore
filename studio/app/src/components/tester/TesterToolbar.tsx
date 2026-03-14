/**
 * TesterToolbar — Room/character selection, overlays.
 *
 * Sits at the top of the tester tab.
 */

import { useTesterStore } from '../../store/tester'

export function TesterToolbar() {
  const manifest = useTesterStore((s) => s.manifest)
  const selectedRoom = useTesterStore((s) => s.selectedRoom)
  const selectedChar = useTesterStore((s) => s.selectedChar)
  const showGrid = useTesterStore((s) => s.showGrid)
  const showWalkability = useTesterStore((s) => s.showWalkability)
  const loaded = useTesterStore((s) => s.loaded)
  const loading = useTesterStore((s) => s.loading)
  const currentRoom = useTesterStore((s) => s.currentRoom)
  const setSelectedRoom = useTesterStore((s) => s.setSelectedRoom)
  const setSelectedChar = useTesterStore((s) => s.setSelectedChar)
  const toggleGrid = useTesterStore((s) => s.toggleGrid)
  const toggleWalkability = useTesterStore((s) => s.toggleWalkability)
  const loadRoom = useTesterStore((s) => s.loadRoom)

  const rooms = manifest?.roomEntries ?? []
  const resourceEntries = manifest?.resourceEntries ?? []
  const characters = resourceEntries.filter((r) =>
    (r.tags ?? []).some((t: string) => t === 'entity:character'),
  )
  // Extract unique character names from name: tags
  const charNames = [...new Set(characters.flatMap((c) =>
    (c.tags ?? []).filter((t: string) => t.startsWith('name:')).map((t: string) => t.slice(5))
  ))].sort()

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

      {loaded && currentRoom && (
        <span class="tester-mode-hint">
          {currentRoom.name || ''} — {currentRoom.width || 0}x{currentRoom.height || 0}
          {selectedChar ? ` — ${selectedChar}` : ''}
        </span>
      )}
    </div>
  )
}
