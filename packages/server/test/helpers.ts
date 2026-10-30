import { sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { connect, type DatabaseHandle } from "../src/db/client.js";
import { MemoryPublisher } from "../src/publisher.js";
import { createApiKey } from "../src/services/apikeys.js";
import { createTenant } from "../src/services/tenants.js";

export function testDatabase(): DatabaseHandle {
  return connect(loadConfig().testDatabaseUrl, { max: 4 });
}

/** Empties every memento table (TRUNCATE bypasses the event immutability trigger). */
export async function reset(handle: DatabaseHandle): Promise<void> {
  await handle.db.execute(
    sql`truncate memento_seen, memento_star, memento_template, memento_chat, memento_event, memento_apikey, memento_tenant cascade`,
  );
}

export interface Fixture {
  app: FastifyInstance;
  publisher: MemoryPublisher;
  keys: { read: string; write: string; admin: string; otherRead: string; otherWrite: string };
}

/** Two tenants (`acme`, `globex`) with keys, and an app wired to a MemoryPublisher. */
export async function setupApp(handle: DatabaseHandle): Promise<Fixture> {
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
  const app = await buildApp({ db: handle.db, publisher, logger: false });
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
