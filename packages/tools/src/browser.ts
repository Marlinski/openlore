/**
 * Tab 2: Resource Browser
 *
 * A faceted tag browser over the resource pool.
 * Resources are discovered purely through their tags — no separate entity definitions.
 *
 * Tag namespaces (conventions):
 *   entity:character  — what kind of thing
 *   name:amanda       — instance identifier
 *   state:idle        — action / animation state
 *   dir:left          — direction
 *   variant:sip       — sub-variant
 *
 * The left panel shows tag facets (grouped by namespace prefix).
 * Clicking a facet value adds it as a filter.
 * The center shows matching resources as a paginated card grid.
 * Each card has an inline animated canvas driven by a single rAF loop.
 */

import type { Resource, ResourceFrame } from "@offisims/shared";
import { appState } from "./state.js";
import { setStatus } from "./main.js";
import { loadTilesetImage, getCachedTilesetImage, getTilesetDef } from "./tileset-picker.js";

// ─── DOM refs ────────────────────────────────────────────────────

const tabPanel = document.getElementById("tab-browser") as HTMLDivElement;
const activeFiltersDiv = document.getElementById("browser-active-filters") as HTMLDivElement;
const facetsDiv = document.getElementById("browser-facets") as HTMLDivElement;
const resultCountSpan = document.getElementById("browser-result-count") as HTMLSpanElement;
const searchInput = document.getElementById("browser-search") as HTMLInputElement;
const gridDiv = document.getElementById("browser-grid") as HTMLDivElement;

// ─── State ───────────────────────────────────────────────────────

/** Active filter: map of namespace -> selected value (single-select per namespace) */
const filters = new Map<string, string>();

/** Pagination */
const PAGE_SIZE = 24;
let currentPage = 0;

/** Dirty flag — set when state changes while tab is hidden */
let dirty = false;

// ─── Animation loop ──────────────────────────────────────────────

interface AnimatedCard {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  img: HTMLImageElement;
  frames: ResourceFrame[];
  tw: number;
  th: number;
  frameIdx: number;
}

/** All animated cards currently in the grid */
let animatedCards: AnimatedCard[] = [];

/** Single rAF id for the shared animation loop */
let animLoopId = 0;
let lastAnimTime = 0;
const ANIM_FPS = 8;
const MS_PER_FRAME = 1000 / ANIM_FPS;

function animLoop(time: number): void {
  if (!isVisible()) {
    // Tab hidden — stop looping, will restart when tab becomes visible
    animLoopId = 0;
    return;
  }

  if (time - lastAnimTime >= MS_PER_FRAME) {
    lastAnimTime = time;
    for (const card of animatedCards) {
      card.frameIdx = (card.frameIdx + 1) % card.frames.length;
      const f = card.frames[card.frameIdx];
      const fw = f.w * card.tw;
      const fh = f.h * card.th;
      card.ctx.clearRect(0, 0, card.canvas.width, card.canvas.height);
      card.ctx.drawImage(
        card.img,
        f.srcCol * card.tw, f.srcRow * card.th, fw, fh,
        0, 0, card.canvas.width, card.canvas.height,
      );
    }
  }

  animLoopId = requestAnimationFrame(animLoop);
}

function startAnimLoop(): void {
  if (animLoopId) return; // already running
  if (animatedCards.length === 0) return; // nothing to animate
  lastAnimTime = 0;
  animLoopId = requestAnimationFrame(animLoop);
}

function stopAnimLoop(): void {
  if (animLoopId) {
    cancelAnimationFrame(animLoopId);
    animLoopId = 0;
  }
}

// ─── Visibility ──────────────────────────────────────────────────

function isVisible(): boolean {
  return tabPanel.classList.contains("active");
}

// ─── Tag helpers ─────────────────────────────────────────────────

/** Known tag namespace prefixes, in display order */
const TAG_ORDER: string[] = ["entity", "name", "state", "dir", "variant"];

interface TagParsed {
  ns: string;
  value: string;
  raw: string;
}

function parseTag(raw: string): TagParsed {
  const idx = raw.indexOf(":");
  if (idx > 0) {
    return { ns: raw.slice(0, idx), value: raw.slice(idx + 1), raw };
  }
  return { ns: "", value: raw, raw };
}

/**
 * Build a faceted index from the given resources.
 * Returns a Map of namespace -> Map of value -> count.
 */
function buildFacets(resources: Resource[]): Map<string, Map<string, number>> {
  const facets = new Map<string, Map<string, number>>();
  for (const r of resources) {
    for (const tag of r.tags) {
      const { ns, value } = parseTag(tag);
      if (!facets.has(ns)) facets.set(ns, new Map());
      const vals = facets.get(ns)!;
      vals.set(value, (vals.get(value) || 0) + 1);
    }
  }
  return facets;
}

