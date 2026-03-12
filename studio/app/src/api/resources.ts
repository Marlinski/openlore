import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type { Resource } from '@offisims/pack'
import { apiFetch } from './client'

const KEYS = {
  all: ['resources'] as const,
  one: (id: string) => ['resources', id] as const,
}

/** List all resources. */
export function useResources() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => apiFetch<Resource[]>('resources'),
  })
}

/** Fetch a single resource by ID. */
export function useResource(id: string | null) {
  return useQuery({
    queryKey: KEYS.one(id!),
    queryFn: () => apiFetch<Resource>(`resources/${id}`),
    enabled: !!id,
  })
}

/** Create or update a resource (PUT is idempotent). */
export function useSaveResource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (resource: Resource) =>
      apiFetch<Resource>(`resources/${resource.id}`, {
        method: 'PUT',
        body: JSON.stringify(resource),
      }),
    onSuccess: (_data, resource) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.invalidateQueries({ queryKey: KEYS.one(resource.id) })
    },
  })
}

/** Delete a resource by ID. */
export function useDeleteResource() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`resources/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.removeQueries({ queryKey: KEYS.one(id) })
    },
  })
}
