import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Use the compiler and runtime from source, like the tests, so the playground
// never runs a stale build.
const src = (pkg: string) => fileURLToPath(new URL(`../${pkg}/src/index.ts`, import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const monacoEsm = fileURLToPath(new URL("../../node_modules/monaco-editor/esm/vs", import.meta.url));

export default defineConfig({
  // Relative asset paths, so the built site works at any URL (e.g. GitHub Pages).
  base: "./",
  plugins: [react()],
  resolve: {
    alias: {
      "@tejun/compiler": src("compiler"),
      "@tejun/runtime": src("runtime"),
      // Monaco internals (see src/monaco.ts).
      "monaco-esm": monacoEsm,
    },
  },
  // The example programs live in the repo's examples/ folder.
  server: { fs: { allow: [repoRoot] } },
  build: { outDir: "dist", chunkSizeWarningLimit: 4000 },
});
