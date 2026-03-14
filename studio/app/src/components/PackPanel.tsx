import { usePackStore } from '../store/pack'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function PackPanel() {
  const status = usePackStore((s) => s.status)
  const messages = usePackStore((s) => s.messages)
  const result = usePackStore((s) => s.result)
  const error = usePackStore((s) => s.error)
  const panelOpen = usePackStore((s) => s.panelOpen)
  const closePanel = usePackStore((s) => s.closePanel)

  if (!panelOpen) return null

  return (
    <div class="pack-panel">
      <div class="pack-panel-header">
        <span class="pack-panel-title">
          {status === 'building' && 'Packing...'}
          {status === 'done' && 'Pack Complete'}
          {status === 'error' && 'Pack Failed'}
          {status === 'idle' && 'Pack'}
        </span>
        <button class="pack-panel-close" onClick={closePanel} title="Close">
          &times;
        </button>
      </div>

      <div class="pack-panel-body">
        {/* Progress messages */}
        <div class="pack-panel-log">
          {messages.map((msg, i) => (
            <div key={i} class="pack-log-line">{msg}</div>
          ))}
          {status === 'building' && (
            <div class="pack-log-line pack-log-spinner">...</div>
          )}
          {error && (
            <div class="pack-log-line pack-log-error">{error}</div>
          )}
        </div>

        {/* Done summary */}
        {status === 'done' && result && (
          <div class="pack-panel-summary">
            <div class="pack-summary-size">{formatSize(result.size)}</div>
            <div class="pack-summary-counts">
              {result.resources} resources, {result.rooms} rooms, {result.atlases} atlases
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
