import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const dataDir = path.join(rootDir, "data");

/** MIME types for static file serving */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

/**
 * Resolve a relative path within the data directory, preventing path traversal.
 * Returns null if the resolved path escapes the data directory.
 */
function safeResolve(relPath: string): string | null {
  const resolved = path.resolve(dataDir, relPath);
  if (!resolved.startsWith(dataDir)) return null;
  return resolved;
}

/** Collect the full request body as a Buffer */
function collectBody(req: import("node:http").IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

export default defineConfig({
  root: __dirname,
  publicDir: false,
  server: {
    port: 3000,
    open: true,
    fs: {
      allow: [rootDir],
    },
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  plugins: [
    // ─── Static file serving for /data/* (read-only, streaming) ───
    {
      name: "serve-data",
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (!req.url || !req.url.startsWith("/data/")) return next();

          const relPath = decodeURIComponent(req.url.slice("/data/".length));
          const filePath = safeResolve(relPath);

          if (!filePath) {
            res.statusCode = 403;
            res.end("Forbidden");
            return;
          }

          if (!fs.existsSync(filePath)) return next();

          const ext = path.extname(filePath).toLowerCase();
          const contentType = MIME_TYPES[ext] || "application/octet-stream";

          res.setHeader("Content-Type", contentType);
          res.setHeader("Cache-Control", "no-cache");
          fs.createReadStream(filePath).pipe(res);
        });
      },
    },

    // ─── Filesystem API for /fs/* (read/write/list within data/) ───
    {
      name: "fs-api",
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          if (!req.url || !req.url.startsWith("/fs/")) return next();

          const url = new URL(req.url, "http://localhost");
          const route = url.pathname;

          try {
            // ── GET /fs/read?path=<relative> ──────────────────────
            // Read a file from data/. Returns raw content with appropriate MIME type.
            if (req.method === "GET" && route === "/fs/read") {
              const relPath = url.searchParams.get("path");
              if (!relPath) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "path parameter required" }));
                return;
              }

              const filePath = safeResolve(relPath);
              if (!filePath) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "Path outside data directory" }));
                return;
              }

              if (!fs.existsSync(filePath)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "File not found" }));
                return;
              }

              const ext = path.extname(filePath).toLowerCase();
              const contentType = MIME_TYPES[ext] || "application/octet-stream";
              res.setHeader("Content-Type", contentType);
              res.setHeader("Cache-Control", "no-cache");
              fs.createReadStream(filePath).pipe(res);
              return;
            }

            // ── PUT /fs/write?path=<relative> ─────────────────────
            // Write a file to data/. Creates parent directories as needed.
            // Body is the raw file content.
            if (req.method === "PUT" && route === "/fs/write") {
              const relPath = url.searchParams.get("path");
              if (!relPath) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "path parameter required" }));
                return;
              }

              const filePath = safeResolve(relPath);
              if (!filePath) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "Path outside data directory" }));
                return;
              }

              const body = await collectBody(req);
              const dir = path.dirname(filePath);
              fs.mkdirSync(dir, { recursive: true });
              fs.writeFileSync(filePath, body);

              const sizeKB = (body.length / 1024).toFixed(1);
              console.log(`[FS] Wrote ${relPath} (${sizeKB} KB)`);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true, size: body.length }));
              return;
            }

            // ── DELETE /fs/delete?path=<relative> ─────────────────
            // Delete a file from data/.
            if (req.method === "DELETE" && route === "/fs/delete") {
              const relPath = url.searchParams.get("path");
              if (!relPath) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "path parameter required" }));
                return;
              }

              const filePath = safeResolve(relPath);
              if (!filePath) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "Path outside data directory" }));
                return;
              }

              if (!fs.existsSync(filePath)) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "File not found" }));
                return;
              }

              fs.unlinkSync(filePath);
              console.log(`[FS] Deleted ${relPath}`);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ ok: true }));
              return;
            }

            // ── GET /fs/read-dir?dir=<relative> ─────────────────
            // Read all JSON files in a directory under data/.
            // Returns { files: { "filename.json": <parsed content>, ... } }
            if (req.method === "GET" && route === "/fs/read-dir") {
              const relDir = url.searchParams.get("dir");
              if (!relDir) {
                res.statusCode = 400;
                res.end(JSON.stringify({ error: "dir parameter required" }));
                return;
              }

              const dirPath = safeResolve(relDir);
              if (!dirPath) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "Path outside data directory" }));
                return;
              }

              if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
                // Directory doesn't exist yet — return empty (not an error)
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ files: {} }));
                return;
              }

              const files: Record<string, unknown> = {};
              const items = fs.readdirSync(dirPath, { withFileTypes: true });
              for (const item of items) {
                if (!item.isFile() || !item.name.endsWith(".json")) continue;
                const filePath = path.join(dirPath, item.name);
                try {
                  const content = fs.readFileSync(filePath, "utf-8");
                  files[item.name] = JSON.parse(content);
                } catch (e) {
                  console.warn(`[FS] Failed to read/parse ${relDir}/${item.name}:`, e);
                }
              }

              console.log(`[FS] Read ${Object.keys(files).length} JSON files from ${relDir}/`);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ files }));
              return;
            }

            // ── GET /fs/list?dir=<relative>&recursive=true ────────
            // List files in a directory under data/.
            // Returns { entries: [{ name, path, type, size }] }
            if (req.method === "GET" && route === "/fs/list") {
              const relDir = url.searchParams.get("dir") || "";
              const recursive = url.searchParams.get("recursive") === "true";

              const dirPath = safeResolve(relDir);
              if (!dirPath) {
                res.statusCode = 403;
                res.end(JSON.stringify({ error: "Path outside data directory" }));
                return;
              }

              if (!fs.existsSync(dirPath) || !fs.statSync(dirPath).isDirectory()) {
                res.statusCode = 404;
                res.end(JSON.stringify({ error: "Directory not found" }));
                return;
              }

              const entries: { name: string; path: string; type: "file" | "directory"; size?: number }[] = [];

              function walk(dir: string, prefix: string): void {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                  if (item.name.startsWith(".")) continue; // skip dotfiles
                  const itemPath = path.join(dir, item.name);
                  const relItemPath = prefix ? `${prefix}/${item.name}` : item.name;

                  if (item.isDirectory()) {
                    entries.push({ name: item.name, path: relItemPath, type: "directory" });
                    if (recursive) walk(itemPath, relItemPath);
                  } else if (item.isFile()) {
                    const stat = fs.statSync(itemPath);
                    entries.push({ name: item.name, path: relItemPath, type: "file", size: stat.size });
                  }
                }
              }

              walk(dirPath, relDir);

              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ entries }));
              return;
            }

            // ── POST /fs/compile ───────────────────────────────────
            // Run the asset compiler: builds atlases + room/character JSONs.
            if (req.method === "POST" && route === "/fs/compile") {
              const { compile } = await import("./compiler.js");
              const result = await compile(dataDir);
              res.setHeader("Content-Type", "application/json");
              res.statusCode = result.ok ? 200 : 500;
              res.end(JSON.stringify(result));
              return;
            }

            // ── GET /fs/scan-tilesets ─────────────────────────────────
            // Scan data/tilesets/**/*.png and return structured metadata.
            // Parses tile size from filename convention: *_WxH.png (e.g. "Room_Builder_48x48.png").
            // Returns { tilesets: [{ relPath, tileWidth, tileHeight }] }
            if (req.method === "GET" && route === "/fs/scan-tilesets") {
              const tilesetsDir = path.join(dataDir, "tilesets");
              if (!fs.existsSync(tilesetsDir)) {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify({ tilesets: [] }));
                return;
              }

              interface ScannedTileset {
                /** Path relative to data/ (e.g. "tilesets/3_office/Room_Builder_Office_48x48.png") */
                relPath: string;
                /** Parsed tile width (from filename or default) */
                tileWidth: number;
                /** Parsed tile height (from filename or default) */
                tileHeight: number;
              }

              const tilesets: ScannedTileset[] = [];
              const tilesetSizeRe = /_(\d+)x(\d+)\.png$/i;

              function scanDir(dir: string): void {
                const items = fs.readdirSync(dir, { withFileTypes: true });
                for (const item of items) {
                  if (item.name.startsWith(".")) continue;
                  const full = path.join(dir, item.name);
                  if (item.isDirectory()) {
                    scanDir(full);
                  } else if (item.isFile() && item.name.toLowerCase().endsWith(".png")) {
                    const relPath = path.relative(dataDir, full);
                    const match = item.name.match(tilesetSizeRe);
                    let tileWidth = 48;
                    let tileHeight = 48;
                    if (match) {
                      tileWidth = parseInt(match[1], 10);
                      tileHeight = parseInt(match[2], 10);
                    }
                    tilesets.push({ relPath, tileWidth, tileHeight });
                  }
                }
              }

              scanDir(tilesetsDir);
              console.log(`[FS] Scanned ${tilesets.length} tilesets from data/tilesets/`);
              res.setHeader("Content-Type", "application/json");
              res.end(JSON.stringify({ tilesets }));
              return;
            }

            // Unknown /fs/ route
            res.statusCode = 404;
            res.end(JSON.stringify({ error: `Unknown FS route: ${route}` }));
          } catch (err: any) {
            console.error(`[FS] Error handling ${req.method} ${req.url}:`, err);
            res.statusCode = 500;
            res.end(JSON.stringify({ error: err.message || "Internal server error" }));
          }
        });
      },
    },
  ],
});
