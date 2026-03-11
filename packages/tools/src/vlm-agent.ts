/**
 * Multi-turn conversation engine with OpenAI tool/function calling.
 *
 * Manages conversation state and runs the agent loop:
 *   1. Send messages to the LLM (with tool definitions)
 *   2. If response contains tool_calls, dispatch them and append results
 *   3. Loop until the LLM responds with text (no tool calls)
 *   4. Yield each step to the UI via callbacks
 */

import OpenAI from "openai";
import {
  type AgentToolResult,
  getToolDefinitions,
  dispatchToolCall,
  getContextSnapshot,
} from "./agent-tools.js";

// ─── Types ──────────────────────────────────────────────────────

/** Configuration for the OpenAI-compatible endpoint. */
export interface AgentConfig {
  apiKey: string;
  baseURL: string;
  model: string;
}

/** A message in the conversation (mirrors OpenAI format). */
export type ConversationMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;

/** Event emitted during the agent loop for UI updates. */
export type AgentEvent =
  | { type: "thinking" }
  | { type: "text"; content: string }
  | { type: "tool_call"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; result: AgentToolResult }
  | { type: "error"; message: string }
  | { type: "done" };

/** Callback for agent events. */
export type AgentEventHandler = (event: AgentEvent) => void;

// ─── Conversation state ─────────────────────────────────────────

let conversationMessages: ConversationMessage[] = [];
let systemPrompt = "";
let client: OpenAI | null = null;
let currentConfig: AgentConfig | null = null;

/** Maximum tool-call loops per user message (safety limit). */
const MAX_TOOL_ROUNDS = 15;

// ─── Public API ─────────────────────────────────────────────────

/** Initialize or reconfigure the OpenAI client. */
export function configureAgent(config: AgentConfig): void {
  currentConfig = config;
  client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    dangerouslyAllowBrowser: true,
  });
}

/** Set the system prompt (called when tab changes or on init). */
export function setSystemPrompt(prompt: string): void {
  systemPrompt = prompt;
}

/** Get the current conversation messages (read-only). */
export function getConversation(): readonly ConversationMessage[] {
  return conversationMessages;
}

/** Clear the conversation history. */
export function clearConversation(): void {
  conversationMessages = [];
}

/** Check if the agent is configured and ready. */
export function isConfigured(): boolean {
  return client !== null && !!currentConfig?.apiKey;
}

/**
 * Send a user message and run the agent loop.
 *
 * The loop continues until the LLM responds with pure text (no tool calls)
 * or the safety limit is reached.
 *
 * @param userMessage - The user's text message
 * @param onEvent - Callback for each step (tool calls, text, errors)
 * @param signal - Optional AbortSignal to cancel mid-run
 */
