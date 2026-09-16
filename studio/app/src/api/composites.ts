import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type { CompositeObject } from '@openlore/pack'
import { apiFetch } from './client'

const KEYS = {
  all: ['composites'] as const,
  one: (id: string) => ['composites', id] as const,
}

/** List all composites. */
export function useComposites() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => apiFetch<CompositeObject[]>('composites'),
  })
}

/** Fetch a single composite by ID. */
export function useComposite(id: string | null) {
  return useQuery({
    queryKey: KEYS.one(id!),
    queryFn: () => apiFetch<CompositeObject>(`composites/${id}`),
    enabled: !!id,
  })
}

/** Create or update a composite (PUT is idempotent). */
export function useSaveComposite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (composite: CompositeObject) =>
      apiFetch<CompositeObject>(`composites/${composite.id}`, {
        method: 'PUT',
        body: JSON.stringify(composite),
      }),
    onSuccess: (_data, composite) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.invalidateQueries({ queryKey: KEYS.one(composite.id) })
    },
  })
}

/** Delete a composite by ID. */
export function useDeleteComposite() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`composites/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.removeQueries({ queryKey: KEYS.one(id) })
    },
  })
}
