/**
 * FilterableList — searchable, scrollable item list with folder tree.
 *
 * Two display modes:
 *   - "tree"   — when the query is empty and items have `path` fields,
 *                shows a collapsible folder tree built from paths
 *   - "flat"   — when the user types a query, switches to filtered flat list
 *
 * Two data modes:
 *   - "local"  — filters a provided array client-side (AND-matched tokens)
 *   - "server" — sends queries to the Go search API with debounce
 *
 * Features:
 *   - Text search input
 *   - Optional area range slider (for tileset size filtering)
 *   - Capped rendering (MAX_VISIBLE items) with "showing N of M" notice
 *   - Semantic search results shown inline with distance badges
 *   - Keyboard navigation (arrow keys + Enter)
 *   - Folder tree with expand/collapse, built from item paths
 */

import { useState, useRef, useEffect, useCallback, useMemo } from 'preact/hooks'

// ─── Types ──────────────────────────────────────────────────────────

export interface FilterableItem {
  id: string
  label: string
  /** Extra text included in filter matching but not displayed */
  meta?: string
  /** Relative file path — used to build folder tree view */
  path?: string
  /** Numeric area for range filtering (e.g. cols * rows for tilesets) */
  area?: number
  /** Source of the item — only set in server-driven mode */
  source?: 'text' | 'semantic'
  /** Semantic distance — only set for semantic results */
  distance?: number | null
}

export interface FilterableListProps {
  /** Items to display (local mode). Ignored in server mode. */
  items?: FilterableItem[]
  /** Server search URL (enables server mode). e.g. "/api/search?kind=tileset" */
  serverUrl?: string
  /** Currently selected item ID */
  value?: string | null
  /** Called when the user selects an item */
  onSelect?: (id: string) => void
  /** Placeholder text for the search input */
  placeholder?: string
  /** Show the area range slider */
  showAreaFilter?: boolean
  /** Max visible items before capping */
  maxVisible?: number
  /** Additional CSS class */
  class?: string
}

const DEFAULT_MAX_VISIBLE = 50
const DEBOUNCE_MS = 250

// ─── Tree building ──────────────────────────────────────────────────

interface TreeFolder {
  name: string
  folders: Map<string, TreeFolder>
  items: FilterableItem[]
}

function buildTree(items: FilterableItem[]): TreeFolder {
  const root: TreeFolder = { name: '', folders: new Map(), items: [] }

  for (const item of items) {
    const path = item.path
    if (!path) {
      root.items.push(item)
      continue
    }

    // Split path into directory segments + filename
    const parts = path.split('/')
    parts.pop() // remove filename — item.label is used for display

    let node = root
    for (const seg of parts) {
      let child = node.folders.get(seg)
      if (!child) {
        child = { name: seg, folders: new Map(), items: [] }
        node.folders.set(seg, child)
      }
      node = child
    }
    node.items.push(item)
  }

  return root
}

// ─── TreeView component ─────────────────────────────────────────────

interface TreeViewProps {
  folder: TreeFolder
  depth: number
  expanded: Set<string>
  onToggle: (path: string) => void
  value: string | null
  onSelect: (id: string) => void
  pathPrefix: string
  /** Apply area filter */
  areaMin: number
  showAreaFilter: boolean
}

