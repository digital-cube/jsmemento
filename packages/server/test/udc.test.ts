import { eq } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { events } from "../src/db/schema.js";
import { actionOf, scopeForAction } from "../src/udc/plugin.js";
import { auth, type Fixture, push, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;

beforeEach(async () => {
  fx = await setupApp(handle);
});
afterAll(async () => {
  await fx.app.close();
  await handle.close();
});

async function udc(
  action: string,
  payload: unknown,
  key: string | null = fx.keys.read,
  headers: Record<string, string> = {},
) {
  const response = await fx.app.inject({
    method: "POST",
    url: `/memento/udc/${action}`,
    headers: { ...(key ? auth(key) : {}), "x-udc-message-id": "m1", ...headers },
    payload: payload as Record<string, unknown>,
  });
  expect(response.statusCode).toBe(200);
  // biome-ignore lint/suspicious/noExplicitAny: the tests read deep into protocol payloads
  return response.json() as { kind: string; id: string; payload: Record<string, any> };
}

const ok = async (action: string, payload: unknown, key?: string) => {
  const answer = await udc(action, payload, key);
  expect(answer.kind, JSON.stringify(answer.payload)).toBe(`udc.${action}.ok`);
  return answer.payload;
};
const err = async (action: string, payload: unknown, key?: string | null) => {
  const answer = await udc(action, payload, key);
  expect(answer.kind).toBe(`udc.${action}.err`);
  return answer.payload as { code: string; message: string };
};

const cpu = (instance_id: string, load: [number, number, number], at: string) => ({
  event_type: "CPU_LOAD",
  instance_type: "server",
  instance_id,
  actor_id: "monitor",
  occurred_at: at,
  payload: { load_1min: load[0], load_5min: load[1], load_15min: load[2] },
});

async function seed() {
  await push(fx.app, fx.keys.write, cpu("backend-01", [0.25, 0.2, 0.1], "2026-10-31T10:00:00Z"));
  await push(fx.app, fx.keys.write, cpu("backend-01", [1.5, 0.9, 0.4], "2026-10-31T10:00:01Z"));
  await push(fx.app, fx.keys.write, cpu("backend-02", [0.75, 0.5, 0.3], "2026-10-31T10:00:02Z"));
  await push(fx.app, fx.keys.write, {
    event_type: "USER_LOGIN",
    instance_type: "user",
    instance_id: "42",
    actor_id: "igor",
    occurred_at: "2026-10-31T10:00:03Z",
  });
  await push(fx.app, fx.keys.otherWrite, cpu("globex-01", [9, 9, 9], "2026-10-31T10:00:04Z"));
}

describe("UDC auth", () => {
  it("refuses a request without a key, in-protocol", async () => {
    const answer = await udc("collections", {}, null);
    expect(answer).toEqual({
      kind: "udc.collections.err",
      id: "m1",
      payload: { code: "forbidden", message: "missing API key" },
    });
  });

  it("refuses an unknown key", async () => {
    expect((await err("list", { collection: "events" }, "mk_nope_nope")).code).toBe("forbidden");
  });

  it("needs the write scope for a mutation", async () => {
    const refused = await err("mutate", { collection: "events", op: "delete", id: "x" });
    expect(refused).toEqual({
      code: "forbidden",
      message: 'this API key lacks the "write" scope',
    });
    const immutable = await err(
      "mutate",
      { collection: "events", op: "delete", id: "x" },
      fx.keys.write,
    );
    expect(immutable.code).toBe("unsupported_op");
  });

  it("leaves the plugin's health check open", async () => {
    const response = await fx.app.inject({ method: "GET", url: "/memento/healthz" });
    expect(response.json()).toEqual({ ok: true });
  });

  it("maps actions to scopes and URLs to actions", () => {
    expect(scopeForAction("list")).toBe("read");
    expect(scopeForAction("schema.add_field")).toBe("write");
    expect(actionOf("/memento/udc/list?x=1")).toBe("list");
    expect(actionOf("/memento/udc/tree.reparent")).toBe("tree.reparent");
    expect(actionOf("/memento/healthz")).toBeNull();
  });
});

describe("UDC collections", () => {
  it("lists events and cpu_load, read-only, offset-paged", async () => {
    const { collections } = await ok("collections", {});
    expect(collections.map((c: { name: string }) => c.name)).toEqual(["events", "cpu_load"]);
    expect(collections[1]).toMatchObject({
      label: "CPU load",
      default_renderer: "table",
      capabilities: { mutate: false, total_count: true, paging: ["offset"] },
    });
  });

  it("describes cpu_load with its load columns and chart", async () => {
    const d = await ok("describe", { collection: "cpu_load" });
    expect(d.schema.field_order).toEqual([
      "occurred_at",
      "instance_type",
      "instance_id",
      "load_1min",
      "load_5min",
      "load_15min",
      "rendered",
    ]);
    expect(d.schema.fields.load_1min.type).toBe("decimal");
    expect(d.view.available_renderers).toEqual(["table", "chart"]);
    expect(d.view.columns.map((c: { field: string }) => c.field)).toContain("load_15min");
    const filterable = d.filterable.fields.find((f: { field: string }) => f.field === "load_1min");
    expect(filterable.ops).toContain("gt");
  });

  it("is not served with udc: false", async () => {
    const app = await buildApp({ db: handle.db, logger: false, udc: false });
    const response = await app.inject({
      method: "POST",
      url: "/memento/udc/collections",
      headers: auth(fx.keys.read),
      payload: {},
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});

describe("UDC list", () => {
  beforeEach(seed);

  it("serves only this tenant's CPU_LOAD events, newest first, with an exact total", async () => {
    const page = await ok("list", { collection: "cpu_load" });
    expect(page.total).toBe(3);
    expect(page.next_cursor).toBeNull();
    expect(page.rows.map((r: { instance_id: string }) => r.instance_id)).toEqual([
      "backend-02",
      "backend-01",
      "backend-01",
    ]);
    expect(page.rows[0]).toEqual({
      __meta: { id: expect.any(String), version: 1 },
      occurred_at: "2026-10-31T10:00:02.000Z",
      instance_type: "server",
      instance_id: "backend-02",
      load_1min: 0.75,
      load_5min: 0.5,
      load_15min: 0.3,
      rendered: "Server backend-02 — CPU: 0.75, 0.5, 0.3",
    });
    const other = await ok("list", { collection: "cpu_load" }, fx.keys.otherRead);
    expect(other.rows.map((r: { instance_id: string }) => r.instance_id)).toEqual(["globex-01"]);
  });

  it("serves every event in the events collection, payload included", async () => {
    const page = await ok("list", { collection: "events" });
    expect(page.total).toBe(4);
    expect(page.rows[0]).toMatchObject({
      event_type: "USER_LOGIN",
      actor_id: "igor",
      payload: {},
      rendered: "User igor logged in.",
    });
    const nonEmpty = await ok("list", {
      collection: "events",
      filter: { not: { field: "payload", op: "is_null" } },
    });
    expect(nonEmpty.total).toBe(4);
  });

  it("renders the rows in the locale X-Memento-Locale names", async () => {
    const login = { field: "event_type", op: "eq", value: "USER_LOGIN" };
    const list = async (headers: Record<string, string>) =>
      udc("list", { collection: "events", filter: login }, fx.keys.read, headers);
    const sr = await list({ "x-memento-locale": "sr" });
    expect(sr.payload.rows[0].rendered).toBe("Korisnik igor se prijavio.");
    const en = await list({ "x-memento-locale": "en" });
    expect(en.payload.rows[0].rendered).toBe("User igor logged in.");
    // Unknown locales fall back along the chain; malformed ones are refused in-protocol.
    expect((await list({ "x-memento-locale": "sr-Latn-RS" })).payload.rows[0].rendered).toBe(
      "Korisnik igor se prijavio.",
    );
    const bad = await list({ "x-memento-locale": "Serbian!" });
    expect(bad.kind).toBe("udc.list.err");
    expect(bad.payload).toEqual({
      code: "validation_error",
      message: "invalid x-memento-locale: Serbian!",
    });
  });

  it("filters on payload numbers, text and time", async () => {
    const ids = async (filter: unknown, collection = "cpu_load") =>
      (await ok("list", { collection, filter })).rows.map(
        (r: { load_1min: number }) => r.load_1min,
      );
    expect(await ids({ field: "load_1min", op: "gt", value: 0.5 })).toEqual([0.75, 1.5]);
    expect(await ids({ field: "load_1min", op: "lte", value: "0.75" })).toEqual([0.75, 0.25]);
    expect(await ids({ field: "load_5min", op: "between", value: [0.4, 1] })).toEqual([0.75, 1.5]);
    expect(await ids({ field: "instance_id", op: "eq", value: "backend-02" })).toEqual([0.75]);
    expect(await ids({ field: "instance_id", op: "neq", value: "backend-02" })).toEqual([
      1.5, 0.25,
    ]);
    expect(
      await ids({
        field: "instance_id",
        op: "starts_with",
        value: "BACKEND",
        case_insensitive: true,
      }),
    ).toHaveLength(3);
    expect(await ids({ field: "instance_id", op: "starts_with", value: "BACKEND" })).toEqual([]);
    expect(await ids({ field: "instance_id", op: "ends_with", value: "-01" })).toEqual([1.5, 0.25]);
    expect(await ids({ field: "rendered", op: "contains", value: "1.5" })).toEqual([1.5]);
    expect(await ids({ field: "instance_id", op: "in", value: ["backend-02", "x"] })).toEqual([
      0.75,
    ]);
    expect(await ids({ field: "instance_id", op: "in", value: [] })).toEqual([]);
    expect(await ids({ field: "instance_id", op: "not_in", value: [] })).toHaveLength(3);
    expect(await ids({ field: "instance_id", op: "not_in", value: ["backend-01"] })).toEqual([
      0.75,
    ]);
    expect(
      await ids({ field: "occurred_at", op: "gte", value: "2026-10-31T12:00:01+02:00" }),
    ).toEqual([0.75, 1.5]);
    expect(
      await ids({ field: "occurred_at", op: "lt", value: Date.parse("2026-10-31T10:00:01Z") }),
    ).toEqual([0.25]);
    expect(
      await ids({
        or: [
          { field: "instance_id", op: "eq", value: "backend-02" },
          {
            and: [
              { field: "load_1min", op: "lt", value: 0.5 },
              { field: "load_1min", op: "is_not_null" },
            ],
          },
        ],
      }),
    ).toEqual([0.75, 0.25]);
    expect(await ids({ field: "load_15min", op: "is_null" })).toEqual([]);
    expect(await ids({ and: [] })).toHaveLength(3);
    expect(await ids({ or: [] })).toEqual([]);
  });

  it("sorts by any field, nulls last, ties by id", async () => {
    const page = await ok("list", {
      collection: "cpu_load",
      sort: [{ field: "load_1min", dir: "asc" }],
    });
    expect(page.rows.map((r: { load_1min: number }) => r.load_1min)).toEqual([0.25, 0.75, 1.5]);
    const byInstance = await ok("list", {
      collection: "cpu_load",
      sort: [{ field: "instance_id" }, { field: "occurred_at", dir: "desc" }],
    });
    expect(byInstance.rows.map((r: { load_1min: number }) => r.load_1min)).toEqual([
      1.5, 0.25, 0.75,
    ]);
  });

  it("pages by offset", async () => {
    const first = await ok("list", { collection: "cpu_load", page: { limit: 2 } });
    const second = await ok("list", { collection: "cpu_load", page: { limit: 2, offset: 2 } });
    expect(first.rows).toHaveLength(2);
    expect(first.total).toBe(3);
    expect(second.rows.map((r: { load_1min: number }) => r.load_1min)).toEqual([0.25]);
  });

  it("hides archived events", async () => {
    const [row] = await handle.db.select().from(events).where(eq(events.instanceId, "backend-02"));
    await handle.db
      .update(events)
      .set({ archivedAt: new Date() })
      .where(eq(events.id, row?.id as string));
    expect((await ok("list", { collection: "cpu_load" })).total).toBe(2);
  });

  it("answers validation_error for what it cannot compile", async () => {
    const bad = async (payload: Record<string, unknown>) =>
      (await err("list", { collection: "cpu_load", ...payload })).message;
    expect(await bad({ filter: { field: "nope", op: "eq", value: 1 } })).toContain(
      '"nope" cannot be filtered',
    );
    expect(await bad({ filter: { field: "load_1min", op: "contains", value: "1" } })).toContain(
      "needs a text field",
    );
    expect(await bad({ filter: { field: "load_1min", op: "gt", value: "high" } })).toContain(
      "needs a number",
    );
    expect(await bad({ filter: { field: "occurred_at", op: "gt", value: "soon" } })).toContain(
      "needs a timestamp",
    );
    expect(await bad({ filter: { field: "instance_id", op: "eq", value: { a: 1 } } })).toContain(
      "needs a value",
    );
    expect(await bad({ filter: { field: "instance_id", op: "in", value: "x" } })).toContain(
      "needs an array",
    );
    expect(await bad({ filter: { field: "load_1min", op: "between", value: [1] } })).toContain(
      "[low, high]",
    );
    expect(await bad({ page: { cursor: "abc" } })).toContain("offset");
    const json = await err("list", {
      collection: "events",
      filter: { field: "payload", op: "eq", value: "x" },
    });
    expect(json.message).toContain("only is_null");
    const sort = await err("list", { collection: "events", sort: [{ field: "payload" }] });
    expect(sort.message).toContain("cannot be sorted");
    expect((await err("list", { collection: "nope" })).code).toBe("not_found");
  });
});

describe("UDC read", () => {
  beforeEach(seed);

  it("reads one event of this tenant", async () => {
    const [first] = (await ok("list", { collection: "cpu_load", page: { limit: 1 } })).rows;
    const { row } = await ok("read", { collection: "cpu_load", id: first.__meta.id });
    expect(row).toEqual(first);
    expect((await err("read", { collection: "cpu_load", id: "nope" })).code).toBe("not_found");
    const globex = await ok("list", { collection: "cpu_load" }, fx.keys.otherRead);
    const foreign = await err("read", { collection: "cpu_load", id: globex.rows[0].__meta.id });
    expect(foreign.code).toBe("not_found");
    const login = (await ok("list", { collection: "events", page: { limit: 1 } })).rows[0];
    expect((await err("read", { collection: "cpu_load", id: login.__meta.id })).code).toBe(
      "not_found",
    );
  });
});
