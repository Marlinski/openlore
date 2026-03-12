/**
 * TesterTab — Shell layout for the Room Tester / Player.
 *
 * Vertical layout: toolbar at top, PixiJS canvas in center, info panel at bottom.
 * Fetches manifest on mount if not already loaded.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks'
import { useTesterStore } from '../../store/tester'
import { TesterToolbar } from './TesterToolbar'
import { TesterCanvas, type TesterCanvasHandle } from './TesterCanvas'
import { TesterInfoPanel } from './TesterInfoPanel'

const TILE_SIZE = 48

export function TesterTab() {
  const manifest = useTesterStore((s) => s.manifest)
  const currentRoom = useTesterStore((s) => s.currentRoom)
  const loaded = useTesterStore((s) => s.loaded)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [canvasHandle, setCanvasHandle] = useState<TesterCanvasHandle | null>(null)

  // Fetch manifest on mount
  useEffect(() => {
    if (!manifest) {
      useTesterStore.getState().fetchManifest()
    }
  }, [])

  const handleFitZoom = useCallback(() => {
    const wrap = wrapRef.current
    if (!wrap || !currentRoom) return 1
    const availW = wrap.clientWidth
    const availH = wrap.clientHeight
    const naturalW = currentRoom.width * TILE_SIZE
    const naturalH = currentRoom.height * TILE_SIZE
    return Math.max(0.25, Math.min(4, Math.min(availW / naturalW, availH / naturalH)))
  }, [currentRoom])

  const handleCanvasHandle = useCallback((handle: TesterCanvasHandle) => {
    setCanvasHandle(handle)
  }, [])

  return (
    <div class="tester-tab">
      <TesterToolbar onFitZoom={handleFitZoom} />
      <div class="tester-canvas-wrap" ref={wrapRef}>
        {loaded ? (
          <TesterCanvas onHandle={handleCanvasHandle} />
        ) : (
          <div class="tester-canvas-empty">
            {manifest
              ? 'Select a room and click "Load Room" to start'
              : 'Loading manifest...'}
          </div>
        )}
      </div>
      <TesterInfoPanel canvasHandle={canvasHandle} />
    </div>
  )
}
