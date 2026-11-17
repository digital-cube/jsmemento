import { fileURLToPath } from "node:url";
import { count, eq, sql } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { Redis } from "ioredis";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type AccountsOptions, buildApp, type MeteringOptions } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { apiKeys, apiKeyUsage, events, tenants } from "../src/db/schema.js";
import { MemoryMailer } from "../src/mail/mailer.js";
import { MemoryPublisher } from "../src/publisher.js";
import { quotaKey } from "../src/quota.js";
import { setUserAdmin } from "../src/services/accounts.js";
import { authenticateApiKey, createApiKey, revokeApiKey } from "../src/services/apikeys.js";
import { applyRetention } from "../src/services/retention.js";
import { createTenant } from "../src/services/tenants.js";
import { hourOf, UsageMeter, type UsageRow, utcDay } from "../src/usage.js";
import { auth, type Fixture, onSqlite, push, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
const SERVICE_URL = "https://service.test";
const JSON_HEADERS = { "content-type": "application/json" };
let fx: Fixture;
let mailer: MemoryMailer;
let apps: FastifyInstance[] = [];
let redis: Redis | null = null;

async function setup(accounts: Partial<AccountsOptions> = {}) {
  mailer = new MemoryMailer();
  fx = await setupApp(handle, {
    accounts: { serviceUrl: SERVICE_URL, mailer, ...accounts },
  });
  apps.push(fx.app);
  return fx;
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
  vi.useRealTimers();
});
afterAll(async () => {
  redis?.disconnect();
  await handle.close();
});

const cookieOf = (response: LightMyRequestResponse) =>
  response.cookies.find((c) => c.name === "memento_session")?.value as string;

/** Registers a user; returns the session cookie and the tenant slug. */
async function register(email = "ana@example.com", name = "Ana") {
  const response = await fx.app.inject({
    method: "POST",
    url: "/memento/auth/register",
    headers: JSON_HEADERS,
    payload: JSON.stringify({ email, password: "correct horse battery", name, terms: true }),
  });
  expect(response.statusCode, response.body).toBe(201);
  return { cookie: cookieOf(response), tenant: response.json().data.tenant.slug as string };
}

function session(cookie: string, method: string, url: string, payload?: unknown) {
  return fx.app.inject({
    method: method as "POST",
    url: `/memento${url}`,
    headers: JSON_HEADERS,
    cookies: { memento_session: cookie },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
  });
}

async function createKey(cookie: string, body: Record<string, unknown> = {}) {
  const response = await session(cookie, "POST", "/keys", {
    name: "backend",
    scopes: ["read", "write"],
    ...body,
  });
  expect(response.statusCode, response.body).toBe(201);
  return response.json().data as { api_key: Record<string, unknown> & { id: string }; key: string };
}

/** A UDC `list` with the session cookie (or an API key). */
async function udcList(
  credential: { cookie: string } | { key: string },
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
) {
  const response = await fx.app.inject({
    method: "POST",
    url: "/memento/udc/list",
    headers: {
      ...JSON_HEADERS,
      "x-udc-message-id": "m1",
      ...("key" in credential ? auth(credential.key) : {}),
      ...headers,
    },
    ...("cookie" in credential ? { cookies: { memento_session: credential.cookie } } : {}),
    payload: JSON.stringify(body),
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

const sampleEvent = (n = 0) => ({
  event_type: "NOTE",
  instance_type: "ticket",
  instance_id: `T-${n}`,
  payload: { text: `note ${n}` },
});

describe("key state and authentication", () => {
  it("refuses disabled and deleted keys like revoked ones; resume restores access", async () => {
    const { cookie } = await register();
    const { api_key, key } = await createKey(cookie);
    expect(api_key).toMatchObject({
      status: "active",
      daily_limit: 100_000,
      used_today: 0,
      scopes: ["read", "write"],
    });
    expect(api_key.created_by).toEqual(expect.any(String));
    await expect(authenticateApiKey(handle.db, key)).resolves.toMatchObject({
      apiKeyId: api_key.id,
    });

    const disabled = await session(cookie, "POST", `/keys/${api_key.id}/disable`);
    expect(disabled.statusCode, disabled.body).toBe(200);
    expect(disabled.json().data.api_key.status).toBe("disabled");
    await expect(authenticateApiKey(handle.db, key)).rejects.toThrow("invalid or expired API key");
    const refused = await fx.app.inject({
      method: "GET",
      url: "/memento/events",
      headers: auth(key),
    });
    expect(refused.statusCode).toBe(401);

    await session(cookie, "POST", `/keys/${api_key.id}/enable`);
    await expect(authenticateApiKey(handle.db, key)).resolves.toBeTruthy();

    const deleted = await session(cookie, "DELETE", `/keys/${api_key.id}`);
    expect(deleted.statusCode).toBe(204);
    await expect(authenticateApiKey(handle.db, key)).rejects.toThrow("invalid or expired API key");
    // The row stays (events point at it), but the routes no longer find it.
    const row = await handle.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, api_key.id) });
    expect(row?.deletedAt).toBeInstanceOf(Date);
    expect((await session(cookie, "POST", `/keys/${api_key.id}/enable`)).statusCode).toBe(404);
  });

  it("keeps revoke-key (CLI) working, and CLI keys have no creator", async () => {
    const { apiKey, key } = await createApiKey(handle.db, {
      tenant: "acme",
      name: "cli",
      scopes: "read",
    });
    expect(apiKey.created_by).toBeNull();
    expect((await revokeApiKey(handle.db, apiKey.prefix)).status).toBe("revoked");
    await expect(authenticateApiKey(handle.db, key)).rejects.toThrow("invalid or expired API key");
  });
});

