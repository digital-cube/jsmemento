import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StreamMessageSchema, streamSubprotocols } from "@jsmemento/core";
import { count, eq, type SQL, sql } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { loadConfig } from "../src/config.js";
import { connect, dialect, runMigrations, uuidv7 } from "../src/db/index.js";
import { apiKeys, apiKeyUsage, events, tenants } from "../src/db/schema.js";
import { SqliteError, sqliteDialect, sqlitePath } from "../src/db/sqlite.js";
import { MementoError } from "../src/errors.js";
import { MemoryMailer } from "../src/mail/mailer.js";
import { saveTemplate } from "../src/services/templates.js";
import { LocalBus } from "../src/stream/feed.js";
import { UsageMeter } from "../src/usage.js";
import { auth, type Fixture, onSqlite, push, reset, setupApp, testDatabase } from "./helpers.js";

/**
 * What only the SQLite run checks (this file is not part of the PostgreSQL project): the
 * connection, the migrations, the writer gate and what SQLite spells differently. The output
 * the two databases must agree on is in test/parity.test.ts, which runs on both.
 */

const sample = (n: number) => ({
  event_type: "NOTE",
  instance_type: "ticket",
  instance_id: `T-${n}`,
  actor_id: "ana",
  payload: { text: `note ${n}` },
});

