import { eq, sql } from "drizzle-orm";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/app.js";
import { runWithTenant } from "../src/context.js";
import { events } from "../src/db/schema.js";
import type { EventPublisher } from "../src/publisher.js";
import { authenticateApiKey } from "../src/services/apikeys.js";
import { pushEvent } from "../src/services/events.js";
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

const post = (payload: unknown, key = fx.keys.write, headers: Record<string, string> = {}) =>
  fx.app.inject({
    method: "POST",
    url: "/memento/events",
    headers: { ...auth(key), ...headers },
    payload: payload as Record<string, unknown>,
  });

describe("POST /memento/events", () => {
  it("stores a valid event, returns it and publishes it", async () => {
    const response = await post({
      event_type: "USER_LOGIN",
      instance_type: "user",
      instance_id: 42,
      actor_id: "igor",
      payload: { ip: "10.0.0.1" },
      occurred_at: "2026-10-30T10:00:00+02:00",
    });
    expect(response.statusCode).toBe(201);
    const event = response.json().data;
    expect(event).toMatchObject({
      id: expect.any(String),
      event_type: "USER_LOGIN",
      instance_type: "user",
      instance_id: "42",
      actor_id: "igor",
      payload: { ip: "10.0.0.1" },
      occurred_at: "2026-10-30T08:00:00.000Z",
      rendered: "User igor logged in from 10.0.0.1.",
      rendered_locale: "en",
      archived_at: null,
    });
    expect(fx.publisher.messages).toEqual([{ tenant: "acme", event }]);
    const [row] = await handle.db.select().from(events).where(eq(events.id, event.id));
    expect(row?.tenantId).toBeDefined();
  });

  it("defaults occurred_at to now and payload to {}", async () => {
    const before = Date.now();
    const event = (
      await post({ event_type: "PING", instance_type: "system", instance_id: "x" })
    ).json().data;
    expect(Date.parse(event.occurred_at)).toBeGreaterThanOrEqual(before - 5);
    expect(event.payload).toEqual({});
    expect(event.actor_id).toBeNull();
  });

  it("keeps a pre-rendered story", async () => {
    const event = (
      await post({
        event_type: "CHAT_MESSAGE_SENT",
        instance_type: "chat",
        instance_id: "igor-marko",
        rendered: 'Igor je poslao poruku: "Pozdrav!"',
      })
    ).json().data;
    expect(event.rendered).toBe('Igor je poslao poruku: "Pozdrav!"');
    expect(event.rendered_locale).toBeNull();
  });

  it.each([
    [{ instance_type: "user", instance_id: "1" }, "event_type"],
    [{ event_type: "user login", instance_type: "user", instance_id: "1" }, "event_type"],
    [{ event_type: "A", instance_type: "User", instance_id: "1" }, "instance_type"],
    [{ event_type: "A", instance_type: "user" }, "instance_id"],
    [{ event_type: "A", instance_type: "user", instance_id: "" }, "instance_id"],
    [{ event_type: "A", instance_type: "user", instance_id: "1", payload: "x" }, "payload"],
    [
      { event_type: "A", instance_type: "user", instance_id: "1", occurred_at: "nope" },
      "occurred_at",
    ],
    [{ event_type: "A", instance_type: "user", instance_id: "1", actor_id: { id: 1 } }, "actor_id"],
  ])("rejects %j with a validation_error naming %s", async (payload, field) => {
    const response = await post(payload);
    expect(response.statusCode).toBe(422);
    const body = response.json();
    expect(body.error.code).toBe("validation_error");
    expect(body.error.details.map((issue: { path: string[] }) => issue.path[0])).toContain(field);
    expect(fx.publisher.messages).toHaveLength(0);
  });

  it("rejects unknown fields", async () => {
    const response = await post({
      event_type: "A",
      instance_type: "u",
      instance_id: "1",
      tenant_id: "x",
    });
    expect(response.statusCode).toBe(422);
  });

  it("rejects malformed JSON and non-JSON bodies with bad_request", async () => {
    const broken = await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: { ...auth(fx.keys.write), "content-type": "application/json" },
      payload: "{nope",
    });
    expect(broken.statusCode).toBe(400);
    expect(broken.json().error.code).toBe("bad_request");
    const text = await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: { ...auth(fx.keys.write), "content-type": "application/xml" },
      payload: "<event/>",
    });
    expect(text.statusCode).toBe(415);
    expect(text.json().ok).toBe(false);
  });

  it("stores the event even when publishing fails", async () => {
    const failing: EventPublisher = {
      publish: async () => {
        throw new Error("redis down");
      },
      close: async () => {},
    };
    const app = await buildApp({ db: handle.db, publisher: failing, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.write),
      payload: { event_type: "A", instance_type: "user", instance_id: "1" },
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it("works without a publisher (NoopPublisher)", async () => {
    const app = await buildApp({ db: handle.db, logger: false });
    const response = await app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.write),
      payload: { event_type: "A", instance_type: "user", instance_id: "1" },
    });
    expect(response.statusCode).toBe(201);
    await app.close();
  });

  it("answers unexpected failures with internal_error", async () => {
    const app = await buildApp({ db: handle.db, publisher: fx.publisher, logger: false });
    await handle.db.execute(sql`alter table memento_event rename to memento_event_tmp`);
    try {
      const response = await app.inject({
        method: "POST",
        url: "/memento/events",
        headers: auth(fx.keys.write),
        payload: { event_type: "A", instance_type: "user", instance_id: "1" },
      });
      expect(response.statusCode).toBe(500);
      expect(response.json().error).toEqual({
        code: "internal_error",
        message: "internal server error",
      });
    } finally {
      await handle.db.execute(sql`alter table memento_event_tmp rename to memento_event`);
      await app.close();
    }
  });
});

describe("immutability", () => {
  it("the database refuses to change or delete an event, but allows archiving", async () => {
    const context = await authenticateApiKey(handle.db, fx.keys.write);
    const event = await runWithTenant(context, () =>
      pushEvent(
        handle.db,
        { event_type: "A", instance_type: "user", instance_id: "1" },
        { publisher: fx.publisher },
      ),
    );
    await expect(
      handle.db.update(events).set({ eventType: "B" }).where(eq(events.id, event.id)),
    ).rejects.toThrow();
    await expect(handle.db.delete(events).where(eq(events.id, event.id))).rejects.toThrow();
    await handle.db.update(events).set({ archivedAt: new Date() }).where(eq(events.id, event.id));
    await expect(
      handle.db.update(events).set({ archivedAt: new Date() }).where(eq(events.id, event.id)),
    ).rejects.toThrow();
  });

  it("services refuse to run outside a tenant context", async () => {
    await expect(
      pushEvent(
        handle.db,
        { event_type: "A", instance_type: "user", instance_id: "1" },
        { publisher: fx.publisher },
      ),
    ).rejects.toMatchObject({ code: "unauthorized" });
  });
});