/** Cached filtered result — recomputed when filters/search change */
let cachedFiltered: Resource[] | null = null;

function getFilteredResources(): Resource[] {
  if (cachedFiltered) return cachedFiltered;

  const search = searchInput.value.trim().toLowerCase();

  cachedFiltered = appState.resources.filter((r) => {
    for (const [ns, value] of filters) {
      const tag = ns ? `${ns}:${value}` : value;
      if (!r.tags.includes(tag)) return false;
    }
    if (search && !r.name.toLowerCase().includes(search)) return false;
    return true;
  });

  return cachedFiltered;
}

function invalidateCache(): void {
  cachedFiltered = null;
}

// ─── Render: active filter pills ─────────────────────────────────

function renderFilters(): void {
  activeFiltersDiv.innerHTML = "";
  if (filters.size === 0) return;

  for (const [ns, value] of filters) {
    const pill = document.createElement("span");
    pill.className = "filter-pill";
    pill.textContent = ns ? `${ns}:${value}` : value;

    const remove = document.createElement("span");
    remove.className = "pill-remove";
    remove.textContent = "\u00d7";
    remove.addEventListener("click", () => {
      filters.delete(ns);
      invalidateCache();
      currentPage = 0;
      renderAll();
    });
    pill.appendChild(remove);
    activeFiltersDiv.appendChild(pill);
  }
}

// ─── Render: facets ──────────────────────────────────────────────

function renderFacets(): void {
  facetsDiv.innerHTML = "";
  const filtered = getFilteredResources();
  const facets = buildFacets(filtered);

  // Sort namespaces by TAG_ORDER, then alphabetically for unknowns
  const nsKeys = [...facets.keys()].sort((a, b) => {
    const ai = TAG_ORDER.indexOf(a);
    const bi = TAG_ORDER.indexOf(b);
    if (ai >= 0 && bi >= 0) return ai - bi;
    if (ai >= 0) return -1;
    if (bi >= 0) return 1;
    return a.localeCompare(b);
  });

  for (const ns of nsKeys) {
    const values = facets.get(ns)!;
    // Skip namespace if already filtered
    if (filters.has(ns)) continue;

    // Section header
    const header = document.createElement("div");
    header.style.cssText = "font-size: 10px; color: var(--text-dim); text-transform: uppercase; letter-spacing: 0.5px; padding: 8px 8px 2px; font-weight: 600;";
    header.textContent = ns || "(unnamespaced)";
    facetsDiv.appendChild(header);

    // Sort values alphabetically
    const sortedValues = [...values.entries()].sort((a, b) => a[0].localeCompare(b[0]));

    for (const [value, count] of sortedValues) {
      const item = document.createElement("div");
      item.className = "tag-facet-item";

      const valueSpan = document.createElement("span");
      valueSpan.className = "facet-value";
      valueSpan.textContent = value;

      const countSpan = document.createElement("span");
      countSpan.className = "facet-count";
      countSpan.textContent = String(count);

      item.appendChild(valueSpan);
      item.appendChild(countSpan);

      item.addEventListener("click", () => {
        filters.set(ns, value);
        invalidateCache();
        currentPage = 0;
        renderAll();
        setStatus(`Filter: ${ns}:${value}`);
      });

      facetsDiv.appendChild(item);
    }
  }
}

// ─── Render: paginated resource grid ─────────────────────────────

function renderGrid(): void {
  gridDiv.innerHTML = "";
  stopAnimLoop();
  animatedCards = [];

  const filtered = getFilteredResources();
  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));

  // Clamp page
  if (currentPage >= totalPages) currentPage = totalPages - 1;
  if (currentPage < 0) currentPage = 0;

  const start = currentPage * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  // Header: count + pagination
  resultCountSpan.textContent = `${filtered.length} resource${filtered.length !== 1 ? "s" : ""}`;

  // Update pagination controls
  const paginationDiv = document.getElementById("browser-pagination");
  if (paginationDiv) {
    if (totalPages <= 1) {
      paginationDiv.style.display = "none";
    } else {
      paginationDiv.style.display = "flex";
      const prevBtn = document.getElementById("browser-prev-btn") as HTMLButtonElement;
      const nextBtn = document.getElementById("browser-next-btn") as HTMLButtonElement;
      const pageLabel = document.getElementById("browser-page-label") as HTMLSpanElement;
      prevBtn.disabled = currentPage === 0;
      nextBtn.disabled = currentPage >= totalPages - 1;
      pageLabel.textContent = `${currentPage + 1} / ${totalPages}`;
    }
  }

  if (filtered.length === 0) {
    const hint = document.createElement("div");
    hint.style.cssText = "color: var(--text-dim); font-size: 12px; padding: 20px; text-align: center;";
    hint.textContent = filters.size > 0 ? "No resources match the current filters." : "No resources available.";
    gridDiv.appendChild(hint);
    return;
  }

  // Collect tilesets that need loading for this page only
  const tilesetIdsToLoad = new Set<string>();

  for (const resource of pageItems) {
    const card = document.createElement("div");
    card.className = "browser-card";

    // Canvas thumbnail (animated or static)
    const needsLoad = renderCardCanvas(card, resource);
    if (needsLoad) tilesetIdsToLoad.add(needsLoad);

    // Name
    const nameDiv = document.createElement("div");
    nameDiv.className = "card-name";
    nameDiv.textContent = resource.name;
    nameDiv.title = resource.name;
    card.appendChild(nameDiv);

    // Tags summary
    const tagsDiv = document.createElement("div");
    tagsDiv.className = "card-tags";
    tagsDiv.textContent = resource.tags.join(", ");
    tagsDiv.title = resource.tags.join("\n");
    card.appendChild(tagsDiv);

    gridDiv.appendChild(card);
  }

  // Start the shared animation loop if there are animated cards
  startAnimLoop();

  // Batch-load any uncached tilesets, then re-render grid once
  if (tilesetIdsToLoad.size > 0) {
    Promise.all([...tilesetIdsToLoad].map((id) => loadTilesetImage(id))).then(
      () => renderGrid(),
      () => {}, // ignore errors
    );
  }
}

