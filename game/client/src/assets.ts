/**
 * Asset loader — fetches and caches tileset/character images from the server.
 *
 * All images are loaded via the server's /data/* endpoint.
 * Images are cached by path so they're only fetched once.
 */

import type { Pack, TilesetDefinition } from "@offisims/pack";

/** Cached loaded images by path */
const imageCache = new Map<string, HTMLImageElement>();

/** Load a single image by URL path */
export function loadImage(path: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(path);
  if (cached) return Promise.resolve(cached);

  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => {
      imageCache.set(path, img);
      resolve(img);
    };
    img.onerror = () => reject(new Error(`Failed to load image: ${path}`));
    img.src = path;
  });
}

/** Get a cached image (returns undefined if not loaded yet) */
export function getCachedImage(path: string): HTMLImageElement | undefined {
  return imageCache.get(path);
}

/**
 * Preload all tileset images referenced by the game data.
 * Returns when all images are loaded (or logs errors for failures).
 */
export async function preloadGameAssets(
  data: Pack,
): Promise<void> {
  const paths = new Set<string>();

  // Collect all tileset image paths
  for (const ts of data.tilesets) {
    paths.add(ts.path);
  }

  const results = await Promise.allSettled(
    [...paths].map((p) => loadImage(p)),
  );

  for (const r of results) {
    if (r.status === "rejected") {
      console.warn(`[Assets] ${r.reason}`);
    }
  }
}

/** Find a tileset definition by ID */
export function findTilesetDef(
  data: Pack,
  id: string,
): TilesetDefinition | undefined {
  return data.tilesets.find((t) => t.id === id);
}
