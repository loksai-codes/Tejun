import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Tests import packages from source so `npm test` works without a build first.
const src = (pkg: string, entry = "index.ts") =>
  fileURLToPath(new URL(`./packages/${pkg}/src/${entry}`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@tejun/compiler": src("compiler"),
      "@tejun/runtime": src("runtime"),
      "@tejun/cli": src("cli", "main.ts"),
    },
  },
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
