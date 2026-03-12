import OpenAI from 'openai'
import type { AgentTool, ChatMessage } from '../store/agent'

// ─── Types ──────────────────────────────────────────────────────────

export type AgentEvent =
  | { type: 'thinking' }
  | { type: 'text'; content: string }
  | { type: 'tool_call'; id: string; name: string; args: string }
  | { type: 'tool_result'; id: string; name: string; result: string }
  | { type: 'error'; error: string }
  | { type: 'done' }

interface ToolResultPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

// ─── Client management ──────────────────────────────────────────────

let client: OpenAI | null = null
let currentBaseUrl = ''
let currentApiKey = ''

function ensureClient(settings: { apiKey: string; baseUrl: string }): OpenAI {
  if (
    client &&
    currentBaseUrl === settings.baseUrl &&
    currentApiKey === settings.apiKey
  ) {
    return client
  }
  client = new OpenAI({
    apiKey: settings.apiKey,
    baseURL: settings.baseUrl,
    dangerouslyAllowBrowser: true,
  })
  currentBaseUrl = settings.baseUrl
  currentApiKey = settings.apiKey
  return client
}

// ─── Message conversion ─────────────────────────────────────────────

type OpenAIMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam

function toOpenAIMessages(messages: ChatMessage[]): OpenAIMessage[] {
  const result: OpenAIMessage[] = []
  for (const msg of messages) {
    // Skip display-only messages (thinking, tool_call, tool_result markers)
    if (msg.meta?.type === 'thinking') continue
    if (msg.meta?.type === 'tool_call') continue
    if (msg.meta?.type === 'tool_result') continue
    if (msg.meta?.type === 'context') continue
    if (msg.meta?.type === 'error') continue

    if (msg.role === 'user') {
      result.push({ role: 'user', content: msg.content })
    } else if (msg.role === 'system') {
      result.push({ role: 'system', content: msg.content })
    } else if (msg.role === 'tool') {
      result.push({
        role: 'tool',
        tool_call_id: msg.toolCallId || '',
        content: msg.content,
      })
    } else if (msg.role === 'assistant') {
      if (msg.toolCalls && msg.toolCalls.length > 0) {
        result.push({
          role: 'assistant',
          content: msg.content || null,
          tool_calls: msg.toolCalls.map((tc) => ({
            id: tc.id,
            type: 'function' as const,
            function: {
              name: tc.name,
              arguments: tc.arguments,
            },
          })),
        })
      } else {
        result.push({ role: 'assistant', content: msg.content })
      }
    }
  }
  return result
}

// ─── Tool result normalization ──────────────────────────────────────

function normalizeToolResult(raw: unknown): {
  textContent: string
  images: { url: string }[]
} {
  // If it's an array of parts (multi-modal)
  if (Array.isArray(raw)) {
    const textParts: string[] = []
    const images: { url: string }[] = []
    for (const part of raw as ToolResultPart[]) {
      if (part.type === 'text' && part.text) {
        textParts.push(part.text)
      } else if (part.type === 'image_url' && part.image_url?.url) {
        textParts.push('[Image attached]')
        images.push({ url: part.image_url.url })
      }
    }
    return { textContent: textParts.join('\n'), images }
  }
  // If it's a string
  if (typeof raw === 'string') {
    return { textContent: raw, images: [] }
  }
  // Otherwise JSON-serialize it
  return { textContent: JSON.stringify(raw, null, 2), images: [] }
}

// ─── Tool call helpers ──────────────────────────────────────────────

/** Extract name and arguments from a tool call (handles both function and custom types) */
function getToolCallInfo(tc: NonNullable<OpenAI.Chat.Completions.ChatCompletionMessage['tool_calls']>[number]) {
  if (tc.type === 'function') {
    return { name: tc.function.name, args: tc.function.arguments }
  }
  // Custom tool type — use the name from the tool call
  return { name: (tc as unknown as Record<string, unknown>).name as string || 'unknown', args: '{}' }
}

// ─── The agentic loop ───────────────────────────────────────────────

const MAX_ROUNDS = 15

