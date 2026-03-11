/**
 * Agent tool registry — per-tab tool registration for the agentic panel.
 *
 * Each app tab registers tools (name, description, JSON schema, async handler).
 * When the active tab changes, the panel queries this registry to get the
 * current tool definitions (in OpenAI function calling format) and dispatchers.
 */

import type OpenAI from "openai";

// ─── Types ──────────────────────────────────────────────────────

/** A single tool that a tab can register. */
export interface AgentTool {
  /** Unique tool name (e.g. "fetch_tile") */
  name: string;
  /** Short description shown to the LLM */
  description: string;
  /** JSON Schema for the parameters object */
  parameters: Record<string, unknown>;
  /**
   * Execute the tool. Receives parsed arguments, returns a result.
   * The result can be:
   * - A string (text result)
   * - An array of content parts (text and/or image_url) for multi-modal results
   */
  handler: (args: Record<string, unknown>) => Promise<AgentToolResult>;
}

/** Result from a tool invocation — either plain text or multi-modal content parts */
export type AgentToolResult = string | AgentToolResultPart[];

export interface AgentToolResultPart {
  type: "text" | "image_url";
  /** Text content (when type is "text") */
  text?: string;
  /** Image data URL (when type is "image_url") */
  image_url?: { url: string };
}

/** A preset query that a tab can register — shown as a button in the panel. */
export interface AgentPreset {
  /** Short label for the button (e.g. "Cut all") */
  label: string;
  /** Full prompt sent to the AI when clicked */
  prompt: string;
}

// ─── Registry ───────────────────────────────────────────────────

/** Map of tabId → tools registered for that tab */
const registry = new Map<string, AgentTool[]>();

/** Global tools available on every tab (e.g. RAG search) */
let globalTools: AgentTool[] = [];

/** Map of tabId → context provider function */
const contextProviders = new Map<string, () => string>();

/** Map of tabId → preset queries */
const presetRegistry = new Map<string, AgentPreset[]>();

/** Currently active tab */
let activeTab = "cutter";

/** Listeners notified when the active tab's tool set changes */
const toolsChangedListeners: Array<() => void> = [];

/** Subscribe to tools-changed events. Returns an unsubscribe function. */
export function onToolsChanged(listener: () => void): () => void {
  toolsChangedListeners.push(listener);
  return () => {
    const idx = toolsChangedListeners.indexOf(listener);
    if (idx >= 0) toolsChangedListeners.splice(idx, 1);
  };
}

/** Notify all listeners that the tool set has changed. */
function notifyToolsChanged(): void {
  for (const fn of toolsChangedListeners) fn();
}

/**
 * Register tools for a specific tab.
 * Replaces any previously registered tools for that tab.
 */
export function registerTools(tabId: string, tools: AgentTool[]): void {
  registry.set(tabId, tools);
  if (tabId === activeTab) notifyToolsChanged();
}

/**
 * Register global tools available on every tab.
 * Replaces any previously registered global tools.
 */
export function registerGlobalTools(tools: AgentTool[]): void {
  globalTools = tools;
  notifyToolsChanged();
}

/**
 * Register a context provider for a specific tab.
 * The provider is called before each user message to get a snapshot
 * of the current tab state (e.g. which tileset is loaded, how many cuts, etc.).
 */
export function registerContextProvider(tabId: string, provider: () => string): void {
  contextProviders.set(tabId, provider);
}

/**
 * Get the current context snapshot for the active tab.
 * Returns empty string if no provider is registered.
 */
export function getContextSnapshot(): string {
  const provider = contextProviders.get(activeTab);
  return provider ? provider() : "";
}

/** Register preset queries for a specific tab. */
export function registerPresets(tabId: string, presets: AgentPreset[]): void {
  presetRegistry.set(tabId, presets);
  if (tabId === activeTab) notifyToolsChanged();
}

/** Get presets for the currently active tab. */
export function getActivePresets(): AgentPreset[] {
  return presetRegistry.get(activeTab) ?? [];
}

/** Set the currently active tab (called when tabs switch). */
export function setActiveTab(tabId: string): void {
  activeTab = tabId;
  notifyToolsChanged();
}

/** Get the currently active tab id. */
export function getActiveTab(): string {
  return activeTab;
}

/** Get tools for the currently active tab (tab-specific + global). */
export function getActiveTools(): AgentTool[] {
  const tabTools = registry.get(activeTab) ?? [];
  return [...tabTools, ...globalTools];
}

