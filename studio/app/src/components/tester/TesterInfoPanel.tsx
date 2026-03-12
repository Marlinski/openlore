/**
 * TesterInfoPanel — Live character state display.
 *
 * Shows position, tile, direction, animation state, and door info.
 * Polls at ~100ms via setInterval for smooth updates without re-renders
 * of the game loop.
 */

import { useRef, useEffect, useState } from 'preact/hooks'
import type { TesterCanvasHandle } from './TesterCanvas'
import { useTesterStore } from '../../store/tester'

export interface TesterInfoPanelProps {
  canvasHandle: TesterCanvasHandle | null
}

interface InfoSnapshot {
  charX: number
  charY: number
  charDir: string
  animState: string
  animFrame: number
  tileX: number
  tileY: number
  doorInfo: string
}

export function TesterInfoPanel({ canvasHandle }: TesterInfoPanelProps) {
  const loaded = useTesterStore((s) => s.loaded)
  const error = useTesterStore((s) => s.error)
  const [info, setInfo] = useState<InfoSnapshot | null>(null)

  useEffect(() => {
    if (!loaded || !canvasHandle) {
      setInfo(null)
      return
    }

    const interval = setInterval(() => {
      const gs = canvasHandle.getGameState()
      setInfo({
        charX: gs.charX,
        charY: gs.charY,
        charDir: gs.charDir,
        animState: gs.animState,
        animFrame: gs.animFrame,
        tileX: Math.floor(gs.charX + 0.5),
        tileY: Math.floor(gs.charY + 0.5),
        doorInfo: gs.doorInfo,
      })
    }, 100)

    return () => clearInterval(interval)
  }, [loaded, canvasHandle])

  if (error) {
    return (
      <div class="tester-info tester-info--error">
        Error: {error}
      </div>
    )
  }

  if (!loaded || !info) {
    return (
      <div class="tester-info tester-info--empty">
        Load a room to begin exploring. Use WASD or arrow keys to move.
      </div>
    )
  }

  return (
    <div class="tester-info">
      <span class="tester-info-item">
        Pos: ({info.charX.toFixed(2)}, {info.charY.toFixed(2)})
      </span>
      <span class="tester-info-item">
        Tile: ({info.tileX}, {info.tileY})
      </span>
      <span class="tester-info-item">
        Dir: {info.charDir}
      </span>
      <span class="tester-info-item">
        Anim: {info.animState} #{info.animFrame}
      </span>
      {info.doorInfo && (
        <span class="tester-info-item tester-info-door">
          Door: {info.doorInfo}
        </span>
      )}
    </div>
  )
}
