import { create } from 'zustand'
import { requireWorkspaceId } from '../api/client'

// ─── Types ──────────────────────────────────────────────────────────

export type PackBuildStatus = 'idle' | 'building' | 'done' | 'error'

export interface PackInfo {
  exists: boolean
  size: number          // bytes
  builtAt: string       // ISO-8601
  sourceHash: string    // workspace content hash at compile time
  currentHash: string   // current workspace content hash
  compiledAt: string    // ISO-8601 compilation timestamp
}

export interface PackBuildResult {
  size: number
  resources: number
  rooms: number
  atlases: number
  sourceHash: string
}

interface PackState {
  // Build state
  status: PackBuildStatus
  messages: string[]
  result: PackBuildResult | null
  error: string | null

  // Latest pack info (from /api/pack/status)
  packInfo: PackInfo | null

  // Panel visibility
  panelOpen: boolean

  // Derived: whether the pack is stale (workspace changed since last compile)
  isStale: boolean

  // Actions
  startBuild: () => void
  fetchStatus: () => Promise<void>
  openPanel: () => void
  closePanel: () => void
}

// ─── Helpers ────────────────────────────────────────────────────────

/** Compute staleness from pack info. */
function computeStale(info: PackInfo | null): boolean {
  if (!info) return false
  if (!info.exists) return true  // no pack built yet but workspace has content
  if (!info.sourceHash || !info.currentHash) return false
  return info.sourceHash !== info.currentHash
}

// ─── Store ──────────────────────────────────────────────────────────

export const usePackStore = create<PackState>()((set, get) => ({
  status: 'idle',
  messages: [],
  result: null,
  error: null,
  packInfo: null,
  panelOpen: false,
  isStale: false,

  openPanel: () => set({ panelOpen: true }),
  closePanel: () => set({ panelOpen: false }),

  fetchStatus: async () => {
    try {
      const wsId = requireWorkspaceId()
      const res = await fetch(`/${wsId}/api/pack/status`)
      if (!res.ok) return
      const info = await res.json() as PackInfo
      set({ packInfo: info, isStale: computeStale(info) })
    } catch {
      // silent — pack status is non-critical
    }
  },

  startBuild: () => {
    const { status } = get()
    if (status === 'building') return

    set({
      status: 'building',
      messages: [],
      result: null,
      error: null,
      panelOpen: true,
    })

    const wsId = requireWorkspaceId()
    const eventSource = new EventSource(`/${wsId}/api/pack/build`)

    // SSE doesn't support POST via EventSource, so we use fetch + ReadableStream
    // Actually EventSource only does GET. We need to use fetch with POST + stream.
    eventSource.close() // close the auto-opened one

    // Use fetch with POST and read the SSE stream manually
    fetch(`/${wsId}/api/pack/build`, { method: 'POST' })
      .then(async (res) => {
        if (!res.ok || !res.body) {
          set({ status: 'error', error: `Build failed: ${res.statusText}` })
          return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Parse SSE frames from buffer
          const lines = buffer.split('\n')
          buffer = lines.pop() || '' // keep incomplete line

          let currentEvent = ''
          for (const line of lines) {
            if (line.startsWith('event: ')) {
              currentEvent = line.slice(7)
            } else if (line.startsWith('data: ')) {
              const data = line.slice(6)

              if (currentEvent === 'progress') {
                set((s) => ({ messages: [...s.messages, data] }))
              } else if (currentEvent === 'done') {
                try {
                  const result = JSON.parse(data) as PackBuildResult
                  const sourceHash = result.sourceHash || ''
                  const packInfo: PackInfo = {
                    exists: true,
                    size: result.size,
                    builtAt: new Date().toISOString(),
                    sourceHash,
                    currentHash: sourceHash, // just compiled, so they match
                    compiledAt: new Date().toISOString(),
                  }
                  set({
                    status: 'done',
                    result,
                    packInfo,
                    isStale: false, // just compiled
                  })
                } catch {
                  set({ status: 'done' })
                }
              } else if (currentEvent === 'error') {
                set({ status: 'error', error: data })
              }
              currentEvent = ''
            }
          }
        }

        // If we finished reading but never got a done/error event, mark done
        const finalState = get()
        if (finalState.status === 'building') {
          set({ status: 'done' })
        }
      })
      .catch((err) => {
        set({ status: 'error', error: `Network error: ${err.message}` })
      })
  },
}))
