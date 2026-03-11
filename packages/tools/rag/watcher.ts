/**
 * Filesystem watcher for incremental RAG re-indexing.
 *
 * Watches data directories for file changes and triggers indexSingleFile /
 * removeSingleFile from the indexer module.  Designed as a dev-tool — keeps
 * things simple, logs liberally, and never crashes the server on errors.
 */

import fs from "node:fs";
import path from "node:path";
import { indexSingleFile, removeSingleFile } from "./indexer.js";
import type { RagDb } from "./db.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WatcherHandle {
  close(): void;
}

interface WatchedDir {
  /** Relative subpath under dataDir (e.g. "data/tilesets") */
  rel: string;
  /** Allowed file extension including the dot (e.g. ".png") */
  ext: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEBOUNCE_MS = 500;

const WATCHED_DIRS: WatchedDir[] = [
  { rel: "tilesets", ext: ".png" },
  { rel: "game/resources", ext: ".json" },
  { rel: "game/composites", ext: ".json" },
  { rel: "game/rooms", ext: ".json" },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function log(...args: unknown[]) {
  console.log("[watcher]", ...args);
}

/** Returns true for paths we should always ignore. */
function shouldIgnore(filePath: string): boolean {
  const base = path.basename(filePath);

  // Dotfiles (includes .DS_Store)
  if (base.startsWith(".")) return true;

  // Temp files
  if (base.endsWith("~") || base.endsWith(".tmp")) return true;

  return false;
}

// ---------------------------------------------------------------------------
// Core
// ---------------------------------------------------------------------------

export function startWatcher(dataDir: string, db: RagDb): WatcherHandle {
  const watchers: fs.FSWatcher[] = [];
  const pending = new Map<string, ReturnType<typeof setTimeout>>();

  for (const dir of WATCHED_DIRS) {
    const absDir = path.resolve(dataDir, dir.rel);

    if (!fs.existsSync(absDir)) {
      log(`skipping ${dir.rel} — directory does not exist`);
      continue;
    }

    let watcher: fs.FSWatcher;
    try {
      watcher = fs.watch(absDir, { recursive: true }, (_event, filename) => {
        if (filename == null) return;

        const fullPath = path.join(absDir, filename);

        if (shouldIgnore(fullPath)) return;
        if (path.extname(filename) !== dir.ext) return;

        // Debounce: clear any existing timer for this path, then set a new one
        const existing = pending.get(fullPath);
        if (existing != null) clearTimeout(existing);

        pending.set(
          fullPath,
          setTimeout(() => {
            pending.delete(fullPath);
            processChange(fullPath, db);
          }, DEBOUNCE_MS),
        );
      });

      watcher.on("error", (err) => {
        log(`error watching ${dir.rel}:`, err);
      });

      watchers.push(watcher);
      log(`watching ${dir.rel} (${dir.ext} files)`);
    } catch (err) {
      log(`failed to start watcher for ${dir.rel}:`, err);
    }
  }

  log(`started — ${watchers.length} director${watchers.length === 1 ? "y" : "ies"} watched`);

  return {
    close() {
      // Clear all pending debounce timers
      for (const timer of pending.values()) {
        clearTimeout(timer);
      }
      pending.clear();

      // Close all fs watchers
      for (const w of watchers) {
        try {
          w.close();
        } catch {
          // ignore errors on close
        }
      }
      watchers.length = 0;

      log("stopped");
    },
  };
}

// ---------------------------------------------------------------------------
// Change handler
// ---------------------------------------------------------------------------

async function processChange(filePath: string, db: RagDb): Promise<void> {
  try {
    if (fs.existsSync(filePath)) {
      log(`changed: ${filePath}`);
      await indexSingleFile(filePath, db);
    } else {
      log(`removed: ${filePath}`);
      await removeSingleFile(filePath, db);
    }
  } catch (err) {
    log(`error processing ${filePath}:`, err);
  }
}
