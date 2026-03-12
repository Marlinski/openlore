import { useStatus } from '../api/search'
import { useUIStore } from '../store/ui'

export function StatusBar() {
  const { data: status } = useStatus()
  const statusText = useUIStore((s) => s.statusText)

  const stats = status?.stats
  const ragAvailable = status?.rag ?? false

  return (
    <footer class="statusbar">
      <span
        class={`statusbar-dot${ragAvailable ? '' : ' statusbar-dot--off'}`}
        title={ragAvailable ? 'RAG available' : 'RAG unavailable'}
      />
      {stats && (
        <>
          <span class="statusbar-item">Resources: {stats.resource ?? 0}</span>
          <span class="statusbar-item">Composites: {stats.composite ?? 0}</span>
          <span class="statusbar-item">Rooms: {stats.room ?? 0}</span>
          <span class="statusbar-item">Tilesets: {stats.tileset ?? 0}</span>
        </>
      )}
      <span class="statusbar-spacer" />
      {statusText && <span class="statusbar-text">{statusText}</span>}
    </footer>
  )
}
