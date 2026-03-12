import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";
import preact from "@preact/preset-vite";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: __dirname,
  publicDir: false,
  plugins: [preact()],
  server: {
    port: 3002,
    open: true,
    // Proxy API and WebSocket to the game server
    proxy: {
      "/api": "http://localhost:3001",
      "/data": "http://localhost:3001",
      "/ws": {
        target: "ws://localhost:3001",
        ws: true,
      },
    },
  },
});
