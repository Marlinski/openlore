/**
 * Tester tab Zustand store.
 *
 * Manages compiled room data, character resources, atlas texture cache,
 * and all UI state for the room player / tester.
 *
 * Consumes the protojson output from the pack compiler:
 *   manifest.json   → PackManifest  (tilesetEntries, roomEntries, resourceEntries)
 *   rooms/<name>.json → RoomDefinition (placements with TilesetRegion, compositeId refs)
 *   resources/<id>.json → Resource   (frames with ResourceFrame: tilesetId/srcCol/srcRow/w/h)
 *   composites/<id>.json → CompositeObject (parts with TilesetRegion + offsets)
 *   tilesets/<id>.json → TilesetDefinition (atlas metadata — tile_width=1 means pixel coords)
 */

import { create } from 'zustand'
import { dataBase } from '../api/client'

// ─── Protojson Types (matching compiled pack output) ────────────────

/** TilesetEntry from PackManifest.tilesetEntries */
export interface TilesetEntryJSON {
  id: string
  label?: string
  path: string // e.g. "atlas/atlas_a0e448f9b5.png"
}

/** RoomEntry from PackManifest.roomEntries */
export interface RoomEntryJSON {
  name: string
}

/** ResourceEntry from PackManifest.resourceEntries */
export interface ResourceEntryJSON {
  id: string
  name?: string
  tags?: string[]
}

/** PackManifest (protojson) */
export interface ManifestJSON {
  id?: string
  name?: string
  description?: string
  version?: string
  author?: string
  created?: string
  updated?: string
  tilesetEntries?: TilesetEntryJSON[]
  roomEntries?: RoomEntryJSON[]
  resourceEntries?: ResourceEntryJSON[]
}

/** TilesetRegion (protojson) — pixel coords when tile_width=1 */
export interface TilesetRegionJSON {
  tilesetId?: string
  srcCol?: number
  srcRow?: number
  w?: number
  h?: number
}

/** ResourceFrame (protojson) — same shape as TilesetRegion */
export interface ResourceFrameJSON {
  tilesetId?: string
  srcCol?: number
  srcRow?: number
  w?: number
  h?: number
}

/** DoorDefinition (protojson) */
export interface DoorJSON {
  id?: string
  col?: number
  row?: number
  target?: string
}

/** TexturePlacement (protojson) */
export interface PlacementJSON {
  gridX?: number
  gridY?: number
  layer?: string | number // protojson may emit "PLACEMENT_LAYER_FLOOR" or 1
  region?: TilesetRegionJSON
  compositeId?: string
  zBias?: number
}

/** RoomDefinition (protojson) */
export interface RoomJSON {
  name?: string
  width?: number
  height?: number
  walkability?: boolean[]
  doors?: DoorJSON[]
  placements?: PlacementJSON[]
}

/** Resource (protojson) */
export interface ResourceJSON {
  id?: string
  name?: string
  tags?: string[]
  frames?: ResourceFrameJSON[]
}

/** CompositePart (protojson) */
export interface CompositePartJSON {
  region?: TilesetRegionJSON
  offsetX?: number
  offsetY?: number
  zBias?: number
}

/** CompositeObject (protojson) */
export interface CompositeJSON {
  id?: string
  name?: string
  parts?: CompositePartJSON[]
  displayWidth?: number
  displayHeight?: number
}

// ─── Layer helpers ──────────────────────────────────────────────────

/**
 * Normalize protojson placement layer to numeric: 1=floor, 2=object.
 * protojson may emit enum as string or number.
 */
export function normalizeLayer(layer: string | number | undefined): number {
  if (typeof layer === 'number') return layer
  if (typeof layer === 'string') {
    if (layer === 'PLACEMENT_LAYER_FLOOR') return 1
    if (layer === 'PLACEMENT_LAYER_OBJECT') return 2
    // Try numeric string
    const n = parseInt(layer, 10)
    if (!isNaN(n)) return n
  }
  return 0
}

