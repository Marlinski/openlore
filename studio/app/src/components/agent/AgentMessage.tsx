import { useState } from 'preact/hooks'
import type { ChatMessage } from '../../store/agent'

// ─── Simple markdown renderer ───────────────────────────────────────

function renderMarkdown(text: string): string {
  // Fenced code blocks
  let html = text.replace(
    /```(?:\w*)\n([\s\S]*?)```/g,
    (_, code) => `<pre class="msg-code">${escapeHtml(code.trimEnd())}</pre>`,
  )
  // Inline code
  html = html.replace(
    /`([^`]+)`/g,
    (_, code) => `<code>${escapeHtml(code)}</code>`,
  )
  // Bold
  html = html.replace(
    /\*\*(.+?)\*\*/g,
    (_, t) => `<strong>${t}</strong>`,
  )
  // Newlines to <br>
  html = html.replace(/\n/g, '<br>')
  return html
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

// ─── Component ──────────────────────────────────────────────────────

interface AgentMessageProps {
  message: ChatMessage
}

export function AgentMessage({ message }: AgentMessageProps) {
  const { role, content, meta } = message

  // Thinking indicator
  if (meta?.type === 'thinking') {
    return (
      <div class="agent-msg thinking">
        <span class="thinking-label">Thinking</span>
        <span class="thinking-dots">
          <span>.</span>
          <span>.</span>
          <span>.</span>
        </span>
      </div>
    )
  }

  // Tool call / tool result (collapsible card)
  if (meta?.type === 'tool_call' || meta?.type === 'tool_result') {
    return <ToolCard meta={meta} content={content} />
  }

  // Error
  if (meta?.type === 'error') {
    return (
      <div class="agent-msg error">
        <span class="error-icon">!</span> {content}
      </div>
    )
  }

  // Context snapshot
  if (meta?.type === 'context') {
    return <ContextCard content={content} />
  }

  // System message
  if (role === 'system') {
    return (
      <div class="agent-msg system">
        <em>{content}</em>
      </div>
    )
  }

  // Tool response (hidden from display — the tool_result display msg is shown instead)
  if (role === 'tool') {
    return null
  }

  // Assistant with tool calls (hidden — individual tool_call msgs are shown)
  if (role === 'assistant' && message.toolCalls && message.toolCalls.length > 0 && !meta) {
    return null
  }

  // User message
  if (role === 'user') {
    return (
      <div class="agent-msg user">
        <div class="msg-content">{content}</div>
      </div>
    )
  }

  // Assistant text message
  if (role === 'assistant') {
    return (
      <div class="agent-msg assistant">
        <div
          class="msg-content"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }}
        />
      </div>
    )
  }

  return null
}

// ─── Tool card (collapsible) ────────────────────────────────────────

function ToolCard({ meta, content }: {
  meta: NonNullable<ChatMessage['meta']>
  content: string
}) {
  const [open, setOpen] = useState(false)
  const statusClass =
    meta.status === 'running' ? 'running' :
    meta.status === 'error' ? 'error' : 'done'

  const statusIcon =
    meta.status === 'running' ? '...' :
    meta.status === 'error' ? '!' : '\u2713'

  return (
    <div class={`agent-msg tool-use ${statusClass}`}>
      <div class="tool-header" onClick={() => setOpen(!open)}>
        <span class="tool-icon">{'\u2699'}</span>
        <span class="tool-name">{meta.toolName}</span>
        <span class={`tool-status ${statusClass}`}>{statusIcon}</span>
        <span class="tool-toggle">{open ? '\u25BC' : '\u25B6'}</span>
      </div>
      {open && (
        <div class="tool-details">
          {meta.toolArgs && (
            <div class="tool-args">
              <div class="tool-section-label">Arguments</div>
              <pre class="msg-code">{formatJson(meta.toolArgs)}</pre>
            </div>
          )}
          {content && meta.type === 'tool_result' && (
            <div class="tool-result-content">
              <div class="tool-section-label">Result</div>
              <pre class="msg-code">{truncate(content, 2000)}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Context snapshot card (collapsible) ────────────────────────────

function ContextCard({ content }: { content: string }) {
  const [open, setOpen] = useState(false)

  return (
    <div class="agent-msg context-snapshot">
      <div class="context-header" onClick={() => setOpen(!open)}>
        <span class="context-label">Context snapshot</span>
        <span class="tool-toggle">{open ? '\u25BC' : '\u25B6'}</span>
      </div>
      {open && (
        <pre class="msg-code context-code">{truncate(content, 3000)}</pre>
      )}
    </div>
  )
}

// ─── Helpers ────────────────────────────────────────────────────────

function formatJson(str: string): string {
  try {
    return JSON.stringify(JSON.parse(str), null, 2)
  } catch {
    return str
  }
}

function truncate(str: string, max: number): string {
  if (str.length <= max) return str
  return str.slice(0, max) + '\n... (truncated)'
}
