import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: [
      { find: /^@memento\/core$/, replacement: src("../../packages/core/src/index.ts") },
      { find: /^@memento\/react$/, replacement: src("../../packages/react/src/index.ts") },
      { find: /^@memento\/ui-shell$/, replacement: src("../../packages/ui-shell/src/index.ts") },
    ],
  },
  test: {
    name: "service",
    root: src("."),
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    // One react-router for the app and @jsudc/react's router adapter.
    server: { deps: { inline: [/@jsudc\/react/, /ui-shell/] } },
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text", "html", "json-summary"],
    },
  },
});