// ─── Atlas Texture Cache (module-level) ─────────────────────────────

const atlasCache = new Map<string, HTMLImageElement>()

/** Map of tilesetId → image path (built from manifest tilesetEntries) */
let tilesetPathMap = new Map<string, string>()

export function getAtlasImage(tilesetId: string): HTMLImageElement | null {
  return atlasCache.get(tilesetId) ?? null
}

/**
 * Load atlas image for a tileset ID. Uses the tilesetPathMap to resolve
 * the image URL from the pack data directory.
 */
export function loadAtlasImage(tilesetId: string): Promise<HTMLImageElement> {
  const cached = atlasCache.get(tilesetId)
  if (cached) return Promise.resolve(cached)

  const path = tilesetPathMap.get(tilesetId)
  if (!path) return Promise.reject(new Error(`No path for tileset: ${tilesetId}`))

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      atlasCache.set(tilesetId, img)
      resolve(img)
    }
    img.onerror = () => reject(new Error(`Failed to load atlas: ${path}`))
    img.src = dataBase() + '/pack/' + path
  })
}

// ─── Composite cache (module-level) ─────────────────────────────────

const compositeCache = new Map<string, CompositeJSON>()

export function getComposite(id: string): CompositeJSON | null {
  return compositeCache.get(id) ?? null
}

async function loadComposite(id: string): Promise<CompositeJSON | null> {
  const cached = compositeCache.get(id)
  if (cached) return cached

  try {
    const resp = await fetch(dataBase() + '/pack/composites/' + id + '.json')
    if (!resp.ok) return null
    const comp: CompositeJSON = await resp.json()
    compositeCache.set(id, comp)
    return comp
  } catch {
    return null
  }
}

// ─── Store Shape ────────────────────────────────────────────────────

interface TesterStoreState {
  manifest: ManifestJSON | null
  selectedRoom: string
  selectedChar: string
  currentRoom: RoomJSON | null
  charResources: ResourceJSON[]
  zoom: number
  showGrid: boolean
  showWalkability: boolean
  loaded: boolean
  loading: boolean
  error: string | null
  /** Set by transitionToRoom so the canvas knows where to spawn after re-render */
  pendingDoor: string | null

  // Actions
  fetchManifest: () => Promise<void>
  loadRoom: () => Promise<void>
  setSelectedRoom: (name: string) => void
  setSelectedChar: (name: string) => void
  setZoom: (zoom: number) => void
  toggleGrid: () => void
  toggleWalkability: () => void
  transitionToRoom: (roomName: string, doorId: string) => Promise<void>
  consumePendingDoor: () => string | null
}

// ─── Store ──────────────────────────────────────────────────────────

