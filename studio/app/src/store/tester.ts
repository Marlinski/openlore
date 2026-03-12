/**
 * Tester tab Zustand store.
 *
 * Manages compiled room data, character resources, atlas texture cache,
 * and all UI state for the room player / tester.
 */

import { create } from 'zustand'
import { dataBase } from '../api/client'

// ─── Compiled Types (local to tester) ───────────────────────────────

export interface CompiledRegionRef {
  atlas: string
  x: number
  y: number
  w: number
  h: number
}

export interface CompiledPlacement {
  gridX: number
  gridY: number
  layer: 'floor' | 'object'
  region?: CompiledRegionRef
  parts?: {
    region: CompiledRegionRef
    offsetX: number
    offsetY: number
    zBias?: number
  }[]
  zBias?: number
}

export interface CompiledDoor {
  id: string
  col: number
  row: number
  target: string
}

export interface CompiledRoom {
  name: string
  width: number
  height: number
  walkability: boolean[]
  doors: CompiledDoor[]
  placements: CompiledPlacement[]
  atlases: string[]
}

export interface CompiledFrame {
  atlas: string
  x: number
  y: number
  w: number
  h: number
}

export interface CompiledResource {
  id: string
  name: string
  tags: string[]
  frames: CompiledFrame[]
}

export interface CompiledManifest {
  compiledAt: string
  atlases: {
    file: string
    tilesetId: string
    regions: number
    sizeBytes: number
  }[]
  rooms: { name: string; file: string }[]
  resources: {
    id: string
    name: string
    tags: string[]
    file: string
  }[]
}

// ─── Atlas Texture Cache (module-level) ─────────────────────────────

const atlasCache = new Map<string, HTMLImageElement>()

export function getAtlasImage(atlas: string): HTMLImageElement | null {
  return atlasCache.get(atlas) ?? null
}

export function loadAtlasImage(atlas: string): Promise<HTMLImageElement> {
  const cached = atlasCache.get(atlas)
  if (cached) return Promise.resolve(cached)

  return new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      atlasCache.set(atlas, img)
      resolve(img)
    }
    img.onerror = () => reject(new Error(`Failed to load atlas: ${atlas}`))
    img.src = dataBase() + '/pack/atlas/' + atlas
  })
}

// ─── Store Shape ────────────────────────────────────────────────────

interface TesterStoreState {
  manifest: CompiledManifest | null
  selectedRoom: string
  selectedChar: string
  currentRoom: CompiledRoom | null
  charResources: CompiledResource[]
  zoom: number
  showGrid: boolean
  showWalkability: boolean
  loaded: boolean
  loading: boolean
  error: string | null

  // Actions
  fetchManifest: () => Promise<void>
  loadRoom: () => Promise<void>
  setSelectedRoom: (name: string) => void
  setSelectedChar: (name: string) => void
  setZoom: (zoom: number) => void
  toggleGrid: () => void
  toggleWalkability: () => void
  transitionToRoom: (roomName: string, doorId: string) => Promise<void>
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

  fetchManifest: async () => {
    set({ loading: true, error: null })
    try {
      const resp = await fetch(dataBase() + '/pack/manifest.json')
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const manifest: CompiledManifest = await resp.json()
      const firstRoom = manifest.rooms.length > 0 ? manifest.rooms[0].name : ''
      // Pick first character resource (resources with tag 'type:character')
      const charResources = manifest.resources.filter((r) =>
        r.tags.some((t) => t === 'type:character'),
      )
      const firstChar = charResources.length > 0 ? charResources[0].name : ''
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
      // Find room entry
      const roomEntry = manifest.rooms.find((r) => r.name === selectedRoom)
      if (!roomEntry) throw new Error(`Room "${selectedRoom}" not found in manifest`)

      // Fetch room JSON
      const roomResp = await fetch(dataBase() + '/pack/' + roomEntry.file)
      if (!roomResp.ok) throw new Error(`HTTP ${roomResp.status} loading room`)
      const room: CompiledRoom = await roomResp.json()

      // Load atlas images for this room
      const atlasPromises = room.atlases.map((a) => loadAtlasImage(a))
      await Promise.all(atlasPromises)

      // Load character resources
      const charResources: CompiledResource[] = []
      if (selectedChar) {
        // Find all resource entries for this character
        const charEntries = manifest.resources.filter(
          (r) => r.name === selectedChar,
        )
        for (const entry of charEntries) {
          const resp = await fetch(dataBase() + '/pack/' + entry.file)
          if (resp.ok) {
            const resource: CompiledResource = await resp.json()
            charResources.push(resource)
            // Load atlas images for character frames
            const charAtlases = new Set(resource.frames.map((f) => f.atlas))
            await Promise.all([...charAtlases].map((a) => loadAtlasImage(a)))
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
  setZoom: (zoom) => set({ zoom: Math.max(0.25, Math.min(4, zoom)) }),
  toggleGrid: () => set((s) => ({ showGrid: !s.showGrid })),
  toggleWalkability: () => set((s) => ({ showWalkability: !s.showWalkability })),

  transitionToRoom: async (roomName, _doorId) => {
    const { manifest } = get()
    if (!manifest) return

    set({ selectedRoom: roomName })
    // loadRoom will pick up the new selectedRoom
    await get().loadRoom()
  },
}))
