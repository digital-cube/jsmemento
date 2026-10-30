import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@memento/core": src("../core/src/index.ts"),
      "@memento/server": src("../server/src/index.ts"),
    },
  },
  test: {
    name: "cli",
    root: src("."),
    include: ["test/**/*.test.ts"],
    globalSetup: ["../server/test/global-setup.ts"],
    fileParallelism: false,
    coverage: {
      include: ["src/**/*.ts"],
      // Process entry point: a thin wrapper over runCli.
      exclude: ["src/main.ts"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
