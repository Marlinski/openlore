/**
 * TesterTab — Shell layout for the Room Tester / Player.
 *
 * Vertical layout: toolbar at top, PixiJS canvas in center, info panel at bottom.
 * Fetches manifest on mount if not already loaded.
 * Shows a "please pack first" overlay when no compiled pack exists.
 */

import { useEffect, useRef, useState, useCallback } from 'preact/hooks'
import { useTesterStore } from '../../store/tester'
import { usePackStore } from '../../store/pack'
import { TesterToolbar } from './TesterToolbar'
import { TesterCanvas, type TesterCanvasHandle } from './TesterCanvas'
import { TesterInfoPanel } from './TesterInfoPanel'

export function TesterTab() {
  const manifest = useTesterStore((s) => s.manifest)
  const loaded = useTesterStore((s) => s.loaded)
  const loading = useTesterStore((s) => s.loading)
  const error = useTesterStore((s) => s.error)
  const isStale = usePackStore((s) => s.isStale)
  const wrapRef = useRef<HTMLDivElement>(null)
  const [canvasHandle, setCanvasHandle] = useState<TesterCanvasHandle | null>(null)

  // Fetch manifest on mount (or retry if previously failed)
  useEffect(() => {
    const { manifest, error } = useTesterStore.getState()
    if (!manifest || error) {
      useTesterStore.getState().fetchManifest()
    }
  }, [])

  const handleCanvasHandle = useCallback((handle: TesterCanvasHandle) => {
    setCanvasHandle(handle)
  }, [])

  // No compiled pack — show greyed-out overlay
  const noPack = !manifest && !loading && !!error

  return (
    <div class={`tester-tab${noPack ? ' tester-tab--no-pack' : ''}`}>
      <TesterToolbar />
      {isStale && loaded && (
        <div class="tester-stale-banner">
          Pack is outdated — workspace has changed since last compile
        </div>
      )}
      <div class="tester-canvas-wrap" ref={wrapRef}>
        {noPack ? (
          <div class="tester-no-pack-overlay">
            <div class="tester-no-pack-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
                <polyline points="3.27 6.96 12 12.01 20.73 6.96"/>
                <line x1="12" y1="22.08" x2="12" y2="12"/>
              </svg>
            </div>
            <div class="tester-no-pack-title">No compiled pack found</div>
            <div class="tester-no-pack-hint">
              Use the <strong>PACK IT</strong> button in the top bar to compile your workspace first.
            </div>
          </div>
        ) : loaded ? (
          <TesterCanvas onHandle={handleCanvasHandle} />
        ) : (
          <div class="tester-canvas-empty">
            {loading
              ? 'Loading...'
              : manifest
                ? 'Select a room and click "Load Room" to start'
                : 'Loading manifest...'}
          </div>
        )}
      </div>
      <TesterInfoPanel canvasHandle={canvasHandle} />
    </div>
  )
}
