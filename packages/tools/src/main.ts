/**
 * Offisims Content Tools — Main entry point
 *
 * Single-page app with 5 tabs:
 *   1. Tile Cutter
 *   2. Resource Browser
 *   3. Composite Builder
 *   4. Room Editor
 *   5. Room Tester
 *
 * Project data is loaded from / saved to disk automatically via the FS API.
 */

import { appState } from "./state.js";
import { initCutterTab } from "./cutter.js";
import { initBrowserTab } from "./browser.js";
import { initCompositeTab } from "./composite.js";
import { initRoomTab } from "./room.js";
import { initTesterTab } from "./tester.js";
import { initAgentPanel, onTabChange } from "./agent-panel.js";
import { registerRagTools } from "./agent-tools.js";

// ─── Tab switching ────────────────────────────────────────────────

const tabButtons = document.querySelectorAll<HTMLButtonElement>(".tab-btn");
const tabPanels = document.querySelectorAll<HTMLDivElement>(".tab-panel");

function switchTab(tabId: string): void {
  tabButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.tab === tabId);
  });
  tabPanels.forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${tabId}`);
  });
  onTabChange(tabId);
}

tabButtons.forEach((btn) => {
  btn.addEventListener("click", () => {
    switchTab(btn.dataset.tab!);
  });
});

// ─── Status bar ───────────────────────────────────────────────────

function updateStatusBar(): void {
  const compositesEl = document.getElementById("status-composites")!;
  const roomsEl = document.getElementById("status-rooms")!;
  const resourcesEl = document.getElementById("status-resources")!;
  const masksEl = document.getElementById("status-masks")!;
  compositesEl.textContent = `Composites: ${appState.composites.length}`;
  roomsEl.textContent = `Rooms: ${appState.rooms.length}`;
  resourcesEl.textContent = `Resources: ${appState.resources.length}`;
  masksEl.textContent = `Masks: ${appState.masks.length}`;
}

appState.subscribe(updateStatusBar);
updateStatusBar();

// ─── Status text ─────────────────────────────────────────────────

export function setStatus(text: string): void {
  document.getElementById("status-text")!.textContent = text;
}

// ─── Pack Resources button ──────────────────────────────────────

const packBtn = document.getElementById("pack-resources-btn") as HTMLButtonElement;
packBtn.addEventListener("click", async () => {
  packBtn.disabled = true;
  packBtn.textContent = "Packing...";
  setStatus("Compiling resources...");
  try {
    const res = await fetch("/fs/compile", { method: "POST" });
    const result = await res.json();
    if (result.ok) {
      setStatus(`Packed: ${result.message}`);
    } else {
      setStatus(`Pack failed: ${result.message}`);
    }
  } catch (e) {
    setStatus(`Pack error: ${e}`);
  } finally {
    packBtn.disabled = false;
    packBtn.textContent = "Pack Resources";
  }
});

// ─── Resizable left panels ───────────────────────────────────────

const PANEL_WIDTHS_KEY = "offisims_panel_widths";
const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 600;

/** Load saved panel widths from localStorage */
function loadPanelWidths(): Record<string, number> {
  try {
    const raw = localStorage.getItem(PANEL_WIDTHS_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Save panel widths to localStorage */
function savePanelWidths(widths: Record<string, number>): void {
  try {
    localStorage.setItem(PANEL_WIDTHS_KEY, JSON.stringify(widths));
  } catch { /* ignore */ }
}

// Apply saved widths on load
const savedWidths = loadPanelWidths();
for (const [id, width] of Object.entries(savedWidths)) {
  const el = document.getElementById(id);
  if (el) el.style.width = `${width}px`;
}

// Set up drag handles
document.querySelectorAll<HTMLDivElement>(".panel-resize-handle").forEach((handle) => {
  const targetId = handle.dataset.resizeTarget!;
  const panel = document.getElementById(targetId)!;

  let startX = 0;
  let startWidth = 0;

  function onMouseMove(e: MouseEvent): void {
    const delta = e.clientX - startX;
    const newWidth = Math.max(MIN_PANEL_WIDTH, Math.min(MAX_PANEL_WIDTH, startWidth + delta));
    panel.style.width = `${newWidth}px`;
  }

  function onMouseUp(e: MouseEvent): void {
    handle.classList.remove("dragging");
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);

    // Persist
    const widths = loadPanelWidths();
    widths[targetId] = parseInt(panel.style.width);
    savePanelWidths(widths);
  }

  handle.addEventListener("mousedown", (e: MouseEvent) => {
    e.preventDefault();
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    handle.classList.add("dragging");
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
  });
});

// ─── Initialize tabs (after data loads from disk) ────────────────

async function init(): Promise<void> {
  setStatus("Loading project from disk...");
  await appState.ready;
  setStatus(`Loaded: ${appState.composites.length} composites, ${appState.rooms.length} rooms, ${appState.resources.length} resources, ${appState.masks.length} masks`);
  updateStatusBar();

  initCutterTab();
  initBrowserTab();
  initCompositeTab();
  initRoomTab();
  initTesterTab();
  initAgentPanel();
  registerRagTools();
}

init();
