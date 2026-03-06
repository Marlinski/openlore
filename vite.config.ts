import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "src/shared"),
    },
  },
  // Use "public" dir (default) for static files, but also serve /data/ via fs allow
  publicDir: false,
  server: {
    port: 3000,
    open: true,
    fs: {
      allow: [__dirname],
    },
  },
});
