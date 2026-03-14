/**
 * RoomTab — Shell layout for the Room Editor.
 *
 * 3-column layout:
 *   Left: LayoutPanel (layout mode) or TexturePanel (texture mode)
 *   Center: RoomToolbar + RoomCanvas
 *   Right: RoomRightPanel (name, resize, stats, save, saved rooms)
 *
 * Restores editor state from localStorage on mount.
 */

import { useEffect, useRef, useCallback } from 'preact/hooks'
import { TILE_SIZE } from '../../lib/pack'
import { useRoomStore } from '../../store/room'
import { RoomToolbar } from './RoomToolbar'
import { RoomCanvas } from './RoomCanvas'
import { LayoutPanel } from './LayoutPanel'
import { TexturePanel } from './TexturePanel'
import { RoomRightPanel } from './RoomRightPanel'
import { ResizablePanel } from '../ResizablePanel'

export function RoomTab() {
  const mode = useRoomStore((s) => s.mode)
  const roomWidth = useRoomStore((s) => s.roomWidth)
  const wrapRef = useRef<HTMLDivElement>(null)

  // Restore persisted state on mount
  useEffect(() => {
    useRoomStore.getState().restoreState()
  }, [])

  const handleFitZoom = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap) return 1
    const available = wrap.clientWidth - 24
    const natural = roomWidth * TILE_SIZE
    return Math.max(0.05, Math.min(8, available / natural))
  }, [roomWidth])

  return (
    <div class="room-tab">
      {/* Left panel — mode-dependent */}
      <ResizablePanel side="right" defaultWidth={200} minWidth={160} maxWidth={420}>
        <div class="room-left">
          {mode === 'layout' ? <LayoutPanel /> : <TexturePanel />}
        </div>
      </ResizablePanel>

      {/* Center — toolbar + canvas */}
      <div class="room-center" ref={wrapRef}>
        <RoomToolbar onFitZoom={handleFitZoom} />
        <RoomCanvas />
      </div>

      {/* Right panel */}
      <ResizablePanel side="left" defaultWidth={220} minWidth={180} maxWidth={400}>
        <RoomRightPanel />
      </ResizablePanel>
    </div>
  )
}
