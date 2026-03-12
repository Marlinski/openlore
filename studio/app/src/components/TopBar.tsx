import { useUIStore, TAB_LIST } from '../store/ui'
import type { TabId } from '../store/ui'
import { AgentToggle } from './agent/AgentToggle'

export function TopBar() {
  const activeTab = useUIStore((s) => s.activeTab)
  const setActiveTab = useUIStore((s) => s.setActiveTab)

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
        {/* Pack Resources — wired to compile endpoint in Phase 3 */}
        <AgentToggle />
      </div>
    </header>
  )
}
