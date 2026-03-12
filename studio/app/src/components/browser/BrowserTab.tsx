/**
 * BrowserTab — faceted tag browser over the resource pool.
 *
 * Layout: FacetPanel (left sidebar) + BrowserMain (toolbar + paginated grid).
 * All filtering/pagination state is local — no Zustand needed since this
 * tab's state doesn't persist across reloads.
 */

import { useState, useMemo, useCallback } from 'preact/hooks'
import type { Resource } from '@offisims/pack'
import { useResources } from '../../api/resources'
import { FacetPanel } from './FacetPanel'
import { ResourceGrid } from './ResourceGrid'

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

export function BrowserTab() {
  const { data: resources = [], isLoading } = useResources()

  // Active filters: namespace -> value (single-select per namespace)
  const [filters, setFilters] = useState<Map<string, string>>(new Map())
  const [searchText, setSearchText] = useState('')
  const [currentPage, setCurrentPage] = useState(0)

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

  if (isLoading) {
    return (
      <div class="browser-tab browser-tab--loading">
        <div class="browser-loading">Loading resources...</div>
      </div>
    )
  }

  return (
    <div class="browser-tab">
      <FacetPanel
        facets={facets}
        filters={filters}
        onAddFilter={addFilter}
        onRemoveFilter={removeFilter}
        onClearFilters={clearFilters}
      />
      <div class="browser-main">
        <ResourceGrid
          items={pageItems}
          totalCount={filtered.length}
          currentPage={clampedPage}
          totalPages={totalPages}
          searchText={searchText}
          onSearchChange={onSearchChange}
          onPageChange={setCurrentPage}
          hasFilters={filters.size > 0}
        />
      </div>
    </div>
  )
}
