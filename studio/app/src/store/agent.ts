import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ─── Types ──────────────────────────────────────────────────────────

export interface AgentTool {
  /** Unique tool name (e.g. "assign_tags", "preview_cut") */
  name: string
  /** Human-readable description for the LLM */
  description: string
  /** JSON Schema describing the tool's parameters */
  parameters: Record<string, unknown>
  /** The function to call when the LLM invokes this tool */
  execute: (args: Record<string, unknown>) => Promise<unknown>
  /** Optional tab scope — if set, tool is only active when this tab is open */
  tabId?: string
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  /** For tool messages — which tool call this is responding to */
  toolCallId?: string
  /** For assistant messages — pending tool calls */
  toolCalls?: {
    id: string
    name: string
    arguments: string
  }[]
  /** Metadata for display purposes */
  meta?: {
    type?: 'thinking' | 'tool_call' | 'tool_result' | 'error' | 'context'
    toolName?: string
    toolArgs?: string
    status?: 'running' | 'done' | 'error'
  }
}

export interface AgentPreset {
  label: string
  prompt: string
}

interface AgentSettings {
  model: string
  apiKey: string
  baseUrl: string
  systemPrompt: string
}

// ─── Context providers (module-level, not serializable) ─────────────

const contextProviders = new Map<string, () => string>()

export function registerContextProvider(tabId: string, fn: () => string) {
  contextProviders.set(tabId, fn)
}

export function unregisterContextProvider(tabId: string) {
  contextProviders.delete(tabId)
}

export function getContextSnapshot(tabId: string): string {
  const parts: string[] = []
  // Always include global context (key = '*')
  const globalFn = contextProviders.get('*')
  if (globalFn) {
    try { parts.push(globalFn()) } catch { /* skip */ }
  }
  // Include tab-specific context
  const tabFn = contextProviders.get(tabId)
  if (tabFn) {
    try { parts.push(tabFn()) } catch { /* skip */ }
  }
  return parts.filter(Boolean).join('\n\n')
}

// ─── Store shape ────────────────────────────────────────────────────

interface AgentState {
  // Panel visibility
  panelOpen: boolean
  togglePanel: () => void
  openPanel: () => void
  closePanel: () => void

  // Sending state
  sending: boolean
  setSending: (v: boolean) => void

  // Tool registry (populated/depopulated by tabs on mount/unmount)
  tools: Record<string, AgentTool>
  registerTool: (tool: AgentTool) => void
  unregisterTool: (name: string) => void

  // Presets per tab
  presets: Record<string, AgentPreset[]>
  registerPresets: (tabId: string, presets: AgentPreset[]) => void

  // Conversation
  messages: ChatMessage[]
  addMessage: (msg: ChatMessage) => void
  updateLastMessage: (patch: Partial<ChatMessage>) => void
  clearMessages: () => void

  // Settings (persisted)
  settings: AgentSettings
  setSettings: (patch: Partial<AgentSettings>) => void
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Return tools available for a given tabId (tab-scoped + global) */
export function getActiveTools(
  tools: Record<string, AgentTool>,
  tabId: string,
): AgentTool[] {
  return Object.values(tools).filter(
    (t) => !t.tabId || t.tabId === tabId,
  )
}

/** Convert AgentTools to OpenAI function-calling tool definitions */
export function getToolDefinitions(tools: AgentTool[]) {
  return tools.map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.parameters,
    },
  }))
}

// ─── Store ──────────────────────────────────────────────────────────

export const useAgentStore = create<AgentState>()(
  persist(
    (set) => ({
      // Panel
      panelOpen: false,
      togglePanel: () => set((s) => ({ panelOpen: !s.panelOpen })),
      openPanel: () => set({ panelOpen: true }),
      closePanel: () => set({ panelOpen: false }),

      // Sending
      sending: false,
      setSending: (v) => set({ sending: v }),

      // Tools
      tools: {},
      registerTool: (tool) =>
        set((s) => ({ tools: { ...s.tools, [tool.name]: tool } })),
      unregisterTool: (name) =>
        set((s) => {
          const { [name]: _, ...rest } = s.tools
          return { tools: rest }
        }),

      // Presets
      presets: {},
      registerPresets: (tabId, presets) =>
        set((s) => ({ presets: { ...s.presets, [tabId]: presets } })),

      // Messages
      messages: [],
      addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
      updateLastMessage: (patch) =>
        set((s) => {
          if (s.messages.length === 0) return s
          const msgs = [...s.messages]
          msgs[msgs.length - 1] = { ...msgs[msgs.length - 1], ...patch }
          return { messages: msgs }
        }),
      clearMessages: () => set({ messages: [] }),

      // Settings
      settings: {
        model: 'anthropic/claude-sonnet-4',
        apiKey: '',
        baseUrl: 'https://openrouter.ai/api/v1',
        systemPrompt: '',
      },
      setSettings: (patch) =>
        set((s) => ({ settings: { ...s.settings, ...patch } })),
    }),
    {
      name: 'offisims-studio-agent',
      // Only persist settings — tools are runtime, messages reset on reload
      partialize: (s) => ({ settings: s.settings }),
    },
  ),
)
