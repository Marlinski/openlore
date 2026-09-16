/**
 * ResourcesTab — faceted tag browser over the resource pool.
 *
 * Layout: FacetPanel (left sidebar) + ResourcesMain (toolbar + paginated grid) + ResourceDetail (right panel).
 * All filtering/pagination state is local — no Zustand needed since this
 * tab's state doesn't persist across reloads.
 */

import { useState, useMemo, useCallback } from 'preact/hooks'
import type { Resource } from '@openlore/pack'
import { useResources } from '../../api/resources'
import { FacetPanel } from './FacetPanel'
import { ResourceGrid } from './ResourceGrid'
import { ResourceDetail } from './ResourceDetail'
import { ResizablePanel } from '../ResizablePanel'

const PAGE_SIZE = 24

/** Known tag namespace prefixes, in display order */
const TAG_ORDER = ['entity', 'name', 'state', 'dir', 'variant']

/** Parse "ns:value" into { ns, value } */
function parseTag(raw: string): { ns: string; value: string } {
  const idx = raw.indexOf(':')
  if (idx > 0) return { ns: raw.slice(0, idx), value: raw.slice(idx + 1) }
  return { ns: '', value: raw }
}

export interface FacetMap {
  /** namespace -> Map<value, count> */
  [ns: string]: Map<string, number>
}

/** Build faceted counts from a resource list */
function buildFacets(resources: Resource[]): FacetMap {
  const facets: FacetMap = {}
  for (const r of resources) {
    for (const tag of r.tags) {
      const { ns, value } = parseTag(tag)
      if (!facets[ns]) facets[ns] = new Map()
      facets[ns].set(value, (facets[ns].get(value) || 0) + 1)
    }
  }
  return facets
}

/** Sort namespace keys by TAG_ORDER, then alphabetically for unknowns */
export function sortNamespaces(keys: string[]): string[] {
  return [...keys].sort((a, b) => {
    const ai = TAG_ORDER.indexOf(a)
    const bi = TAG_ORDER.indexOf(b)
    if (ai >= 0 && bi >= 0) return ai - bi
    if (ai >= 0) return -1
    if (bi >= 0) return 1
    return a.localeCompare(b)
  })
}

export function ResourcesTab() {
  const { data: resources = [], isLoading } = useResources()

  // Active filters: namespace -> value (single-select per namespace)
  const [filters, setFilters] = useState<Map<string, string>>(new Map())
  const [searchText, setSearchText] = useState('')
  const [currentPage, setCurrentPage] = useState(0)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Filter resources
  const filtered = useMemo(() => {
    const search = searchText.trim().toLowerCase()
    return resources.filter((r) => {
      for (const [ns, value] of filters) {
        const tag = ns ? `${ns}:${value}` : value
        if (!r.tags.includes(tag)) return false
      }
      if (search && !r.name.toLowerCase().includes(search)) return false
      return true
    })
  }, [resources, filters, searchText])

  // Build facets from filtered resources (post-filter)
  const facets = useMemo(() => buildFacets(filtered), [filtered])

  // Look up selected resource from the full list (not just current page)
  const selectedResource = useMemo(() => {
    if (!selectedId) return null
    return resources.find((r) => r.id === selectedId) ?? null
  }, [selectedId, resources])

  // Clear selection if the resource was deleted
  useMemo(() => {
    if (selectedId && !selectedResource) setSelectedId(null)
  }, [selectedId, selectedResource])

  // Pagination
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE))
  const clampedPage = Math.min(currentPage, totalPages - 1)
  const pageItems = filtered.slice(
    clampedPage * PAGE_SIZE,
    clampedPage * PAGE_SIZE + PAGE_SIZE,
  )

  const addFilter = useCallback(
    (ns: string, value: string) => {
      setFilters((prev) => {
        const next = new Map(prev)
        next.set(ns, value)
        return next
      })
      setCurrentPage(0)
    },
    [],
  )

  const removeFilter = useCallback(
    (ns: string) => {
      setFilters((prev) => {
        const next = new Map(prev)
        next.delete(ns)
        return next
      })
      setCurrentPage(0)
    },
    [],
  )

  const clearFilters = useCallback(() => {
    setFilters(new Map())
    setCurrentPage(0)
  }, [])

  const onSearchChange = useCallback(
    (text: string) => {
      setSearchText(text)
      setCurrentPage(0)
    },
    [],
  )

  const handleSelect = useCallback((resource: Resource) => {
    setSelectedId((prev) => (prev === resource.id ? null : resource.id))
  }, [])

  const handleCloseDetail = useCallback(() => {
    setSelectedId(null)
  }, [])

  if (isLoading) {
    return (
      <div class="resources-tab resources-tab--loading">
        <div class="resources-loading">Loading resources...</div>
      </div>
    )
  }

  return (
    <div class="resources-tab">
      <ResizablePanel side="right" defaultWidth={200} minWidth={160} maxWidth={360}>
        <FacetPanel
          facets={facets}
          filters={filters}
          onAddFilter={addFilter}
          onRemoveFilter={removeFilter}
          onClearFilters={clearFilters}
        />
      </ResizablePanel>
      <div class="resources-main">
        <ResourceGrid
          items={pageItems}
          totalCount={filtered.length}
          currentPage={clampedPage}
          totalPages={totalPages}
          searchText={searchText}
          onSearchChange={onSearchChange}
          onPageChange={setCurrentPage}
          hasFilters={filters.size > 0}
          selectedId={selectedId}
          onSelect={handleSelect}
        />
      </div>
      {selectedResource && (
        <ResizablePanel side="left" defaultWidth={280} minWidth={220} maxWidth={420}>
          <ResourceDetail
            resource={selectedResource}
            onClose={handleCloseDetail}
          />
        </ResizablePanel>
      )}
    </div>
  )
}
