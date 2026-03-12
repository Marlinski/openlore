import { useQuery } from '@tanstack/react-query'
import { apiFetch } from './client'

// ─── Types ──────────────────────────────────────────────────────────

/** SearchResult as returned by the Go server (no json tags → PascalCase). */
export interface SearchResult {
  ID: string
  Kind: string
  Score: float32
  Metadata: Record<string, unknown>
  Tags: string[]
}

// biome-ignore: float32 is just number in TS — alias kept for documentation
type float32 = number

export interface StatusResponse {
  ok: boolean
  rag: boolean
  stats?: Record<string, number>
}

// ─── Query keys ─────────────────────────────────────────────────────

const KEYS = {
  search: (q: string, kind?: string, limit?: number) =>
    ['search', { q, kind, limit }] as const,
  similar: (id: string, kind?: string, limit?: number) =>
    ['similar', { id, kind, limit }] as const,
  tags: (prefix: string, limit?: number) =>
    ['tags', { prefix, limit }] as const,
  status: ['status'] as const,
}

// ─── Hooks ──────────────────────────────────────────────────────────

/** Semantic text search via CLIP embeddings. */
export function useSearch(query: string, kind?: string, limit?: number) {
  const params = new URLSearchParams()
  if (query) params.set('q', query)
  if (kind) params.set('kind', kind)
  if (limit) params.set('limit', String(limit))

  return useQuery({
    queryKey: KEYS.search(query, kind, limit),
    queryFn: () => apiFetch<SearchResult[]>(`search?${params}`),
    enabled: query.length > 0,
    placeholderData: (prev: SearchResult[] | undefined) => prev,
  })
}

/** Find items similar to a given ID. */
export function useSimilar(id: string | null, kind?: string, limit?: number) {
  const params = new URLSearchParams()
  if (id) params.set('id', id)
  if (kind) params.set('kind', kind)
  if (limit) params.set('limit', String(limit))

  return useQuery({
    queryKey: KEYS.similar(id!, kind, limit),
    queryFn: () => apiFetch<SearchResult[]>(`similar?${params}`),
    enabled: !!id,
  })
}

/** Tag autocomplete. Uses placeholderData to keep previous results while typing. */
export function useTags(prefix: string, limit?: number) {
  const params = new URLSearchParams()
  if (prefix) params.set('prefix', prefix)
  if (limit) params.set('limit', String(limit))

  return useQuery({
    queryKey: KEYS.tags(prefix, limit),
    queryFn: () => apiFetch<string[]>(`tags?${params}`),
    enabled: prefix.length > 0,
    placeholderData: (prev: string[] | undefined) => prev,
  })
}

/** Server health + entity counts. Polled every 30s for the status bar. */
export function useStatus() {
  return useQuery({
    queryKey: KEYS.status,
    queryFn: () => apiFetch<StatusResponse>('status'),
    refetchInterval: 30_000,
  })
}