export async function sendMessage(
  userMessage: string,
  onEvent: AgentEventHandler,
  signal?: AbortSignal,
): Promise<void> {
  if (!client || !currentConfig) {
    onEvent({ type: "error", message: "Agent not configured. Set API key and base URL in settings." });
    onEvent({ type: "done" });
    return;
  }

  // Get context snapshot and prepend to user message
  const contextSnapshot = getContextSnapshot();
  const fullUserMessage = contextSnapshot
    ? `[Current state]\n${contextSnapshot}\n\n[User message]\n${userMessage}`
    : userMessage;

  // Add the user message (with context) to conversation
  conversationMessages.push({ role: "user", content: fullUserMessage });

  let toolRounds = 0;

  try {
    while (toolRounds < MAX_TOOL_ROUNDS) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

      onEvent({ type: "thinking" });

      const tools = getToolDefinitions();
      const messages: ConversationMessage[] = [
        { role: "system", content: systemPrompt },
        ...conversationMessages,
      ];

      console.log("[agent] API request:", {
        model: currentConfig.model,
        baseURL: currentConfig.baseURL,
        messageCount: messages.length,
        toolCount: tools.length,
        toolNames: tools.map((t) => (t as { function: { name: string } }).function.name),
        systemPromptLength: systemPrompt.length,
        lastUserMessage: messages.filter((m) => m.role === "user").slice(-1)[0],
      });

      const response = await client.chat.completions.create(
        {
          model: currentConfig.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          max_tokens: 4096,
        },
        { signal },
      );

      const choice = response.choices?.[0];

      console.log("[agent] API response:", {
        finishReason: choice?.finish_reason,
        hasToolCalls: !!(choice?.message?.tool_calls?.length),
        toolCallCount: choice?.message?.tool_calls?.length ?? 0,
        contentPreview: choice?.message?.content?.slice(0, 200),
        model: response.model,
        usage: response.usage,
      });
      if (!choice) {
        onEvent({ type: "error", message: "Empty response from LLM" });
        break;
      }

      const assistantMessage = choice.message;

      // Add the assistant message to conversation history
      conversationMessages.push(assistantMessage as ConversationMessage);

      // Check for tool calls
      if (assistantMessage.tool_calls && assistantMessage.tool_calls.length > 0) {
        toolRounds++;

        for (const toolCall of assistantMessage.tool_calls) {
          if (signal?.aborted) throw new DOMException("Aborted", "AbortError");

          const fnName = toolCall.function.name;
          const fnArgs = toolCall.function.arguments;

          onEvent({ type: "tool_call", id: toolCall.id, name: fnName, args: fnArgs });

          let result: AgentToolResult;
          try {
            const parsedArgs = JSON.parse(fnArgs);
            result = await dispatchToolCall(fnName, parsedArgs);
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }

          onEvent({ type: "tool_result", id: toolCall.id, name: fnName, result });

          // Build the tool result message for the conversation
          const toolResultContent = formatToolResultForAPI(result);

          conversationMessages.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content: toolResultContent,
          } as ConversationMessage);
        }

        // Continue the loop — the LLM needs to process tool results
        continue;
      }

      // No tool calls — this is a text response
      const textContent = assistantMessage.content ?? "";
      if (textContent) {
        onEvent({ type: "text", content: textContent });
      }

      // Done — the LLM responded with text
      break;
    }

    if (toolRounds >= MAX_TOOL_ROUNDS) {
      onEvent({
        type: "error",
        message: `Tool call limit reached (${MAX_TOOL_ROUNDS} rounds). Stopping.`,
      });
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      onEvent({ type: "error", message: "Request cancelled." });
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      onEvent({ type: "error", message: `API error: ${msg}` });
    }
  }

  onEvent({ type: "done" });
}

// ─── Helpers ────────────────────────────────────────────────────

/**
 * Format a tool result for the OpenAI API.
 *
 * If the result is a string, return it directly.
 * If it's multi-modal (with images), we need to convert image parts
 * to text descriptions since tool results in the API are text-only.
 * However, we can include image data as a user message follow-up.
 *
 * For simplicity, we serialize multi-modal results:
 * - Text parts are concatenated
 * - Image parts get a placeholder "[Image: data URL provided]"
 *   The actual image will be injected as a follow-up user message
 *   with image_url content.
 */
function formatToolResultForAPI(result: AgentToolResult): string {
  if (typeof result === "string") return result;

  // Multi-modal result — check for images
  const textParts: string[] = [];
  const hasImages = result.some((p) => p.type === "image_url");

  for (const part of result) {
    if (part.type === "text" && part.text) {
      textParts.push(part.text);
    } else if (part.type === "image_url") {
      textParts.push("[Image attached]");
    }
  }

  // If there are images, inject them as a follow-up user message
  // so the VLM can actually see the image content.
  if (hasImages) {
    const contentParts: OpenAI.Chat.Completions.ChatCompletionContentPart[] = [];
    for (const part of result) {
      if (part.type === "text" && part.text) {
        contentParts.push({ type: "text", text: part.text });
      } else if (part.type === "image_url" && part.image_url) {
        contentParts.push({
          type: "image_url",
          image_url: { url: part.image_url.url },
        });
      }
    }
    // Inject a user message with the image so the LLM sees it
    conversationMessages.push({
      role: "user",
      content: contentParts,
    });
  }

  return textParts.join("\n");
}
