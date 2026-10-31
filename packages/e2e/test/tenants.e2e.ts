import type { Chat, MementoEvent } from "@memento/core";
import { beforeAll, describe, expect, it } from "vitest";
import { api, LiveFeed, newTenant, type TenantKeys } from "./helpers.js";

let a: TenantKeys;
let b: TenantKeys;
beforeAll(async () => {
  a = await newTenant("a");
  b = await newTenant("b");
});

const login = (actor_id: string) => ({
  event_type: "USER_LOGIN",
  instance_type: "user",
  instance_id: "shared-7",
  actor_id,
});

describe("tenant isolation", () => {
  it("a user of tenant A sees only tenant A events — in queries and live", async () => {
    const liveA = await LiveFeed.open(a.read);
    const liveB = await LiveFeed.open(b.read);

    // both tenants write to an entity with the same type and id
    const fromA = (await api<MementoEvent>(a.write, "POST", "/events", login("alice"))).body.data;
    const fromB = (await api<MementoEvent>(b.write, "POST", "/events", login("bob"))).body.data;

    // live: each stream gets its own tenant's event first, and never the other's
    expect((await liveA.next()).id).toBe(fromA.id);
    expect((await liveB.next()).id).toBe(fromB.id);
    expect(liveA.events.map((e) => e.id)).toEqual([fromA.id]);
    expect(liveB.events.map((e) => e.id)).toEqual([fromB.id]);

    // queries
    const listA = await api<MementoEvent[]>(a.read, "GET", "/events");
    expect(listA.body.data.map((e) => e.id)).toEqual([fromA.id]);
    const listB = await api<MementoEvent[]>(b.read, "GET", "/events");
    expect(listB.body.data.map((e) => e.id)).toEqual([fromB.id]);

    const historyA = await api<MementoEvent[]>(a.read, "GET", "/entities/user/shared-7/events");
    expect(historyA.body.data.map((e) => e.actor_id)).toEqual(["alice"]);

    const queryB = await api<MementoEvent[]>(b.read, "POST", "/events/query", {
      filter: { field: "actor_id", op: "eq", value: "alice" },
    });
    expect(queryB.body.data).toEqual([]);
  });

  it("does not let a key name another tenant", async () => {
    const forged = await api(a.write, "POST", "/events", {
      ...login("mallory"),
      tenant_id: b.slug,
    });
    expect(forged.status).toBe(422);
    const listB = await api<MementoEvent[]>(b.read, "GET", "/events?actor_id=mallory");
    expect(listB.body.data).toEqual([]);
  });

  it("hides tenant A's chats from tenant B", async () => {
    const chat = (await api<Chat>(a.write, "POST", "/chats", { participants: ["alice", "carol"] }))
      .body.data;
    const peek = await api(b.read, "GET", `/chats/${chat.chat_id}?user_id=alice`);
    expect(peek.status).toBe(404);
    const write = await api(b.write, "POST", `/chats/${chat.chat_id}/messages`, {
      user_id: "alice",
      content: "hi from B",
    });
    expect(write.status).toBe(404);
    const messages = await api<MementoEvent[]>(
      a.read,
      "GET",
      `/chats/${chat.chat_id}/messages?user_id=alice`,
    );
    expect(messages.body.data).toEqual([]);
  });
});
