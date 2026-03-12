import { create } from 'zustand'
import { persist } from 'zustand/middleware'

// ─── Tab IDs ────────────────────────────────────────────────────────

export type TabId = 'cutter' | 'browser' | 'composite' | 'room' | 'tester'

export const TAB_LIST: { id: TabId; label: string }[] = [
  { id: 'cutter', label: 'Tile Cutter' },
  { id: 'browser', label: 'Browser' },
  { id: 'composite', label: 'Composite' },
  { id: 'room', label: 'Room' },
  { id: 'tester', label: 'Tester' },
]

// ─── Per-tab selection state ────────────────────────────────────────

interface CutterState {
  selectedTileset: string | null
}

interface BrowserState {
  filters: string[]
}

interface CompositeState {
  selectedComposite: string | null
}

interface RoomState {
  selectedRoom: string | null
  mode: 'layout' | 'texture'
}

interface TesterState {
  selectedRoom: string | null
}

// ─── Store shape ────────────────────────────────────────────────────

interface UIState {
  // Global
  activeTab: TabId
  setActiveTab: (tab: TabId) => void
  statusText: string
  setStatusText: (text: string) => void

  // Panel widths (persisted)
  panelWidths: Record<string, number>
  setPanelWidth: (id: string, width: number) => void

  // Per-tab selections (extended in later phases)
  cutter: CutterState
  browser: BrowserState
  composite: CompositeState
  room: RoomState
  tester: TesterState

  // Per-tab setters
  setCutter: (patch: Partial<CutterState>) => void
  setBrowser: (patch: Partial<BrowserState>) => void
  setComposite: (patch: Partial<CompositeState>) => void
  setRoom: (patch: Partial<RoomState>) => void
  setTester: (patch: Partial<TesterState>) => void
}

// ─── Defaults ───────────────────────────────────────────────────────

const DEFAULT_CUTTER: CutterState = { selectedTileset: null }
const DEFAULT_BROWSER: BrowserState = { filters: [] }
const DEFAULT_COMPOSITE: CompositeState = { selectedComposite: null }
const DEFAULT_ROOM: RoomState = { selectedRoom: null, mode: 'layout' }
const DEFAULT_TESTER: TesterState = { selectedRoom: null }

// ─── Store ──────────────────────────────────────────────────────────

export const useUIStore = create<UIState>()(
  persist(
    (set) => ({
      // Global
      activeTab: 'cutter',
      setActiveTab: (tab) => set({ activeTab: tab }),
      statusText: '',
      setStatusText: (text) => set({ statusText: text }),

      // Panel widths
      panelWidths: {},
      setPanelWidth: (id, width) =>
        set((s) => ({ panelWidths: { ...s.panelWidths, [id]: width } })),

      // Per-tab
      cutter: DEFAULT_CUTTER,
      browser: DEFAULT_BROWSER,
      composite: DEFAULT_COMPOSITE,
      room: DEFAULT_ROOM,
      tester: DEFAULT_TESTER,

      setCutter: (patch) =>
        set((s) => ({ cutter: { ...s.cutter, ...patch } })),
      setBrowser: (patch) =>
        set((s) => ({ browser: { ...s.browser, ...patch } })),
      setComposite: (patch) =>
        set((s) => ({ composite: { ...s.composite, ...patch } })),
      setRoom: (patch) =>
        set((s) => ({ room: { ...s.room, ...patch } })),
      setTester: (patch) =>
        set((s) => ({ tester: { ...s.tester, ...patch } })),
    }),
    {
      name: 'offisims-studio-ui',
      // Only persist panel widths and active tab — per-tab selections reset on reload
      partialize: (s) => ({
        activeTab: s.activeTab,
        panelWidths: s.panelWidths,
      }),
    },
  ),
)
