import { eq, type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { connect, type DatabaseHandle, dialect, uuidv7 } from "../src/db/index.js";
import { apiKeys, apiKeyUsage, chatParticipants, chats, events, users } from "../src/db/schema.js";
import { createApiKey } from "../src/services/apikeys.js";
import { createTenant } from "../src/services/tenants.js";
import { onSqlite, reset } from "./helpers.js";

const render = (query: SQL) => dialect.render(query);
const text = (query: SQL) => render(sql`${query}`).sql;

/**
 * `after` (the dialect helper) renders exactly what `before` (the expression the service
 * spelled inline until the dialect seam, copied verbatim) did: same SQL, same parameters.
 */
const same = (after: SQL, before: SQL) => expect(render(after)).toEqual(render(before));

describe("connect", () => {
  it.each([
    "sqlite:///var/memento.db",
    "mysql://memento:secret@localhost/memento",
    "redis://memento:secret@localhost:6379",
  ])("refuses %s with an error naming only the scheme", (url) => {
    let error: unknown;
    try {
      connect(url);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain(`unsupported scheme "${url.split(":")[0]}:"`);
    expect(message).toContain("postgres://, postgresql://, file:<path>, :memory:");
    expect(message).not.toContain("secret");
  });

  it("refuses a URL without a scheme", () => {
    expect(() => connect("/var/memento.db")).toThrow(/database URL: no scheme/);
  });

  // Skipped on SQLite: that process speaks SQLite, and one process speaks one dialect
  // (test/sqlite.test.ts checks that a PostgreSQL URL is refused there).
  it
    .skipIf(onSqlite)
    .each([
      "postgres://memento:memento@localhost:5432/memento",
      "POSTGRESQL://memento:memento@localhost:5432/memento",
    ])("opens %s as PostgreSQL (lazily: no connection until a query)", async (url) => {
    const handle = connect(url, { max: 1 });
    expect(handle.dialect).toBe(dialect);
    expect(handle.dialect.name).toBe("postgres");
    expect(handle).not.toHaveProperty("pool");
    await handle.close();
  });
});

// The PostgreSQL spelling and evaluation of the seam. Skipped on SQLite, where the process
// speaks the other dialect: test/sqlite.test.ts holds the SQLite twins of these tests.
describe.skipIf(onSqlite)("postgres dialect", () => {
  it("has a capabilities object", () => {
    expect(dialect.capabilities).toEqual({});
  });

  it("classifies unique violations, also wrapped by drizzle (as services/pg.ts did)", () => {
    expect(dialect.isUniqueViolation({ code: "23505" })).toBe(true);
    expect(dialect.isUniqueViolation({ cause: { code: "23505" } })).toBe(true);
    expect(dialect.isUniqueViolation({ cause: { cause: { code: "23505" } } })).toBe(true);
    expect(dialect.isUniqueViolation({ code: "23503" })).toBe(false);
    expect(dialect.isUniqueViolation(new Error("boom"))).toBe(false);
    expect(dialect.isUniqueViolation(undefined)).toBe(false);
  });

  it("spells LIKE and ILIKE as drizzle's operators, the escapes left to escapeLike", () => {
    expect(render(dialect.like(events.eventType, "CHAT\\_%"))).toEqual({
      sql: '"memento_event"."event_type" like $1',
      params: ["CHAT\\_%"],
    });
    expect(text(dialect.ilike(events.instanceId, "%t-1%"))).toBe(
      '"memento_event"."instance_id" ilike $1',
    );
  });

  it("reads JSON fields as udc/source.ts did (payloadNumber)", () => {
    same(
      dialect.jsonNumber(events.payload, "load_1min"),
      sql`(case when jsonb_typeof(${events.payload} -> ${"load_1min"}) = 'number' then (${events.payload} ->> ${"load_1min"})::numeric end)`,
    );
    expect(render(dialect.jsonText(events.payload, "content"))).toEqual({
      sql: '("memento_event"."payload" ->> $1)',
      params: ["content"],
    });
  });

  it("casts as udc/activity.ts and udc/accounts.ts did", () => {
    same(sql`${dialect.int(sql`count(*)`)}`, sql`count(*)::int`);
    same(
      dialect.int(sql`(case when ${events.eventType} = ${"NOTE"} then count(*) else 0 end)`),
      sql`(case when ${events.eventType} = ${"NOTE"} then count(*) else 0 end)::int`,
    );
    same(
      sql`coalesce(${apiKeys.dailyLimit}, ${dialect.int(1000)})`,
      sql`coalesce(${apiKeys.dailyLimit}, ${1000}::int)`,
    );
    same(dialect.joinStrings(apiKeys.scopes), sql`array_to_string(${apiKeys.scopes}, ',')`);
  });

  it("spells the time expressions as the services did", () => {
    same(
      dialect.truncateToMinute(events.occurredAt),
      sql`date_trunc('minute', ${events.occurredAt})`,
    );
    // udc/accounts.ts: the id of a usage row.
    same(
      sql`(${dialect.text(apiKeyUsage.apiKeyId)} || '|' || ${dialect.utcHourIso(apiKeyUsage.hour)})`,
      sql`(${apiKeyUsage.apiKeyId}::text || '|' || to_char(${apiKeyUsage.hour} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"'))`,
    );
    same(
      sql`${events.occurredAt} > ${dialect.hoursAgo(24)}`,
      sql`${events.occurredAt} > now() - interval '24 hours'`,
    );
    expect(() => dialect.hoursAgo(1.5)).toThrow(/whole number/);
    same(sql`${apiKeys.expiresAt} <= ${dialect.now()}`, sql`${apiKeys.expiresAt} <= now()`);
    // services/chats.ts: the denormalized last message time only moves forward.
    const at = "2026-11-15T10:00:00.000Z";
    same(
      dialect.later(
        sql`coalesce(${chats.lastMessageAt}, ${dialect.timestamp(at)})`,
        dialect.timestamp(new Date(at)),
      ),
      sql`greatest(coalesce(${chats.lastMessageAt}, ${at}::timestamptz), ${at}::timestamptz)`,
    );
    // services/chats.ts: the read watermark, a row-value comparison.
    const id = "0196f2b0-0000-7000-8000-000000000000";
    same(
      sql`(${chatParticipants.lastSeenAt}, ${chatParticipants.lastSeenEventId}) < (${dialect.timestamp(at)}, ${dialect.uuid(id)})`,
      sql`(${chatParticipants.lastSeenAt}, ${chatParticipants.lastSeenEventId}) < (${at}::timestamptz, ${id}::uuid)`,
    );
    // services/accounts.ts
    same(
      sql`coalesce(${users.emailVerifiedAt}, ${dialect.timestamp(new Date(at))})`,
      sql`coalesce(${users.emailVerifiedAt}, ${at}::timestamptz)`,
    );
  });

  it("spells quota.ts's casts and its null-safe comparison as before", () => {
    const ids = ["a", "b"];
    same(
      sql`${apiKeyUsage.apiKeyId} in (${sql.join(
        ids.map((id) => dialect.uuid(id)),
        sql`, `,
      )})`,
      sql`${apiKeyUsage.apiKeyId} in (${sql.join(
        ids.map((id) => sql`${id}::uuid`),
        sql`, `,
      )})`,
    );
    same(
      dialect.isDistinctFrom(apiKeys.quotaWarnedOn, dialect.date("2026-11-15")),
      sql`${apiKeys.quotaWarnedOn} is distinct from ${"2026-11-15"}::date`,
    );
  });

  it("orders nulls last either way, as the UDC sort did", () => {
    expect(text(dialect.nullsLast(events.actorId, "desc"))).toBe(
      '"memento_event"."actor_id" desc nulls last',
    );
    expect(text(dialect.nullsLast(events.actorId, "asc"))).toBe(
      '"memento_event"."actor_id" asc nulls last',
    );
  });
});

describe("uuidv7", () => {
  it("is a version 7, RFC 4122 variant UUID", () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("sorts by its millisecond timestamp", () => {
    const ids = [3, 1, 2].map((ms) => uuidv7(1_763_200_000_000 + ms));
    expect([...ids].sort()).toEqual([ids[1], ids[2], ids[0]]);
    expect(uuidv7(0).startsWith("00000000-0000-7")).toBe(true);
  });
});

describe.skipIf(onSqlite)("postgres dialect against the database", () => {
  let handle: DatabaseHandle;
  beforeAll(() => {
    handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
  });
  afterAll(async () => {
    await handle.close();
  });

  const value = async (query: SQL): Promise<unknown> => {
    const result = (await handle.db.execute(sql`select ${query} as v`)) as unknown as {
      rows: { v: unknown }[];
    };
    return result.rows[0]?.v;
  };
  /** A timestamp `value` (drizzle's node-postgres parser hands raw timestamptz back as text). */
  const time = async (query: SQL): Promise<Date> => new Date(String(await value(query)));

  it("evaluates the expressions on PostgreSQL", async () => {
    const doc = sql`'{"n": 1.5, "s": "x", "t": true}'::jsonb`;
    expect(await value(dialect.jsonNumber(doc, "n"))).toBe("1.5");
    expect(await value(dialect.jsonNumber(doc, "s"))).toBeNull();
    expect(await value(dialect.jsonNumber(doc, "missing"))).toBeNull();
    expect(await value(dialect.jsonText(doc, "s"))).toBe("x");
    expect(await value(dialect.jsonText(doc, "missing"))).toBeNull();
    expect(await value(dialect.ilike(sql`'Ticket-1'`, "%t-1%"))).toBe(true);
    expect(await value(dialect.like(sql`'CHATX'`, "CHAT\\_%"))).toBe(false);
    expect(await value(dialect.like(sql`'CHAT_X'`, "CHAT\\_%"))).toBe(true);
    expect(await value(dialect.int(sql`count(*)`))).toBe(1);
    expect(await value(dialect.joinStrings(sql`array['read', 'write']::text[]`))).toBe(
      "read,write",
    );
    const at = "2026-11-15T10:42:31.250Z";
    expect(await value(dialect.utcHourIso(dialect.timestamp(at)))).toBe("2026-11-15T10:00:00Z");
    expect(await time(dialect.truncateToMinute(dialect.timestamp(at)))).toEqual(
      new Date("2026-11-15T10:42:00.000Z"),
    );
    expect(
      await time(dialect.later(dialect.timestamp(at), dialect.timestamp(new Date(0)))),
    ).toEqual(new Date(at));
    expect(await value(dialect.isDistinctFrom(sql`null::date`, dialect.date("2026-11-15")))).toBe(
      true,
    );
    expect(await value(dialect.isDistinctFrom(sql`null::date`, sql`null::date`))).toBe(false);
    expect(
      await value(dialect.isDistinctFrom(dialect.date("2026-11-15"), dialect.date("2026-11-15"))),
    ).toBe(false);
    const ago = await time(dialect.hoursAgo(24));
    expect(Math.abs(Date.now() - 24 * 3_600_000 - ago.getTime())).toBeLessThan(60_000);
  });

  it("an insert carries the application's UUID v7; the column default stays for raw SQL", async () => {
    await reset(handle);
    const v7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/;
    const tenant = await createTenant(handle.db, { slug: "dialect", name: "Dialect" });
    expect(tenant.id).toMatch(v7);
    const { apiKey } = await createApiKey(handle.db, {
      tenant: "dialect",
      name: "k",
      scopes: "read",
    });
    const [key] = await handle.db.select().from(apiKeys).where(eq(apiKeys.prefix, apiKey.prefix));
    expect(key?.id).toMatch(v7);
    // gen_random_uuid() (v4) still fills an id nobody passed.
    const raw = (await handle.db.execute(
      "insert into memento_tenant (slug, name) values ('raw', 'Raw') returning id",
    )) as unknown as { rows: { id: string }[] };
    expect(raw.rows[0]?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  });
});
