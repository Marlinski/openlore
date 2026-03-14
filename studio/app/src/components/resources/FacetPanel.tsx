/**
 * FacetPanel — left sidebar showing active filter pills and tag facet groups.
 *
 * Each namespace becomes a collapsible section with value+count rows.
 * Clicking a value adds it as a filter (single-select per namespace).
 * Active filters are shown as removable pills at the top.
 */

import { sortNamespaces } from './ResourcesTab'
import type { FacetMap } from './ResourcesTab'

interface FacetPanelProps {
  facets: FacetMap
  filters: Map<string, string>
  onAddFilter: (ns: string, value: string) => void
  onRemoveFilter: (ns: string) => void
  onClearFilters: () => void
}

export function FacetPanel(props: FacetPanelProps) {
  const { facets, filters, onAddFilter, onRemoveFilter, onClearFilters } = props

  return (
    <aside class="resources-facet-panel">
      <ActiveFilters
        filters={filters}
        onRemove={onRemoveFilter}
        onClear={onClearFilters}
      />
      <div class="resources-facet-groups">
        <FacetGroups
          facets={facets}
          filters={filters}
          onAddFilter={onAddFilter}
        />
      </div>
    </aside>
  )
}

// ─── Active Filters ─────────────────────────────────────────────────

interface ActiveFiltersProps {
  filters: Map<string, string>
  onRemove: (ns: string) => void
  onClear: () => void
}

function ActiveFilters({ filters, onRemove, onClear }: ActiveFiltersProps) {
  if (filters.size === 0) return null

  return (
    <div class="resources-active-filters">
      <div class="resources-active-filters-header">
        <span class="resources-active-filters-label">Active Filters</span>
        <button class="resources-clear-btn" onClick={onClear}>
          Clear all
        </button>
      </div>
      <div class="resources-filter-pills">
        {[...filters].map(([ns, value]) => (
          <span key={ns} class="resources-filter-pill">
            <span class="resources-pill-text">
              {ns ? `${ns}:${value}` : value}
            </span>
            <span
              class="resources-pill-remove"
              onClick={() => onRemove(ns)}
            >
              &times;
            </span>
          </span>
        ))}
      </div>
    </div>
  )
}

// ─── Facet Groups ───────────────────────────────────────────────────

interface FacetGroupsProps {
  facets: FacetMap
  filters: Map<string, string>
  onAddFilter: (ns: string, value: string) => void
}

function FacetGroups({ facets, filters, onAddFilter }: FacetGroupsProps) {
  const nsKeys = sortNamespaces(Object.keys(facets))

  if (nsKeys.length === 0) {
    return (
      <div class="resources-facets-empty">No tags to filter by.</div>
    )
  }

  return (
    <>
      {nsKeys.map((ns) => {
        // Skip namespaces that already have an active filter
        if (filters.has(ns)) return null

        const values = facets[ns]
        const sorted = [...values.entries()].sort((a, b) =>
          a[0].localeCompare(b[0]),
        )

        return (
          <div key={ns} class="resources-facet-group">
            <div class="resources-facet-group-header">
              {ns || '(unnamespaced)'}
            </div>
            {sorted.map(([value, count]) => (
              <button
                key={value}
                class="resources-facet-item"
                onClick={() => onAddFilter(ns, value)}
              >
                <span class="resources-facet-value">{value}</span>
                <span class="resources-facet-count">{count}</span>
              </button>
            ))}
          </div>
        )
      })}
    </>
  )
}
