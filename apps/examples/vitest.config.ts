import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    // Exact matches: `@memento/react/styles.css` resolves through the package's exports.
    alias: [
      { find: /^@memento\/core$/, replacement: src("../../packages/core/src/index.ts") },
      { find: /^@memento\/react$/, replacement: src("../../packages/react/src/index.ts") },
    ],
  },
  test: {
    name: "examples",
    root: src("."),
    include: ["test/**/*.test.{ts,tsx}"],
    environment: "jsdom",
    setupFiles: ["test/setup.ts"],
    // One react-router for the app and @jsudc/react's router adapter: run the library
    // through Vite too, instead of Node resolving its own copy of the router.
    server: { deps: { inline: [/@jsudc\/react/] } },
    coverage: {
      include: ["src/**/*.{ts,tsx}"],
      // The entry point only mounts <App />.
      exclude: ["src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text", "html", "json-summary"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
