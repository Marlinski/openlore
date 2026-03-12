import { useQuery } from '@tanstack/react-query'
import { apiFetch, requireWorkspaceId } from './client'

/**
 * TilesetMeta as returned by the Go server's TilesetService.
 * Uses the SHA-256 hash prefix as the ID, and includes full image dimensions.
 */
export interface TilesetMeta {
  id: string        // first 16 hex chars of SHA-256
  label: string     // filename stem
  path: string      // relative to data/tilesets/
  tileWidth: number
  tileHeight: number
  cols: number
  rows: number
  width: number     // full image width in px
  height: number    // full image height in px
}

const KEYS = {
  all: ['tilesets'] as const,
  one: (hash: string) => ['tilesets', hash] as const,
}

/** List all tilesets. */
export function useTilesets() {
  return useQuery({
    queryKey: KEYS.all,
    queryFn: () => apiFetch<TilesetMeta[]>('tilesets'),
  })
}

/** Fetch a single tileset by hash. */
export function useTileset(hash: string | null) {
  return useQuery({
    queryKey: KEYS.one(hash!),
    queryFn: () => apiFetch<TilesetMeta>(`tilesets/${hash}`),
    enabled: !!hash,
  })
}

/** Build the URL for a tileset's PNG image. */
export function tilesetImageUrl(hash: string): string {
  return `/${requireWorkspaceId()}/api/tilesets/${hash}/image`
}
