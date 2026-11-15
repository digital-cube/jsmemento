import { loadConfig } from "./config.js";
import { connect, describeDatabase, runMigrations } from "./db/index.js";

// `MIGRATE_TARGET=test` points the same migrations at the test database. The URL picks the
// migrations: `drizzle/` for PostgreSQL, `drizzle-sqlite/` for a `file:` URL.
const config = loadConfig();
const url = process.env.MIGRATE_TARGET === "test" ? config.testDatabaseUrl : config.databaseUrl;
const database = connect(url, { max: 1 });
try {
  await runMigrations(database.db);
  console.log(`migrations applied to ${describeDatabase(url)}`);
} finally {
  await database.close();
}
