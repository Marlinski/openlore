/**
 * LayoutPanel — Left sidebar for Layout mode.
 *
 * Walk/door tool selector, door list, and door properties panel.
 */

import { useCallback, useMemo } from 'preact/hooks'
import { useRoomStore, parseDoorTarget } from '../../store/room'
import type { LayoutTool } from '../../store/room'
import { useRooms } from '../../api/rooms'
import type { DoorDefinition, RoomDefinition } from '@offisims/pack'

export function LayoutPanel() {
  const layoutTool = useRoomStore((s) => s.layoutTool)
  const doors = useRoomStore((s) => s.doors)
  const selectedDoorId = useRoomStore((s) => s.selectedDoorId)
  const walkability = useRoomStore((s) => s.walkability)
  const roomWidth = useRoomStore((s) => s.roomWidth)
  const roomHeight = useRoomStore((s) => s.roomHeight)
  const setLayoutTool = useRoomStore((s) => s.setLayoutTool)
  const selectDoor = useRoomStore((s) => s.selectDoor)
  const removeDoor = useRoomStore((s) => s.removeDoor)
  const setDoorTarget = useRoomStore((s) => s.setDoorTarget)

  const { data: savedRooms = [] } = useRooms()

  const total = roomWidth * roomHeight
  const walkableCount = walkability.filter(Boolean).length

  const selectedDoor = useMemo(
    () => doors.find((d) => d.id === selectedDoorId) ?? null,
    [doors, selectedDoorId],
  )

  const handleToolChange = useCallback(
    (tool: LayoutTool) => setLayoutTool(tool),
    [setLayoutTool],
  )

  return (
    <div class="room-layout-panel">
      {/* Tool selector */}
      <div class="room-panel-section">
        <div class="room-panel-header">Tools</div>
        <div class="room-tool-buttons">
          <button
            class={`btn room-tool-btn${layoutTool === 'walk' ? ' btn--accent' : ''}`}
            onClick={() => handleToolChange('walk')}
          >
            Walkability
          </button>
          <button
            class={`btn room-tool-btn${layoutTool === 'door' ? ' btn--accent' : ''}`}
            onClick={() => handleToolChange('door')}
          >
            Doors
          </button>
        </div>
      </div>

      {/* Stats */}
      <div class="room-panel-section">
        <div class="room-layout-stats">
          Walkable: {walkableCount} / {total} &middot; Doors: {doors.length}
        </div>
      </div>

      {/* Tool info */}
      {layoutTool === 'walk' && (
        <div class="room-panel-section room-tool-info">
          Left-click to block, right-click to make walkable. Drag to paint.
        </div>
      )}

      {layoutTool === 'door' && (
        <div class="room-panel-section room-tool-info">
          Click to place a door. Click existing door to select.
        </div>
      )}

      {/* Door list */}
      {doors.length > 0 && (
        <div class="room-panel-section">
          <div class="room-panel-header">
            Doors <span class="room-count">{doors.length}</span>
          </div>
          <div class="room-door-list">
            {doors.map((door) => (
              <DoorListItem
                key={door.id}
                door={door}
                isSelected={door.id === selectedDoorId}
                onSelect={selectDoor}
                onRemove={removeDoor}
              />
            ))}
          </div>
        </div>
      )}

      {/* Door properties */}
      {selectedDoor && (
        <DoorProperties
          door={selectedDoor}
          savedRooms={savedRooms}
          onSetTarget={setDoorTarget}
          onRemove={removeDoor}
        />
      )}
    </div>
  )
}

// ─── Door List Item ─────────────────────────────────────────────────

interface DoorListItemProps {
  door: DoorDefinition
  isSelected: boolean
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}

function DoorListItem({ door, isSelected, onSelect, onRemove }: DoorListItemProps) {
  return (
    <div
      class={`room-door-item${isSelected ? ' selected' : ''}`}
      onClick={() => onSelect(door.id)}
    >
      <div class="room-door-dot" />
      <div class="room-door-info">
        <span class="room-door-id">
          {door.id} ({door.col},{door.row})
        </span>
        <span class={`room-door-target${door.target ? ' linked' : ''}`}>
          {door.target || 'unlinked'}
        </span>
      </div>
      <button
        class="room-door-remove"
        onClick={(e) => {
          e.stopPropagation()
          onRemove(door.id)
        }}
      >
        &times;
      </button>
    </div>
  )
}

// ─── Door Properties ────────────────────────────────────────────────

interface DoorPropertiesProps {
  door: DoorDefinition
  savedRooms: RoomDefinition[]
  onSetTarget: (id: string, target: string) => void
  onRemove: (id: string) => void
}

function DoorProperties({ door, savedRooms, onSetTarget, onRemove }: DoorPropertiesProps) {
  const [targetRoom, targetDoor] = parseDoorTarget(door.target)

  const selectedRoom = useMemo(
    () => savedRooms.find((r) => r.name === targetRoom),
    [savedRooms, targetRoom],
  )

  const handleRoomChange = useCallback(
    (e: Event) => {
      const roomName = (e.target as HTMLSelectElement).value
      // When room changes, clear door selection
      onSetTarget(door.id, roomName ? `${roomName}#` : '')
    },
    [door.id, onSetTarget],
  )

  const handleDoorChange = useCallback(
    (e: Event) => {
      const doorId = (e.target as HTMLSelectElement).value
      if (targetRoom && doorId) {
        onSetTarget(door.id, `${targetRoom}#${doorId}`)
      } else if (targetRoom) {
        onSetTarget(door.id, `${targetRoom}#`)
      } else {
        onSetTarget(door.id, '')
      }
    },
    [door.id, targetRoom, onSetTarget],
  )

  return (
    <div class="room-panel-section room-door-props">
      <div class="room-panel-header">Door Properties</div>
      <div class="room-door-props-id">{door.id}</div>

      <div class="room-door-props-field">
        <label class="room-field-label">Target Room</label>
        <select class="room-select" value={targetRoom} onChange={handleRoomChange}>
          <option value="">(none)</option>
          {savedRooms.map((r) => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
        </select>
      </div>

      <div class="room-door-props-field">
        <label class="room-field-label">Target Door</label>
        <select
          class="room-select"
          value={targetDoor}
          onChange={handleDoorChange}
          disabled={!targetRoom}
        >
          <option value="">(none)</option>
          {selectedRoom?.doors.map((d) => (
            <option key={d.id} value={d.id}>
              {d.id} ({d.col},{d.row})
            </option>
          ))}
        </select>
      </div>

      <div class={`room-door-target-display${door.target ? ' linked' : ''}`}>
        {door.target ? `Target: ${door.target}` : 'Not linked'}
      </div>

      <button
        class="btn btn-danger room-door-remove-btn"
        onClick={() => onRemove(door.id)}
      >
        Remove Door
      </button>
    </div>
  )
}
