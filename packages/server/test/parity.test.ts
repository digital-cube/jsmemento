import { asc, eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { runWithTenant } from "../src/context.js";
import { dialect } from "../src/db/index.js";
import { apiKeys, apiKeyUsage, events, tenants, users } from "../src/db/schema.js";
import { registerUser } from "../src/services/accounts.js";
import { applyRetention } from "../src/services/retention.js";
import { adminUsersSource, apiKeyUsageSource } from "../src/udc/accounts.js";
import { eventCollections } from "../src/udc/collections.js";
import { auth, type Fixture, push, setupApp, testDatabase } from "./helpers.js";

/**
 * The output PostgreSQL and SQLite must agree on, character for character: this file runs on
 * both (the `server` and `server-sqlite` projects) with the same data and the same literal
 * expectations, so a green run on each is the proof that they answer alike.
 */

const handle = testDatabase();
let fx: Fixture;
const NOW = new Date("2026-11-15T10:45:00Z");

beforeEach(async () => {
  fx = await setupApp(handle, {
    udc: eventCollections({ db: handle.db, activity: { now: () => NOW } }),
  });
});
afterAll(async () => {
  await fx.app.close();
  await handle.close();
});

async function list(payload: Record<string, unknown>) {
  const response = await fx.app.inject({
    method: "POST",
    url: "/memento/udc/list",
    headers: { ...auth(fx.keys.read), "x-udc-message-id": "m1" },
    payload,
  });
  const answer = response.json();
  expect(answer.kind, JSON.stringify(answer.payload)).toBe("udc.list.ok");
  // biome-ignore lint/suspicious/noExplicitAny: the tests read deep into protocol payloads
  return answer.payload as { rows: any[]; total: number };
}

const note = (occurred_at: string, payload: Record<string, unknown> = { text: "t" }) => ({
  event_type: "NOTE",
  instance_type: "ticket",
  instance_id: "T-1",
  actor_id: "ana",
  occurred_at,
  payload,
});

describe(`the same answers on both databases (${dialect.name})`, () => {
  it("cuts the activity buckets at the same minutes, with the same ids", async () => {
    for (const at of [
      "2026-11-15T10:42:00.000Z",
      "2026-11-15T10:42:31.250Z",
      "2026-11-15T10:42:59.999Z",
      "2026-11-15T10:43:00.000Z",
      "2026-11-15T10:44:00.001Z",
    ]) {
      await push(fx.app, fx.keys.write, note(at));
    }
    const page = await list({ collection: "activity" });
    expect(page.total).toBe(3);
    expect(page.rows.map((r) => [r.__meta.id, r.minute, r.count, r.note])).toEqual([
      ["2026-11-15T10:44:00.000Z|NOTE", "2026-11-15T10:44:00.000Z", 1, 1],
      ["2026-11-15T10:43:00.000Z|NOTE", "2026-11-15T10:43:00.000Z", 1, 1],
      ["2026-11-15T10:42:00.000Z|NOTE", "2026-11-15T10:42:00.000Z", 3, 3],
    ]);
    const exact = await list({
      collection: "activity",
      filter: { field: "minute", op: "eq", value: "2026-11-15T10:42:00Z" },
    });
    expect(exact.rows.map((r) => r.__meta.id)).toEqual(["2026-11-15T10:42:00.000Z|NOTE"]);
  });

  it("spells the usage row ids alike: <key id>|<UTC hour>", async () => {
    const [key] = await handle.db.select().from(apiKeys).where(eq(apiKeys.name, "acme-write"));
    const [tenant] = await handle.db.select().from(tenants).where(eq(tenants.slug, "acme"));
    const keyId = key?.id as string;
    for (const hour of ["2026-11-15T09:00:00Z", "2026-11-15T10:00:00Z", "2026-01-02T00:00:00Z"]) {
      await handle.db.insert(apiKeyUsage).values({
        apiKeyId: keyId,
        tenantId: tenant?.id as string,
        hour: new Date(hour),
        requests: 2,
        eventsWritten: 1,
      });
    }
    const source = apiKeyUsageSource(handle.db);
    const context = {
      tenantId: tenant?.id as string,
      tenantSlug: "acme",
      tenantName: "Acme",
      apiKeyId: null,
      scopes: ["read" as const],
    };
    const page = await runWithTenant(context, () => source.list({}));
    expect(page.rows.map((r) => [r.__meta.id, r.hour, r.requests])).toEqual([
      [`${keyId}|2026-11-15T10:00:00Z`, "2026-11-15T10:00:00.000Z", 2],
      [`${keyId}|2026-11-15T09:00:00Z`, "2026-11-15T09:00:00.000Z", 2],
      [`${keyId}|2026-01-02T00:00:00Z`, "2026-01-02T00:00:00.000Z", 2],
    ]);
  });

  it("filters and sorts by a numeric payload member (payloadNumber), NULL when missing or not a number", async () => {
    const cpu = (instance_id: string, load_1min: unknown) => ({
      event_type: "CPU_LOAD",
      instance_type: "server",
      instance_id,
      occurred_at: "2026-11-15T10:40:00Z",
      payload: { load_1min, load_5min: 1, load_15min: 1 },
    });
    await push(fx.app, fx.keys.write, cpu("a", 2.5));
    await push(fx.app, fx.keys.write, cpu("b", 10));
    await push(fx.app, fx.keys.write, cpu("c", "high"));
    await push(fx.app, fx.keys.write, cpu("d", 0.75));
    await push(fx.app, fx.keys.write, {
      ...cpu("e", 0),
      payload: { load_5min: 1, load_15min: 1 },
    });
    const above = await list({
      collection: "cpu_load",
      filter: { field: "load_1min", op: "gt", value: 1 },
      sort: [{ field: "load_1min", dir: "desc" }],
    });
    expect(above.rows.map((r) => [r.instance_id, r.load_1min])).toEqual([
      ["b", 10],
      ["a", 2.5],
    ]);
    const sorted = await list({
      collection: "cpu_load",
      sort: [
        { field: "load_1min", dir: "asc" },
        { field: "instance_id", dir: "asc" },
      ],
    });
    expect(sorted.rows.map((r) => r.instance_id)).toEqual(["d", "a", "b", "c", "e"]);
    const none = await list({
      collection: "cpu_load",
      filter: { field: "load_1min", op: "is_null" },
    });
    expect(none.rows.map((r) => r.instance_id).sort()).toEqual(["c", "e"]);
  });

  it("orders UUIDs as PostgreSQL's uuid type does: by their 128 bits", async () => {
    const ids = [
      "ffffffff-ffff-7fff-bfff-ffffffffffff",
      "00000000-0000-7000-8000-000000000000",
      "a0000000-0000-7000-8000-000000000000",
      "9fffffff-ffff-7fff-bfff-ffffffffffff",
      "0196f2b0-0000-7000-8000-0000000000a0",
      "0196f2b0-0000-7000-8000-00000000000a",
      "0196f2b0-0000-7000-9000-000000000000",
    ];
    for (const [i, id] of ids.entries()) {
      await handle.db.insert(tenants).values({ id, slug: `order-${i}`, name: "Order" });
    }
    const rows = await handle.db
      .select({ id: tenants.id })
      .from(tenants)
      .where(sql`${tenants.slug} like 'order-%'`)
      .orderBy(asc(tenants.id));
    expect(rows.map((r) => r.id)).toEqual([
      "00000000-0000-7000-8000-000000000000",
      "0196f2b0-0000-7000-8000-00000000000a",
      "0196f2b0-0000-7000-8000-0000000000a0",
      "0196f2b0-0000-7000-9000-000000000000",
      "9fffffff-ffff-7fff-bfff-ffffffffffff",
      "a0000000-0000-7000-8000-000000000000",
      "ffffffff-ffff-7fff-bfff-ffffffffffff",
    ]);
  });

  it("moves the chat read watermark only forward in (occurred_at, id), as the unread count reads it", async () => {
    const post = (url: string, payload: Record<string, unknown>) =>
      fx.app.inject({
        method: "POST",
        url: `/memento${url}`,
        headers: auth(fx.keys.write),
        payload,
      });
    const created = await post("/chats", { participants: ["ana", "igor"], kind: "direct" });
    const chat = created.json().data.chat_id as string;
    const send = async (occurred_at: string) =>
      (await post(`/chats/${chat}/messages`, { content: "x", user_id: "ana", occurred_at })).json()
        .data.event_id as string;
    const t2 = "2026-11-15T10:00:02.000Z";
    const a = await send("2026-11-15T10:00:01.000Z");
    // Two in the same millisecond: their ids decide which is later.
    const [b, c] = [await send(t2), await send(t2)].sort();
    const d = await send("2026-11-15T10:00:00.500Z"); // arrives late, happened first
    const seen = async (up_to_event_id: string) =>
      (await post(`/chats/${chat}/seen`, { user_id: "igor", up_to_event_id })).json().data as {
        advanced: boolean;
        participant: { last_seen_event_id: string | null };
      };
    expect((await seen(b as string)).advanced).toBe(true);
    // The later one of the same millisecond moves it on; the earlier one, `a` and `d` do not.
    expect((await seen(c as string)).advanced).toBe(true);
    for (const older of [b, a, d]) {
      const result = await seen(older as string);
      expect(result.advanced).toBe(false);
      expect(result.participant.last_seen_event_id).toBe(c);
    }
    const f = await send("2026-11-15T10:00:03.000Z");
    // Unread for igor, as a client counts it: messages after the watermark in that order.
    const messages = (
      await fx.app.inject({
        method: "GET",
        url: `/memento/chats/${chat}/messages?user_id=igor`,
        headers: auth(fx.keys.read),
      })
    ).json().data as { id: string; occurred_at: string }[];
    const order = (m: { id: string; occurred_at: string }) => `${m.occurred_at}|${m.id}`;
    const watermark = order(
      messages.find((m) => m.id === c) as { id: string; occurred_at: string },
    );
    expect(messages.filter((m) => order(m) > watermark).map((m) => m.id)).toEqual([f]);
    expect(messages.map((m) => m.id).sort()).toEqual([a, b, c, d, f].sort());
  });

  it("archives the same rows by retention, in batches", async () => {
    const day = 86_400_000;
    const ago = (days: number) => new Date(NOW.getTime() - days * day).toISOString();
    const pushed: Record<string, string> = {};
    for (const days of [40, 31, 30.5, 29, 1]) {
      pushed[days] = (await push(fx.app, fx.keys.write, note(ago(days)))).id as string;
    }
    await push(fx.app, fx.keys.otherWrite, note(ago(40))); // globex keeps everything
    await handle.db.update(tenants).set({ retentionDays: 30 }).where(eq(tenants.slug, "acme"));
    const dry = await applyRetention(handle.db, { now: NOW, dryRun: true });
    expect(dry).toEqual([
      { tenant: "acme", retention_days: 30, cutoff: "2026-10-16T10:45:00.000Z", archived: 3 },
    ]);
    const done = await applyRetention(handle.db, { now: NOW, batchSize: 2 });
    expect(done).toEqual(dry);
    const archived = await handle.db
      .select({ id: events.id, archivedAt: events.archivedAt })
      .from(events)
      .where(sql`${events.archivedAt} is not null`);
    expect(archived.map((r) => r.id).sort()).toEqual([pushed[40], pushed[31], pushed[30.5]].sort());
    expect(archived.every((r) => r.archivedAt?.getTime() === NOW.getTime())).toBe(true);
    expect(await applyRetention(handle.db, { now: NOW })).toEqual([{ ...dry[0], archived: 0 }]);
  });

  it("filters a boolean field with true / false and reads it back as a boolean", async () => {
    const ana = await registerUser(handle.db, {
      email: "ana@example.com",
      password: "correct horse battery",
      name: "Ana",
      terms: true,
    });
    await registerUser(handle.db, {
      email: "igor@example.com",
      password: "correct horse battery",
      name: "Igor",
      terms: true,
    });
    await handle.db.update(users).set({ isAdmin: true }).where(eq(users.id, ana.user.id));
    const source = adminUsersSource(handle.db);
    const admins = await source.list({
      filter: { field: "is_admin", op: "eq", value: true },
    });
    expect(admins.rows.map((r) => [r.email, r.is_admin, r.email_verified])).toEqual([
      ["ana@example.com", true, false],
    ]);
    const others = await source.list({
      filter: { field: "is_admin", op: "eq", value: "false" },
    });
    expect(others.rows.map((r) => [r.email, r.is_admin, r.disabled])).toEqual([
      ["igor@example.com", false, false],
    ]);
    await expect(
      source.list({
        filter: { field: "is_admin", op: "eq", value: "yes" },
      }),
    ).rejects.toMatchObject({ code: "validation_error" });
  });
});
