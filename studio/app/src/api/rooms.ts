import {
  useQuery,
  useMutation,
  useQueryClient,
} from '@tanstack/react-query'
import type { RoomDefinition } from '@openlore/pack'
import { apiFetch } from './client'

const KEYS = {
  all: ['rooms'] as const,
  one: (name: string) => ['rooms', name] as const,
}

/** List all rooms. */
export function useRooms() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => apiFetch<RoomDefinition[]>('rooms'),
  })
}

/** Fetch a single room by name. */
export function useRoom(name: string | null) {
  return useQuery({
    queryKey: KEYS.one(name!),
    queryFn: () => apiFetch<RoomDefinition>(`rooms/${name}`),
    enabled: !!name,
  })
}

/** Create or update a room (PUT is idempotent, keyed by name). */
export function useSaveRoom() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (room: RoomDefinition) =>
      apiFetch<RoomDefinition>(`rooms/${room.name}`, {
        method: 'PUT',
        body: JSON.stringify(room),
      }),
    onSuccess: (_data, room) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.invalidateQueries({ queryKey: KEYS.one(room.name) })
    },
  })
}

/** Delete a room by name. */
export function useDeleteRoom() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (name: string) =>
      apiFetch<void>(`rooms/${name}`, { method: 'DELETE' }),
    onSuccess: (_data, name) => {
      qc.invalidateQueries({ queryKey: KEYS.all })
      qc.removeQueries({ queryKey: KEYS.one(name) })
    },
  })
}
