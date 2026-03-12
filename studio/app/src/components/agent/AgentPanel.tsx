import { useRef, useEffect, useState, useCallback } from 'preact/hooks'
import {
  useAgentStore,
  getActiveTools,
  getContextSnapshot,
} from '../../store/agent'
import type { ChatMessage, AgentPreset } from '../../store/agent'
import { useUIStore } from '../../store/ui'
import { sendMessage } from '../../lib/agentEngine'
import { AgentMessage } from './AgentMessage'
import { registerRagTools, unregisterRagTools } from './ragTools'

// ─── Models ─────────────────────────────────────────────────────────

const MODEL_OPTIONS = [
  'anthropic/claude-sonnet-4',
  'anthropic/claude-haiku-4',
  'openai/gpt-4o',
  'openai/gpt-4o-mini',
  'google/gemini-2.0-flash-001',
]

// ─── Component ──────────────────────────────────────────────────────

export function AgentPanel() {
  const panelOpen = useAgentStore((s) => s.panelOpen)
  const messages = useAgentStore((s) => s.messages)
  const sending = useAgentStore((s) => s.sending)
  const settings = useAgentStore((s) => s.settings)
  const tools = useAgentStore((s) => s.tools)
  const presets = useAgentStore((s) => s.presets)
  const activeTab = useUIStore((s) => s.activeTab)

  const [input, setInput] = useState('')
  const [showSettings, setShowSettings] = useState(false)
  const [customModel, setCustomModel] = useState('')

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const abortRef = useRef<AbortController | null>(null)

  // Register RAG tools on mount
  useEffect(() => {
    registerRagTools()
    return () => unregisterRagTools()
  }, [])

  // Auto-scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // Auto-resize textarea
  useEffect(() => {
    const ta = textareaRef.current
    if (ta) {
      ta.style.height = 'auto'
      ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'
    }
  }, [input])

  // Active tools for current tab
  const activeTools = getActiveTools(tools, activeTab)

  // Active presets
  const activePresets: AgentPreset[] = [
    ...(presets['*'] || []),
    ...(presets[activeTab] || []),
  ]

  const conversationEmpty = messages.length === 0

  // ─── Settings handlers ──────────────────────────────────────────

  const { setSettings } = useAgentStore.getState()

  const handleModelChange = useCallback((e: Event) => {
    const val = (e.target as HTMLSelectElement).value
    if (val === '__custom__') {
      setCustomModel(settings.model)
    } else {
      setSettings({ model: val })
      setCustomModel('')
    }
  }, [settings.model])

  const handleCustomModelBlur = useCallback(() => {
    if (customModel.trim()) {
      setSettings({ model: customModel.trim() })
    }
  }, [customModel])

  // ─── Send ─────────────────────────────────────────────────────────

  const handleSend = useCallback(async (text?: string) => {
    const msg = text ?? input.trim()
    if (!msg || sending) return

    if (!settings.apiKey) {
      useAgentStore.getState().addMessage({
        role: 'assistant',
        content: 'Please set an API key in settings before sending messages.',
        meta: { type: 'error' },
      })
      setShowSettings(true)
      return
    }

    setInput('')

    const store = useAgentStore.getState()
    const tab = useUIStore.getState().activeTab

    // Build context snapshot
    const context = getContextSnapshot(tab)
    let userContent = msg
    if (context) {
      userContent = `[Current state]\n${context}\n\n[User message]\n${msg}`
      // Add display-only context message
      store.addMessage({
        role: 'system',
        content: context,
        meta: { type: 'context' },
      })
    }

    // Add user message
    const userMsg: ChatMessage = { role: 'user', content: userContent }
    store.addMessage(userMsg)

    // Add thinking indicator
    store.addMessage({
      role: 'assistant',
      content: '',
      meta: { type: 'thinking' },
    })

    store.setSending(true)
    const abort = new AbortController()
    abortRef.current = abort

    // Gather all current messages for the loop
    const allMessages = [...store.messages.filter(m => !m.meta), userMsg]
    const currentTools = getActiveTools(store.tools, tab)

    try {
      await sendMessage(
        settings,
        allMessages,
        currentTools,
        (_event) => {
          // Events are handled by addMessage calls in the engine
        },
        (chatMsg) => {
          // Remove thinking indicator if it's the last message
          const current = useAgentStore.getState().messages
          const lastMsg = current[current.length - 1]
          if (lastMsg?.meta?.type === 'thinking') {
            // Replace the thinking message
            useAgentStore.getState().updateLastMessage(chatMsg)
          } else {
            useAgentStore.getState().addMessage(chatMsg)
          }
        },
        abort.signal,
      )
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err)
      useAgentStore.getState().addMessage({
        role: 'assistant',
        content: errMsg,
        meta: { type: 'error' },
      })
    } finally {
      // Clean up any remaining thinking indicator
      const current = useAgentStore.getState().messages
      const lastMsg = current[current.length - 1]
      if (lastMsg?.meta?.type === 'thinking') {
        // Remove it by updating to a done message
        useAgentStore.getState().updateLastMessage({
          content: '',
          meta: undefined,
          role: 'assistant',
        })
      }
      useAgentStore.getState().setSending(false)
      abortRef.current = null
    }
  }, [input, sending, settings])

  // ─── Key handling ─────────────────────────────────────────────────

  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }, [handleSend])

  // ─── Stop ─────────────────────────────────────────────────────────

  const handleStop = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  // ─── Clear ────────────────────────────────────────────────────────

  const handleClear = useCallback(() => {
    useAgentStore.getState().clearMessages()
  }, [])

  // ─── Preset click ─────────────────────────────────────────────────

  const handlePreset = useCallback((preset: AgentPreset) => {
    handleSend(preset.prompt)
  }, [handleSend])

  // ─── Render ───────────────────────────────────────────────────────

  const isCustomModel = !MODEL_OPTIONS.includes(settings.model)
  const showCustomInput = customModel !== '' || isCustomModel

  return (
    <div class={`agent-panel${panelOpen ? ' open' : ''}`}>
      {/* Header */}
      <div class="agent-header">
        <span class="agent-title">AI Agent</span>
        <div class="agent-header-actions">
          <button
            class="btn agent-header-btn"
            onClick={() => setShowSettings(!showSettings)}
            title="Settings"
          >
            {'\u2699'}
          </button>
          <button
            class="btn agent-header-btn"
            onClick={handleClear}
            title="Clear conversation"
            disabled={sending}
          >
            Clear
          </button>
          <button
            class="btn agent-header-btn"
            onClick={() => useAgentStore.getState().closePanel()}
            title="Hide panel"
          >
            {'\u2715'}
          </button>
        </div>
      </div>

      {/* Settings (collapsible) */}
      {showSettings && (
        <div class="agent-settings">
          <div class="agent-setting-field">
            <label class="agent-setting-label">API Key</label>
            <input
              type="password"
              class="agent-setting-input"
              value={settings.apiKey}
              onInput={(e) => setSettings({ apiKey: (e.target as HTMLInputElement).value })}
              placeholder="sk-..."
            />
          </div>
          <div class="agent-setting-field">
            <label class="agent-setting-label">Base URL</label>
            <input
              type="text"
              class="agent-setting-input"
              value={settings.baseUrl}
              onInput={(e) => setSettings({ baseUrl: (e.target as HTMLInputElement).value })}
              placeholder="https://openrouter.ai/api/v1"
            />
          </div>
          <div class="agent-setting-field">
            <label class="agent-setting-label">Model</label>
            <select
              class="agent-setting-select"
              value={showCustomInput ? '__custom__' : settings.model}
              onChange={handleModelChange}
            >
              {MODEL_OPTIONS.map((m) => (
                <option key={m} value={m}>{m}</option>
              ))}
              <option value="__custom__">Custom...</option>
            </select>
            {showCustomInput && (
              <input
                type="text"
                class="agent-setting-input"
                style={{ marginTop: '4px' }}
                value={customModel || settings.model}
                onInput={(e) => setCustomModel((e.target as HTMLInputElement).value)}
                onBlur={handleCustomModelBlur}
                placeholder="model-name"
              />
            )}
          </div>
          <div class="agent-setting-field">
            <label class="agent-setting-label">System prompt</label>
            <textarea
              class="agent-setting-textarea"
              value={settings.systemPrompt}
              onInput={(e) => setSettings({ systemPrompt: (e.target as HTMLTextAreaElement).value })}
              placeholder="Optional system instructions..."
              rows={3}
            />
          </div>
        </div>
      )}

      {/* Context chips */}
      <div class="agent-chips">
        {settings.systemPrompt && (
          <span class="agent-chip active" title={settings.systemPrompt}>
            System
          </span>
        )}
        {activeTools.map((t) => (
          <span key={t.name} class="agent-chip active" title={t.description}>
            {t.name}
          </span>
        ))}
      </div>

      {/* Messages */}
      <div class="agent-messages">
        {/* Presets (when conversation is empty) */}
        {conversationEmpty && activePresets.length > 0 && (
          <div class="agent-presets">
            <div class="agent-presets-label">Quick prompts</div>
            <div class="agent-presets-list">
              {activePresets.map((p) => (
                <button
                  key={p.label}
                  class="agent-preset-btn"
                  onClick={() => handlePreset(p)}
                  disabled={sending}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {conversationEmpty && activePresets.length === 0 && (
          <div class="agent-empty">
            Ask the AI agent anything about your resources, or use tools to manipulate them.
          </div>
        )}

        {messages.map((msg, i) => (
          <AgentMessage key={i} message={msg} />
        ))}
        <div ref={messagesEndRef} />
      </div>

      {/* Input area */}
      <div class="agent-input-area">
        <textarea
          ref={textareaRef}
          class="agent-input"
          value={input}
          onInput={(e) => setInput((e.target as HTMLTextAreaElement).value)}
          onKeyDown={handleKeyDown}
          placeholder={sending ? 'Waiting for response...' : 'Ask the AI agent...'}
          disabled={sending}
          rows={1}
        />
        {sending ? (
          <button class="btn btn-danger agent-send-btn" onClick={handleStop}>
            Stop
          </button>
        ) : (
          <button
            class="btn btn--accent agent-send-btn"
            onClick={() => handleSend()}
            disabled={!input.trim() || !settings.apiKey}
          >
            Send
          </button>
        )}
      </div>
    </div>
  )
}
