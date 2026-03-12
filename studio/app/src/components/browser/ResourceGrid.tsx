/**
 * ResourceGrid — toolbar (search + count + pagination) plus a paginated
 * card grid using the shared ResourceCard component.
 */

import type { Resource } from '@offisims/pack'
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
  } = props

  return (
    <div class="browser-grid-container">
      <Toolbar
        totalCount={totalCount}
        currentPage={currentPage}
        totalPages={totalPages}
        searchText={searchText}
        onSearchChange={onSearchChange}
        onPageChange={onPageChange}
      />
      <Grid items={items} hasFilters={hasFilters} />
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
    <div class="browser-toolbar">
      <input
        type="text"
        class="browser-search-input"
        placeholder="Search by name..."
        value={searchText}
        onInput={(e) => onSearchChange((e.target as HTMLInputElement).value)}
      />
      <span class="browser-result-count">
        {totalCount} resource{totalCount !== 1 ? 's' : ''}
      </span>
      {totalPages > 1 && (
        <div class="browser-pagination">
          <button
            class="btn browser-page-btn"
            disabled={currentPage === 0}
            onClick={() => onPageChange(currentPage - 1)}
          >
            &lsaquo;
          </button>
          <span class="browser-page-label">
            {currentPage + 1} / {totalPages}
          </span>
          <button
            class="btn browser-page-btn"
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
}

function Grid({ items, hasFilters }: GridProps) {
  if (items.length === 0) {
    return (
      <div class="browser-grid-empty">
        {hasFilters
          ? 'No resources match the current filters.'
          : 'No resources available.'}
      </div>
    )
  }

  return (
    <div class="browser-grid">
      {items.map((resource) => (
        <ResourceCard
          key={resource.id}
          resource={resource}
          class="browser-grid-card"
        />
      ))}
    </div>
  )
}
