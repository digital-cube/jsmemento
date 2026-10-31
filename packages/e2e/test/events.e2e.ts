import type { MementoEvent } from "@memento/core";
import { beforeAll, describe, expect, it } from "vitest";
import { api, LiveFeed, newTenant, pushServer, streamServer, type TenantKeys } from "./helpers.js";

let acme: TenantKeys;
beforeAll(async () => {
  acme = await newTenant("events");
});

describe("push event → query → WebSocket stream", () => {
  it("serves the stack's health and describes it as realtime", async () => {
    const health = await fetch(`${pushServer}/api/health`);
    expect(health.status).toBe(200);
    const info = await api<{ tenant: { slug: string }; capabilities: { realtime: boolean } }>(
      acme.read,
      "GET",
      "/describe",
    );
    expect(info.status).toBe(200);
    expect(info.body.data.tenant.slug).toBe(acme.slug);
    expect(info.body.data.capabilities.realtime).toBe(true);
  });

  it("delivers a pushed event live and returns it from every query", async () => {
    const live = await LiveFeed.open(acme.read, { event_type: "USER_LOGIN" });

    const pushed = await api<MementoEvent>(acme.write, "POST", "/events?locale=sr", {
      event_type: "USER_LOGIN",
      instance_type: "user",
      instance_id: 42,
      actor_id: "igor",
      payload: { ip: "10.0.0.1" },
    });
    expect(pushed.status).toBe(201);
    const event = pushed.body.data;
    expect(event.rendered).toBe("Korisnik igor se prijavio sa adrese 10.0.0.1.");

    // live: through Redis when the stream server is another process
    const streamed = await live.next();
    expect(streamed).toMatchObject({ id: event.id, event_type: "USER_LOGIN", instance_id: "42" });
    expect(streamed.payload).toEqual({ ip: "10.0.0.1" });

    // query: list, filter DSL, entity history
    const list = await api<MementoEvent[]>(acme.read, "GET", "/events?event_type=USER_LOGIN");
    expect(list.body.data.map((e) => e.id)).toEqual([event.id]);

    const query = await api<MementoEvent[]>(acme.read, "POST", "/events/query", {
      filter: {
        and: [
          { field: "instance_type", op: "eq", value: "user" },
          { field: "actor_id", op: "in", value: ["igor", "marko"] },
        ],
      },
    });
    expect(query.status).toBe(200);
    expect(query.body.data.map((e) => e.id)).toEqual([event.id]);

    const history = await api<MementoEvent[]>(
      acme.read,
      "GET",
      "/entities/user/42/events?locale=en",
      undefined,
      streamServer,
    );
    expect(history.body.data).toHaveLength(1);
    expect(history.body.data[0]?.rendered).toBe("User igor logged in from 10.0.0.1.");
  });

  it("streams only what matches the connection's filter, in order", async () => {
    const tickets = await LiveFeed.open(acme.read, { instance_type: "ticket" });
    for (const event_type of ["TICKET_CREATED", "USER_LOGOUT", "TICKET_CLOSED"]) {
      const instance_type = event_type.startsWith("TICKET") ? "ticket" : "user";
      const response = await api(acme.write, "POST", "/events", {
        event_type,
        instance_type,
        instance_id: "T-1",
        actor_id: "igor",
      });
      expect(response.status).toBe(201);
    }
    expect((await tickets.next()).event_type).toBe("TICKET_CREATED");
    expect((await tickets.next()).event_type).toBe("TICKET_CLOSED");
    expect(tickets.events.map((e) => e.event_type)).toEqual(["TICKET_CREATED", "TICKET_CLOSED"]);
  });

  it("refuses the stream without a valid key before the upgrade", async () => {
    await expect(LiveFeed.open("mk_not-a-key")).rejects.toThrow(/closed before welcome/);
    const ws = await fetch(`${streamServer}/ws`, { headers: { authorization: "Bearer nope" } });
    expect(ws.status).toBe(401);
  });
});