/**
 * Create a canvas for a resource card, drawing frame 0 immediately.
 * If the resource has multiple frames, registers it with the shared animation loop.
 * Returns the tilesetId that needs loading if image is not cached, or null if drawn.
 */
function renderCardCanvas(container: HTMLElement, resource: Resource): string | null {
  if (resource.frames.length === 0) return null;

  const frame0 = resource.frames[0];
  const tilesetDef = getTilesetDef(frame0.tilesetId);

  if (!tilesetDef) {
    // Def not cached yet — show placeholder, tell caller to batch-load this tileset
    const ph = document.createElement("div");
    ph.className = "card-thumb-placeholder";
    container.appendChild(ph);
    return frame0.tilesetId;
  }

  const img = getCachedTilesetImage(tilesetDef.id);
  if (!img) {
    // Def cached but image not — show placeholder, caller will batch-load
    const ph = document.createElement("div");
    ph.className = "card-thumb-placeholder";
    container.appendChild(ph);
    return tilesetDef.id;
  }

  const tw = tilesetDef.tileWidth;
  const th = tilesetDef.tileHeight;
  const fw = frame0.w * tw;
  const fh = frame0.h * th;
  const maxH = 64;
  const scale = fh > maxH ? maxH / fh : 1;

  const canvas = document.createElement("canvas");
  canvas.width = Math.round(fw * scale);
  canvas.height = Math.round(fh * scale);
  canvas.style.width = `${canvas.width}px`;
  canvas.style.height = `${canvas.height}px`;

  const ctx = canvas.getContext("2d")!;
  ctx.imageSmoothingEnabled = false;

  // Draw frame 0
  ctx.drawImage(
    img,
    frame0.srcCol * tw, frame0.srcRow * th, fw, fh,
    0, 0, canvas.width, canvas.height,
  );

  container.appendChild(canvas);

  // Register for animation if multi-frame
  if (resource.frames.length > 1) {
    animatedCards.push({
      canvas,
      ctx,
      img,
      frames: resource.frames,
      tw,
      th,
      frameIdx: 0,
    });
  }

  return null;
}

// ─── Orchestrate ─────────────────────────────────────────────────

function renderAll(): void {
  renderFilters();
  renderFacets();
  renderGrid();
}

// ─── Event listeners ─────────────────────────────────────────────

searchInput.addEventListener("input", () => {
  invalidateCache();
  currentPage = 0;
  renderFacets();
  renderGrid();
});

appState.subscribe(() => {
  invalidateCache();
  if (!isVisible()) {
    dirty = true;
    return;
  }
  renderAll();
});

// Re-render when tab becomes visible (if dirty), and manage animation loop
const observer = new MutationObserver(() => {
  if (isVisible()) {
    if (dirty) {
      dirty = false;
      renderAll();
    }
    // Restart animation if we have animated cards
    startAnimLoop();
  } else {
    stopAnimLoop();
  }
});
observer.observe(tabPanel, { attributes: true, attributeFilter: ["class"] });

// ─── Init ────────────────────────────────────────────────────────

export function initBrowserTab(): void {
  // Wire up pagination buttons
  const prevBtn = document.getElementById("browser-prev-btn");
  const nextBtn = document.getElementById("browser-next-btn");
  if (prevBtn) {
    prevBtn.addEventListener("click", () => {
      if (currentPage > 0) {
        currentPage--;
        renderGrid();
      }
    });
  }
  if (nextBtn) {
    nextBtn.addEventListener("click", () => {
      currentPage++;
      renderGrid();
    });
  }

  renderAll();
}
