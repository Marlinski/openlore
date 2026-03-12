import { useAgentStore } from '../../store/agent'

export function AgentToggle() {
  const panelOpen = useAgentStore((s) => s.panelOpen)

  return (
    <button
      class={`btn${panelOpen ? ' btn--accent' : ''}`}
      onClick={() => useAgentStore.getState().togglePanel()}
      title="Toggle AI Agent panel"
    >
      AI Agent
    </button>
  )
}