describe.runIf(onSqlite)("SQLite connection and migrations", () => {
  it("opens file:<path>, file:///abs/path and :memory:, and refuses the rest", () => {
    expect(sqlitePath("file:var/memento.db")).toBe(join(process.cwd(), "var/memento.db"));
    expect(sqlitePath("file:///var/lib/memento/memento.db")).toBe("/var/lib/memento/memento.db");
    expect(sqlitePath("file:///tmp/a%20b.db")).toBe("/tmp/a b.db");
    expect(sqlitePath(":memory:")).toBe(":memory:");
    expect(sqlitePath("file::memory:")).toBe(":memory:");
    expect(() => sqlitePath("file://host/x.db")).toThrow(/with a host/);
    expect(() => sqlitePath("file:")).toThrow(/needs a path/);
    expect(() => sqlitePath("file:x.db?mode=ro")).toThrow(/parameters/);
    expect(() => sqlitePath("postgres://h/db")).toThrow(/not a file: URL/);
    expect(loadConfig({ TEST_DATABASE_URL: "file:/tmp/t.db" }).testDatabaseUrl).toBe(
      "file:/tmp/t.db",
    );
  });

  it("keeps one dialect per process", () => {
    expect(dialect.name).toBe("sqlite");
    expect(() => connect("postgres://memento:memento@localhost:5432/memento")).toThrow(
      /already uses sqlite; one process speaks one dialect/,
    );
  });

  it("applies the migrations to an empty file, twice without harm", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memento-sqlite-migrate-"));
    const fresh = connect(`file:${join(dir, "nested", "memento.db")}`);
    try {
      await runMigrations(fresh.db);
      await runMigrations(fresh.db);
      const rows = async (query: SQL) =>
        ((await fresh.db.execute(query)) as unknown as { rows: Record<string, unknown>[] }).rows;
      expect(
        (
          await rows(
            sql`select name from sqlite_master where type = 'table' and name like 'memento\\_%' escape '\\' order by name`,
          )
        ).map((r) => r.name),
      ).toEqual([
        "memento_apikey",
        "memento_apikey_usage",
        "memento_chat",
        "memento_chat_participant",
        "memento_event",
        "memento_seen",
        "memento_session",
        "memento_star",
        "memento_template",
        "memento_tenant",
        "memento_tenant_user",
        "memento_user",
        "memento_user_token",
      ]);
      expect(await rows(sql`select count(*) as n from __drizzle_migrations`)).toEqual([{ n: 2 }]);
      expect(await rows(sql`select * from pragma_journal_mode(), pragma_foreign_keys()`)).toEqual([
        { journal_mode: "wal", foreign_keys: 1 },
      ]);
      // The partial indexes, the unique indexes, the CHECKs and the immutability triggers.
      const schemaSql = (await rows(sql`select sql from sqlite_master where sql is not null`))
        .map((r) => String(r.sql))
        .join("\n");
      expect(schemaSql).toContain(
        'memento_event_apikey_idx` ON `memento_event` (`tenant_id`,`api_key_id`,`occurred_at`) WHERE "memento_event"."api_key_id" is not null',
      );
      expect(schemaSql).toContain(
        'memento_event_actor_idx` ON `memento_event` (`tenant_id`,`actor_id`,`occurred_at`) WHERE "memento_event"."actor_id" is not null',
      );
      expect(schemaSql).toContain(
        "CREATE UNIQUE INDEX `memento_template_key` ON `memento_template` (`tenant_id`,`event_type`,`locale`)",
      );
      expect(schemaSql).toContain(
        "CREATE UNIQUE INDEX `memento_chat_instance_key` ON `memento_chat` (`tenant_id`,`instance_id`)",
      );
      expect(schemaSql).toContain(`CHECK("memento_chat"."kind" in ('direct', 'room'))`);
      expect(schemaSql).toContain("CREATE TRIGGER memento_event_no_delete");
      expect(schemaSql).toContain("CREATE TRIGGER memento_event_archive_only");
    } finally {
      await fresh.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("runs on :memory: (one connection, no reader)", async () => {
    const memory = connect(":memory:");
    try {
      await runMigrations(memory.db);
      await memory.db.insert(tenants).values({ slug: "mem", name: "Memory" });
      const [row] = await memory.db.select().from(tenants);
      expect(row).toMatchObject({ slug: "mem", isActive: true, plan: "free" });
      expect(row?.createdAt).toBeInstanceOf(Date);
    } finally {
      await memory.close();
    }
  });
});

describe.runIf(onSqlite)("SQLite dialect", () => {
  const handle = testDatabase();
  afterAll(() => handle.close());

  const value = async (query: SQL): Promise<unknown> =>
    (
      (await handle.db.execute(sql`select ${query} as v`)) as unknown as {
        rows: { v: unknown }[];
      }
    ).rows[0]?.v;

  it("evaluates the seam's expressions as PostgreSQL does (dialect.test.ts)", async () => {
    const doc = sql`'{"n": 1.5, "i": 3, "s": "x", "t": true, "a.b": 2}'`;
    expect(await value(dialect.jsonNumber(doc, "n"))).toBe(1.5);
    expect(await value(dialect.jsonNumber(doc, "i"))).toBe(3);
    expect(await value(dialect.jsonNumber(doc, "s"))).toBeNull();
    expect(await value(dialect.jsonNumber(doc, "t"))).toBeNull();
    expect(await value(dialect.jsonNumber(doc, "missing"))).toBeNull();
    // A key with a dot is one key, as PostgreSQL's ->> takes it.
    expect(await value(dialect.jsonNumber(doc, "a.b"))).toBe(2);
    expect(await value(dialect.jsonText(doc, "s"))).toBe("x");
    expect(await value(dialect.jsonText(doc, "missing"))).toBeNull();
    expect(await value(dialect.int(sql`count(*)`))).toBe(1);
    expect(await value(dialect.int(7))).toBe(7);
    expect(await value(dialect.text(sql`42`))).toBe("42");
    expect(await value(dialect.joinStrings(sql`'["read","write"]'`))).toBe("read,write");
    const at = "2026-11-15T10:42:31.250Z";
    expect(await value(dialect.utcHourIso(dialect.timestamp(at)))).toBe("2026-11-15T10:00:00Z");
    expect(await value(dialect.truncateToMinute(dialect.timestamp(at)))).toBe(
      Date.parse("2026-11-15T10:42:00.000Z"),
    );
    // Before 1970 the minute is still the floor.
    expect(await value(dialect.truncateToMinute(sql`${-1}`))).toBe(-60_000);
    expect(await value(dialect.later(dialect.timestamp(at), dialect.timestamp(new Date(0))))).toBe(
      Date.parse(at),
    );
    // greatest() skips a NULL; SQLite's max() would not.
    expect(await value(dialect.later(sql`null`, dialect.timestamp(at)))).toBe(Date.parse(at));
    expect(await value(dialect.later(dialect.timestamp(at), sql`null`))).toBe(Date.parse(at));
    expect(await value(dialect.later(sql`null`, sql`null`))).toBeNull();
    expect(await value(dialect.isDistinctFrom(sql`null`, dialect.date("2026-11-15")))).toBe(1);
    expect(await value(dialect.isDistinctFrom(sql`null`, sql`null`))).toBe(0);
    expect(
      await value(dialect.isDistinctFrom(dialect.date("2026-11-15"), dialect.date("2026-11-15"))),
    ).toBe(0);
    expect(await value(dialect.uuid("0196F2B0-0000-7000-8000-00000000000A"))).toBe(
      "0196f2b0-0000-7000-8000-00000000000a",
    );
    const ago = Number(await value(dialect.hoursAgo(24)));
    expect(Math.abs(Date.now() - 24 * 3_600_000 - ago)).toBeLessThan(60_000);
    expect(Math.abs(Date.now() - Number(await value(dialect.now())))).toBeLessThan(60_000);
    expect(() => dialect.hoursAgo(1.5)).toThrow(/whole number/);
  });

  it("matches LIKE case-sensitively with \\ escapes, and ilike beyond ASCII", async () => {
    expect(await value(dialect.like(sql`'chat_x'`, "CHAT\\_%"))).toBe(0);
    expect(await value(dialect.like(sql`'CHATX'`, "CHAT\\_%"))).toBe(0);
    expect(await value(dialect.like(sql`'CHAT_X'`, "CHAT\\_%"))).toBe(1);
    expect(await value(dialect.like(sql`'100%'`, "100\\%"))).toBe(1);
    expect(await value(dialect.like(sql`'1000'`, "100\\%"))).toBe(0);
    expect(await value(dialect.ilike(sql`'Ticket-1'`, "%t-1%"))).toBe(1);
    expect(await value(dialect.ilike(sql`'ŽUTO ČELO'`, "%žuto č%"))).toBe(1);
    expect(await value(dialect.ilike(sql`null`, "%"))).toBeNull();
  });

  it("orders nulls last either way", async () => {
    expect(dialect.render(dialect.nullsLast(events.actorId, "desc")).sql).toBe(
      '"memento_event"."actor_id" desc nulls last',
    );
    const ordered = (await handle.db.execute(
      sql`select v from (select 2 as v union all select null union all select 1) order by ${dialect.nullsLast(sql`v`, "asc")}`,
    )) as unknown as { rows: { v: number | null }[] };
    expect(ordered.rows.map((r) => r.v)).toEqual([1, 2, null]);
  });

  it("classifies unique violations by SQLite's extended result code", () => {
    expect(dialect.isUniqueViolation(new SqliteError("x", "SQLITE_CONSTRAINT_UNIQUE", 2067))).toBe(
      true,
    );
    expect(dialect.isUniqueViolation({ cause: { code: "SQLITE_CONSTRAINT_PRIMARYKEY" } })).toBe(
      true,
    );
    expect(dialect.isUniqueViolation({ code: "SQLITE_CONSTRAINT_FOREIGNKEY" })).toBe(false);
    expect(dialect.isUniqueViolation({ code: "23505" })).toBe(false);
    expect(dialect).toBe(sqliteDialect);
    expect(dialect.capabilities).toEqual({});
  });

  it("binds UUIDs in lower case, so an upper-case id finds its row as on PostgreSQL", async () => {
    await reset(handle);
    const [tenant] = await handle.db
      .insert(tenants)
      .values({ slug: "case", name: "Case" })
      .returning();
    const id = tenant?.id as string;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
    const [found] = await handle.db
      .select({ slug: tenants.slug })
      .from(tenants)
      .where(eq(tenants.id, id.toUpperCase()));
    expect(found?.slug).toBe("case");
  });

  it("keeps memento_event immutable: no DELETE, no UPDATE but archiving once", async () => {
    await reset(handle);
    const fx = await setupApp(handle);
    try {
      const stored = await push(fx.app, fx.keys.write, sample(1));
      const id = stored.id as string;
      // drizzle wraps the driver error ("Failed query: …") in its own; the trigger's is the cause.
      const refusal = (message: RegExp) => ({
        cause: { code: "SQLITE_CONSTRAINT_TRIGGER", message: expect.stringMatching(message) },
      });
      await expect(handle.db.delete(events).where(eq(events.id, id))).rejects.toMatchObject(
        refusal(/DELETE is not allowed/),
      );
      await expect(
        handle.db.update(events).set({ actorId: "eve" }).where(eq(events.id, id)),
      ).rejects.toMatchObject(refusal(/only archiving/));
      await handle.db.update(events).set({ archivedAt: new Date() }).where(eq(events.id, id));
      await expect(
        handle.db.update(events).set({ archivedAt: new Date() }).where(eq(events.id, id)),
      ).rejects.toMatchObject(refusal(/only archiving/));
    } finally {
      await fx.app.close();
    }
  });

  it("rolls a failed transaction back, and a nested one is a savepoint", async () => {
    await reset(handle);
    await expect(
      handle.db.transaction(async (tx) => {
        await tx.insert(tenants).values({ slug: "gone", name: "Gone" });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await handle.db.transaction(async (tx) => {
      await tx.insert(tenants).values({ slug: "kept", name: "Kept" });
      // Opened on `db` inside the transaction, as PostgreSQL code may: a savepoint.
      await handle.db
        .transaction(async (inner) => {
          await inner.insert(tenants).values({ slug: "inner", name: "Inner" });
          throw new Error("inner");
        })
        .catch(() => undefined);
    });
    const slugs = (await handle.db.select({ slug: tenants.slug }).from(tenants)).map((r) => r.slug);
    expect(slugs).toEqual(["kept"]);
  });
});

describe.runIf(onSqlite)("SQLite with one server process and no Redis", () => {
  const handle = testDatabase();
  let fx: Fixture;
  const apps: Fixture[] = [];

  beforeEach(async () => {
    fx = await setupApp(handle);
    apps.push(fx);
  });
  afterAll(async () => {
    for (const app of apps) await app.app.close();
    await handle.close();
  });

  it("reports the database healthy", async () => {
    const health = await fx.app.inject({ method: "GET", url: "/memento/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().data).toEqual({ status: "ok" });
  });

  it("stores many events posted at once, and a usage flush during them, without SQLITE_BUSY", async () => {
    const [key] = await handle.db.select().from(apiKeys).where(eq(apiKeys.name, "acme-write"));
    const meter = new UsageMeter({
      db: handle.db,
      log: { error: (o) => console.error(o) },
      flushIntervalMs: 60_000,
    });
    const N = 200;
    const work: Promise<unknown>[] = [];
    for (let n = 0; n < N; n++) {
      work.push(
        fx.app.inject({
          method: "POST",
          url: "/memento/events",
          headers: auth(fx.keys.write),
          payload: sample(n),
        }),
      );
      if (n % 40 === 0) {
        meter.add(key?.id as string, key?.tenantId as string, { requests: 40, events_written: 40 });
        work.push(meter.flush());
      }
    }
    const results = await Promise.all(work);
    const statuses = results
      .filter((r): r is { statusCode: number } => typeof r === "object" && r !== null)
      .map((r) => r.statusCode);
    expect(statuses).toEqual(Array(N).fill(201));
    await meter.close();
    const [stored] = await handle.db.select({ n: count() }).from(events);
    expect(stored?.n).toBe(N);
    const [usage] = await handle.db
      .select({ requests: sql<number>`sum(${apiKeyUsage.requests})` })
      .from(apiKeyUsage);
    expect(usage?.requests).toBe(200);
  });

  it("answers a template key and a chat instance collision with the API error of PostgreSQL", async () => {
    const template = { event_type: "NOTE", locale: "en", body: "{{actor_id}} wrote" };
    await saveTemplate(handle.db, "acme", template);
    const again = saveTemplate(handle.db, "acme", template);
    await expect(again).rejects.toBeInstanceOf(MementoError);
    await expect(again).rejects.toMatchObject({ code: "conflict" });
    // replace: the collision becomes the update.
    const replaced = await saveTemplate(
      handle.db,
      "acme",
      { ...template, body: "{{actor_id}} noted" },
      { replace: true },
    );
    expect(replaced).toMatchObject({ created: false, template: { body: "{{actor_id}} noted" } });

    const chat = () =>
      fx.app.inject({
        method: "POST",
        url: "/memento/chats",
        headers: auth(fx.keys.write),
        payload: { chat_id: "chat-sales", participants: ["ana", "igor"], kind: "room" },
      });
    expect((await chat()).statusCode).toBe(201);
    const collision = await chat();
    expect(collision.statusCode).toBe(409);
    expect(collision.json().error).toMatchObject({
      code: "conflict",
      message: 'chat "chat-sales" already exists',
    });
  });

  it("delivers a stored event on /ws through the in-process bus", async () => {
    const bus = new LocalBus();
    const live = await setupApp(handle, { publisher: bus, stream: { feed: bus } });
    apps.push(live);
    await live.app.listen({ host: "127.0.0.1", port: 0 });
    const port = (live.app.server.address() as AddressInfo).port;
    const ws = new WebSocket(
      `ws://127.0.0.1:${port}/memento/ws?event_type=NOTE`,
      streamSubprotocols(live.keys.read),
    );
    const messages: unknown[] = [];
    const arrived = new Promise<void>((resolve) =>
      ws.on("message", (data) => {
        messages.push(StreamMessageSchema.parse(JSON.parse(String(data))));
        if (messages.length === 2) resolve();
      }),
    );
    try {
      await new Promise((resolve) => ws.once("open", resolve));
      await new Promise((resolve) => setTimeout(resolve, 50)); // the welcome
      const stored = await push(live.app, live.keys.write, sample(7));
      await arrived;
      expect(messages[0]).toMatchObject({ kind: "memento.welcome" });
      expect(messages[1]).toEqual({ kind: "memento.event.new", id: stored.id, payload: stored });
    } finally {
      ws.terminate();
    }
  });

  it("enforces the daily quota from the usage table and the unflushed buffer", async () => {
    const mailer = new MemoryMailer();
    const quota = await setupApp(handle, {
      accounts: { serviceUrl: "https://service.test", mailer, redis: null },
    });
    apps.push(quota);
    const [key] = await handle.db.select().from(apiKeys).where(eq(apiKeys.name, "acme-write"));
    await handle.db
      .update(apiKeys)
      .set({ dailyLimit: 3 })
      .where(eq(apiKeys.id, key?.id as string));
    const post = (n: number) =>
      quota.app.inject({
        method: "POST",
        url: "/memento/events",
        headers: auth(quota.keys.write),
        payload: sample(n),
      });
    // Three pass, one of them already in the table (a flushed hour), two in the buffer.
    await handle.db.insert(apiKeyUsage).values({
      apiKeyId: key?.id as string,
      tenantId: key?.tenantId as string,
      hour: new Date(Math.floor(Date.now() / 3_600_000) * 3_600_000),
      eventsWritten: 1,
    });
    expect((await post(1)).statusCode).toBe(201);
    expect((await post(2)).statusCode).toBe(201);
    const refused = await post(3);
    expect(refused.statusCode).toBe(429);
    expect(refused.json().error).toMatchObject({
      code: "quota_exceeded",
      details: { limit: 3, used: 3 },
    });
    const [row] = await handle.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.id, key?.id as string));
    expect(row?.quotaExceededOn).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe.runIf(onSqlite)("SQLite: two connections, and another process, on one file", () => {
  // Two handles on the test file: two connections, which SQLite locks against each other
  // exactly as it locks two processes (a `memento` CLI command next to the running server) —
  // and, below, a second process for real.
  const server = testDatabase();
  const cli = testDatabase();
  beforeAll(() => reset(server));
  afterAll(async () => {
    await cli.close();
    await server.close();
  });

  it("waits for a transaction another connection holds open without stopping the event loop", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    try {
      let release!: () => void;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let begun!: () => void;
      const isBegun = new Promise<void>((resolve) => {
        begun = resolve;
      });
      const held = cli.db.transaction(async (tx) => {
        await tx.insert(tenants).values({ slug: "cli", name: "CLI" });
        begun();
        await released;
      });
      await isBegun;
      const write = server.db.insert(tenants).values({ slug: "server", name: "Server" });
      const before = ticks;
      await new Promise((resolve) => setTimeout(resolve, 300));
      // The waiting writer did not block this process: the timer kept firing.
      expect(ticks - before).toBeGreaterThan(20);
      release();
      await held;
      await write;
      const slugs = (await server.db.select({ slug: tenants.slug }).from(tenants)).map(
        (r) => r.slug,
      );
      expect(slugs.sort()).toEqual(["cli", "server"]);
    } finally {
      clearInterval(timer);
    }
  });

  it("waits for another PROCESS holding the write lock, then writes", async () => {
    const path = sqlitePath(loadConfig().testDatabaseUrl);
    // A child holding BEGIN IMMEDIATE for 500 ms, sleeping synchronously inside it.
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const { DatabaseSync } = require("node:sqlite");
const db = new DatabaseSync(process.argv[1]);
db.exec("pragma busy_timeout = 10000");
db.exec("begin immediate");
db.prepare("insert into memento_tenant (id, slug, name) values (?, 'child', 'Child')").run(process.argv[2]);
process.stdout.write("locked\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500);
db.exec("commit");
db.close();`,
        path,
        uuidv7(),
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
    await new Promise<void>((resolve) => child.stdout.once("data", () => resolve()));
    const started = Date.now();
    await server.db.insert(tenants).values({ slug: "after-child", name: "After" });
    expect(Date.now() - started).toBeGreaterThan(200);
    expect(await exited).toBe(0);
    const slugs = (await server.db.select({ slug: tenants.slug }).from(tenants)).map((r) => r.slug);
    expect(slugs).toEqual(expect.arrayContaining(["child", "after-child"]));
  });
});
