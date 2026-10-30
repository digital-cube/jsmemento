import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { events } from "../src/db/schema.js";
import { auth, type Fixture, push, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;
let archivedId: string;

const at = (minute: number) => `2026-10-30T10:${String(minute).padStart(2, "0")}:00Z`;

beforeAll(async () => {
  fx = await setupApp(handle);
  const seed: [string, string, string, string | null, number][] = [
    ["USER_LOGIN", "user", "42", "igor", 0],
    ["USER_LOGOUT", "user", "42", "igor", 1],
    ["USER_LOGIN", "user", "7", "marko", 2],
    ["TICKET_CREATED", "ticket", "T-777", "igor", 3],
    ["CHAT_MESSAGE_SENT", "chat", "igor-marko", "igor", 4],
    ["CHAT_MESSAGE_SENT", "chat", "igor-marko", "marko", 5],
    ["CHAT_MESSAGE_SEEN", "chat", "igor-marko", "marko", 6],
    ["CHAT_MESSAGE_SENT", "chat", "igor-ana", null, 7],
    // `CHATXMESSAGE` must not match the prefix `CHAT_` (underscore is literal).
    ["CHATXMESSAGE", "chat", "igor-marko", "igor", 8],
  ];
  for (const [event_type, instance_type, instance_id, actor_id, minute] of seed) {
    await push(fx.app, fx.keys.write, {
      event_type,
      instance_type,
      instance_id,
      actor_id,
      occurred_at: at(minute),
    });
  }
  const archived = await push(fx.app, fx.keys.write, {
    event_type: "USER_LOGIN",
    instance_type: "user",
    instance_id: "42",
    occurred_at: at(9),
  });
  archivedId = archived.id as string;
  await handle.db.update(events).set({ archivedAt: new Date() }).where(eq(events.id, archivedId));
  // The other tenant's events must never show up for acme's keys.
  await push(fx.app, fx.keys.otherWrite, {
    event_type: "USER_LOGIN",
    instance_type: "user",
    instance_id: "42",
    occurred_at: at(30),
  });
});
afterAll(async () => {
  await fx.app.close();
  await handle.close();
});

const list = async (query = "", key = fx.keys.read) => {
  const response = await fx.app.inject({
    method: "GET",
    url: `/memento/events${query}`,
    headers: auth(key),
  });
  return { status: response.statusCode, body: response.json() };
};
const types = (body: { data: { event_type: string }[] }) => body.data.map((e) => e.event_type);

describe("GET /memento/events", () => {
  it("lists the tenant's events newest first, without archived ones", async () => {
    const { status, body } = await list();
    expect(status).toBe(200);
    expect(body.data).toHaveLength(9);
    expect(body.data[0].occurred_at).toBe("2026-10-30T10:08:00.000Z");
    expect(body.meta).toEqual({ limit: 50, count: 9, next_cursor: null });
  });

  it("filters by instance_type, instance_id and event_type", async () => {
    const { body } = await list(
      "?instance_type=user&instance_id=42&event_type=USER_LOGIN&limit=100",
    );
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({ instance_id: "42", event_type: "USER_LOGIN" });
  });

  it("supports trailing-* prefix matching with literal underscores", async () => {
    expect(types((await list("?event_type=CHAT_*")).body)).toEqual([
      "CHAT_MESSAGE_SENT",
      "CHAT_MESSAGE_SEEN",
      "CHAT_MESSAGE_SENT",
      "CHAT_MESSAGE_SENT",
    ]);
    const { body } = await list("?instance_type=chat&instance_id=igor-m*");
    expect(body.data).toHaveLength(4);
    expect((await list("?event_type=*")).body.data).toHaveLength(9);
  });

  it("filters by actor and time range", async () => {
    expect((await list("?actor_id=marko")).body.data).toHaveLength(3);
    const { body } = await list(`?after=${at(2)}&before=${at(5)}`);
    expect(body.data.map((e: { occurred_at: string }) => e.occurred_at)).toEqual([
      "2026-10-30T10:04:00.000Z",
      "2026-10-30T10:03:00.000Z",
      "2026-10-30T10:02:00.000Z",
    ]);
  });

  it("includes archived events on request", async () => {
    const { body } = await list("?include_archived=true");
    expect(body.data).toHaveLength(10);
    expect(body.data[0]).toMatchObject({ id: archivedId, archived_at: expect.any(String) });
  });

  it.each(["desc", "asc"])("pages through everything with cursors (%s)", async (order) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query = `?limit=4&order=${order}${cursor ? `&cursor=${cursor}` : ""}`;
      const { body } = await list(query);
      seen.push(...body.data.map((e: { occurred_at: string }) => e.occurred_at));
      cursor = body.meta.next_cursor;
      pages++;
    } while (cursor);
    expect(pages).toBe(3);
    expect(seen).toHaveLength(9);
    expect(new Set(seen).size).toBe(9);
    const sorted = [...seen].sort();
    expect(seen).toEqual(order === "asc" ? sorted : sorted.reverse());
  });

  it("pages correctly through events sharing the same occurred_at", async () => {
    for (let i = 0; i < 3; i++) {
      await push(fx.app, fx.keys.otherWrite, {
        event_type: "SAME_TIME",
        instance_type: "batch",
        instance_id: "b",
        occurred_at: at(40),
      });
    }
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const { body } = await list(
        `?event_type=SAME_TIME&limit=1${cursor ? `&cursor=${cursor}` : ""}`,
        fx.keys.otherRead,
      );
      ids.push(...body.data.map((e: { id: string }) => e.id));
      cursor = body.meta.next_cursor;
    } while (cursor);
    expect(new Set(ids).size).toBe(3);
  });

  it("rejects a bad cursor and bad parameters", async () => {
    const bad = await list("?cursor=garbage");
    expect(bad.status).toBe(400);
    expect(bad.body.error.code).toBe("bad_request");
    expect((await list("?limit=0")).status).toBe(422);
    expect((await list("?limit=9999")).status).toBe(422);
    expect((await list("?after=yesterday")).status).toBe(422);
    expect((await list("?order=sideways")).status).toBe(422);
  });
});