describe("api_key_id on events", () => {
  it("stores the key of a key context; a session writes none", async () => {
    const stored = await push(fx.app, fx.keys.write, sampleEvent());
    const keyRow = await handle.db.query.apiKeys.findFirst({
      where: eq(apiKeys.name, "acme-write"),
    });
    expect(stored.api_key_id).toBe(keyRow?.id);

    const { cookie } = await register();
    await createKey(cookie);
    const lifecycle = await handle.db
      .select()
      .from(events)
      .where(eq(events.eventType, "APIKEY_CREATED"));
    expect(lifecycle).toHaveLength(1);
    expect(lifecycle[0]?.apiKeyId).toBeNull();
  });

  it("chat messages carry the key too", async () => {
    const chat = await fx.app.inject({
      method: "POST",
      url: "/memento/chats",
      headers: auth(fx.keys.write),
      payload: { participants: ["a", "b"], kind: "direct" },
    });
    const id = chat.json().data.chat_id;
    const sent = await fx.app.inject({
      method: "POST",
      url: `/memento/chats/${id}/messages`,
      headers: auth(fx.keys.write),
      payload: { content: "hi", user_id: "a" },
    });
    expect(sent.statusCode, sent.body).toBe(201);
    expect(sent.json().data.message.api_key_id).toEqual(expect.any(String));
  });

  it("the events collection shows and filters by the key's prefix", async () => {
    await push(fx.app, fx.keys.write, sampleEvent(1));
    await push(fx.app, fx.keys.admin, sampleEvent(2));
    const writeKey = await handle.db.query.apiKeys.findFirst({
      where: eq(apiKeys.name, "acme-write"),
    });
    const all = await udcList({ key: fx.keys.read }, { collection: "events" });
    const prefixes = all.payload.rows.map((r: { api_key: string }) => r.api_key);
    expect(new Set(prefixes).size).toBe(2);
    expect(prefixes).toContain(writeKey?.prefix);
    const filtered = await udcList(
      { key: fx.keys.read },
      {
        collection: "events",
        filter: { field: "api_key", op: "eq", value: writeKey?.prefix },
      },
    );
    expect(filtered.payload.total).toBe(1);
    expect(filtered.payload.rows[0]).toMatchObject({
      instance_id: "T-1",
      api_key: writeKey?.prefix,
    });
    const sorted = await udcList(
      { key: fx.keys.read },
      { collection: "events", sort: [{ field: "api_key", dir: "asc" }] },
    );
    expect(sorted.kind).toBe("udc.list.err");
  });
});

describe("lifecycle events", () => {
  it("writes APIKEY_* events with the prefix, the user's email and a sentence in EN and SR", async () => {
    const { cookie, tenant } = await register();
    const { api_key } = await createKey(cookie, { name: "ingest" });
    await session(cookie, "POST", `/keys/${api_key.id}/disable`);
    await session(cookie, "POST", `/keys/${api_key.id}/disable`); // no change: no event
    await session(cookie, "POST", `/keys/${api_key.id}/enable`);
    const patched = await session(cookie, "PATCH", `/keys/${api_key.id}`, { daily_limit: 500 });
    expect(patched.json().data.api_key.daily_limit).toBe(500);
    await session(cookie, "DELETE", `/keys/${api_key.id}`);

    const reader = (await createApiKey(handle.db, { tenant, name: "reader", scopes: "read" })).key;
    const list = async (locale: string) => {
      const response = await fx.app.inject({
        method: "GET",
        url: `/memento/events?instance_type=api_key&order=asc&locale=${locale}`,
        headers: auth(reader),
      });
      return response.json().data as Record<string, unknown>[];
    };
    const en = await list("en");
    expect(en.map((e) => e.event_type)).toEqual([
      "APIKEY_CREATED",
      "APIKEY_DISABLED",
      "APIKEY_ENABLED",
      "APIKEY_LIMIT_CHANGED",
      "APIKEY_DELETED",
    ]);
    for (const event of en) {
      expect(event).toMatchObject({
        instance_type: "api_key",
        instance_id: api_key.prefix,
        actor_id: "ana@example.com",
        api_key_id: null,
      });
      expect(event.payload).toMatchObject({ name: "ingest", scopes: ["read", "write"] });
    }
    expect(en[3]?.payload).toMatchObject({ daily_limit: 500, previous: null });
    expect(en[0]?.rendered).toBe(`ana@example.com created API key "ingest" (${api_key.prefix}).`);
    expect(en[3]?.rendered).toBe(
      `ana@example.com changed the daily limit of API key "ingest" (${api_key.prefix}) from the default to 500 events.`,
    );
    const sr = await list("sr");
    expect(sr[0]?.rendered).toBe(
      `ana@example.com je kreirao API ključ „ingest" (${api_key.prefix}).`,
    );
    expect(sr[1]?.rendered).toBe(
      `ana@example.com je pauzirao API ključ „ingest" (${api_key.prefix}).`,
    );
  });
});

