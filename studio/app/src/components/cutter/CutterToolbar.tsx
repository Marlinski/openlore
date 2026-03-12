/**
 * CutterToolbar — zoom, grid toggle, and show-cuts controls.
 *
 * Sits above the canvas. Reads/writes zoom, showGrid, showCuts
 * from the cutter store.
 */

import { useCallback } from 'preact/hooks'
import { useCutterStore } from '../../store/cutter'

const ZOOM_LEVELS = [0.5, 1, 1.5, 2, 3, 4] as const

export function CutterToolbar() {
  const zoom = useCutterStore((s) => s.zoom)
  const showGrid = useCutterStore((s) => s.showGrid)
  const showCuts = useCutterStore((s) => s.showCuts)
  const setZoom = useCutterStore((s) => s.setZoom)
  const setShowGrid = useCutterStore((s) => s.setShowGrid)
  const setShowCuts = useCutterStore((s) => s.setShowCuts)

  const handleZoomChange = useCallback(
    (e: Event) => {
      const val = (e.target as HTMLSelectElement).value
      if (val === 'fit') {
        // "fit" zoom is computed by CutterCanvas based on container size.
        // We use -1 as a sentinel value; the canvas component handles it.
        setZoom(-1)
      } else {
        setZoom(parseFloat(val))
      }
    },
    [setZoom],
  )

  // Display the zoom value in the select; -1 means "fit"
  const zoomValue = zoom === -1 ? 'fit' : String(zoom)

  return (
    <div class="cutter-toolbar">
      <label class="cutter-toolbar__item">
        Zoom{' '}
        <select value={zoomValue} onChange={handleZoomChange}>
          <option value="fit">Fit</option>
          {ZOOM_LEVELS.map((z) => (
            <option key={z} value={String(z)}>
              {z}x
            </option>
          ))}
        </select>
      </label>

      <label class="cutter-toolbar__item">
        <input
          type="checkbox"
          checked={showGrid}
          onChange={(e) => setShowGrid((e.target as HTMLInputElement).checked)}
        />
        Grid
      </label>

      <label class="cutter-toolbar__item">
        <input
          type="checkbox"
          checked={showCuts}
          onChange={(e) => setShowCuts((e.target as HTMLInputElement).checked)}
        />
        Cuts
      </label>
    </div>
  )
}
