import { useAgentStore } from '../../store/agent'
import type { AgentTool } from '../../store/agent'

const API_BASE = '/api'

async function apiFetch(path: string): Promise<string> {
  const res = await fetch(`${API_BASE}${path}`)
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText}`)
  }
  const data = await res.json()
  return JSON.stringify(data, null, 2)
}

const ragSearchTool: AgentTool = {
  name: 'rag_search',
  description:
    'Search the resource database by text query. Returns matching resources with name, path, tags, and kind. Use parameters q (search text), kind (optional filter: "sprite" | "composite" | "tileset" | "room"), limit (optional, default 20).',
  parameters: {
    type: 'object',
    properties: {
      q: { type: 'string', description: 'Search query text' },
      kind: {
        type: 'string',
        description: 'Filter by resource kind',
        enum: ['sprite', 'composite', 'tileset', 'room'],
      },
      limit: { type: 'number', description: 'Max results (default 20)' },
    },
    required: ['q'],
  },
  execute: async (args) => {
    const params = new URLSearchParams()
    if (args.q) params.set('q', String(args.q))
    if (args.kind) params.set('kind', String(args.kind))
    if (args.limit) params.set('limit', String(args.limit))
    return apiFetch(`/search?${params.toString()}`)
  },
}

const ragSimilarTool: AgentTool = {
  name: 'rag_similar',
  description:
    'Find resources similar to a given resource by path. Returns semantically similar resources. Parameters: path (resource path), kind (optional filter), limit (optional, default 10).',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Resource path to find similar items for' },
      kind: {
        type: 'string',
        description: 'Filter by resource kind',
        enum: ['sprite', 'composite', 'tileset', 'room'],
      },
      limit: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['path'],
  },
  execute: async (args) => {
    const params = new URLSearchParams()
    if (args.path) params.set('path', String(args.path))
    if (args.kind) params.set('kind', String(args.kind))
    if (args.limit) params.set('limit', String(args.limit))
    return apiFetch(`/similar?${params.toString()}`)
  },
}

const ragTagsTool: AgentTool = {
  name: 'rag_tags',
  description:
    'List available tags in the resource database, optionally filtered by prefix. Parameters: prefix (optional), limit (optional, default 50).',
  parameters: {
    type: 'object',
    properties: {
      prefix: { type: 'string', description: 'Filter tags by prefix' },
      limit: { type: 'number', description: 'Max results (default 50)' },
    },
  },
  execute: async (args) => {
    const params = new URLSearchParams()
    if (args.prefix) params.set('prefix', String(args.prefix))
    if (args.limit) params.set('limit', String(args.limit))
    return apiFetch(`/tags?${params.toString()}`)
  },
}

const ragStatusTool: AgentTool = {
  name: 'rag_status',
  description:
    'Get the current status of the resource server, including indexed resource counts and health information.',
  parameters: {
    type: 'object',
    properties: {},
  },
  execute: async () => {
    return apiFetch('/status')
  },
}

const RAG_TOOLS = [ragSearchTool, ragSimilarTool, ragTagsTool, ragStatusTool]

export function registerRagTools() {
  const { registerTool } = useAgentStore.getState()
  for (const tool of RAG_TOOLS) {
    registerTool(tool)
  }
}

export function unregisterRagTools() {
  const { unregisterTool } = useAgentStore.getState()
  for (const tool of RAG_TOOLS) {
    unregisterTool(tool.name)
  }
}
