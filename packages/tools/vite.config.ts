import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");
const dataDir = path.join(rootDir, "data");

/** Minimal static file middleware for /data/* requests */
const MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

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
    {
      name: "serve-data",
      configureServer(server) {
        // Serve /data/* from the monorepo data/ directory
        // so tools can load sprites/characters without the server running
        server.middlewares.use((req, res, next) => {
          if (!req.url || !req.url.startsWith("/data/")) return next();

          const relPath = decodeURIComponent(req.url.slice("/data/".length));
          const filePath = path.join(dataDir, relPath);

          // Prevent path traversal
          if (!filePath.startsWith(dataDir)) {
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
  ],
});
