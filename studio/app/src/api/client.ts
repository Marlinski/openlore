/**
 * API client — thin fetch wrapper for the Go backend.
 *
 * All endpoints are workspace-scoped: /{workspaceId}/api/...
 * The workspace ID is extracted from the current URL path.
 * In dev mode Vite proxies these requests to :4000.
 * Errors follow the Go shape: { "error": "message", "code": "SNAKE_CASE" }.
 */

/**
 * Extract the workspace ID from the current URL path.
 * Expects the first path segment to be the workspace ID:
 *   /workspace1/...  → "workspace1"
 *   /my-project/...  → "my-project"
 * Returns null when at the root (no workspace segment) — this signals
 * the app to show the welcome/workspace-picker screen instead of the studio.
 */
export function getWorkspaceId(): string | null {
  const segments = window.location.pathname.split('/').filter(Boolean)
  return segments[0] || null
}

/**
 * Return the workspace ID or throw if not in a workspace context.
 * Use this in code that must run inside /{workspaceId}/... routes.
 */
export function requireWorkspaceId(): string {
  const id = getWorkspaceId()
  if (!id) throw new Error('No workspace selected — cannot make workspace-scoped request')
  return id
}

/**
 * Build the base path for API requests: /{workspaceId}/api
 */
function apiBase(): string {
  return `/${requireWorkspaceId()}/api`
}

/**
 * Build the base path for data requests: /{workspaceId}/data
 */
export function dataBase(): string {
  return `/${requireWorkspaceId()}/data`
}

export class ApiError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly status: number,
  ) {
    super(message)
    this.name = 'ApiError'
  }
}

/**
 * Typed fetch against the Go API.
 *
 * - Prepends `/{workspaceId}/api/` to the path (do NOT include it in the argument).
 * - Parses JSON on success, throws `ApiError` on non-2xx.
 * - DELETE returning 204 returns `undefined`.
 * - After any successful mutation (PUT/POST/DELETE), schedules a debounced
 *   pack status refresh so the UI can detect stale packs.
 */
export async function apiFetch<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const res = await fetch(`${apiBase()}/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })

  if (!res.ok) {
    let code = 'UNKNOWN'
    let message = res.statusText
    try {
      const body = await res.json()
      if (body.error) message = body.error
      if (body.code) code = body.code
    } catch {
      // body wasn't JSON — keep statusText
    }
    throw new ApiError(message, code, res.status)
  }

  // Schedule a pack status refresh after any mutation
  const method = (options?.method || 'GET').toUpperCase()
  if (method === 'PUT' || method === 'POST' || method === 'DELETE' || method === 'PATCH') {
    schedulePackStatusRefresh()
  }

  // 204 No Content (DELETE responses)
  if (res.status === 204) return undefined as T

  return res.json() as Promise<T>
}

// ─── Debounced pack status refresh ──────────────────────────────────

let _packStatusTimer: ReturnType<typeof setTimeout> | null = null

/**
 * Schedule a debounced fetchStatus() call. Coalesces rapid mutations
 * (e.g. multiple tag edits) into a single server round-trip.
 */
function schedulePackStatusRefresh() {
  if (_packStatusTimer) clearTimeout(_packStatusTimer)
  _packStatusTimer = setTimeout(() => {
    _packStatusTimer = null
    // Dynamic import to avoid circular dependency
    import('../store/pack').then(({ usePackStore }) => {
      usePackStore.getState().fetchStatus()
    })
  }, 1000) // 1 second debounce
}