describe("key routes", () => {
  it("validates the body: scopes read/write only, a limit within the ceiling", async () => {
    await setup({ limits: { defaultMaxKeys: 10, defaultDailyLimit: 1000, maxDailyLimit: 5000 } });
    const { cookie } = await register();
    const bad = async (body: Record<string, unknown>) =>
      (await session(cookie, "POST", "/keys", { name: "k", scopes: ["read"], ...body })).statusCode;
    expect(await bad({ scopes: ["admin"] })).toBe(422);
    expect(await bad({ scopes: [] })).toBe(422);
    expect(await bad({ daily_limit: 0 })).toBe(422);
    expect(await bad({ daily_limit: 6000 })).toBe(422);
    const { api_key } = await createKey(cookie, {
      daily_limit: 5000,
      expires_at: "2099-01-01T00:00:00Z",
    });
    expect(api_key).toMatchObject({ daily_limit: 5000, expires_at: "2099-01-01T00:00:00.000Z" });
    const reset = await session(cookie, "PATCH", `/keys/${api_key.id}`, {
      daily_limit: null,
      name: "renamed",
    });
    expect(reset.json().data.api_key).toMatchObject({ daily_limit: 1000, name: "renamed" });
    expect(
      (await session(cookie, "PATCH", `/keys/${api_key.id}`, { daily_limit: 9000 })).statusCode,
    ).toBe(422);
  });

  it("answers 404 for another tenant's key and 401 to an API key", async () => {
    const ana = await register();
    const bob = await register("bob@example.com", "Bob");
    const { api_key, key } = await createKey(ana.cookie);
    for (const [method, url] of [
      ["PATCH", `/keys/${api_key.id}`],
      ["POST", `/keys/${api_key.id}/disable`],
      ["POST", `/keys/${api_key.id}/enable`],
      ["DELETE", `/keys/${api_key.id}`],
    ] as const) {
      const response = await session(
        bob.cookie,
        method,
        url,
        method === "PATCH" ? { name: "x" } : undefined,
      );
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    expect((await session(bob.cookie, "POST", "/keys/not-a-uuid/disable")).statusCode).toBe(404);
    const withKey = await fx.app.inject({
      method: "POST",
      url: "/memento/keys",
      headers: { ...JSON_HEADERS, ...auth(key) },
      payload: JSON.stringify({ name: "x", scopes: ["read"] }),
    });
    expect(withKey.statusCode).toBe(401);
  });

  it("refuses a key past max_keys with 409 limit_reached; deleted keys do not count", async () => {
    const { cookie, tenant } = await register();
    await handle.db.update(tenants).set({ maxKeys: 2 }).where(eq(tenants.slug, tenant));
    const first = await createKey(cookie);
    await createKey(cookie);
    const third = await session(cookie, "POST", "/keys", { name: "c", scopes: ["read"] });
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toMatchObject({ code: "limit_reached", details: { max_keys: 2 } });
    await session(cookie, "DELETE", `/keys/${first.api_key.id}`);
    expect(
      (await session(cookie, "POST", "/keys", { name: "c", scopes: ["read"] })).statusCode,
    ).toBe(201);
  });
});

describe("daily quota", () => {
  /** Ana with one write key limited to `limit` events a day. */
  async function limitedKey(limit: number) {
    const ana = await register();
    const { api_key, key } = await createKey(ana.cookie, { name: "ingest", daily_limit: limit });
    return { ...ana, api_key, key };
  }
  const pushRaw = (key: string, n: number) =>
    fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(key),
      payload: sampleEvent(n),
    });

  async function exercise(key: string, apiKeyId: string) {
    for (let n = 1; n <= 3; n++) expect((await pushRaw(key, n)).statusCode).toBe(201);
    expect(mailer.sent.filter((m) => m.subject.includes("80 %"))).toHaveLength(0);
    // The 4th of 5 reaches 80 %: one warning, not repeated by the 5th.
    expect((await pushRaw(key, 4)).statusCode).toBe(201);
    expect((await pushRaw(key, 5)).statusCode).toBe(201);
    await vi.waitFor(() =>
      expect(mailer.sent.filter((m) => m.subject.includes("80 %"))).toHaveLength(1),
    );
    const warning = mailer.sent.find((m) => m.subject.includes("80 %"));
    expect(warning?.to).toBe("ana@example.com");
    expect(warning?.text).toContain(`${SERVICE_URL}/keys/${apiKeyId}`);
    expect(warning?.text).toContain("4 of its 5 events");

    const refused = await pushRaw(key, 6);
    expect(refused.statusCode).toBe(429);
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    expect(refused.json().error).toMatchObject({
      code: "quota_exceeded",
      details: { limit: 5, used: 5, resets_at: tomorrow.toISOString() },
    });
    expect((await pushRaw(key, 7)).statusCode).toBe(429);
    await vi.waitFor(() =>
      expect(mailer.sent.filter((m) => m.subject.includes("reached"))).toHaveLength(1),
    );
    expect(mailer.sent).toHaveLength(3); // verify + warning + exceeded
    const row = await handle.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, apiKeyId) });
    expect(row?.quotaWarnedOn).toBe(utcDay(new Date()));
    expect(row?.quotaExceededOn).toBe(utcDay(new Date()));
    // Nothing past the limit was stored.
    const [stored] = await handle.db
      .select({ n: count() })
      .from(events)
      .where(eq(events.apiKeyId, apiKeyId));
    expect(stored?.n).toBe(5);
  }

  it("without Redis: counts from the usage table and the unflushed buffer", async () => {
    const { key, api_key } = await limitedKey(5);
    await exercise(key, api_key.id);
  });

  // Skipped on SQLite: that run has no Redis (REDIS_URL is empty), by design of the run.
  it.skipIf(onSqlite)("with Redis: counts in memento:quota:<key>:<day>", async () => {
    redis = new Redis(loadConfig().redisUrl ?? "redis://localhost:6379/0", {
      maxRetriesPerRequest: 1,
    });
    await setup({ redis });
    const { key, api_key } = await limitedKey(5);
    await exercise(key, api_key.id);
    const counter = quotaKey(api_key.id, utcDay(new Date()));
    expect(await redis.get(counter)).toBe("5");
    expect(await redis.ttl(counter)).toBeGreaterThan(172_000);
    await redis.del(counter);
  });

  it("limits chat writes too, before the seen marker moves", async () => {
    const { key, cookie, api_key } = await limitedKey(2);
    const chat = await fx.app.inject({
      method: "POST",
      url: "/memento/chats",
      headers: auth(key),
      payload: { participants: ["a", "b"], kind: "direct" },
    });
    const id = chat.json().data.chat_id;
    const message = (n: number) =>
      fx.app.inject({
        method: "POST",
        url: `/memento/chats/${id}/messages`,
        headers: auth(key),
        payload: { content: `m${n}`, user_id: "a" },
      });
    expect((await message(1)).statusCode).toBe(201);
    expect((await message(2)).statusCode).toBe(201);
    expect((await message(3)).statusCode).toBe(429);
    const seen = await fx.app.inject({
      method: "POST",
      url: `/memento/chats/${id}/seen`,
      headers: auth(key),
      payload: { user_id: "b" },
    });
    expect(seen.statusCode).toBe(429);
    const view = await session(cookie, "PATCH", `/keys/${api_key.id}`, { name: "ingest" });
    expect(view.json().data.api_key.used_today).toBe(2);
  });
});

