import { loadConfig } from "../src/config.js";
import { connect, runMigrations } from "../src/db/client.js";

/** Brings the test database up to the latest migration once per run. */
export default async function setup(): Promise<void> {
  const database = connect(loadConfig().testDatabaseUrl, { max: 1 });
  try {
    await runMigrations(database.db);
  } finally {
    await database.close();
  }
}