/**
 * Convert active tools to OpenAI function calling format.
 * Returns the `tools` array to pass to `chat.completions.create()`.
 */
export function getToolDefinitions(): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return getActiveTools().map((tool) => ({
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

/**
 * Dispatch a tool call by name with the given arguments.
 * Looks up the tool in the active tab's registry and calls its handler.
 * Throws if the tool is not found.
 */
export async function dispatchToolCall(
  name: string,
  args: Record<string, unknown>,
): Promise<AgentToolResult> {
  const tools = getActiveTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) {
    throw new Error(`Unknown tool: "${name}" (active tab: ${activeTab})`);
  }
  return tool.handler(args);
}

/**
 * Build the system prompt prefix that describes available tools.
 * This is appended to the tab-specific system prompt so the LLM
 * knows what tools are available.
 */
export function getToolSystemPromptSuffix(): string {
  const tools = getActiveTools();
  if (tools.length === 0) return "";
  const lines = tools.map(
    (t) => `- ${t.name}: ${t.description}`,
  );
  return `\n\nYou have access to the following tools:\n${lines.join("\n")}`;
}

// ─── Global RAG tools ───────────────────────────────────────────

/** Helper to fetch JSON from a RAG endpoint, returning null on failure. */
async function ragFetch<T>(url: string): Promise<T | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

/** Register global RAG search tools (available on all tabs). */
export function registerRagTools(): void {
  registerGlobalTools([
    {
      name: "rag_search",
      description:
        "Semantic text search across all indexed items (tilesets, resources, composites, rooms). " +
        "Returns the most similar items to the query string.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Natural language search query" },
          kind: {
            type: "string",
            description: "Optional: filter by item kind",
            enum: ["tileset", "resource", "resource_sprite", "composite", "room"],
          },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["query"],
      },
      handler: async (args) => {
        const q = args.query as string;
        const params = new URLSearchParams({ q });
        if (args.kind) params.set("kind", args.kind as string);
        if (args.limit) params.set("limit", String(args.limit));
        const data = await ragFetch<{ results: unknown[] }>(`/api/search?${params}`);
        if (!data) return "RAG search unavailable (server may still be indexing).";
        return JSON.stringify(data.results, null, 2);
      },
    },
    {
      name: "rag_similar",
      description:
        "Find items visually similar to a given tileset image. " +
        "Pass the tileset path (relative, e.g. 'tilesets/3_office/Room_Builder_Office_48x48.png').",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Relative path to the tileset PNG" },
          kind: {
            type: "string",
            description: "Optional: filter by item kind",
            enum: ["tileset", "resource", "resource_sprite", "composite", "room"],
          },
          limit: { type: "number", description: "Max results (default 10)" },
        },
        required: ["path"],
      },
      handler: async (args) => {
        const p = args.path as string;
        const params = new URLSearchParams({ path: p });
        if (args.kind) params.set("kind", args.kind as string);
        if (args.limit) params.set("limit", String(args.limit));
        const data = await ragFetch<{ results: unknown[] }>(`/api/similar?${params}`);
        if (!data) return "RAG similar search unavailable (server may still be indexing).";
        return JSON.stringify(data.results, null, 2);
      },
    },
    {
      name: "rag_tags",
      description:
        "Autocomplete/search tags across all resources. " +
        "Returns tags matching the prefix, with usage counts.",
      parameters: {
        type: "object",
        properties: {
          prefix: { type: "string", description: "Tag prefix to search for (e.g. 'entity:' or 'name:am')" },
          limit: { type: "number", description: "Max results (default 20)" },
        },
        required: ["prefix"],
      },
      handler: async (args) => {
        const prefix = args.prefix as string;
        const params = new URLSearchParams({ prefix });
        if (args.limit) params.set("limit", String(args.limit));
        const data = await ragFetch<{ tags: unknown[] }>(`/api/tags?${params}`);
        if (!data) return "RAG tag search unavailable (server may still be indexing).";
        return JSON.stringify(data.tags, null, 2);
      },
    },
    {
      name: "rag_status",
      description:
        "Check the current RAG indexing status — whether it's ready, still indexing, or has errors.",
      parameters: {
        type: "object",
        properties: {},
      },
      handler: async () => {
        const data = await ragFetch<Record<string, unknown>>("/api/status");
        if (!data) return "RAG system unavailable.";
        return JSON.stringify(data, null, 2);
      },
    },
  ]);
}
