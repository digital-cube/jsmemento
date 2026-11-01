import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { events } from "../src/db/schema.js";
import { ACTIVITY_FIELDS } from "../src/udc/activity.js";
import { eventCollections } from "../src/udc/collections.js";
import { auth, type Fixture, push, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;

/** The clock of the default window: 10:05:30, so the last 60 minutes start at 09:06. */
const NOW = new Date("2026-10-31T10:05:30Z");

beforeEach(async () => {
  fx = await setupApp(handle, {
    udc: eventCollections({ db: handle.db, activity: { now: () => NOW } }),
  });
});
afterAll(async () => {
  await fx.app.close();
  await handle.close();
});

async function udc(action: string, payload: unknown, key: string = fx.keys.read) {
  const response = await fx.app.inject({
    method: "POST",
    url: `/memento/udc/${action}`,
    headers: { ...auth(key), "x-udc-message-id": "m1" },
    payload: payload as Record<string, unknown>,
  });
  expect(response.statusCode).toBe(200);
  // biome-ignore lint/suspicious/noExplicitAny: the tests read deep into protocol payloads
  return response.json() as { kind: string; payload: Record<string, any> };
}
const ok = async (action: string, payload: unknown, key?: string) => {
  const answer = await udc(action, payload, key);
  expect(answer.kind, JSON.stringify(answer.payload)).toBe(`udc.${action}.ok`);
  return answer.payload;
};
const err = async (action: string, payload: unknown) => {
  const answer = await udc(action, payload);
  expect(answer.kind).toBe(`udc.${action}.err`);
  return answer.payload as { code: string; message: string };
};

const event = (event_type: string, occurred_at: string, instance_id = "x") => ({
  event_type,
  instance_type: event_type === "CPU_LOAD" ? "server" : "ticket",
  instance_id,
  actor_id: "sim",
  occurred_at,
  ...(event_type === "CPU_LOAD"
    ? { payload: { load_1min: 1, load_5min: 1, load_15min: 1 } }
    : { payload: { title: "t", text: "t" } }),
});

/**
 * Two types over three minutes (10:02, 10:03, 10:04) for acme: CPU_LOAD 3 + 2 + 1 and
 * TICKET_CREATED 1 in 10:02 and 2 in 10:04; one event of a type outside lookups.yaml; one
 * event two hours back (outside the default window); globex's events in the same minutes.
 */
async function seed() {
  const at = (minute: string, second: number) =>
    `2026-10-31T${minute}:${String(second).padStart(2, "0")}Z`;
  const acme = [
    event("CPU_LOAD", at("10:02", 1)),
    event("CPU_LOAD", at("10:02", 20)),
    event("CPU_LOAD", at("10:02", 59)),
    event("TICKET_CREATED", at("10:02", 30)),
    event("CPU_LOAD", at("10:03", 0)),
    event("CPU_LOAD", at("10:03", 45)),
    event("CPU_LOAD", at("10:04", 10)),
    event("TICKET_CREATED", at("10:04", 11)),
    event("TICKET_CREATED", at("10:04", 12)),
    event("DEPLOY_DONE", at("10:03", 30)),
    event("TICKET_CREATED", "2026-10-31T08:00:00Z"),
  ];
  for (const body of acme) await push(fx.app, fx.keys.write, body);
  for (const body of [event("CPU_LOAD", at("10:02", 5)), event("NOTE", at("10:03", 5))]) {
    await push(fx.app, fx.keys.otherWrite, body);
  }
}

type Bucket = { minute: string; event_type: string; count: number } & Record<string, unknown>;
const triples = (rows: Bucket[]) =>
  rows.map((r) => [r.minute.slice(11, 16), r.event_type, r.count]);

describe("the activity collection", () => {
  it("is listed with the other collections and described with its fields and chart", async () => {
    const { collections } = await ok("collections", {});
    expect(collections.map((c: { name: string }) => c.name)).toEqual([
      "events",
      "cpu_load",
      "activity",
    ]);
    const d = await ok("describe", { collection: "activity" });
    expect(d.schema.field_order.slice(0, 3)).toEqual(["minute", "event_type", "count"]);
    expect(d.schema.field_order).toEqual(Object.keys(ACTIVITY_FIELDS));
    expect(d.schema.fields.minute).toMatchObject({ type: "datetime", index: true });
    expect(d.schema.fields.event_type).toMatchObject({ type: "string", index: true });
    expect(d.schema.fields.count.type).toBe("integer");
    expect(d.view.default_renderer).toBe("chart");
    expect(d.view.available_renderers).toEqual(["chart", "table"]);
    expect(d.view.columns.map((c: { field: string }) => c.field)).toEqual(
      Object.keys(ACTIVITY_FIELDS),
    );
    expect(d.view.chart_options).toMatchObject({ type: "line", x_field: "minute" });
    const series = d.view.chart_options.series as { field: string; label: string; agg: string }[];
    expect(series.map((s) => s.label)).toContain("CPU_LOAD");
    expect(series.map((s) => s.field)).toEqual(Object.keys(ACTIVITY_FIELDS).slice(3));
    expect(new Set(series.map((s) => s.agg))).toEqual(new Set(["sum"]));
  });

  it("counts this tenant's events per minute and type, newest minute first", async () => {
    await seed();
    const page = await ok("list", { collection: "activity" });
    expect(page.total).toBe(6);
    expect(triples(page.rows)).toEqual([
      ["10:04", "CPU_LOAD", 1],
      ["10:04", "TICKET_CREATED", 2],
      ["10:03", "CPU_LOAD", 2],
      ["10:03", "DEPLOY_DONE", 1],
      ["10:02", "CPU_LOAD", 3],
      ["10:02", "TICKET_CREATED", 1],
    ]);
    const [first] = page.rows as Bucket[];
    expect(first?.minute).toBe("2026-10-31T10:04:00.000Z");
    expect(first?.__meta).toEqual({ id: "2026-10-31T10:04:00.000Z|CPU_LOAD", version: 1 });
  });

  it("puts each bucket's count in its own type's series column, 0 in the others", async () => {
    await seed();
    const { rows } = await ok("list", { collection: "activity" });
    const byId = new Map(
      (rows as Bucket[]).map((r) => [`${r.minute.slice(11, 16)} ${r.event_type}`, r]),
    );
    expect(byId.get("10:02 CPU_LOAD")).toMatchObject({ cpu_load: 3, ticket_created: 0, other: 0 });
    expect(byId.get("10:04 TICKET_CREATED")).toMatchObject({ cpu_load: 0, ticket_created: 2 });
    expect(byId.get("10:03 DEPLOY_DONE")).toMatchObject({ cpu_load: 0, note: 0, other: 1 });
  });

  it("never shows another tenant's events", async () => {
    await seed();
    const globex = await ok("list", { collection: "activity" }, fx.keys.otherRead);
    expect(triples(globex.rows)).toEqual([
      ["10:03", "NOTE", 1],
      ["10:02", "CPU_LOAD", 1],
    ]);
  });

  it("covers the last 60 minutes unless the filter names minute", async () => {
    await seed();
    const old = { field: "minute", op: "lt", value: "2026-10-31T09:00:00Z" };
    const older = await ok("list", { collection: "activity", filter: old });
    expect(triples(older.rows)).toEqual([["08:00", "TICKET_CREATED", 1]]);

    const all = await ok("list", {
      collection: "activity",
      filter: { field: "minute", op: "gte", value: "2026-10-31T00:00:00Z" },
    });
    expect(all.total).toBe(7);
  });

  it("narrows by a minute range and by event_type", async () => {
    await seed();
    const range = await ok("list", {
      collection: "activity",
      filter: {
        and: [
          { field: "minute", op: "gte", value: "2026-10-31T10:03:00Z" },
          { field: "minute", op: "lte", value: "2026-10-31T10:03:00Z" },
        ],
      },
    });
    expect(triples(range.rows)).toEqual([
      ["10:03", "CPU_LOAD", 2],
      ["10:03", "DEPLOY_DONE", 1],
    ]);

    const between = await ok("list", {
      collection: "activity",
      filter: {
        field: "minute",
        op: "between",
        value: ["2026-10-31T10:02:00Z", "2026-10-31T10:03:00Z"],
      },
    });
    expect(between.total).toBe(4);

    const nested = await ok("list", {
      collection: "activity",
      filter: {
        or: [
          { field: "minute", op: "eq", value: "2026-10-31T10:04:00Z" },
          { field: "minute", op: "eq", value: "2026-10-31T08:00:00Z" },
        ],
      },
    });
    expect(nested.total).toBe(3);

    const tickets = await ok("list", {
      collection: "activity",
      filter: { field: "event_type", op: "eq", value: "TICKET_CREATED" },
    });
    expect(triples(tickets.rows)).toEqual([
      ["10:04", "TICKET_CREATED", 2],
      ["10:02", "TICKET_CREATED", 1],
    ]);

    const busy = await ok("list", {
      collection: "activity",
      filter: { field: "count", op: "gte", value: 2 },
    });
    expect(busy.total).toBe(3);
  });

  it("sorts and pages by offset, total = number of buckets", async () => {
    await seed();
    const sort = [{ field: "count", dir: "desc" }];
    const first = await ok("list", { collection: "activity", sort, page: { limit: 2 } });
    const second = await ok("list", {
      collection: "activity",
      sort,
      page: { limit: 2, offset: 2 },
    });
    expect(first.total).toBe(6);
    // Ties by minute, then type, in the direction of the last sort key.
    expect(triples(first.rows)).toEqual([
      ["10:02", "CPU_LOAD", 3],
      ["10:04", "TICKET_CREATED", 2],
    ]);
    expect(triples(second.rows)).toEqual([
      ["10:03", "CPU_LOAD", 2],
      ["10:04", "CPU_LOAD", 1],
    ]);
  });

  it("leaves archived events out", async () => {
    await seed();
    await handle.db
      .update(events)
      .set({ archivedAt: new Date() })
      .where(eq(events.eventType, "DEPLOY_DONE"));
    expect((await ok("list", { collection: "activity" })).total).toBe(5);
  });

  it("reads one bucket by its id", async () => {
    await seed();
    const row = await ok("read", {
      collection: "activity",
      id: "2026-10-31T10:02:00.000Z|CPU_LOAD",
    });
    expect(row.row ?? row).toMatchObject({ event_type: "CPU_LOAD", count: 3 });
    const missing = await err("read", { collection: "activity", id: "nope" });
    expect(missing.code).toBe("not_found");
  });

  it("answers validation_error for what it cannot compile, and is read-only", async () => {
    const bad = await err("list", {
      collection: "activity",
      filter: { field: "minute", op: "gte", value: "yesterday" },
    });
    expect(bad.code).toBe("validation_error");
    const answer = await udc(
      "mutate",
      { collection: "activity", op: "delete", id: "x" },
      fx.keys.write,
    );
    expect(answer.payload.code).toBe("unsupported_op");
  });
});
