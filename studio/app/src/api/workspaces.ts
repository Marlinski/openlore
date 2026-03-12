/**
 * Workspace API client.
 *
 * Workspace management endpoints live at the root level (/api/workspaces),
 * NOT under a workspace-scoped path. This is intentional — you need to
 * list/create workspaces before you have a workspace ID.
 */

export interface WorkspaceInfo {
  id: string
  name: string
  createdAt: string
}

/**
 * Fetch wrapper for root-level API (no workspace prefix).
 */
async function rootFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  })
  if (!res.ok) {
    let message = res.statusText
    try {
      const body = await res.json()
      if (body.error) message = body.error
    } catch {
      // body wasn't JSON
    }
    throw new Error(message)
  }
  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

/** List all workspaces. */
export function listWorkspaces(): Promise<WorkspaceInfo[]> {
  return rootFetch<WorkspaceInfo[]>('workspaces')
}

/** Get a single workspace by ID. */
export function getWorkspace(id: string): Promise<WorkspaceInfo> {
  return rootFetch<WorkspaceInfo>(`workspaces/${id}`)
}

/** Create a new workspace with the given display name. */
export function createWorkspace(name: string): Promise<WorkspaceInfo> {
  return rootFetch<WorkspaceInfo>('workspaces', {
    method: 'POST',
    body: JSON.stringify({ name }),
  })
}

/** Delete a workspace by ID. */
export function deleteWorkspace(id: string): Promise<void> {
  return rootFetch<void>(`workspaces/${id}`, { method: 'DELETE' })
}