export const useTesterStore = create<TesterStoreState>()((set, get) => ({
  manifest: null,
  selectedRoom: '',
  selectedChar: '',
  currentRoom: null,
  charResources: [],
  zoom: 1,
  showGrid: false,
  showWalkability: false,
  loaded: false,
  loading: false,
  error: null,
  pendingDoor: null,

  fetchManifest: async () => {
    set({ loading: true, error: null })
    try {
      const resp = await fetch(dataBase() + '/pack/manifest.json?t=' + Date.now())
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const manifest: ManifestJSON = await resp.json()

      // Build tileset path map from manifest entries
      tilesetPathMap = new Map<string, string>()
      for (const entry of manifest.tilesetEntries ?? []) {
        tilesetPathMap.set(entry.id, entry.path)
      }

      const rooms = manifest.roomEntries ?? []
      const firstRoom = rooms.length > 0 ? (rooms[0].name || '') : ''

      // Pick first character resource (resources with tag 'entity:character')
      const resourceEntries = manifest.resourceEntries ?? []
      const charResources = resourceEntries.filter((r) =>
        (r.tags ?? []).some((t) => t === 'entity:character'),
      )
      // Extract unique character names from name: tags
      const charNameSet = new Set(
        charResources.flatMap((r) =>
          (r.tags ?? []).filter((t: string) => t.startsWith('name:')).map((t: string) => t.slice(5)),
        ),
      )
      const charNames = [...charNameSet].sort()
      const firstChar = charNames.length > 0 ? charNames[0] : ''
      set({
        manifest,
        selectedRoom: firstRoom,
        selectedChar: firstChar,
        loading: false,
      })
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to fetch manifest',
      })
    }
  },

  loadRoom: async () => {
    const { manifest, selectedRoom, selectedChar } = get()
    if (!manifest || !selectedRoom) return

    set({ loading: true, error: null, loaded: false })
    try {
      // Fetch room JSON (rooms/<name>.json)
      const roomResp = await fetch(dataBase() + '/pack/rooms/' + selectedRoom + '.json')
      if (!roomResp.ok) throw new Error(`HTTP ${roomResp.status} loading room`)
      const room: RoomJSON = await roomResp.json()

      // Collect all tileset IDs referenced by placements
      const tilesetIds = new Set<string>()
      const compositeIds = new Set<string>()

      for (const p of room.placements ?? []) {
        if (p.region?.tilesetId) {
          tilesetIds.add(p.region.tilesetId)
        }
        if (p.compositeId) {
          compositeIds.add(p.compositeId)
        }
      }

      // Load composites and collect their tileset IDs too
      for (const compId of compositeIds) {
        const comp = await loadComposite(compId)
        if (comp) {
          for (const part of comp.parts ?? []) {
            if (part.region?.tilesetId) {
              tilesetIds.add(part.region.tilesetId)
            }
          }
        }
      }

      // Load all referenced atlas images
      const atlasPromises = [...tilesetIds].map((id) => loadAtlasImage(id))
      await Promise.all(atlasPromises)

      // Load character resources — selectedChar is a character name like "amanda"
      // Find all resources tagged entity:character AND name:<selectedChar>
      const charResources: ResourceJSON[] = []
      if (selectedChar) {
        const charTag = `name:${selectedChar}`
        const resourceEntries = manifest.resourceEntries ?? []
        const charEntries = resourceEntries.filter(
          (r) =>
            (r.tags ?? []).some((t) => t === 'entity:character') &&
            (r.tags ?? []).some((t) => t === charTag),
        )
        for (const entry of charEntries) {
          const resp = await fetch(dataBase() + '/pack/resources/' + entry.id + '.json')
          if (resp.ok) {
            const resource: ResourceJSON = await resp.json()
            charResources.push(resource)
            // Load atlas images for character frames
            const charTilesets = new Set(
              (resource.frames ?? [])
                .map((f) => f.tilesetId || '')
                .filter((id) => id !== ''),
            )
            await Promise.all([...charTilesets].map((id) => loadAtlasImage(id)))
          }
        }
      }

      set({
        currentRoom: room,
        charResources,
        loaded: true,
        loading: false,
      })
    } catch (e) {
      set({
        loading: false,
        error: e instanceof Error ? e.message : 'Failed to load room',
      })
    }
  },

  setSelectedRoom: (name) => set({ selectedRoom: name }),
  setSelectedChar: (name) => set({ selectedChar: name }),
  setZoom: (zoom) => set({ zoom: Math.max(0.05, Math.min(8, zoom)) }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleWalkability: () => set((s) => ({ showWalkability: !s.showWalkability })),

  transitionToRoom: async (roomName, doorId) => {
    const { manifest } = get()
    if (!manifest) return

    // Set pendingDoor BEFORE loadRoom so the canvas effect can consume it
    set({ selectedRoom: roomName, pendingDoor: doorId || null })
    // loadRoom will pick up the new selectedRoom
    await get().loadRoom()
  },

  consumePendingDoor: () => {
    const door = get().pendingDoor
    if (door !== null) set({ pendingDoor: null })
    return door
  },
}))
