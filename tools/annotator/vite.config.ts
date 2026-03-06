import { defineConfig } from "vite";
import path from "path";

const projectRoot = path.resolve(__dirname, "../../");

export default defineConfig({
  root: __dirname,
  resolve: {
    alias: {
      "@shared": path.resolve(__dirname, "../../src/shared"),
    },
  },
  server: {
    port: 3001,
    open: true,
    fs: {
      allow: [projectRoot],
    },
  },
  // Serve project root as public dir so /data/sprites/... works
  publicDir: projectRoot,
});
