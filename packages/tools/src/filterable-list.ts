/**
 * FilterableList — reusable scrollable list with text-filter input.
 *
 * Replaces native <select> elements for large item sets (1,500+ tilesets).
 * Renders a text input at the top for substring filtering, plus a
 * scrollable list of clickable items. Selected item is highlighted.
 *
 * Usage:
 *   const list = new FilterableList(containerDiv);
 *   list.setItems([{ id: "foo", label: "Foo Bar", meta: "extra search text" }]);
 *   list.onSelect((id) => console.log("selected", id));
 *   list.setValue("foo");
 *   list.getValue(); // "foo"
 */

export interface FilterableItem {
  id: string;
  label: string;
  /** Optional extra text included in filter matching but not displayed */
  meta?: string;
  /** Optional numeric area (e.g. cols*rows for tilesets) for range filtering */
  area?: number;
  /** Source of the item — only set in server-driven mode */
  source?: "text" | "semantic";
  /** Semantic distance — only set for semantic results in server-driven mode */
  distance?: number | null;
}

export interface TilesetSearchResult {
  contentHash: string;
  label: string;
  relPath: string;
  tileWidth: number;
  tileHeight: number;
  cols: number;
  rows: number;
  area: number;
  width: number;
  height: number;
  source: "text" | "semantic";
  distance: number | null;
}

export type OnSelectCallback = (id: string) => void;

export type SemanticSearchFn = (query: string) => Promise<{ id: string; label: string; distance: number }[]>;

const MAX_VISIBLE_ITEMS = 50;

export class FilterableList {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private listEl: HTMLDivElement;
  private semanticHeader: HTMLDivElement;
  private semanticEl: HTMLDivElement;

  private items: FilterableItem[] = [];
  private filteredItems: FilterableItem[] = [];
  private selectedId: string | null = null;
  private callbacks: OnSelectCallback[] = [];
  private semanticFn: SemanticSearchFn | null = null;
  private semanticDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private areaSliderRow: HTMLDivElement;
  private areaMinInput: HTMLInputElement;
  private areaLabel: HTMLSpanElement;
  private areaFilterEnabled = false;
  private areaMin = 1;
  private totalMatchCount = 0;

  private serverMode = false;
  private serverUrl: string | null = null;
  private serverDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private serverFetchController: AbortController | null = null;

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add("filterable-list");

    // Search input
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Filter...";
    this.input.className = "filterable-list-input";
    this.container.appendChild(this.input);

    // Area range slider row (hidden until enableAreaFilter is called)
    this.areaSliderRow = document.createElement("div");
    this.areaSliderRow.className = "filterable-list-area-row";
    this.areaSliderRow.style.display = "none";

    const areaLabelEl = document.createElement("span");
    areaLabelEl.className = "filterable-list-area-label";
    areaLabelEl.textContent = "Min area:";
    this.areaSliderRow.appendChild(areaLabelEl);

    this.areaMinInput = document.createElement("input");
    this.areaMinInput.type = "range";
    this.areaMinInput.className = "filterable-list-area-slider";
    this.areaMinInput.min = "1";
    this.areaMinInput.max = "1000";
    this.areaMinInput.value = "1";
    this.areaSliderRow.appendChild(this.areaMinInput);

    this.areaLabel = document.createElement("span");
    this.areaLabel.className = "filterable-list-area-value";
    this.areaLabel.textContent = "≥ 1";
    this.areaSliderRow.appendChild(this.areaLabel);

    this.areaMinInput.addEventListener("input", () => {
      this.areaMin = parseInt(this.areaMinInput.value, 10);
      this.areaLabel.textContent = `≥ ${this.areaMin}`;
      if (this.serverMode) {
        this.debouncedServerFetch();
      } else {
        this.applyFilter();
      }
    });

    this.container.appendChild(this.areaSliderRow);

    // Scrollable list
    this.listEl = document.createElement("div");
    this.listEl.className = "filterable-list-items";
    this.container.appendChild(this.listEl);

    // Semantic search results section
    this.semanticHeader = document.createElement("div");
    this.semanticHeader.className = "filterable-list-semantic-header";
    this.semanticHeader.textContent = "Semantic matches";
    this.semanticHeader.style.display = "none";
    this.container.appendChild(this.semanticHeader);

    this.semanticEl = document.createElement("div");
    this.semanticEl.className = "filterable-list-semantic-items";
    this.semanticEl.style.display = "none";
    this.container.appendChild(this.semanticEl);

