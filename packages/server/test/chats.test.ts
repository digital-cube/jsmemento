import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { chats } from "../src/db/schema.js";
import { DEFAULT_LOOKUPS_PATH, initLookups } from "../src/lookups.js";
import { auth, type Fixture, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;

afterEach(async () => {
  await fx?.app.close();
});
afterAll(() => handle.close());

type Json = Record<string, unknown> & { data?: unknown };

const call = async (method: "GET" | "POST", url: string, key: string, payload?: unknown) => {
  const response = await fx.app.inject({
    method,
    url,
    headers: auth(key),
    ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
  });
  return { status: response.statusCode, body: response.json() as Json & { data: never } };
};
const post = (url: string, payload: unknown, key = fx.keys.write) =>
  call("POST", url, key, payload);
const get = (url: string, key = fx.keys.read) => call("GET", url, key);

const at = (minute: number) => `2026-10-30T10:${String(minute).padStart(2, "0")}:00.000Z`;

async function chat(body: Record<string, unknown>): Promise<string> {
  const { status, body: res } = await post("/memento/chats", body);
  if (status !== 201) throw new Error(`create chat failed: ${JSON.stringify(res)}`);
  return (res.data as { chat_id: string }).chat_id;
}

async function send(chatId: string, user: string, content: string, minute?: number) {
  const { status, body } = await post(`/memento/chats/${chatId}/messages`, {
    user_id: user,
    content,
    ...(minute === undefined ? {} : { occurred_at: at(minute) }),
  });
  if (status !== 201) throw new Error(`send failed: ${JSON.stringify(body)}`);
  return body.data as { event_id: string; rendered: string; message: Record<string, unknown> };
}

describe("POST /memento/chats", () => {
  beforeEach(async () => {
    fx = await setupApp(handle);
  });

  it("creates a direct chat chat-<uuid> for two participants", async () => {
    const { status, body } = await post("/memento/chats", {
      participants: ["igor", "marko"],
      name: "Igor-Marko chat",
    });
    expect(status).toBe(201);
    const data = body.data as Record<string, unknown>;
    expect(data).toMatchObject({
      instance_type: "chat",
      kind: "direct",
      name: "Igor-Marko chat",
      last_message_at: null,
      archived_at: null,
      participants: [
        { user_id: "igor", last_seen_event_id: null, last_seen_at: null },
        { user_id: "marko", last_seen_event_id: null, last_seen_at: null },
      ],
    });
    expect(data.chat_id).toMatch(/^chat-[0-9a-f-]{36}$/);
    expect(data.instance_id).toBe(data.chat_id);
    expect(typeof data.created_at).toBe("string");
  });

  it("derives kind, de-duplicates participants and accepts the producer's own id", async () => {
    const room = await post("/memento/chats", { participants: ["a", "b", "c"], chat_id: 123 });
    expect(room.body.data).toMatchObject({ chat_id: "chat-123", kind: "room", name: null });
    const pair = await post("/memento/chats", {
      participants: ["igor", "igor", "marko"],
      chat_id: "chat-igor-marko",
    });
    expect(pair.body.data).toMatchObject({ chat_id: "chat-igor-marko", kind: "direct" });
    const explicit = await post("/memento/chats", { participants: ["x", "y"], kind: "room" });
    expect(explicit.body.data).toMatchObject({ kind: "room" });
    const solo = await post("/memento/chats", { participants: ["x"] });
    expect(solo.body.data).toMatchObject({ kind: "room" });
  });

  it("rejects invalid chats and duplicate ids", async () => {
    const cases: unknown[] = [
      { participants: [] },
      { participants: ["a", "b", "c"], kind: "direct" },
      { participants: ["a", "a"], kind: "direct" },
      { participants: ["a", "b"], chat_id: "bad id" },
      { participants: ["a", "b"], extra: true },
      {},
    ];
    for (const body of cases) {
      const { status, body: res } = await post("/memento/chats", body);
      expect(status, JSON.stringify(body)).toBe(422);
      expect(res).toMatchObject({ ok: false, error: { code: "validation_error" } });
    }
    await chat({ participants: ["a", "b"], chat_id: "dup" });
    const again = await post("/memento/chats", { participants: ["a", "b"], chat_id: "dup" });
    expect(again.status).toBe(409);
    expect(again.body).toMatchObject({ error: { message: 'chat "chat-dup" already exists' } });
  });

  it("needs the write scope; the same id may exist in another tenant", async () => {
    const denied = await post("/memento/chats", { participants: ["a", "b"] }, fx.keys.read);
    expect(denied.status).toBe(403);
    await chat({ participants: ["a", "b"], chat_id: "shared" });
    const other = await post(
      "/memento/chats",
      { participants: ["a", "b"], chat_id: "shared" },
      fx.keys.otherWrite,
    );
    expect(other.status).toBe(201);
  });
});

describe("chat messages", () => {
  let chatId: string;

  beforeEach(async () => {
    fx = await setupApp(handle);
    chatId = await chat({ participants: ["igor", "marko"], chat_id: "1" });
  });

  it("sends a message as a CHAT_MESSAGE_SENT event with a rendered text", async () => {
    const { status, body } = await post(`/memento/chats/${chatId}/messages`, {
      user_id: "igor",
      content: "Zdravo Marko!",
      occurred_at: "2026-10-30T12:00:00+02:00",
    });
    expect(status).toBe(201);
    const data = body.data as { event_id: string; message: Record<string, unknown> };
    expect(data).toMatchObject({
      rendered: 'igor sent a message: "Zdravo Marko!"',
      message: {
        event_type: "CHAT_MESSAGE_SENT",
        instance_type: "chat",
        instance_id: "chat-1",
        actor_id: "igor",
        occurred_at: "2026-10-30T10:00:00.000Z",
        payload: {
          content: "Zdravo Marko!",
          sender_user_id: "igor",
          timestamp: "2026-10-30T10:00:00.000Z",
        },
        rendered_locale: "en",
      },
    });
    expect(data.event_id).toBe(data.message.id);
    expect(fx.publisher.messages.map((m) => [m.tenant, m.event.id])).toEqual([
      ["acme", data.event_id],
    ]);
    const meta = await get(`/memento/chats/${chatId}?user_id=marko`);
    expect(meta.body.data).toMatchObject({ last_message_at: "2026-10-30T10:00:00.000Z" });
  });

  it("renders in ?locale and keeps last_message_at moving forward only", async () => {
    const sr = await post(`/memento/chats/${chatId}/messages?locale=sr`, {
      user_id: "marko",
      content: "Ćao!",
      occurred_at: at(30),
    });
    expect(sr.body.data).toMatchObject({ rendered: 'marko je poslao poruku: "Ćao!"' });
    await send(chatId, "igor", "late arrival", 5);
    const meta = await get(`/memento/chats/${chatId}?user_id=igor`);
    expect(meta.body.data).toMatchObject({ last_message_at: at(30) });
    const bad = await post(`/memento/chats/${chatId}/messages?locale=!!`, {
      user_id: "igor",
      content: "x",
    });
    expect(bad.status).toBe(422);
  });

  it("only participants may send; unknown and archived chats are refused", async () => {
    const outsider = await post(`/memento/chats/${chatId}/messages`, {
      user_id: "ana",
      content: "hi",
    });
    expect(outsider.status).toBe(403);
    expect(outsider.body).toMatchObject({
      error: { code: "forbidden", message: 'user "ana" is not a participant of chat-1' },
    });
    const missing = await post("/memento/chats/chat-nope/messages", {
      user_id: "igor",
      content: "hi",
    });
    expect(missing.status).toBe(404);
    const otherTenant = await post(
      `/memento/chats/${chatId}/messages`,
      { user_id: "igor", content: "hi" },
      fx.keys.otherWrite,
    );
    expect(otherTenant.status).toBe(404);
    for (const body of [{ user_id: "igor", content: "   " }, { content: "x" }]) {
      expect((await post(`/memento/chats/${chatId}/messages`, body)).status).toBe(422);
    }
    await handle.db
      .update(chats)
      .set({ archivedAt: new Date() })
      .where(eq(chats.instanceId, chatId));
    const archived = await post(`/memento/chats/${chatId}/messages`, {
      user_id: "igor",
      content: "hi",
    });
    expect(archived.status).toBe(409);
    expect(fx.publisher.messages).toHaveLength(0);
  });

  it("GET lists messages with limit/offset, order and locale", async () => {
    for (let i = 0; i < 5; i++) await send(chatId, i % 2 ? "marko" : "igor", `m${i}`, i);
    const page1 = await get(`/memento/chats/${chatId}/messages?user_id=igor&limit=2`);
    expect(page1.status).toBe(200);
    const contents = (body: Json) =>
      (body.data as { payload: { content: string } }[]).map((e) => e.payload.content);
    expect(contents(page1.body)).toEqual(["m4", "m3"]);
    expect(page1.body.meta).toMatchObject({ limit: 2, count: 2, offset: 0, next_offset: 2 });
    const page3 = await get(`/memento/chats/${chatId}/messages?user_id=igor&limit=2&offset=4`);
    expect(contents(page3.body)).toEqual(["m0"]);
    expect(page3.body.meta).toMatchObject({ count: 1, offset: 4, next_offset: null });
    const asc = await get(`/memento/chats/${chatId}/messages?user_id=marko&order=asc&locale=sr`);
    expect((asc.body.data as { rendered: string }[]).map((e) => e.rendered).slice(0, 2)).toEqual([
      'igor je poslao poruku: "m0"',
      'marko je poslao poruku: "m1"',
    ]);
    const invalid = await get(`/memento/chats/${chatId}/messages?user_id=igor&limit=0`);
    expect(invalid.status).toBe(422);
  });

  it("GET is for participants; admin keys may read without user_id", async () => {
    await send(chatId, "igor", "secret", 1);
    const noUser = await get(`/memento/chats/${chatId}/messages`);
    expect(noUser.status).toBe(403);
    expect(noUser.body).toMatchObject({
      error: { message: "user_id is required (only admin keys may omit it)" },
    });
    expect((await get(`/memento/chats/${chatId}/messages?user_id=ana`)).status).toBe(403);
    expect((await get(`/memento/chats/${chatId}/messages`, fx.keys.otherRead)).status).toBe(404);
    const admin = await get(`/memento/chats/${chatId}/messages`, fx.keys.admin);
    expect(admin.status).toBe(200);
    expect(admin.body.data).toHaveLength(1);
    expect((await get(`/memento/chats/${chatId}`)).status).toBe(403);
    expect((await get(`/memento/chats/${chatId}?user_id=ana`)).status).toBe(403);
    expect((await get(`/memento/chats/${chatId}?user_id=`)).status).toBe(422);
    expect((await get(`/memento/chats/${chatId}`, fx.keys.admin)).status).toBe(200);
  });
});

describe("POST /memento/chats/:chat_id/seen", () => {
  let chatId: string;
  let messages: string[];

  beforeEach(async () => {
    fx = await setupApp(handle);
    chatId = await chat({ participants: ["igor", "marko"], chat_id: "seen" });
    messages = [];
    for (let i = 0; i < 3; i++) messages.push((await send(chatId, "igor", `m${i}`, i)).event_id);
  });

  const seen = (body: Record<string, unknown>, query = "") =>
    post(`/memento/chats/${chatId}/seen${query}`, body);

  it("moves the watermark and pushes CHAT_MESSAGE_SEEN", async () => {
    const { status, body } = await seen({ user_id: "marko", up_to_event_id: messages[1] });
    expect(status).toBe(200);
    const data = body.data as { event_id: string; event: Record<string, unknown> };
    expect(data).toMatchObject({
      advanced: true,
      rendered: "marko read the messages",
      event: {
        event_type: "CHAT_MESSAGE_SEEN",
        instance_type: "chat",
        instance_id: "chat-seen",
        actor_id: "marko",
        payload: { user_id: "marko", messages_read_up_to: messages[1] },
      },
      participant: {
        user_id: "marko",
        last_seen_event_id: messages[1],
        last_seen_at: at(1),
      },
    });
    expect(data.event_id).toBe(data.event.id);
    const sr = await seen({ user_id: "marko", up_to_event_id: messages[2] }, "?locale=sr");
    expect(sr.body.data).toMatchObject({ advanced: true, rendered: "marko je pročitao poruke" });
    const meta = await get(`/memento/chats/${chatId}?user_id=igor`);
    expect(meta.body.data).toMatchObject({
      participants: [
        { user_id: "igor", last_seen_event_id: null },
        { user_id: "marko", last_seen_event_id: messages[2], last_seen_at: at(2) },
      ],
    });
  });

  it("never moves back: the same or an older message pushes nothing", async () => {
    await seen({ user_id: "marko", up_to_event_id: messages[2] });
    const published = fx.publisher.messages.length;
    for (const id of [messages[2], messages[0]]) {
      const { status, body } = await seen({ user_id: "marko", up_to_event_id: id });
      expect(status).toBe(200);
      expect(body.data).toMatchObject({
        advanced: false,
        event_id: null,
        event: null,
        rendered: null,
        participant: { last_seen_event_id: messages[2] },
      });
    }
    expect(fx.publisher.messages).toHaveLength(published);
    const events = await get(`/memento/chats/${chatId}/messages?user_id=igor&event_type=CHAT_*`);
    const types = (events.body.data as { event_type: string }[]).map((e) => e.event_type);
    expect(types.filter((t) => t === "CHAT_MESSAGE_SEEN")).toHaveLength(1);
  });

  it("defaults to the newest message", async () => {
    const { body } = await seen({ user_id: "igor" });
    expect(body.data).toMatchObject({
      advanced: true,
      participant: { last_seen_event_id: messages[2] },
    });
  });

  it("refuses outsiders, foreign or non-message events and empty chats", async () => {
    expect((await seen({ user_id: "ana" })).status).toBe(403);
    const other = await chat({ participants: ["igor", "marko"], chat_id: "other" });
    const foreign = await send(other, "marko", "elsewhere", 9);
    const wrongChat = await seen({ user_id: "marko", up_to_event_id: foreign.event_id });
    expect(wrongChat.status).toBe(404);
    const marker = await seen({ user_id: "marko" });
    const notMessage = await seen({
      user_id: "igor",
      up_to_event_id: (marker.body.data as { event_id: string }).event_id,
    });
    expect(notMessage.status).toBe(404);
    expect(
      (await seen({ user_id: "marko", up_to_event_id: "00000000-0000-0000-0000-000000000000" }))
        .status,
    ).toBe(404);
    expect((await seen({ user_id: "marko", up_to_event_id: "nope" })).status).toBe(422);
    const empty = await chat({ participants: ["igor", "marko"], chat_id: "empty" });
    const none = await post(`/memento/chats/${empty}/seen`, { user_id: "igor" });
    expect(none.status).toBe(409);
    expect(none.body).toMatchObject({ error: { message: "chat-empty has no messages yet" } });
  });
});

describe("POST /memento/chats/:chat_id/participants", () => {
  beforeEach(async () => {
    fx = await setupApp(handle);
  });

  it("adds a room member with a CHAT_PARTICIPANT_ADDED event", async () => {
    const room = await chat({ participants: ["igor", "marko", "jovan"], name: "Tim" });
    const { status, body } = await post(`/memento/chats/${room}/participants`, {
      user_id: "ana",
      added_by: "igor",
    });
    expect(status).toBe(201);
    expect(body.data).toMatchObject({
      rendered: "ana was added to the chat",
      event: {
        event_type: "CHAT_PARTICIPANT_ADDED",
        instance_id: room,
        actor_id: "igor",
        payload: { user_id: "ana", added_by: "igor" },
      },
      participant: { user_id: "ana", last_seen_event_id: null },
    });
    const sr = await post(`/memento/chats/${room}/participants?locale=sr`, { user_id: "mila" });
    expect(sr.body.data).toMatchObject({
      rendered: "mila je dodat u čat",
      event: { actor_id: null, payload: { user_id: "mila" } },
    });
    await send(room, "ana", "Hvala!");
    const meta = await get(`/memento/chats/${room}?user_id=ana`);
    expect(
      (meta.body.data as { participants: { user_id: string }[] }).participants.map(
        (p) => p.user_id,
      ),
    ).toEqual(["igor", "jovan", "marko", "ana", "mila"]);
  });

  it("refuses direct chats, duplicates and outsiders adding people", async () => {
    const direct = await chat({ participants: ["igor", "marko"] });
    const fixed = await post(`/memento/chats/${direct}/participants`, { user_id: "ana" });
    expect(fixed.status).toBe(409);
    const room = await chat({ participants: ["igor", "marko"], kind: "room" });
    expect((await post(`/memento/chats/${room}/participants`, { user_id: "marko" })).status).toBe(
      409,
    );
    const outsider = await post(`/memento/chats/${room}/participants`, {
      user_id: "ana",
      added_by: "eve",
    });
    expect(outsider.status).toBe(403);
    expect((await post(`/memento/chats/${room}/participants`, {})).status).toBe(422);
    expect(fx.publisher.messages).toHaveLength(0);
  });
});

describe("GET /memento/chats", () => {
  beforeEach(async () => {
    fx = await setupApp(handle);
  });

  it("lists a user's chats by last activity; admin keys list them all", async () => {
    const a = await chat({ participants: ["igor", "marko"], chat_id: "a" });
    const b = await chat({ participants: ["igor", "ana"], chat_id: "b" });
    await chat({ participants: ["marko", "ana"], chat_id: "c" });
    await send(a, "igor", "newest activity", 59);
    await send(b, "ana", "older", 1);
    const ids = (body: Json) => (body.data as { chat_id: string }[]).map((c) => c.chat_id);
    const mine = await get("/memento/chats?user_id=igor");
    expect(mine.status).toBe(200);
    expect(ids(mine.body)).toEqual(["chat-a", "chat-b"]);
    expect((mine.body.data as { participants: unknown[] }[])[0]?.participants).toHaveLength(2);
    const paged = await get("/memento/chats?user_id=igor&limit=1&offset=1");
    expect(ids(paged.body)).toEqual(["chat-b"]);
    expect(paged.body.meta).toMatchObject({ offset: 1, next_offset: null });
    expect(ids((await get("/memento/chats", fx.keys.admin)).body)).toHaveLength(3);
    expect((await get("/memento/chats?user_id=nobody")).body.data).toEqual([]);
    expect((await get("/memento/chats")).status).toBe(403);
    expect((await get("/memento/chats?limit=-1&user_id=igor")).status).toBe(422);
    expect((await get("/memento/chats", fx.keys.otherRead)).status).toBe(403);
  });
});

describe("querying chat events through /memento/events", () => {
  beforeEach(async () => {
    fx = await setupApp(handle);
    const one = await chat({ participants: ["igor", "marko"], chat_id: "123" });
    const two = await chat({ participants: ["igor", "ana", "mila"], chat_id: "456" });
    await send(one, "igor", "first", 1);
    await send(two, "ana", "second", 2);
    await post(`/memento/chats/${one}/seen`, { user_id: "marko" });
    await post(`/memento/chats/${two}/participants`, { user_id: "jovan" });
    await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.write),
      payload: { event_type: "USER_LOGIN", instance_type: "user", instance_id: "chat-999" },
    });
  });

  const pick = (body: Json) =>
    (body.data as { event_type: string; instance_id: string }[])
      .map((e) => `${e.instance_id}:${e.event_type}`)
      .sort();

  it("one chat, the whole family, and one event type across chats", async () => {
    expect(
      pick((await get("/memento/events?instance_type=chat&instance_id=chat-123")).body),
    ).toEqual(["chat-123:CHAT_MESSAGE_SEEN", "chat-123:CHAT_MESSAGE_SENT"]);
    expect(pick((await get("/memento/events?instance_type=chat&instance_id=chat-*")).body)).toEqual(
      [
        "chat-123:CHAT_MESSAGE_SEEN",
        "chat-123:CHAT_MESSAGE_SENT",
        "chat-456:CHAT_MESSAGE_SENT",
        "chat-456:CHAT_PARTICIPANT_ADDED",
      ],
    );
    expect(pick((await get("/memento/events?event_type=CHAT_MESSAGE_SENT")).body)).toEqual([
      "chat-123:CHAT_MESSAGE_SENT",
      "chat-456:CHAT_MESSAGE_SENT",
    ]);
    // Other tenants see none of it.
    expect((await get("/memento/events?instance_type=chat", fx.keys.otherRead)).body.data).toEqual(
      [],
    );
  });

  it("offset pagination works on /memento/events too, but not together with a cursor", async () => {
    const page = await get("/memento/events?instance_type=chat&order=asc&limit=3&offset=2");
    expect(page.body.meta).toMatchObject({ count: 2, offset: 2, next_offset: null });
    const first = await get("/memento/events?instance_type=chat&order=asc&limit=1");
    const cursor = (first.body.meta as { next_cursor: string }).next_cursor;
    const both = await get(`/memento/events?cursor=${cursor}&offset=1`);
    expect(both.status).toBe(400);
  });
});

describe("chat events and the vocabulary", () => {
  it("every chat event type is known in strict lookup mode; describe advertises chats", async () => {
    const lookups = await initLookups({
      path: DEFAULT_LOOKUPS_PATH,
      candidatesDir: null,
      strict: true,
    });
    fx = await setupApp(handle, { lookups });
    const room = await chat({ participants: ["igor", "marko", "ana"] });
    await send(room, "igor", "strict");
    expect((await post(`/memento/chats/${room}/seen`, { user_id: "marko" })).status).toBe(200);
    expect((await post(`/memento/chats/${room}/participants`, { user_id: "jovan" })).status).toBe(
      201,
    );
    const describe = await get("/memento/describe");
    expect(describe.body.data).toMatchObject({ capabilities: { chats: true } });
  });
});