// Stage: `service` (accounts on) and `memento` (the examples site, accounts off) share one
// database, so a key made on the service site writes through either.
describe("a self-service key on a process without accounts", () => {
  const log = { error: vi.fn() };
  let examplesMailer: MemoryMailer;

  /** A second process on the same database, without `accounts`. */
  async function examplesApp(metering: Partial<MeteringOptions> = {}) {
    examplesMailer = new MemoryMailer();
    const app = await buildApp({
      db: handle.db,
      publisher: new MemoryPublisher(),
      logger: false,
      metering: { mail: { serviceUrl: SERVICE_URL, mailer: examplesMailer }, ...metering },
    });
    apps.push(app);
    return app;
  }
  const pushTo = (app: FastifyInstance, key: string, n: number) =>
    app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(key),
      payload: sampleEvent(n),
    });
  const usageOf = async (apiKeyId: string) => {
    const [row] = await handle.db
      .select({
        events: sql<string>`coalesce(sum(${apiKeyUsage.eventsWritten}), 0)`,
        requests: sql<string>`coalesce(sum(${apiKeyUsage.requests}), 0)`,
      })
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.apiKeyId, apiKeyId));
    return { events: Number(row?.events ?? 0), requests: Number(row?.requests ?? 0) };
  };

  async function exercise(service: UsageMeter, examples: UsageMeter, app: FastifyInstance) {
    const ana = await register();
    const { api_key, key } = await createKey(ana.cookie, { name: "ingest", daily_limit: 5 });
    for (let n = 1; n <= 3; n++) expect((await pushTo(fx.app, key, n)).statusCode).toBe(201);
    await service.flush();
    // The 4th of 5, through the other process, reaches 80 %: it sends the warning.
    expect((await pushTo(app, key, 4)).statusCode).toBe(201);
    expect((await pushTo(app, key, 5)).statusCode).toBe(201);
    await vi.waitFor(() => expect(examplesMailer.sent).toHaveLength(1));
    expect(examplesMailer.sent[0]?.to).toBe("ana@example.com");
    expect(examplesMailer.sent[0]?.text).toContain(`${SERVICE_URL}/keys/${api_key.id}`);
    const refused = await pushTo(app, key, 6);
    expect(refused.statusCode, refused.body).toBe(429);
    expect(refused.json().error).toMatchObject({ code: "quota_exceeded", details: { used: 5 } });
    await examples.flush();
    // The service process sees the 2 events the other one stored.
    expect((await pushTo(fx.app, key, 7)).statusCode).toBe(429);
    const view = await session(ana.cookie, "PATCH", `/keys/${api_key.id}`, { name: "ingest" });
    expect(view.json().data.api_key.used_today).toBe(5);
    await service.flush();
    await examples.flush();
    // Events written: 3 + 2; requests: all 7 POSTs, refused ones included.
    expect(await usageOf(api_key.id)).toEqual({ events: 5, requests: 7 });
    const [stored] = await handle.db
      .select({ n: count() })
      .from(events)
      .where(eq(events.apiKeyId, api_key.id));
    expect(stored?.n).toBe(5);
    // One warning (from the other process), one exceeded mail, nothing twice.
    await vi.waitFor(() =>
      expect(
        [...mailer.sent, ...examplesMailer.sent].filter((m) => /80 %|reached/.test(m.subject)),
      ).toHaveLength(2),
    );
  }

  it("is metered and held to its daily limit there (usage table)", async () => {
    const service = new UsageMeter({ db: handle.db, log, flushIntervalMs: 3_600_000 });
    const examples = new UsageMeter({ db: handle.db, log, flushIntervalMs: 3_600_000 });
    await setup({ usage: service });
    await exercise(service, examples, await examplesApp({ usage: examples }));
  });

  // Skipped on SQLite: that run has no Redis (REDIS_URL is empty), by design of the run.
  it.skipIf(onSqlite)("is metered and held to its daily limit there (Redis)", async () => {
    redis = new Redis(loadConfig().redisUrl ?? "redis://localhost:6379/0", {
      maxRetriesPerRequest: 1,
    });
    const service = new UsageMeter({ db: handle.db, log, flushIntervalMs: 3_600_000 });
    const examples = new UsageMeter({ db: handle.db, log, flushIntervalMs: 3_600_000 });
    await setup({ usage: service, redis });
    const app = await examplesApp({ usage: examples, redis });
    try {
      await exercise(service, examples, app);
    } finally {
      for (const k of await redis.keys("memento:quota:*")) await redis.del(k);
    }
  });

  it("leaves a key of a tenant without accounts unmetered and unlimited", async () => {
    const examples = new UsageMeter({ db: handle.db, log, flushIntervalMs: 3_600_000 });
    const app = await examplesApp({ usage: examples });
    await handle.db.update(apiKeys).set({ dailyLimit: 1 });
    for (let n = 1; n <= 3; n++) {
      expect((await pushTo(app, fx.keys.write, n)).statusCode).toBe(201);
    }
    await app.close();
    expect(await handle.db.select().from(apiKeyUsage)).toEqual([]);
  });

  it("without a service URL: no quota mail, and the day's mail is left to a process that has one", async () => {
    const app = await examplesApp({ mail: null });
    const ana = await register();
    const { api_key, key } = await createKey(ana.cookie, { name: "ingest", daily_limit: 1 });
    expect((await pushTo(app, key, 1)).statusCode).toBe(201);
    expect((await pushTo(app, key, 2)).statusCode).toBe(429);
    const row = await handle.db.query.apiKeys.findFirst({ where: eq(apiKeys.id, api_key.id) });
    expect(row).toMatchObject({ quotaWarnedOn: null, quotaExceededOn: null });
  });
});