    // Events
    this.input.addEventListener("input", () => {
      if (this.serverMode) {
        this.debouncedServerFetch();
      } else {
        this.applyFilter();
      }
    });
  }

  /** Replace the entire item set. Preserves selection if still present. */
  setItems(items: FilterableItem[]): void {
    this.items = items;
    // Keep current selection if still valid
    if (this.selectedId && !items.some((i) => i.id === this.selectedId)) {
      this.selectedId = null;
    }
    this.applyFilter();
    if (this.areaFilterEnabled) {
      this.recalcAreaRange();
    }
  }

  /** Get the currently selected item id, or null */
  getValue(): string | null {
    return this.selectedId;
  }

  /** Programmatically select an item by id. Scrolls it into view. */
  setValue(id: string): void {
    if (this.selectedId === id) return;
    this.selectedId = id;
    this.renderList();
    this.scrollToSelected();
  }

  /** Register a callback for when the user selects an item. */
  onSelect(cb: OnSelectCallback): void {
    this.callbacks.push(cb);
  }

  /** Set a default selection: use defaultId if current selection is null/invalid. */
  setDefault(defaultId: string): void {
    const ids = new Set(this.items.map((i) => i.id));
    if (this.selectedId && ids.has(this.selectedId)) return; // current selection is valid
    if (ids.has(defaultId)) {
      this.selectedId = defaultId;
    } else if (this.items.length > 0) {
      this.selectedId = this.items[0].id;
    }
    this.renderList();
    this.scrollToSelected();
  }

  /** Clear filter text and reset view */
  clearFilter(): void {
    this.input.value = "";
    this.applyFilter();
  }

  /** Register a semantic search provider for fuzzy/vector matching. */
  setSemanticSearch(fn: SemanticSearchFn): void {
    this.semanticFn = fn;
  }

  /** Enable the area range slider. Call after setItems to compute the range from actual data. */
  enableAreaFilter(): void {
    this.areaFilterEnabled = true;
    if (!this.serverMode) {
      this.recalcAreaRange();
    }
    this.areaSliderRow.style.display = "";
  }

  /**
   * Enable server-driven mode. Text input and area slider changes trigger
   * debounced fetches to the given URL instead of filtering a local array.
   * The server merges text + semantic results so the separate semantic section
   * is hidden.
   */
  enableServerMode(url: string): void {
    this.serverMode = true;
    this.serverUrl = url;

    // Hide the separate semantic results section permanently
    this.semanticHeader.style.display = "none";
    this.semanticEl.style.display = "none";
    this.semanticEl.innerHTML = "";

    // Trigger an initial fetch (no query) to populate the list on startup
    this.serverFetch();
  }

  /**
   * Update area slider bounds without triggering a fetch loop.
   * Used by serverFetch() to sync slider with server-reported range.
   */
  updateAreaBounds(_min: number, _max: number): void {
    // Slider is always 1-1000, no dynamic bounds needed
  }

  // ─── Internal ─────────────────────────────────────────────────

  private recalcAreaRange(): void {
    // Fixed range 1-1000, no dynamic calculation needed
    this.areaMin = 1;
    this.areaMinInput.min = "1";
    this.areaMinInput.max = "1000";
    this.areaMinInput.value = "1";
    this.areaLabel.textContent = "≥ 1";
  }

  private debouncedServerFetch(): void {
    if (this.serverDebounceTimer) clearTimeout(this.serverDebounceTimer);
    this.serverDebounceTimer = setTimeout(() => this.serverFetch(), 250);
  }

  private async serverFetch(): Promise<void> {
    if (!this.serverUrl) return;

    // Cancel any in-flight request
    if (this.serverFetchController) {
      this.serverFetchController.abort();
    }
    this.serverFetchController = new AbortController();

    // Build URL with query params
    const params = new URLSearchParams();
    const query = this.input.value.trim();
    if (query) {
      params.set("q", query);
    }
    if (this.areaFilterEnabled) {
      if (this.areaMin > 1) params.set("minArea", String(this.areaMin));
    }
    params.set("limit", String(MAX_VISIBLE_ITEMS));
    const separator = this.serverUrl.includes("?") ? "&" : "?";
    const url = `${this.serverUrl}${separator}${params.toString()}`;

    try {
      const resp = await fetch(url, { signal: this.serverFetchController.signal });
      if (!resp.ok) {
        console.error(`Server fetch failed: ${resp.status} ${resp.statusText}`);
        return;
      }

      const data: {
        results: TilesetSearchResult[];
        totalTextMatches: number;
        areaRange: { min: number; max: number };
      } = await resp.json();

      // Update area slider bounds from server response
      if (this.areaFilterEnabled && data.areaRange) {
        this.updateAreaBounds(data.areaRange.min, data.areaRange.max);
      }

      // Convert results to FilterableItems
      this.filteredItems = data.results.map((r) => ({
        id: r.contentHash,
        label: r.label,
        meta: r.relPath,
        area: r.area,
        source: r.source,
        distance: r.distance,
      }));
      this.totalMatchCount = data.totalTextMatches;

      this.renderList();
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === "AbortError") {
        // Silently ignore aborted fetches
        return;
      }
      console.error("Server fetch error:", err);
    }
  }

  private applyFilter(): void {
    const raw = this.input.value.toLowerCase().trim();
    if (!raw) {
      this.filteredItems = this.items;
    } else {
      // Split on whitespace — every token must match somewhere (AND logic)
      const tokens = raw.split(/\s+/);
      this.filteredItems = this.items.filter((item) => {
        // Build a single searchable string from all fields
        const haystack =
          item.id.toLowerCase() +
          " " +
          item.label.toLowerCase() +
          (item.meta ? " " + item.meta.toLowerCase() : "");
        return tokens.every((t) => haystack.includes(t));
      });
    }

    // Area filter
    if (this.areaFilterEnabled) {
      this.filteredItems = this.filteredItems.filter((item) => {
        const area = item.area ?? 0;
        if (area <= 0) return true; // items without area always pass
        return area >= this.areaMin;
      });
    }

    // Track total match count before capping
    this.totalMatchCount = this.filteredItems.length;

    // Cap visible items
    if (this.filteredItems.length > MAX_VISIBLE_ITEMS) {
      this.filteredItems = this.filteredItems.slice(0, MAX_VISIBLE_ITEMS);
    }

    this.renderList();

    // Semantic search (debounced)
    if (this.semanticFn && raw.length >= 2) {
      if (this.semanticDebounceTimer) clearTimeout(this.semanticDebounceTimer);
      const filterText = raw;
      this.semanticDebounceTimer = setTimeout(() => this.runSemanticSearch(filterText), 300);
    } else {
      if (this.semanticDebounceTimer) clearTimeout(this.semanticDebounceTimer);
      this.semanticHeader.style.display = "none";
      this.semanticEl.style.display = "none";
      this.semanticEl.innerHTML = "";
    }
  }

  private renderList(): void {
    this.listEl.innerHTML = "";
    for (const item of this.filteredItems) {
      const row = document.createElement("div");
      row.className = "filterable-list-item";
      if (item.id === this.selectedId) {
        row.classList.add("selected");
      }
      row.dataset.id = item.id;

      // In server mode, semantic results get a distance badge
      if (item.source === "semantic" && item.distance != null) {
        row.innerHTML = `${item.label} <span class="semantic-distance">${item.distance.toFixed(3)}</span>`;
      } else {
        row.textContent = item.label;
      }

      row.addEventListener("click", () => this.handleClick(item.id));
      this.listEl.appendChild(row);
    }

    if (this.totalMatchCount > MAX_VISIBLE_ITEMS) {
      const notice = document.createElement("div");
      notice.className = "filterable-list-cap-notice";
      notice.textContent = `Showing ${MAX_VISIBLE_ITEMS} of ${this.totalMatchCount} matches`;
      this.listEl.appendChild(notice);
    }
  }

  private handleClick(id: string): void {
    this.selectedId = id;
    this.renderList();
    this.renderSemanticSelection();
    for (const cb of this.callbacks) cb(id);
  }

  private async runSemanticSearch(query: string): Promise<void> {
    if (!this.semanticFn) return;

    // Show "Searching..." state
    this.semanticHeader.textContent = "Searching...";
    this.semanticHeader.style.display = "";
    this.semanticEl.style.display = "";

    try {
      const results = await this.semanticFn(query);
      if (!results || results.length === 0) {
        this.semanticHeader.style.display = "none";
        this.semanticEl.style.display = "none";
        this.semanticEl.innerHTML = "";
        return;
      }

      this.semanticHeader.textContent = `Semantic matches (${results.length})`;
      this.semanticHeader.style.display = "";
      this.semanticEl.style.display = "";
      this.semanticEl.innerHTML = "";

      for (const result of results) {
        const row = document.createElement("div");
        row.className = "filterable-list-item filterable-list-semantic-item";
        if (result.id === this.selectedId) {
          row.classList.add("selected");
        }
        row.dataset.id = result.id;
        row.innerHTML = `${result.label} <span class="semantic-distance">${result.distance.toFixed(3)}</span>`;
        row.addEventListener("click", () => this.handleClick(result.id));
        this.semanticEl.appendChild(row);
      }
    } catch (err) {
      console.error("Semantic search failed:", err);
      this.semanticHeader.style.display = "none";
      this.semanticEl.style.display = "none";
      this.semanticEl.innerHTML = "";
    }
  }

  private renderSemanticSelection(): void {
    const items = this.semanticEl.querySelectorAll(".filterable-list-semantic-item");
    for (const el of items) {
      const htmlEl = el as HTMLElement;
      if (htmlEl.dataset.id === this.selectedId) {
        htmlEl.classList.add("selected");
      } else {
        htmlEl.classList.remove("selected");
      }
    }
  }

  private scrollToSelected(): void {
    if (!this.selectedId) return;
    const el = this.listEl.querySelector(`.filterable-list-item.selected`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }
}
