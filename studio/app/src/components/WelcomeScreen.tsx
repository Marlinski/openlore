import { useState } from 'preact/hooks'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  listWorkspaces,
  createWorkspace,
  deleteWorkspace,
  type WorkspaceInfo,
} from '../api/workspaces'

const KEYS = { all: ['workspaces'] as const }

export function WelcomeScreen() {
  const qc = useQueryClient()
  const { data: workspaces, isLoading, error } = useQuery({
    queryKey: KEYS.all,
    queryFn: listWorkspaces,
  })

  const [newName, setNewName] = useState('')

  const createMut = useMutation({
    mutationFn: (name: string) => createWorkspace(name),
    onSuccess: (ws) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      // Navigate into the new workspace
      window.location.href = `/${ws.id}/`
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: string) => deleteWorkspace(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: KEYS.all }),
  })

  function handleCreate() {
    const name = newName.trim()
    if (!name) return
    createMut.mutate(name)
  }

  function handleKeyDown(e: KeyboardEvent) {
    if (e.key === 'Enter') handleCreate()
  }

  function handleOpen(ws: WorkspaceInfo) {
    window.location.href = `/${ws.id}/`
  }

  function handleDelete(e: Event, ws: WorkspaceInfo) {
    e.stopPropagation()
    if (!confirm(`Delete workspace "${ws.name}"? This cannot be undone.`)) return
    deleteMut.mutate(ws.id)
  }

  return (
    <div class="welcome">
      <div class="welcome-card">
        <h1 class="welcome-title">Offisims Studio</h1>
        <p class="welcome-subtitle">Select a workspace or create a new one</p>

        {/* Create new workspace */}
        <div class="welcome-create">
          <input
            class="welcome-input"
            type="text"
            placeholder="New workspace name..."
            value={newName}
            onInput={(e) => setNewName((e.target as HTMLInputElement).value)}
            onKeyDown={handleKeyDown}
            disabled={createMut.isPending}
          />
          <button
            class="btn btn--accent welcome-create-btn"
            onClick={handleCreate}
            disabled={!newName.trim() || createMut.isPending}
          >
            {createMut.isPending ? 'Creating...' : 'Create'}
          </button>
        </div>
        {createMut.isError && (
          <p class="welcome-error">{(createMut.error as Error).message}</p>
        )}

        {/* Workspace list */}
        <div class="welcome-list">
          {isLoading && <p class="welcome-loading">Loading workspaces...</p>}
          {error && <p class="welcome-error">Failed to load workspaces</p>}
          {workspaces && workspaces.length === 0 && (
            <p class="welcome-empty">No workspaces yet. Create one to get started.</p>
          )}
          {workspaces?.map((ws) => (
            <div
              key={ws.id}
              class="welcome-item"
              onClick={() => handleOpen(ws)}
            >
              <div class="welcome-item-info">
                <span class="welcome-item-name">{ws.name}</span>
                <span class="welcome-item-meta">
                  {ws.id} &middot; {new Date(ws.createdAt).toLocaleDateString()}
                </span>
              </div>
              <button
                class="welcome-item-delete"
                onClick={(e) => handleDelete(e, ws)}
                title="Delete workspace"
              >
                x
              </button>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
