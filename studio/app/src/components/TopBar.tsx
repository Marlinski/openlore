import { useEffect } from 'preact/hooks'
import { useUIStore, TAB_LIST } from '../store/ui'
import type { TabId } from '../store/ui'
import { usePackStore } from '../store/pack'
import { AgentToggle } from './agent/AgentToggle'
import { PublishDialog } from './PublishDialog'
import { requireWorkspaceId } from '../api/client'

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function handleDownload() {
  const wsId = requireWorkspaceId()
  const a = document.createElement('a')
  a.href = `/${wsId}/api/pack/download`
  a.download = ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export function TopBar() {
  const activeTab = useUIStore((s) => s.activeTab)
  const setActiveTab = useUIStore((s) => s.setActiveTab)

  const buildStatus = usePackStore((s) => s.status)
  const packInfo = usePackStore((s) => s.packInfo)
  const isStale = usePackStore((s) => s.isStale)
  const startBuild = usePackStore((s) => s.startBuild)
  const fetchStatus = usePackStore((s) => s.fetchStatus)
  const openPublishDialog = usePackStore((s) => s.openPublishDialog)

  // Check for existing pack on mount and on tab visibility change
  useEffect(() => {
    fetchStatus()
    const onVisibility = () => {
      if (document.visibilityState === 'visible') fetchStatus()
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])

  const isBuilding = buildStatus === 'building'
  const hasDownload = packInfo?.exists === true

  return (
    <header class="topbar">
      <nav class="topbar-tabs">
        {TAB_LIST.map((tab) => (
          <button
            key={tab.id}
            class="tab-btn"
            data-active={activeTab === tab.id}
            onClick={() => setActiveTab(tab.id as TabId)}
          >
            {tab.label}
          </button>
        ))}
      </nav>
      <div class="topbar-actions">
        <div class="pack-split-btn">
          <button
            class={`pack-btn${isStale ? ' pack-btn--stale' : ''}`}
            onClick={startBuild}
            disabled={isBuilding}
            title={isBuilding ? 'Building...' : isStale ? 'Workspace has changed — recompile to update pack' : 'Build .offpack from workspace'}
          >
            {isBuilding ? (
              <svg class="pack-spinner" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="8" cy="8" r="6" stroke-dasharray="28 10" />
              </svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <rect x="2" y="2" width="12" height="12" rx="1.5" />
                <path d="M5 2v4h6V2" />
                <rect x="7" y="3" width="2" height="2" />
              </svg>
            )}
            {isBuilding ? 'PACKING' : 'PACK IT'}
            {isStale && !isBuilding && <span class="pack-stale-dot" />}
          </button>
          <button
            class={`pack-download-btn${isStale ? ' pack-download-btn--stale' : ''}`}
            onClick={handleDownload}
            disabled={!hasDownload}
            title={hasDownload ? `Download pack (${formatSize(packInfo!.size)})` : 'No pack built yet'}
          >
            <svg width="10" height="10" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M8 2v8M4.5 7 8 10.5 11.5 7" />
              <path d="M2 13h12" />
            </svg>
          </button>
        </div>
        <button
          class="pack-publish-btn"
          onClick={openPublishDialog}
          disabled={!hasDownload || isBuilding}
          title={hasDownload ? 'Publish pack to game server' : 'Build a pack first'}
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <path d="M8 10V2M4.5 5 8 1.5 11.5 5" />
            <path d="M2 13h12" />
          </svg>
          PUBLISH
        </button>
        <AgentToggle />
      </div>
      <PublishDialog />
    </header>
  )
}
