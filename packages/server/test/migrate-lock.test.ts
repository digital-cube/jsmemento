import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { connect, type DatabaseHandle, MIGRATIONS_FOLDER, runMigrations } from "../src/db/index.js";
import { onSqlite, testDatabase } from "./helpers.js";

/**
 * Two server processes that start together on a database with pending migrations both migrate
 * (TCKFETCQTN). Without a lock both ran the same `CREATE …` and one died with a unique violation
 * (`_bt_check_unique`) — 3 runs of 4 with two containers on an empty PostgreSQL 18. Here each
 * "process" is its own pool of ONE connection (what `migrate-cli` and the test setup open), on a
 * database created empty for the round; a race needs no more than a few rounds to show.
 * SQLite needs no lock: one process per file.
 */
const ROUNDS = 3;
const PROCESSES = 3;

let admin: DatabaseHandle;
beforeAll(() => {
  if (!onSqlite) admin = testDatabase();
});
afterAll(async () => {
  await admin?.close();
});

/** The migrations shipped with the package. */
const journal = JSON.parse(
  readFileSync(join(MIGRATIONS_FOLDER, "meta", "_journal.json"), "utf8"),
) as {
  entries: unknown[];
};

/** The `n` of a `select count(*)::int as n …`. */
async function count(handle: DatabaseHandle, query: SQL): Promise<number | undefined> {
  const result = (await handle.db.execute(query)) as unknown as { rows: { n: number }[] };
  return result.rows[0]?.n;
}

/** `TEST_DATABASE_URL` with its database replaced by `name`. */
function urlOf(name: string): string {
  const url = new URL(loadConfig().testDatabaseUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

describe("PostgreSQL migrations", () => {
  it.skipIf(onSqlite)(
    "run concurrently from several processes on one empty database, and all succeed",
    async () => {
      for (let round = 0; round < ROUNDS; round++) {
        const name = `memento_migrate_lock_${process.pid}_${round}`;
        await admin.db.execute(sql.raw(`drop database if exists "${name}" with (force)`));
        await admin.db.execute(sql.raw(`create database "${name}"`));
        const handles = Array.from({ length: PROCESSES }, () => connect(urlOf(name), { max: 1 }));
        try {
          const results = await Promise.allSettled(handles.map((h) => runMigrations(h.db)));
          expect(results.filter((r) => r.status === "rejected")).toEqual([]);
          // Every migration applied once, and the lock released once every process returned.
          const [first] = handles as [DatabaseHandle];
          expect(
            await count(first, sql`select count(*)::int as n from drizzle.__drizzle_migrations`),
          ).toBe(journal.entries.length);
          expect(
            await count(
              first,
              sql`select count(*)::int as n from pg_locks where locktype = 'advisory' and granted
                  and database = (select oid from pg_database where datname = current_database())`,
            ),
          ).toBe(0);
        } finally {
          await Promise.all(handles.map((h) => h.close()));
          await admin.db.execute(sql.raw(`drop database if exists "${name}" with (force)`));
        }
      }
    },
    60_000,
  );
});