describe("usage meter", () => {
  const log = { error: vi.fn() };

  it("aggregates per key and hour and flushes on its timer", async () => {
    vi.useFakeTimers({ now: new Date("2026-11-01T10:15:00Z"), toFake: ["setInterval", "Date"] });
    const batches: UsageRow[][] = [];
    const meter = new UsageMeter({
      db: handle.db,
      log,
      write: async (rows) => {
        batches.push(rows.map((r) => ({ ...r })));
      },
    });
    meter.add("k1", "t1", { requests: 1, bytes_in: 100 });
    meter.add("k1", "t1", { requests: 1, events_written: 2 });
    meter.add("k2", "t1", { rows_read: 50 });
    expect(meter.pendingEventsWritten("k1", new Date("2026-11-01T00:00:00Z"))).toBe(2);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(batches).toHaveLength(1);
    expect(batches[0]).toEqual([
      expect.objectContaining({
        apiKeyId: "k1",
        hour: new Date("2026-11-01T10:00:00Z"),
        requests: 2,
        bytesIn: 100,
        eventsWritten: 2,
      }),
      expect.objectContaining({ apiKeyId: "k2", rowsRead: 50, requests: 0 }),
    ]);
    // Nothing new: no write.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(batches).toHaveLength(1);
    meter.add("k1", "t1", { stream_seconds: 30 });
    await meter.close();
    expect(batches).toHaveLength(2);
    expect(meter.pending()).toEqual([]);
  });

  it("adds to the stored row on conflict", async () => {
    const { apiKey } = await createApiKey(handle.db, { tenant: "acme", name: "m", scopes: "read" });
    const meter = new UsageMeter({ db: handle.db, log });
    meter.add(apiKey.id, apiKey.tenant_id, { requests: 2, rows_read: 10 });
    await meter.flush();
    meter.add(apiKey.id, apiKey.tenant_id, { requests: 3, events_written: 1 });
    await meter.close();
    const rows = await handle.db
      .select()
      .from(apiKeyUsage)
      .where(eq(apiKeyUsage.apiKeyId, apiKey.id));
    expect(rows).toEqual([
      expect.objectContaining({
        hour: hourOf(new Date()),
        requests: 5,
        rowsRead: 10,
        eventsWritten: 1,
        streamSeconds: 0,
        bytesIn: 0,
      }),
    ]);
  });

  it("logs and drops a failed flush; the request it counts still succeeds", async () => {
    const errors: unknown[] = [];
    const meter = new UsageMeter({
      db: handle.db,
      log: { error: (obj) => errors.push(obj) },
      write: async () => {
        throw new Error("db down");
      },
    });
    await setup({ usage: meter });
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.write),
      payload: sampleEvent(),
    });
    expect(response.statusCode).toBe(201);
    expect(meter.pending()).toHaveLength(1);
    await meter.flush();
    expect(errors).toHaveLength(1);
    expect(meter.pending()).toEqual([]);
  });

  it("meters requests, bytes, events written and rows read of API keys only", async () => {
    const payload = JSON.stringify(sampleEvent());
    await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: { ...auth(fx.keys.write), "content-type": "application/json" },
      payload,
    });
    await fx.app.inject({ method: "GET", url: "/memento/events", headers: auth(fx.keys.read) });
    await fx.app.inject({
      method: "POST",
      url: "/memento/events/query",
      headers: auth(fx.keys.read),
      payload: {},
    });
    await udcList({ key: fx.keys.read }, { collection: "events" });
    const { cookie } = await register();
    await udcList({ cookie }, { collection: "api_keys" });
    await fx.app.close(); // preClose flushes the meter
    const usage = await handle.db
      .select({ name: apiKeys.name, row: apiKeyUsage })
      .from(apiKeyUsage)
      .innerJoin(apiKeys, eq(apiKeys.id, apiKeyUsage.apiKeyId));
    const byName = Object.fromEntries(usage.map((u) => [u.name, u.row]));
    expect(Object.keys(byName).sort()).toEqual(["acme-read", "acme-write"]);
    expect(byName["acme-write"]).toMatchObject({
      requests: 1,
      eventsWritten: 1,
      bytesIn: Buffer.byteLength(payload),
    });
    expect(byName["acme-read"]).toMatchObject({ requests: 3, rowsRead: 3, eventsWritten: 0 });
  });
});

