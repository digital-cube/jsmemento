import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import { clientsPlugin } from "./vite-plugin-clients.js";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // `virtual:clients` from the real clients/ directory (plain text: no shiki in tests).
  plugins: [clientsPlugin({ highlight: false })],
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: [
      { find: /^@jsmemento\/core$/, replacement: src("../../packages/core/src/index.ts") },
      { find: /^@jsmemento\/react$/, replacement: src("../../packages/react/src/index.ts") },
      { find: /^@jsmemento\/ui-shell$/, replacement: src("../../packages/ui-shell/src/index.ts") },
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
      reporter: ["text", "html", "json-summary", "json"],
      // A red run still reports (tools/test-full.mjs merges it for the thilo Testing tab).
      reportOnFailure: true,
    },
  },
});
