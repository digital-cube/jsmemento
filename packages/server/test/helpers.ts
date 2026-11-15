import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { type BuildAppOptions, buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connect, type DatabaseHandle } from "../src/db/index.js";
import { MemoryPublisher } from "../src/publisher.js";
import { createApiKey } from "../src/services/apikeys.js";
import { createTenant } from "../src/services/tenants.js";

export function testDatabase(): DatabaseHandle {
  return connect(loadConfig().testDatabaseUrl, { max: 4 });
}

/**
 * The suite runs on SQLite (the `server-sqlite` vitest project, `MEMENTO_TEST_DIALECT`). A test
 * that cannot run there is skipped by name with `it.skipIf(onSqlite)` and says why.
 */
export const onSqlite = process.env.MEMENTO_TEST_DIALECT === "sqlite";

/** The memento tables, children before parents (SQLite's reset deletes in this order). */
const TABLES = [
  "memento_seen",
  "memento_star",
  "memento_chat_participant",
  "memento_chat",
  "memento_template",
  "memento_event",
  "memento_apikey_usage",
  "memento_session",
  "memento_user_token",
  "memento_tenant_user",
  "memento_apikey",
  "memento_tenant",
  "memento_user",
];

/**
 * Empties every memento table. PostgreSQL: TRUNCATE, which bypasses the event immutability
 * trigger. SQLite has no TRUNCATE: one transaction drops the triggers of `memento_event`,
 * deletes every row and creates the triggers again from their own SQL.
 */
export async function reset(handle: DatabaseHandle): Promise<void> {
  if (handle.dialect.name === "sqlite") {
    await handle.db.transaction(async (tx) => {
      const triggers = (await tx.execute(
        sql`select name, sql from sqlite_master where type = 'trigger' and tbl_name = 'memento_event'`,
      )) as unknown as { rows: { name: string; sql: string }[] };
      for (const t of triggers.rows) await tx.execute(sql.raw(`drop trigger "${t.name}"`));
      for (const table of TABLES) await tx.execute(sql.raw(`delete from "${table}"`));
      for (const t of triggers.rows) await tx.execute(sql.raw(t.sql));
    });
    return;
  }
  await handle.db.execute(
    sql`truncate memento_seen, memento_star, memento_template, memento_chat_participant, memento_chat, memento_event, memento_apikey, memento_tenant, memento_user cascade`,
  );
}

export interface Fixture {
  app: FastifyInstance;
  publisher: MemoryPublisher;
  keys: { read: string; write: string; admin: string; otherRead: string; otherWrite: string };
}

/** Two tenants (`acme`, `globex`) with keys, and an app wired to a MemoryPublisher. */
export async function setupApp(
  handle: DatabaseHandle,
  options: Partial<BuildAppOptions> = {},
): Promise<Fixture> {
  await reset(handle);
  await createTenant(handle.db, { slug: "acme", name: "Acme" });
  await createTenant(handle.db, { slug: "globex", name: "Globex" });
  const key = async (tenant: string, scopes: string) =>
    (await createApiKey(handle.db, { tenant, name: `${tenant}-${scopes}`, scopes })).key;
  const keys = {
    read: await key("acme", "read"),
    write: await key("acme", "write"),
    admin: await key("acme", "admin"),
    otherRead: await key("globex", "read"),
    otherWrite: await key("globex", "write"),
  };
  const publisher = new MemoryPublisher();
  const app = await buildApp({ db: handle.db, publisher, logger: false, ...options });
  return { app, publisher, keys };
}

export const auth = (key: string) => ({ authorization: `Bearer ${key}` });

/** Pushes an event through the API and returns the stored event. */
export async function push(
  app: FastifyInstance,
  key: string,
  body: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: "POST",
    url: "/memento/events",
    headers: auth(key),
    payload: body,
  });
  if (response.statusCode !== 201) throw new Error(`push failed: ${response.body}`);
  return response.json().data;
}
