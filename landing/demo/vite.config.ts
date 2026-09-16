import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Builds the landing-page hero demo into landing/demo.js as one self-contained
// ES module (PixiJS included). emptyOutDir is off because the output directory
// is landing/, which holds the hand-written index.html and the vendored pack.
export default defineConfig({
  root: __dirname,
  build: {
    outDir: path.resolve(__dirname, ".."),
    emptyOutDir: false,
    target: "es2020",
    lib: {
      entry: path.resolve(__dirname, "src/main.ts"),
      formats: ["es"],
      fileName: () => "demo.js",
    },
    rollupOptions: { output: { inlineDynamicImports: true } },
  },
});
