import './app.css'
import { getWorkspaceId } from './api/client'
import { WelcomeScreen } from './components/WelcomeScreen'
import { TopBar } from './components/TopBar'
import { StatusBar } from './components/StatusBar'
import { CutterTab } from './components/cutter/CutterTab'
import { ResourcesTab } from './components/resources/ResourcesTab'
import { CompositeTab } from './components/composite/CompositeTab'
import { RoomTab } from './components/room/RoomTab'
import { TesterTab } from './components/tester/TesterTab'
import { AgentPanel } from './components/agent/AgentPanel'
import { PackPanel } from './components/PackPanel'
import { useUIStore, TAB_LIST } from './store/ui'

function TabContent({ id }: { id: string }) {
  switch (id) {
    case 'cutter':
      return <CutterTab />
    case 'resources':
      return <ResourcesTab />
    case 'composite':
      return <CompositeTab />
    case 'room':
      return <RoomTab />
    case 'tester':
      return <TesterTab />
    default:
      return <div class="tab-placeholder">{TAB_LIST.find((t) => t.id === id)?.label}</div>
  }
}

function Studio() {
  const activeTab = useUIStore((s) => s.activeTab)

  return (
    <div class="app-layout">
      <TopBar />
      <main class="main-content">
        {TAB_LIST.map((tab) => (
          <div
            key={tab.id}
            class="tab-panel"
            data-active={activeTab === tab.id}
          >
            <TabContent id={tab.id} />
          </div>
        ))}
      </main>
      <StatusBar />
      <AgentPanel />
      <PackPanel />
    </div>
  )
}

export function App() {
  const workspaceId = getWorkspaceId()

  // At root path — show workspace picker
  if (!workspaceId) {
    return <WelcomeScreen />
  }

  // Inside a workspace — show the studio
  return <Studio />
}