describe("session collections", () => {
  it("api_keys, api_key_events, api_key_activity and api_key_usage list the session's tenant", async () => {
    const meter = new UsageMeter({ db: handle.db, log: { error: vi.fn() } });
    await setup({ usage: meter });
    const ana = await register();
    const bob = await register("bob@example.com", "Bob");
    const { api_key, key } = await createKey(ana.cookie, { name: "ingest" });
    await createKey(bob.cookie, { name: "bobs" });
    await push(fx.app, key, sampleEvent(1));
    await push(fx.app, key, sampleEvent(2));

    const keys = await udcList({ cookie: ana.cookie }, { collection: "api_keys" });
    expect(keys.payload.total).toBe(1);
    expect(keys.payload.rows[0]).toMatchObject({
      __meta: { id: api_key.id },
      name: "ingest",
      prefix: api_key.prefix,
      scopes: ["read", "write"],
      status: "active",
      daily_limit: 100_000,
      used_today: 2,
      events_24h: 2,
    });
    const active = await udcList(
      { cookie: ana.cookie },
      { collection: "api_keys", filter: { field: "status", op: "eq", value: "disabled" } },
    );
    expect(active.payload.total).toBe(0);

    const keyEvents = await udcList(
      { cookie: ana.cookie },
      {
        collection: "api_key_events",
        filter: { field: "api_key", op: "eq", value: api_key.prefix },
      },
    );
    expect(keyEvents.payload.total).toBe(2);
    expect(keyEvents.payload.rows[0]).toMatchObject({
      instance_id: "T-2",
      api_key: api_key.prefix,
    });
    const unfiltered = await udcList({ cookie: ana.cookie }, { collection: "api_key_events" });
    expect(unfiltered.kind).toBe("udc.list.err");
    expect(unfiltered.payload.message).toContain("needs a filter on api_key");
    // Bob filtering on Ana's prefix sees nothing: the tenant scope holds.
    const foreign = await udcList(
      { cookie: bob.cookie },
      {
        collection: "api_key_events",
        filter: { field: "api_key", op: "eq", value: api_key.prefix },
      },
    );
    expect(foreign.payload.total).toBe(0);

    const activity = await udcList(
      { cookie: ana.cookie },
      {
        collection: "api_key_activity",
        filter: { field: "api_key", op: "eq", value: api_key.prefix },
      },
    );
    expect(activity.payload.rows).toEqual([
      expect.objectContaining({ event_type: "NOTE", count: 2, note: 2, api_key: api_key.prefix }),
    ]);

    await meter.flush();
    const usage = await udcList({ cookie: ana.cookie }, { collection: "api_key_usage" });
    expect(usage.payload.rows).toEqual([
      expect.objectContaining({
        api_key: api_key.prefix,
        hour: hourOf(new Date()).toISOString(),
        requests: 2,
        events_written: 2,
      }),
    ]);
  });

  it("read one row by id and refuse writes", async () => {
    const { cookie } = await register();
    const { api_key } = await createKey(cookie, { name: "ingest" });
    const call = async (action: string, body: Record<string, unknown>) => {
      const response = await fx.app.inject({
        method: "POST",
        url: `/memento/udc/${action}`,
        headers: { ...JSON_HEADERS, "x-udc-message-id": "m1" },
        cookies: { memento_session: cookie },
        payload: JSON.stringify(body),
      });
      return response.json();
    };
    const read = await call("read", { collection: "api_keys", id: api_key.id });
    expect(read.payload.row).toMatchObject({ name: "ingest", status: "active", used_today: 0 });
    const missing = await call("read", { collection: "api_keys", id: "nope" });
    expect(missing.payload.code).toBe("not_found");
    const write = await call("mutate", {
      collection: "api_keys",
      op: "delete",
      id: api_key.id,
    });
    expect(write.kind).toBe("udc.mutate.err");
  });

  it("api_key_history lists the key's lifecycle, needs instance_id and the session", async () => {
    const ana = await register();
    const bob = await register("bob@example.com", "Bob");
    const { api_key } = await createKey(ana.cookie, { name: "ingest" });
    await createKey(bob.cookie, { name: "bobs" });
    await session(ana.cookie, "POST", `/keys/${api_key.id}/disable`, {});

    const history = await udcList(
      { cookie: ana.cookie },
      {
        collection: "api_key_history",
        filter: { field: "instance_id", op: "eq", value: api_key.prefix },
        sort: [{ field: "occurred_at", dir: "asc" }],
      },
    );
    expect(history.kind, JSON.stringify(history.payload)).toBe("udc.list.ok");
    expect(history.payload.rows.map((r: { event_type: string }) => r.event_type)).toEqual([
      "APIKEY_CREATED",
      "APIKEY_DISABLED",
    ]);
    // Another tenant's key history is not there, even by its prefix.
    const bobs = await udcList(
      { cookie: bob.cookie },
      {
        collection: "api_key_history",
        filter: { field: "instance_id", op: "eq", value: api_key.prefix },
      },
    );
    expect(bobs.payload.total).toBe(0);
    const unfiltered = await udcList({ cookie: ana.cookie }, { collection: "api_key_history" });
    expect(unfiltered.payload.code).toBe("validation_error");
  });

  it("refuse an API key", async () => {
    for (const collection of [
      "api_keys",
      "api_key_events",
      "api_key_history",
      "api_key_activity",
      "api_key_usage",
    ]) {
      const answer = await udcList({ key: fx.keys.admin }, { collection });
      expect(answer.kind, collection).toBe("udc.list.err");
      expect(answer.payload.code).toBe("forbidden");
    }
  });
});

