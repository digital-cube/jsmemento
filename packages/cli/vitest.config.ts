import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (path: string) => fileURLToPath(new URL(path, import.meta.url));

/**
 * The commands run against the test database twice, like the server suite: PostgreSQL
 * (`TEST_DATABASE_URL`) and a SQLite file under the temporary directory, each migrated once,
 * the SQLite one with no Redis. `MEMENTO_TEST_DIALECT=postgres` or `=sqlite` runs one of them.
 */
const SQLITE_TEST_URL = `file:${join(tmpdir(), `memento-cli-test-${process.pid}.db`)}`;
const only = process.env.MEMENTO_TEST_DIALECT;

const projects = [
  {
    name: "cli",
    dialect: "postgres",
    env: { MEMENTO_TEST_DIALECT: "postgres" },
    exclude: ["test/sqlite.test.ts"],
  },
  {
    name: "cli-sqlite",
    dialect: "sqlite",
    env: { MEMENTO_TEST_DIALECT: "sqlite", TEST_DATABASE_URL: SQLITE_TEST_URL, REDIS_URL: "" },
    exclude: [],
  },
].filter((p) => !only || p.dialect === only);

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@jsmemento/core": src("../core/src/index.ts"),
      "@jsmemento/lookups": src("../lookups/src/index.ts"),
      "@jsmemento/server": src("../server/src/index.ts"),
    },
  },
  test: {
    root: src("."),
    projects: projects.map(({ name, env, exclude }) => ({
      extends: true,
      test: {
        name,
        env,
        include: ["test/**/*.test.ts"],
        exclude,
        globalSetup: ["../server/test/global-setup.ts"],
        fileParallelism: false,
      },
    })),
    coverage: {
      include: ["src/**/*.ts"],
      // Process entry point: a thin wrapper over runCli.
      exclude: ["src/main.ts"],
      reporter: ["text", "html", "json-summary", "json"],
      // A red run still reports (tools/test-full.mjs merges it for the thilo Testing tab).
      reportOnFailure: true,
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
