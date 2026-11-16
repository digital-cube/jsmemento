import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * The suite runs twice: on PostgreSQL (`TEST_DATABASE_URL`) and on SQLite (a file under the
 * temporary directory, created and migrated for the run, with no Redis: `REDIS_URL` is
 * emptied). `MEMENTO_TEST_DIALECT=postgres` or `=sqlite` runs one of them (`pnpm test:pg`,
 * `pnpm test:sqlite` in this package).
 */
const SQLITE_TEST_URL = `file:${join(tmpdir(), `memento-server-test-${process.pid}.db`)}`;
const only = process.env.MEMENTO_TEST_DIALECT;

const projects = [
  {
    name: "server",
    dialect: "postgres",
    env: { MEMENTO_TEST_DIALECT: "postgres" },
    // What only SQLite has: the connection, the migrations, the writer gate.
    exclude: ["test/sqlite.test.ts"],
  },
  {
    name: "server-sqlite",
    dialect: "sqlite",
    env: { MEMENTO_TEST_DIALECT: "sqlite", TEST_DATABASE_URL: SQLITE_TEST_URL, REDIS_URL: "" },
    exclude: [],
  },
].filter((p) => !only || p.dialect === only);

export default defineConfig({
  // Test workspace packages from source, without a build step.
  resolve: {
    alias: {
      "@memento/core": fileURLToPath(new URL("../core/src/index.ts", import.meta.url)),
      "@memento/lookups": fileURLToPath(new URL("../lookups/src/index.ts", import.meta.url)),
    },
  },
  test: {
    root: fileURLToPath(new URL(".", import.meta.url)),
    projects: projects.map(({ name, env, exclude }) => ({
      extends: true,
      test: {
        name,
        env,
        include: ["test/**/*.test.ts"],
        exclude,
        globalSetup: ["test/global-setup.ts"],
        // Every DB test file empties the same tables: run files one at a time.
        fileParallelism: false,
      },
    })),
    coverage: {
      include: ["src/**/*.ts"],
      // Process entry points are thin wrappers over tested functions; the schema modules are
      // declarative (their FK/index callbacks only run inside drizzle-kit).
      exclude: [
        "src/server.ts",
        "src/migrate-cli.ts",
        "src/db/schema-postgres.ts",
        "src/db/schema-sqlite.ts",
      ],
      reporter: ["text", "html", "json-summary", "json"],
      // A red run still reports (tools/test-full.mjs merges it for the thilo Testing tab).
      reportOnFailure: true,
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
