/**
 * Offisims Content Tools — Main entry point
 *
 * Single-page app with 4 tabs:
 *   1. Composite Builder
 *   2. Room Editor
 *   3. Character Definer
 *   4. Room Tester
 */

import { appState } from "@shared/state.js";
import { initCompositeTab } from "./composite.js";
import { initRoomTab } from "./room.js";
import { initCharacterTab } from "./character.js";
import { initTesterTab } from "./tester.js";

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
  const charsEl = document.getElementById("status-characters")!;
  compositesEl.textContent = `Composites: ${appState.composites.length}`;
  roomsEl.textContent = `Rooms: ${appState.rooms.length}`;
  charsEl.textContent = `Characters: ${appState.characters.length}`;
}

appState.subscribe(updateStatusBar);
updateStatusBar();

// ─── Import / Export ──────────────────────────────────────────────

document.getElementById("btn-export")!.addEventListener("click", () => {
  appState.exportToFile();
  setStatus("Exported project to file");
});

document.getElementById("btn-import")!.addEventListener("click", async () => {
  await appState.importFromFile();
  setStatus("Imported project from file");
});

export function setStatus(text: string): void {
  document.getElementById("status-text")!.textContent = text;
}

// ─── Resizable left panels ───────────────────────────────────────

const PANEL_WIDTHS_KEY = "offisims_panel_widths";
const MIN_PANEL_WIDTH = 180;
const MAX_PANEL_WIDTH = 600;
const DEFAULT_PANEL_WIDTH = 280;

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

// ─── Initialize tabs ─────────────────────────────────────────────

initCompositeTab();
initRoomTab();
initCharacterTab();
initTesterTab();
