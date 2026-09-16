/**
 * ResourceGrid — toolbar (search + count + pagination) plus a paginated
 * card grid using the shared ResourceCard component.
 */

import type { Resource } from '@openlore/pack'
import { ResourceCard } from '../ResourceCard'

interface ResourceGridProps {
  items: Resource[]
  totalCount: number
  currentPage: number
  totalPages: number
  searchText: string
  onSearchChange: (text: string) => void
  onPageChange: (page: number) => void
  hasFilters: boolean
  selectedId?: string | null
  onSelect?: (resource: Resource) => void
}

export function ResourceGrid(props: ResourceGridProps) {
  const {
    items,
    totalCount,
    currentPage,
    totalPages,
    searchText,
    onSearchChange,
    onPageChange,
    hasFilters,
    selectedId,
    onSelect,
  } = props

  return (
    <div class="resources-grid-container">
      <Toolbar
        totalCount={totalCount}
        currentPage={currentPage}
        totalPages={totalPages}
        searchText={searchText}
        onSearchChange={onSearchChange}
        onPageChange={onPageChange}
      />
      <Grid items={items} hasFilters={hasFilters} selectedId={selectedId} onSelect={onSelect} />
    </div>
  )
}

// ─── Toolbar ────────────────────────────────────────────────────────

interface ToolbarProps {
  totalCount: number
  currentPage: number
  totalPages: number
  searchText: string
  onSearchChange: (text: string) => void
  onPageChange: (page: number) => void
}

function Toolbar(props: ToolbarProps) {
  const {
    totalCount,
    currentPage,
    totalPages,
    searchText,
    onSearchChange,
    onPageChange,
  } = props

  return (
    <div class="resources-toolbar">
      <input
        type="text"
        class="resources-search-input"
        placeholder="Search by name..."
        value={searchText}
        onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
      />
      <span class="resources-result-count">
        {totalCount} resource{totalCount !== 1 ? 's' : ''}
      </span>
      {totalPages > 1 && (
        <div class="resources-pagination">
          <button
            class="btn resources-page-btn"
            disabled={currentPage === 0}
            onClick={() => onPageChange(currentPage - 1)}
          >
            &lsaquo;
          </button>
          <span class="resources-page-label">
            {currentPage + 1} / {totalPages}
          </span>
          <button
            class="btn resources-page-btn"
            disabled={currentPage >= totalPages - 1}
            onClick={() => onPageChange(currentPage + 1)}
          >
            &rsaquo;
          </button>
        </div>
      )}
    </div>
  )
}

// ─── Card Grid ──────────────────────────────────────────────────────

interface GridProps {
  items: Resource[]
  hasFilters: boolean
  selectedId?: string | null
  onSelect?: (resource: Resource) => void
}

function Grid({ items, hasFilters, selectedId, onSelect }: GridProps) {
  if (items.length === 0) {
    return (
      <div class="resources-grid-empty">
        {hasFilters
          ? 'No resources match the current filters.'
          : 'No resources available.'}
      </div>
    )
  }

  return (
    <div class="resources-grid">
      {items.map((resource) => (
        <ResourceCard
          key={resource.id}
          resource={resource}
          selected={resource.id === selectedId}
          onClick={onSelect ? () => onSelect(resource) : undefined}
          class="resources-grid-card"
        />
      ))}
    </div>
  )
}
