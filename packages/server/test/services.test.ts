import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { codeForStatus } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { currentTenant, requireTenant, runWithTenant, type TenantContext } from "../src/context.js";
import { runMigrations } from "../src/db/client.js";
import { escapeLike } from "../src/db/filter.js";
import { MemoryPublisher, NoopPublisher, RedisPublisher } from "../src/publisher.js";
import { createTenant, getTenantBySlug, listTenants } from "../src/services/tenants.js";
import { reset, testDatabase } from "./helpers.js";

const handle = testDatabase();
beforeEach(() => reset(handle));
afterAll(() => handle.close());

describe("tenants", () => {
  it("creates, finds and lists tenants", async () => {
    const created = await createTenant(handle.db, { slug: "zeta", name: "Zeta" });
    await createTenant(handle.db, { slug: "alpha", name: "Alpha" });
    expect(created).toMatchObject({ slug: "zeta", name: "Zeta", is_active: true });
    expect(await getTenantBySlug(handle.db, "zeta")).toEqual(created);
    expect((await listTenants(handle.db)).map((t) => t.slug)).toEqual(["alpha", "zeta"]);
  });

  it("refuses duplicates and unknown slugs", async () => {
    await createTenant(handle.db, { slug: "acme", name: "Acme" });
    await expect(createTenant(handle.db, { slug: "acme", name: "Again" })).rejects.toMatchObject({
      code: "conflict",
      status: 409,
    });
    await expect(getTenantBySlug(handle.db, "nope")).rejects.toMatchObject({ code: "not_found" });
  });

  it("validates input", async () => {
    await expect(createTenant(handle.db, { slug: "Bad Slug", name: "x" })).rejects.toThrow();
  });
});

describe("tenant context", () => {
  const context: TenantContext = {
    tenantId: "t",
    tenantSlug: "acme",
    tenantName: "Acme",
    apiKeyId: "k",
    scopes: ["read"],
  };

  it("is available inside runWithTenant, across awaits, and nowhere else", async () => {
    expect(currentTenant()).toBeUndefined();
    expect(() => requireTenant()).toThrow("no tenant context");
    await runWithTenant(context, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      expect(requireTenant()).toBe(context);
    });
    expect(currentTenant()).toBeUndefined();
  });
});

describe("config", () => {
  it("has defaults for local development", () => {
    const config = loadConfig({});
    expect(config).toMatchObject({
      databaseUrl: expect.stringContaining("/jsmemento"),
      redisUrl: null,
      port: 8000,
      apiPrefix: "/memento",
      logLevel: "info",
    });
  });

  it("reads and normalises the environment; empty values mean unset", () => {
    const config = loadConfig({
      DATABASE_URL: "postgresql://x/y",
      REDIS_URL: "",
      PORT: "9001",
      MEMENTO_API_PREFIX: "/api/memento/",
      LOG_LEVEL: "debug",
    });
    expect(config).toMatchObject({
      databaseUrl: "postgresql://x/y",
      redisUrl: null,
      port: 9001,
      apiPrefix: "/api/memento",
      logLevel: "debug",
    });
    expect(() => loadConfig({ PORT: "http" })).toThrow();
  });
});

describe("helpers", () => {
  it("escapes LIKE metacharacters", () => {
    expect(escapeLike("50%_off\\")).toBe("50\\%\\_off\\\\");
  });

  it("maps framework statuses to error codes", () => {
    expect(codeForStatus(404)).toBe("not_found");
    expect(codeForStatus(413)).toBe("bad_request");
  });

  it("migrations are idempotent", async () => {
    await expect(runMigrations(handle.db)).resolves.toBeUndefined();
  });
});

describe("publishers", () => {
  const event = {
    id: "0b9f3a2e-6f4c-4f63-9b1a-3f2a1c0d9e8b",
    occurred_at: "2026-10-30T10:00:00.000Z",
    received_at: "2026-10-30T10:00:00.000Z",
    event_type: "USER_LOGIN",
    instance_type: "user",
    instance_id: "42",
    actor_id: null,
    payload: {},
    rendered: null,
    rendered_locale: null,
    archived_at: null,
  };

  it("memory and noop publishers", async () => {
    const memory = new MemoryPublisher();
    await memory.publish({ tenant: "acme", event });
    expect(memory.messages).toHaveLength(1);
    await memory.close();
    const noop = new NoopPublisher();
    await expect(noop.publish()).resolves.toBeUndefined();
    await noop.close();
  });

  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/0";

  it("publishes JSON on memento:events:<tenant> in Redis", async () => {
    const subscriber = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 });
    try {
      await subscriber.connect();
    } catch {
      subscriber.disconnect();
      console.warn(`Redis not reachable at ${redisUrl}: skipping RedisPublisher test`);
      return;
    }
    const prefix = `memento-test-${process.pid}`;
    const publisher = new RedisPublisher(redisUrl, prefix);
    expect(publisher.channel("acme")).toBe(`${prefix}:acme`);
    const received = new Promise<[string, string]>((resolve) =>
      subscriber.on("message", (channel, message) => resolve([channel, message])),
    );
    await subscriber.subscribe(`${prefix}:acme`);
    await publisher.publish({ tenant: "acme", event });
    const [channel, message] = await received;
    expect(channel).toBe(`${prefix}:acme`);
    expect(JSON.parse(message)).toEqual(event);
    await publisher.close();
    await subscriber.quit();
  });
});