describe("tenant isolation", () => {
  it("never returns another tenant's events", async () => {
    const acme = (await list("?instance_type=user&instance_id=42&include_archived=1")).body.data;
    const globex = (await list("?instance_type=user&instance_id=42", fx.keys.otherRead)).body.data;
    expect(acme.map((e: { occurred_at: string }) => e.occurred_at)).not.toContain(
      "2026-10-30T10:30:00.000Z",
    );
    expect(globex).toHaveLength(1);
    expect(globex[0].occurred_at).toBe("2026-10-30T10:30:00.000Z");
  });

  it("entity history is tenant scoped too", async () => {
    const response = await fx.app.inject({
      method: "GET",
      url: "/memento/entities/user/42/events",
      headers: auth(fx.keys.otherRead),
    });
    expect(response.json().data).toHaveLength(1);
  });

  it("a filter on another tenant's data is just empty", async () => {
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/events/query",
      headers: auth(fx.keys.otherRead),
      payload: { filter: { field: "instance_type", op: "eq", value: "chat" } },
    });
    expect(response.json().data).toHaveLength(0);
  });
});

describe("GET /memento/entities/:instance_type/:instance_id/events", () => {
  const history = (path: string, query = "") =>
    fx.app.inject({
      method: "GET",
      url: `/memento/entities/${path}/events${query}`,
      headers: auth(fx.keys.read),
    });

  it("returns one entity's history", async () => {
    const response = await history("chat/igor-marko");
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(4);
  });

  it("does not treat the path id as a wildcard and ignores instance overrides", async () => {
    expect((await history("chat/igor-*")).json().data).toHaveLength(0);
    const response = await history("user/42", "?instance_id=7&event_type=USER_LOGOUT");
    expect(response.json().data).toEqual([
      expect.objectContaining({ instance_id: "42", event_type: "USER_LOGOUT" }),
    ]);
  });

  it("validates the entity", async () => {
    const response = await history("User/42");
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_error");
  });
});

describe("POST /memento/events/query (Filter DSL)", () => {
  const query = (body: unknown) =>
    fx.app.inject({
      method: "POST",
      url: "/memento/events/query",
      headers: auth(fx.keys.read),
      payload: body as Record<string, unknown>,
    });

  it.each([
    [{ field: "event_type", op: "in", value: ["USER_LOGIN", "USER_LOGOUT"] }, 3],
    [{ field: "event_type", op: "nin", value: ["USER_LOGIN", "USER_LOGOUT"] }, 6],
    [{ field: "event_type", op: "ne", value: "CHAT_MESSAGE_SENT" }, 6],
    [{ field: "instance_id", op: "contains", value: "MARKO" }, 4],
    [{ field: "actor_id", op: "is_null", value: true }, 1],
    [{ field: "actor_id", op: "is_null", value: false }, 8],
    [{ field: "occurred_at", op: "between", value: [at(1), at(3)] }, 3],
    [{ field: "occurred_at", op: "gt", value: at(6) }, 2],
    [{ field: "occurred_at", op: "lte", value: at(1) }, 2],
    [{ field: "received_at", op: "gte", value: "2000-01-01T00:00:00Z" }, 9],
    [
      {
        or: [
          { field: "instance_type", op: "eq", value: "ticket" },
          {
            and: [
              { field: "instance_type", op: "eq", value: "user" },
              { not: { field: "actor_id", op: "eq", value: "igor" } },
            ],
          },
        ],
      },
      2,
    ],
  ])("%j → %i events", async (filter, count) => {
    const response = await query({ filter });
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toHaveLength(count);
  });

  it("combines a filter with query options", async () => {
    const response = await query({
      filter: { field: "instance_type", op: "eq", value: "chat" },
      limit: 2,
      order: "asc",
    });
    const body = response.json();
    expect(body.data.map((e: { occurred_at: string }) => e.occurred_at)).toEqual([
      at(4).replace("Z", ".000Z"),
      at(5).replace("Z", ".000Z"),
    ]);
    expect(body.meta.next_cursor).toEqual(expect.any(String));
    expect((await query({})).json().data).toHaveLength(9);
  });

  it("rejects invalid filters and non-timestamps for time fields", async () => {
    const invalid = await query({ filter: { field: "payload", op: "eq", value: 1 } });
    expect(invalid.statusCode).toBe(422);
    const notATime = await query({ filter: { field: "occurred_at", op: "gt", value: "soon" } });
    expect(notATime.statusCode).toBe(422);
    const boolTime = await query({ filter: { field: "occurred_at", op: "eq", value: true } });
    expect(boolTime.statusCode).toBe(422);
  });
});
