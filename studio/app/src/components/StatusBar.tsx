import { useStatus } from '../api/search'
import { useUIStore } from '../store/ui'
import { usePackStore } from '../store/pack'

export function StatusBar() {
  const { data: status } = useStatus()
  const statusText = useUIStore((s) => s.statusText)
  const packInfo = usePackStore((s) => s.packInfo)
  const isStale = usePackStore((s) => s.isStale)

  const stats = status?.stats
  const ragAvailable = status?.rag ?? false

  // Short revision: first 10 chars of current workspace hash
  const currentHash = packInfo?.currentHash || ''
  const shortHash = currentHash ? currentHash.slice(0, 10) : ''

  return (
    <footer class="statusbar">
      <span
        class={`statusbar-dot${ragAvailable ? '' : ' statusbar-dot--off'}`}
        title={ragAvailable ? 'RAG available' : 'RAG unavailable'}
      />
      {stats && (
        <>
          <span class="statusbar-item">Tilesets: {stats.tileset ?? 0}</span>
          <span class="statusbar-item">Resources: {stats.resource ?? 0}</span>
          <span class="statusbar-item">Composites: {stats.composite ?? 0}</span>
          <span class="statusbar-item">Rooms: {stats.room ?? 0}</span>
        </>
      )}
      {shortHash && (
        <span
          class={`statusbar-item statusbar-hash${isStale ? ' statusbar-hash--stale' : ''}`}
          title={`Workspace: ${currentHash}${packInfo?.sourceHash ? '\nPack: ' + packInfo.sourceHash : ''}`}
        >
          {isStale ? 'rev: ' : 'rev: '}{shortHash}
        </span>
      )}
      <span class="statusbar-spacer" />
      {statusText && <span class="statusbar-text">{statusText}</span>}
    </footer>
  )
}