describe("the menu of the service site", () => {
  const MENU = fileURLToPath(new URL("../../../menu-service.yaml", import.meta.url));

  it("is read with an API key, or without one by a signed-in user — reading only", async () => {
    await setup({});
    await fx.app.close();
    fx = await setupApp(handle, {
      accounts: { serviceUrl: SERVICE_URL, mailer: new MemoryMailer() },
      menu: MENU,
    });
    apps.push(fx.app);
    const ana = await register();
    const byCookie = await udcList({ cookie: ana.cookie }, { collection: "menu" });
    expect(byCookie.kind, JSON.stringify(byCookie.payload)).toBe("udc.list.ok");
    expect(byCookie.payload.rows.map((r: { code: string }) => r.code)).toEqual(
      expect.arrayContaining(["HOME", "KEYS", "CLIENTS", "ACCOUNT", "ADMIN"]),
    );
    expect((await udcList({ key: fx.keys.admin }, { collection: "menu" })).kind).toBe(
      "udc.list.ok",
    );
    const anonymous = await udcList({ cookie: "nope" }, { collection: "menu" });
    expect(anonymous.kind).toBe("udc.list.err");
    // The cookie still opens no key collection.
    const events = await udcList({ cookie: ana.cookie }, { collection: "events" });
    expect(events.payload.message).toBe("missing API key");
  });
});

