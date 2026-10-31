import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { requestId } from "../src/app.js";
import { apiKeys, tenants } from "../src/db/schema.js";
import { authenticateApiKey, createApiKey, revokeApiKey } from "../src/services/apikeys.js";
import { auth, type Fixture, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;

beforeEach(async () => {
  fx = await setupApp(handle);
});
afterAll(async () => {
  await fx.app.close();
  await handle.close();
});

const get = (headers: Record<string, string> = {}) =>
  fx.app.inject({ method: "GET", url: "/memento/events", headers });

describe("API key auth", () => {
  it("rejects a request without a key", async () => {
    const response = await get();
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "unauthorized", message: "missing API key" },
      request_id: expect.any(String),
    });
  });

  it.each([
    ["malformed", "not-a-key"],
    ["unknown prefix", "mk_zzzzzzzz_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"],
  ])("rejects a %s key", async (_label, key) => {
    const response = await get(auth(key));
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("invalid or expired API key");
  });

  it("rejects a key whose secret does not match the stored hash", async () => {
    const forged = `${fx.keys.read.slice(0, 12)}${"A".repeat(32)}`;
    expect((await get(auth(forged))).statusCode).toBe(401);
  });

  it("accepts Bearer and X-Api-Key and records last use", async () => {
    expect((await get(auth(fx.keys.read))).statusCode).toBe(200);
    expect((await get({ "x-api-key": fx.keys.read })).statusCode).toBe(200);
    const [row] = await handle.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.prefix, fx.keys.read.slice(3, 11)));
    expect(row?.lastUsedAt).toBeInstanceOf(Date);
  });

  it("rejects revoked keys", async () => {
    await revokeApiKey(handle.db, fx.keys.read.slice(3, 11));
    expect((await get(auth(fx.keys.read))).statusCode).toBe(401);
    await expect(revokeApiKey(handle.db, fx.keys.read.slice(3, 11))).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("rejects expired keys and accepts not-yet-expired ones", async () => {
    const past = await createApiKey(handle.db, {
      tenant: "acme",
      name: "old",
      scopes: "read",
      expiresAt: new Date(Date.now() - 1000),
    });
    const future = await createApiKey(handle.db, {
      tenant: "acme",
      name: "new",
      scopes: "read",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect((await get(auth(past.key))).statusCode).toBe(401);
    expect((await get(auth(future.key))).statusCode).toBe(200);
    expect(future.apiKey.expires_at).not.toBeNull();
  });

  it("rejects keys of a deactivated tenant", async () => {
    await handle.db.update(tenants).set({ isActive: false }).where(eq(tenants.slug, "acme"));
    expect((await get(auth(fx.keys.read))).statusCode).toBe(401);
  });

  it("resolves the tenant context of a key", async () => {
    const context = await authenticateApiKey(handle.db, fx.keys.admin);
    expect(context).toMatchObject({ tenantSlug: "acme", tenantName: "Acme", scopes: ["admin"] });
  });
});

describe("scope checks", () => {
  it("a read key cannot push", async () => {
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.read),
      payload: { event_type: "A", instance_type: "user", instance_id: "1" },
    });
    expect(response.statusCode).toBe(403);
    expect(response.json().error).toEqual({
      code: "forbidden",
      message: 'this API key lacks the "write" scope',
    });
  });

  it("a write key cannot read", async () => {
    expect((await get(auth(fx.keys.write))).statusCode).toBe(403);
  });

  it("an admin key can do both", async () => {
    expect((await get(auth(fx.keys.admin))).statusCode).toBe(200);
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.admin),
      payload: { event_type: "A", instance_type: "user", instance_id: "1" },
    });
    expect(response.statusCode).toBe(201);
  });

  it("validates scopes and names when creating keys", async () => {
    await expect(
      createApiKey(handle.db, { tenant: "acme", name: "x", scopes: "read,root" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      createApiKey(handle.db, { tenant: "acme", name: " ", scopes: "read" }),
    ).rejects.toMatchObject({ code: "validation_error" });
    await expect(
      createApiKey(handle.db, { tenant: "nope", name: "x", scopes: "read" }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("request id, health, routing", () => {
  it("echoes a sane X-Request-Id and generates one otherwise", async () => {
    const echoed = await get({ ...auth(fx.keys.read), "x-request-id": "abc-123" });
    expect(echoed.headers["x-request-id"]).toBe("abc-123");
    const generated = await get({ ...auth(fx.keys.read), "x-request-id": "bad id!" });
    expect(generated.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestId(["first", "second"])).toBe("first");
    expect(requestId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("serves /api/health without a key", async () => {
    const response = await fx.app.inject({ method: "GET", url: "/memento/api/health" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true, data: { status: "ok" } });
  });

  it("answers unknown routes with a not_found envelope", async () => {
    const response = await fx.app.inject({ method: "GET", url: "/memento/nope" });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe("not_found");
  });

  it("describes the collection for the key's tenant", async () => {
    const response = await fx.app.inject({
      method: "GET",
      url: "/memento/describe",
      headers: auth(fx.keys.read),
    });
    expect(response.statusCode).toBe(200);
    const data = response.json().data;
    expect(data).toMatchObject({
      name: "memento",
      collection: "events",
      tenant: { slug: "acme", name: "Acme" },
      capabilities: { push: true, query: true, entity_history: true },
      pagination: { style: "cursor", max_limit: 500 },
    });
    expect(data.schema.event_input.properties).toHaveProperty("event_type");
    expect(data.view.columns.length).toBeGreaterThan(0);
  });
});
