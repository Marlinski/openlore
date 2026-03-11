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
}

export type OnSelectCallback = (id: string) => void;

export class FilterableList {
  private container: HTMLElement;
  private input: HTMLInputElement;
  private listEl: HTMLDivElement;

  private items: FilterableItem[] = [];
  private filteredItems: FilterableItem[] = [];
  private selectedId: string | null = null;
  private callbacks: OnSelectCallback[] = [];

  constructor(container: HTMLElement) {
    this.container = container;
    this.container.classList.add("filterable-list");

    // Search input
    this.input = document.createElement("input");
    this.input.type = "text";
    this.input.placeholder = "Filter...";
    this.input.className = "filterable-list-input";
    this.container.appendChild(this.input);

    // Scrollable list
    this.listEl = document.createElement("div");
    this.listEl.className = "filterable-list-items";
    this.container.appendChild(this.listEl);

    // Events
    this.input.addEventListener("input", () => this.applyFilter());
  }

  /** Replace the entire item set. Preserves selection if still present. */
  setItems(items: FilterableItem[]): void {
    this.items = items;
    // Keep current selection if still valid
    if (this.selectedId && !items.some((i) => i.id === this.selectedId)) {
      this.selectedId = null;
    }
    this.applyFilter();
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

  // ─── Internal ─────────────────────────────────────────────────

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
    this.renderList();
  }

  private renderList(): void {
    this.listEl.innerHTML = "";
    for (const item of this.filteredItems) {
      const row = document.createElement("div");
      row.className = "filterable-list-item";
      if (item.id === this.selectedId) {
        row.classList.add("selected");
      }
      row.textContent = item.label;
      row.dataset.id = item.id;
      row.addEventListener("click", () => this.handleClick(item.id));
      this.listEl.appendChild(row);
    }
  }

  private handleClick(id: string): void {
    this.selectedId = id;
    this.renderList();
    for (const cb of this.callbacks) cb(id);
  }

  private scrollToSelected(): void {
    if (!this.selectedId) return;
    const el = this.listEl.querySelector(`.filterable-list-item.selected`) as HTMLElement | null;
    if (el) {
      el.scrollIntoView({ block: "nearest" });
    }
  }
}