export async function sendMessage(
  settings: { model: string; apiKey: string; baseUrl: string; systemPrompt: string },
  allMessages: ChatMessage[],
  tools: AgentTool[],
  onEvent: (event: AgentEvent) => void,
  addMessage: (msg: ChatMessage) => void,
  signal?: AbortSignal,
): Promise<void> {
  const openai = ensureClient(settings)

  // Build tool definitions for OpenAI
  const toolDefs = tools.length > 0
    ? tools.map((t) => ({
        type: 'function' as const,
        function: {
          name: t.name,
          description: t.description,
          parameters: t.parameters,
        },
      }))
    : undefined

  // Build a tool lookup
  const toolMap = new Map(tools.map((t) => [t.name, t]))

  let rounds = 0

  while (rounds < MAX_ROUNDS) {
    rounds++
    onEvent({ type: 'thinking' })

    // Build messages for API
    const apiMessages = toOpenAIMessages(allMessages)

    // Prepend system prompt if set
    if (settings.systemPrompt) {
      apiMessages.unshift({ role: 'system', content: settings.systemPrompt })
    }

    let response: OpenAI.Chat.Completions.ChatCompletion
    try {
      response = await openai.chat.completions.create(
        {
          model: settings.model,
          messages: apiMessages,
          tools: toolDefs,
          max_tokens: 4096,
        },
        { signal },
      )
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        onEvent({ type: 'done' })
        return
      }
      const errorMsg = err instanceof Error ? err.message : String(err)
      onEvent({ type: 'error', error: errorMsg })
      onEvent({ type: 'done' })
      return
    }

    const choice = response.choices?.[0]
    if (!choice) {
      onEvent({ type: 'error', error: 'No response from model' })
      onEvent({ type: 'done' })
      return
    }

    const message = choice.message
    const toolCalls = message.tool_calls

    if (toolCalls && toolCalls.length > 0) {
      // Record the assistant message with tool calls
      const assistantMsg: ChatMessage = {
        role: 'assistant',
        content: message.content || '',
        toolCalls: toolCalls.map((tc) => {
          const info = getToolCallInfo(tc)
          return { id: tc.id, name: info.name, arguments: info.args }
        }),
      }
      addMessage(assistantMsg)
      allMessages = [...allMessages, assistantMsg]

      // Execute each tool call
      for (const tc of toolCalls) {
        const { name: toolName, args: toolArgs } = getToolCallInfo(tc)

        onEvent({ type: 'tool_call', id: tc.id, name: toolName, args: toolArgs })

        // Add a display-only tool_call message
        addMessage({
          role: 'assistant',
          content: `Calling ${toolName}...`,
          meta: {
            type: 'tool_call',
            toolName,
            toolArgs,
            status: 'running',
          },
        })

        const tool = toolMap.get(toolName)
        if (!tool) {
          const errResult = `Error: Unknown tool "${toolName}"`
          onEvent({ type: 'tool_result', id: tc.id, name: toolName, result: errResult })

          const toolResultMsg: ChatMessage = {
            role: 'tool',
            content: errResult,
            toolCallId: tc.id,
          }
          addMessage(toolResultMsg)
          allMessages = [...allMessages, toolResultMsg]
          continue
        }

        let parsedArgs: Record<string, unknown> = {}
        try {
          parsedArgs = JSON.parse(toolArgs || '{}')
        } catch {
          parsedArgs = {}
        }

        let resultRaw: unknown
        try {
          resultRaw = await tool.execute(parsedArgs)
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err)
          const errResult = `Error executing ${toolName}: ${errMsg}`
          onEvent({ type: 'tool_result', id: tc.id, name: toolName, result: errResult })

          const toolResultMsg: ChatMessage = {
            role: 'tool',
            content: errResult,
            toolCallId: tc.id,
          }
          addMessage(toolResultMsg)
          allMessages = [...allMessages, toolResultMsg]

          // Update the tool_call display message
          addMessage({
            role: 'assistant',
            content: errResult,
            meta: {
              type: 'tool_result',
              toolName,
              toolArgs,
              status: 'error',
            },
          })
          continue
        }

        const { textContent, images } = normalizeToolResult(resultRaw)
        onEvent({ type: 'tool_result', id: tc.id, name: toolName, result: textContent })

        // Add the tool result message
        const toolResultMsg: ChatMessage = {
          role: 'tool',
          content: textContent,
          toolCallId: tc.id,
        }
        addMessage(toolResultMsg)
        allMessages = [...allMessages, toolResultMsg]

        // Add display-only tool_result message
        addMessage({
          role: 'assistant',
          content: textContent,
          meta: {
            type: 'tool_result',
            toolName,
            toolArgs,
            status: 'done',
          },
        })

        // If there are images, inject a follow-up user message with image parts
        if (images.length > 0) {
          const imageContent: Array<{ type: 'image_url'; image_url: { url: string } }> =
            images.map((img) => ({
              type: 'image_url' as const,
              image_url: { url: img.url },
            }))

          // We add a user message that the API will see with the images
          const imageMsg: ChatMessage = {
            role: 'user',
            content: JSON.stringify(imageContent),
          }
          allMessages = [...allMessages, imageMsg]
        }
      }

      // Loop back to get next response
      continue
    }

    // Text response (no tool calls) — we're done
    const text = message.content || ''
    onEvent({ type: 'text', content: text })

    addMessage({
      role: 'assistant',
      content: text,
    })

    break
  }

  if (rounds >= MAX_ROUNDS) {
    onEvent({ type: 'error', error: 'Safety limit reached (15 rounds). Stopping.' })
  }

  onEvent({ type: 'done' })
}
