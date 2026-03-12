import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type { Mask } from '@offisims/pack'
import { apiFetch } from './client'

const KEYS = {
  all: ['masks'] as const,
  one: (id: string) => ['masks', id] as const,
}

/** List all masks. */
export function useMasks() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => apiFetch<Mask[]>('masks'),
  })
}

/** Fetch a single mask by ID. */
export function useMask(id: string | null) {
  return useQuery({
    queryKey: KEYS.one(id!),
    queryFn: () => apiFetch<Mask>(`masks/${id}`),
    enabled: !!id,
  })
}

/** Create or update a mask (PUT is idempotent). */
export function useSaveMask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (mask: Mask) =>
      apiFetch<Mask>(`masks/${mask.id}`, {
        method: 'PUT',
        body: JSON.stringify(mask),
      }),
    onSuccess: (_data, mask) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.invalidateQueries({ queryKey: KEYS.one(mask.id) })
    },
  })
}

/** Delete a mask by ID. */
export function useDeleteMask() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`masks/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.removeQueries({ queryKey: KEYS.one(id) })
    },
  })
}
