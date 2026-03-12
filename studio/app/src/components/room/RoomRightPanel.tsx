/**
 * RoomRightPanel — Right sidebar for the Room tab.
 *
 * Room name input, width/height + resize, room stats,
 * save/clear/export buttons, and saved rooms list.
 */

import { useState, useCallback, useMemo } from 'preact/hooks'
import { useRoomStore, computeRoomStats, hasUnsavedChanges } from '../../store/room'
import { useRooms, useSaveRoom, useDeleteRoom } from '../../api/rooms'
import { extractRoomLayout, extractRoomTexture } from '../../lib/pack'
import type { RoomDefinition } from '@offisims/pack'
import { useComposites } from '../../api/composites'
import { TileStackPanel } from './TileStackPanel'

export function RoomRightPanel() {
  const roomWidth = useRoomStore((s) => s.roomWidth)
  const roomHeight = useRoomStore((s) => s.roomHeight)
  const editingRoomName = useRoomStore((s) => s.editingRoomName)
  const mode = useRoomStore((s) => s.mode)
  const setEditingRoomName = useRoomStore((s) => s.setEditingRoomName)

  const { data: savedRooms = [] } = useRooms()
  const saveRoom = useSaveRoom()
  const deleteRoom = useDeleteRoom()
  const { data: composites = [] } = useComposites()

  const getComposite = useCallback(
    (id: string) => composites.find((c) => c.id === id),
    [composites],
  )

  const [nameInput, setNameInput] = useState(editingRoomName ?? '')
  const [widthInput, setWidthInput] = useState(String(roomWidth))
  const [heightInput, setHeightInput] = useState(String(roomHeight))

  // Sync name when room is loaded
  useMemo(() => {
    if (editingRoomName !== null) setNameInput(editingRoomName)
  }, [editingRoomName])

  useMemo(() => {
    setWidthInput(String(roomWidth))
    setHeightInput(String(roomHeight))
  }, [roomWidth, roomHeight])

  const stats = useMemo(
    () => computeRoomStats(useRoomStore.getState()),
    [useRoomStore((s) => s.walkability), useRoomStore((s) => s.placements), useRoomStore((s) => s.doors)],
  )

  const handleResize = useCallback(() => {
    const w = parseInt(widthInput, 10)
    const h = parseInt(heightInput, 10)
    if (isNaN(w) || isNaN(h)) return
    useRoomStore.getState().resizeRoom(w, h, getComposite)
  }, [widthInput, heightInput, getComposite])

  const handleSave = useCallback(() => {
    const name = nameInput.trim()
    if (!name) return
    const room = useRoomStore.getState().buildRoomDefinition(name)
    saveRoom.mutate(room, {
      onSuccess: () => {
        useRoomStore.getState().setEditingRoomName(name)
      },
    })
  }, [nameInput, saveRoom])

  const handleClear = useCallback(() => {
    const state = useRoomStore.getState()
    if (hasUnsavedChanges(state)) {
      if (!confirm('Discard unsaved changes?')) return
    }
    state.clearRoom()
    state.clearSavedState()
    setNameInput('')
  }, [])

  const handleExport = useCallback(
    (type: 'layout' | 'texture') => {
      const name = nameInput.trim() || 'untitled'
      const room = useRoomStore.getState().buildRoomDefinition(name)
      let data: any
      let filename: string
      if (type === 'layout') {
        data = extractRoomLayout(room)
        filename = `${name}_layout.dat`
      } else {
        data = extractRoomTexture(room)
        filename = `${name}_texture.dat`
      }
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    },
    [nameInput],
  )

  const handleLoadRoom = useCallback(
    (room: RoomDefinition) => {
      const state = useRoomStore.getState()
      if (hasUnsavedChanges(state)) {
        if (!confirm('Discard unsaved changes?')) return
      }
      state.loadRoom(room)
      setNameInput(room.name)
    },
    [],
  )

  const handleDeleteRoom = useCallback(
    (name: string) => {
      if (!confirm(`Delete room "${name}"?`)) return
      deleteRoom.mutate(name)
    },
    [deleteRoom],
  )

  return (
    <div class="room-right-panel">
      {/* Room details */}
      <div class="room-panel-section">
        <div class="room-panel-header">Room</div>

        <div class="room-field">
          <label class="room-field-label">Name</label>
          <input
            type="text"
            class="room-input"
            value={nameInput}
            onInput={(e) => setNameInput((e.target as HTMLInputElement).value)}
            placeholder="room name..."
          />
        </div>

        <div class="room-field room-size-field">
          <div class="room-size-inputs">
            <label class="room-field-label">W</label>
            <input
              type="number"
              class="room-input room-size-input"
              value={widthInput}
              min={4}
              max={50}
              onInput={(e) => setWidthInput((e.target as HTMLInputElement).value)}
            />
            <label class="room-field-label">H</label>
            <input
              type="number"
              class="room-input room-size-input"
              value={heightInput}
              min={4}
              max={50}
              onInput={(e) => setHeightInput((e.target as HTMLInputElement).value)}
            />
            <button class="btn" onClick={handleResize}>
              Resize
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div class="room-panel-section room-stats">
        <div>
          Grid: {roomWidth}&times;{roomHeight} ({stats.total} tiles)
        </div>
        <div>
          Walkable: {stats.walkableCount} / {stats.total}
        </div>
        <div>Doors: {useRoomStore((s) => s.doors).length}</div>
        {stats.floorCount + stats.objectCount > 0 && (
          <div>
            Placements: {stats.floorCount + stats.objectCount} (floor:{' '}
            {stats.floorCount}, objects: {stats.objectCount})
          </div>
        )}
      </div>

      {/* Actions */}
      <div class="room-panel-section room-actions">
        <button
          class="btn btn-primary"
          disabled={!nameInput.trim() || saveRoom.isPending}
          onClick={handleSave}
        >
          {saveRoom.isPending ? 'Saving...' : 'Save Room'}
        </button>
        <button class="btn" onClick={handleClear}>
          Clear
        </button>
        <button class="btn" onClick={() => handleExport('layout')}>
          Export Layout
        </button>
        <button class="btn" onClick={() => handleExport('texture')}>
          Export Texture
        </button>
      </div>

      {/* Tile stack inspector (texture mode only) */}
      {mode === 'texture' && <TileStackPanel />}

      {/* Saved rooms */}
      <div class="room-panel-section room-saved-section">
        <div class="room-panel-header">
          Saved Rooms <span class="room-count">{savedRooms.length}</span>
        </div>
        {savedRooms.length === 0 ? (
          <div class="room-saved-empty">No saved rooms.</div>
        ) : (
          <div class="room-saved-list">
            {savedRooms.map((room) => (
              <div
                key={room.name}
                class="room-saved-item"
                onClick={() => handleLoadRoom(room)}
              >
                <div class="room-saved-info">
                  <span class="room-saved-name">{room.name}</span>
                  <span class="room-saved-meta">
                    {room.width}&times;{room.height} &middot; {room.doors.length} doors
                    &middot; {room.placements.length} placements
                  </span>
                </div>
                <button
                  class="room-saved-delete"
                  onClick={(e) => {
                    e.stopPropagation()
                    handleDeleteRoom(room.name)
                  }}
                >
                  &times;
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