describe("administration", () => {
  it("admin collections and routes refuse a non-admin, serve an admin", async () => {
    const ana = await register();
    const bob = await register("bob@example.com", "Bob");
    const { api_key, key } = await createKey(bob.cookie, { name: "bobs" });
    for (const collection of ["admin_users", "admin_api_keys"]) {
      const answer = await udcList({ cookie: ana.cookie }, { collection });
      expect(answer.payload.code, collection).toBe("forbidden");
    }
    expect(
      (await session(ana.cookie, "POST", `/admin/keys/${api_key.id}/disable`)).statusCode,
    ).toBe(403);

    await setUserAdmin(handle.db, "ana@example.com", true);
    const users = await udcList(
      { cookie: ana.cookie },
      { collection: "admin_users", sort: [{ field: "email", dir: "asc" }] },
    );
    expect(users.payload.rows).toEqual([
      expect.objectContaining({
        email: "ana@example.com",
        is_admin: true,
        keys: 0,
        disabled: false,
      }),
      expect.objectContaining({ email: "bob@example.com", tenant: bob.tenant, keys: 1 }),
    ]);
    const allKeys = await udcList({ cookie: ana.cookie }, { collection: "admin_api_keys" });
    expect(allKeys.payload.rows.map((r: { user: string | null }) => r.user)).toContain(
      "bob@example.com",
    );
    expect(allKeys.payload.total).toBe(6); // Bob's and the five CLI keys of the fixture

    const paused = await session(ana.cookie, "POST", `/admin/keys/${api_key.id}/disable`);
    expect(paused.json().data.api_key.status).toBe("disabled");
    await expect(authenticateApiKey(handle.db, key)).rejects.toThrow();
    const [event] = await handle.db
      .select()
      .from(events)
      .where(eq(events.eventType, "APIKEY_DISABLED"));
    const bobTenant = await handle.db.query.tenants.findFirst({
      where: eq(tenants.slug, bob.tenant),
    });
    expect(event).toMatchObject({ tenantId: bobTenant?.id, actorId: "ana@example.com" });
    await session(ana.cookie, "POST", `/admin/keys/${api_key.id}/enable`);
    await expect(authenticateApiKey(handle.db, key)).resolves.toBeTruthy();

    const bobId = users.payload.rows[1].__meta.id;
    const disabled = await session(ana.cookie, "POST", `/admin/users/${bobId}/disable`);
    expect(disabled.json().data.user.disabled).toBe(true);
    expect((await session(bob.cookie, "GET", "/auth/me")).statusCode).toBe(401);
    await session(ana.cookie, "POST", `/admin/users/${bobId}/enable`);
    expect((await session(ana.cookie, "POST", "/admin/users/nope/enable")).statusCode).toBe(404);
  });
});

describe("retention", () => {
  it("archives only the older events of tenants with retention_days", async () => {
    await createTenant(handle.db, { slug: "keepall", name: "Keep all" });
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const recent = new Date(Date.now() - 5 * 86_400_000).toISOString();
    for (const occurred_at of [old, old, recent]) {
      await push(fx.app, fx.keys.write, { ...sampleEvent(), occurred_at });
      await push(fx.app, fx.keys.otherWrite, { ...sampleEvent(), occurred_at });
    }
    await handle.db.update(tenants).set({ retentionDays: 30 }).where(eq(tenants.slug, "acme"));

    const dry = await applyRetention(handle.db, { dryRun: true });
    expect(dry).toEqual([
      expect.objectContaining({ tenant: "acme", retention_days: 30, archived: 2 }),
    ]);
    const result = await applyRetention(handle.db, { batchSize: 1 });
    expect(result).toEqual([expect.objectContaining({ tenant: "acme", archived: 2 })]);
    expect(await applyRetention(handle.db)).toEqual([expect.objectContaining({ archived: 0 })]);
    expect(await applyRetention(handle.db, { tenant: "globex" })).toEqual([]);
    await expect(applyRetention(handle.db, { tenant: "nope" })).rejects.toThrow("not found");

    const listed = await fx.app.inject({
      method: "GET",
      url: "/memento/events",
      headers: auth(fx.keys.read),
    });
    expect(listed.json().data).toHaveLength(1);
    const other = await fx.app.inject({
      method: "GET",
      url: "/memento/events",
      headers: auth(fx.keys.otherRead),
    });
    expect(other.json().data).toHaveLength(3);
    const udc = await udcList({ key: fx.keys.read }, { collection: "events" });
    expect(udc.payload.total).toBe(1);
  });
});