function TreeView({
  folder,
  depth,
  expanded,
  onToggle,
  value,
  onSelect,
  pathPrefix,
  areaMin,
  showAreaFilter,
}: TreeViewProps) {
  // Sort folders alphabetically
  const sortedFolders = useMemo(
    () => [...folder.folders.entries()].sort((a, b) => a[0].localeCompare(b[0])),
    [folder.folders],
  )

  // Filter items by area
  const visibleItems = useMemo(() => {
    if (!showAreaFilter || areaMin <= 1) return folder.items
    return folder.items.filter((item) => {
      const area = item.area ?? 0
      if (area <= 0) return true
      return area >= areaMin
    })
  }, [folder.items, showAreaFilter, areaMin])

  // Sort items alphabetically
  const sortedItems = useMemo(
    () => [...visibleItems].sort((a, b) => a.label.localeCompare(b.label)),
    [visibleItems],
  )

  // Count total descendants (for folder badge)
  const countDescendants = useCallback(
    (f: TreeFolder): number => {
      let count = showAreaFilter && areaMin > 1
        ? f.items.filter((item) => {
            const area = item.area ?? 0
            return area <= 0 || area >= areaMin
          }).length
        : f.items.length
      for (const child of f.folders.values()) {
        count += countDescendants(child)
      }
      return count
    },
    [showAreaFilter, areaMin],
  )

  return (
    <>
      {sortedFolders.map(([name, child]) => {
        const fullPath = pathPrefix ? `${pathPrefix}/${name}` : name
        const isOpen = expanded.has(fullPath)
        const childCount = countDescendants(child)

        if (childCount === 0) return null

        return (
          <div key={fullPath}>
            <div
              class="flt-tree-folder"
              style={{ paddingLeft: `${depth * 14 + 4}px` }}
              onClick={() => onToggle(fullPath)}
            >
              <span class={`flt-tree-arrow${isOpen ? ' open' : ''}`}>&#9654;</span>
              <span class="flt-tree-folder-name">{name}</span>
              <span class="flt-tree-count">{childCount}</span>
            </div>
            {isOpen && (
              <TreeView
                folder={child}
                depth={depth + 1}
                expanded={expanded}
                onToggle={onToggle}
                value={value}
                onSelect={onSelect}
                pathPrefix={fullPath}
                areaMin={areaMin}
                showAreaFilter={showAreaFilter}
              />
            )}
          </div>
        )
      })}

      {sortedItems.map((item) => (
        <div
          key={item.id}
          class={`flt-tree-file${item.id === value ? ' selected' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
          onClick={() => onSelect(item.id)}
        >
          <span class="flt-tree-file-label">{item.label}</span>
        </div>
      ))}
    </>
  )
}

// ─── Main component ─────────────────────────────────────────────────

export function FilterableList(props: FilterableListProps) {
  const {
    items: localItems = [],
    serverUrl,
    value = null,
    onSelect,
    placeholder = 'Filter...',
    showAreaFilter = false,
    maxVisible = DEFAULT_MAX_VISIBLE,
  } = props

  const isServer = !!serverUrl

  const [query, setQuery] = useState('')
  const [areaMin, setAreaMin] = useState(1)
  const [serverItems, setServerItems] = useState<FilterableItem[]>([])
  const [serverTotal, setServerTotal] = useState(0)
  const [focusIdx, setFocusIdx] = useState(-1)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Determine whether to show tree or flat list
  const hasQuery = query.trim().length > 0
  const hasPaths = useMemo(
    () => !isServer && localItems.some((item) => !!item.path),
    [isServer, localItems],
  )
  const showTree = !hasQuery && hasPaths

  // ─── Tree data ──────────────────────────────────────────────

  const tree = useMemo(() => {
    if (!showTree) return null
    return buildTree(localItems)
  }, [showTree, localItems])

  // Auto-expand to the selected item on first render / selection change
  useEffect(() => {
    if (!showTree || !value) return
    const item = localItems.find((i) => i.id === value)
    if (!item?.path) return

    const parts = item.path.split('/')
    parts.pop() // remove filename
    const paths: string[] = []
    for (let i = 0; i < parts.length; i++) {
      paths.push(parts.slice(0, i + 1).join('/'))
    }

    setExpanded((prev) => {
      const next = new Set(prev)
      let changed = false
      for (const p of paths) {
        if (!next.has(p)) {
          next.add(p)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [showTree, value, localItems])

  const handleToggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) {
        next.delete(path)
      } else {
        next.add(path)
      }
      return next
    })
  }, [])

  // ─── Local filtering ──────────────────────────────────────────

  const filtered = useMemo(() => {
    if (isServer) return serverItems
    if (showTree) return [] // tree mode handles its own rendering

    let result = localItems
    const raw = query.toLowerCase().trim()

    if (raw) {
      const tokens = raw.split(/\s+/)
      result = result.filter((item) => {
        const haystack =
          item.id.toLowerCase() +
          ' ' +
          item.label.toLowerCase() +
          (item.path ? ' ' + item.path.toLowerCase() : '') +
          (item.meta ? ' ' + item.meta.toLowerCase() : '')
        return tokens.every((t) => haystack.includes(t))
      })
    }

    if (showAreaFilter && areaMin > 1) {
      result = result.filter((item) => {
        const area = item.area ?? 0
        if (area <= 0) return true
        return area >= areaMin
      })
    }

    return result
  }, [isServer, localItems, serverItems, query, areaMin, showAreaFilter, showTree])

  const totalCount = isServer ? serverTotal : filtered.length
  const displayItems = filtered.length > maxVisible ? filtered.slice(0, maxVisible) : filtered

  // ─── Server fetch ─────────────────────────────────────────────

  const serverFetch = useCallback(
    async (q: string, area: number) => {
      if (!serverUrl) return

      abortRef.current?.abort()
      const controller = new AbortController()
      abortRef.current = controller

      const params = new URLSearchParams()
      if (q) params.set('q', q)
      if (showAreaFilter && area > 1) params.set('minArea', String(area))
      params.set('limit', String(maxVisible))

      const sep = serverUrl.includes('?') ? '&' : '?'
      const url = `${serverUrl}${sep}${params}`

      try {
        const res = await fetch(url, { signal: controller.signal })
        if (!res.ok) return

        const data = await res.json()
        const results: FilterableItem[] = (data.results ?? []).map(
          (r: any) => ({
            id: r.contentHash ?? r.ID ?? r.id,
            label: r.label ?? r.Label ?? '',
            meta: r.relPath ?? '',
            area: r.area,
            source: r.source,
            distance: r.distance ?? null,
          }),
        )

        setServerItems(results)
        setServerTotal(data.totalTextMatches ?? results.length)
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') return
        console.error('FilterableList server fetch error:', err)
      }
    },
    [serverUrl, showAreaFilter, maxVisible],
  )

  // Debounced trigger
  const debouncedFetch = useCallback(
    (q: string, area: number) => {
      if (debounceRef.current) clearTimeout(debounceRef.current)
      debounceRef.current = setTimeout(() => serverFetch(q, area), DEBOUNCE_MS)
    },
    [serverFetch],
  )

  // Initial server fetch
  useEffect(() => {
    if (isServer) serverFetch('', areaMin)
  }, [isServer, serverFetch])

  // ─── Input handlers ───────────────────────────────────────────

  const handleInput = useCallback(
    (e: Event) => {
      const val = (e.target as HTMLInputElement).value
      setQuery(val)
      setFocusIdx(-1)
      if (isServer) debouncedFetch(val, areaMin)
    },
    [isServer, debouncedFetch, areaMin],
  )

  const handleAreaChange = useCallback(
    (e: Event) => {
      const val = parseInt((e.target as HTMLInputElement).value, 10)
      setAreaMin(val)
      if (isServer) debouncedFetch(query, val)
    },
    [isServer, debouncedFetch, query],
  )

  // ─── Keyboard navigation ──────────────────────────────────────

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (showTree) return // keyboard nav only for flat mode
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setFocusIdx((i) => Math.min(i + 1, displayItems.length - 1))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setFocusIdx((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter' && focusIdx >= 0 && focusIdx < displayItems.length) {
        e.preventDefault()
        onSelect?.(displayItems[focusIdx].id)
      }
    },
    [showTree, displayItems, focusIdx, onSelect],
  )

  // Scroll focused item into view
  useEffect(() => {
    if (focusIdx < 0) return
    const el = listRef.current?.children[focusIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [focusIdx])

  const handleSelect = useCallback(
    (id: string) => {
      onSelect?.(id)
    },
    [onSelect],
  )

  // ─── Render ───────────────────────────────────────────────────

  return (
    <div class={`filterable-list ${props.class ?? ''}`} onKeyDown={handleKeyDown as any}>
      <input
        type="text"
        class="filterable-list-input"
        placeholder={placeholder}
        value={query}
        onInput={handleInput}
      />

      {showAreaFilter && (
        <div class="filterable-list-area-row">
          <span class="filterable-list-area-label">Min area:</span>
          <input
            type="range"
            class="filterable-list-area-slider"
            min={1}
            max={1000}
            value={areaMin}
            onInput={handleAreaChange}
          />
          <span class="filterable-list-area-value">&ge; {areaMin}</span>
        </div>
      )}

      <div class="filterable-list-items" ref={listRef}>
        {showTree && tree ? (
          <TreeView
            folder={tree}
            depth={0}
            expanded={expanded}
            onToggle={handleToggle}
            value={value}
            onSelect={handleSelect}
            pathPrefix=""
            areaMin={areaMin}
            showAreaFilter={showAreaFilter}
          />
        ) : (
          <>
            {displayItems.map((item, i) => (
              <div
                key={item.id}
                class={`filterable-list-item${item.id === value ? ' selected' : ''}${i === focusIdx ? ' focused' : ''}`}
                onClick={() => onSelect?.(item.id)}
              >
                <span class="filterable-list-item-label">{item.label}</span>
                {item.source === 'semantic' && item.distance != null && (
                  <span class="semantic-distance">{item.distance.toFixed(3)}</span>
                )}
              </div>
            ))}

            {totalCount > maxVisible && (
              <div class="filterable-list-cap-notice">
                Showing {maxVisible} of {totalCount} matches
              </div>
            )}

            {displayItems.length === 0 && (
              <div class="filterable-list-empty">No matches</div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
