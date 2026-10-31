import type { AddressInfo } from "node:net";
import {
  STREAM_SUBPROTOCOL,
  type StreamMessage,
  StreamMessageSchema,
  streamSubprotocols,
} from "@memento/core";
import { Redis } from "ioredis";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { buildApp, selectSubprotocol } from "../src/app.js";
import { RedisPublisher } from "../src/publisher.js";
import { LocalBus, RedisFeed } from "../src/stream/feed.js";
import { auth, type Fixture, push, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture | null = null;
let bus: LocalBus;
let base: string;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const ws of clients.splice(0)) ws.terminate();
  await fx?.app.close();
  fx = null;
});
afterAll(() => handle.close());

/** An app with the stream on an in-memory bus, listening on a random port. */
async function start(stream: Record<string, unknown> = {}) {
  bus = new LocalBus();
  fx = await setupApp(handle, { publisher: bus, stream: { feed: bus, ...stream } });
  await fx.app.listen({ host: "127.0.0.1", port: 0 });
  base = `ws://127.0.0.1:${(fx.app.server.address() as AddressInfo).port}/memento/ws`;
  return fx;
}

/** A connected client whose messages can be awaited one by one. */
class Client {
  readonly messages: StreamMessage[] = [];
  private readonly waiting: ((message: StreamMessage) => void)[] = [];
  private seen = 0;
  closed: Promise<{ code: number; reason: string }>;

  constructor(readonly ws: WebSocket) {
    clients.push(ws);
    ws.on("message", (data) => {
      const message = StreamMessageSchema.parse(JSON.parse(String(data)));
      this.messages.push(message);
      this.waiting.shift()?.(message);
    });
    this.closed = new Promise((resolve) =>
      ws.on("close", (code, reason) => resolve({ code, reason: String(reason) })),
    );
  }

  /** The next message not yet returned by `next`. */
  next(): Promise<StreamMessage> {
    const index = this.seen++;
    const ready = this.messages[index];
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  async nextEvent(): Promise<Record<string, unknown>> {
    const message = await this.next();
    if (message.kind !== "memento.event.new") throw new Error(`expected an event: ${message.kind}`);
    expect(message.id).toBe(message.payload.id);
    return message.payload;
  }
}

async function open(
  query = "",
  options: { key?: string; protocols?: string[]; headers?: Record<string, string> } = {},
): Promise<Client> {
  const protocols = options.protocols ?? (options.key ? streamSubprotocols(options.key) : []);
  const client = new Client(
    new WebSocket(`${base}${query}`, protocols, { headers: options.headers ?? {} }),
  );
  const welcome = await client.next();
  expect(welcome.kind).toBe("memento.welcome");
  return client;
}

/** Opens a connection that the server must refuse; returns its HTTP status and body. */
function refused(
  query: string,
  protocols: string[] = [],
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${base}${query}`, protocols);
    clients.push(ws);
    ws.on("open", () => reject(new Error("connection was accepted")));
    ws.on("error", () => {});
    ws.on("unexpected-response", (_request, response) => {
      let body = "";
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () =>
        resolve({ status: response.statusCode ?? 0, body: JSON.parse(body) }),
      );
    });
  });
}

const login = {
  event_type: "USER_LOGIN",
  instance_type: "user",
  instance_id: 42,
  actor_id: "igor",
};
const message = (chat: string, actor = "igor") => ({
  event_type: "CHAT_MESSAGE_SENT",
  instance_type: "chat",
  instance_id: chat,
  actor_id: actor,
  payload: { content: "Pozdrav!", sender_user_id: actor },
});

describe("GET /memento/ws — auth", () => {
  it("accepts the bearer.<key> subprotocol and selects memento.v1", async () => {
    const { keys } = await start();
    const client = await open("", { key: keys.read });
    expect(client.ws.protocol).toBe(STREAM_SUBPROTOCOL);
    expect(client.messages[0]).toEqual({
      kind: "memento.welcome",
      payload: {
        protocol_version: "1",
        tenant: "acme",
        filter: {},
        heartbeat_interval_ms: 30_000,
        max_buffered_messages: 1000,
      },
    });
  });

  it("accepts a bare bearer protocol, and an Authorization header", async () => {
    const { keys } = await start();
    const bare = await open("", { protocols: [`bearer.${keys.read}`] });
    expect(bare.ws.protocol).toBe(`bearer.${keys.read}`);
    const header = await open("", { headers: auth(keys.read) });
    expect(header.ws.protocol).toBe("");
  });

  it("refuses an invalid or missing key with 401 and a key without read with 403", async () => {
    const { keys } = await start();
    const invalid = await refused(
      "",
      streamSubprotocols("mk_aaaaaaaa_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"),
    );
    expect(invalid.status).toBe(401);
    expect(invalid.body).toMatchObject({ ok: false, error: { code: "unauthorized" } });
    expect((await refused("", [STREAM_SUBPROTOCOL])).status).toBe(401);
    expect((await refused("")).status).toBe(401);
    expect(keys.write).toBeTruthy();
    const writeOnly = await refused("", streamSubprotocols(keys.write));
    expect(writeOnly.status).toBe(403);
  });

  it("refuses an invalid filter or locale with 422", async () => {
    const { keys } = await start();
    const bad = await refused("?event_type=login", streamSubprotocols(keys.read));
    expect(bad).toMatchObject({ status: 422, body: { error: { code: "validation_error" } } });
    expect((await refused("?colour=red", streamSubprotocols(keys.read))).status).toBe(422);
    expect((await refused("?locale=!!", streamSubprotocols(keys.read))).status).toBe(422);
  });

  it("answers a plain HTTP GET with 400", async () => {
    const { app, keys } = await start();
    const response = await app.inject({
      method: "GET",
      url: "/memento/ws",
      headers: auth(keys.read),
    });
    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("bad_request");
  });

  it("selects no protocol when neither memento.v1 nor bearer is offered", () => {
    expect(selectSubprotocol(new Set(["chat", "bearer.k"]))).toBe("bearer.k");
    expect(selectSubprotocol(new Set(["chat"]))).toBe(false);
  });

  it("advertises realtime in /describe", async () => {
    const { app, keys } = await start();
    const response = await app.inject({
      method: "GET",
      url: "/memento/describe",
      headers: auth(keys.read),
    });
    expect(response.json().data.capabilities.realtime).toBe(true);
  });
});

describe("GET /memento/ws — streaming", () => {
  it("delivers an event pushed over HTTP to every subscribed client", async () => {
    const { app, keys } = await start();
    const a = await open("", { key: keys.read });
    const b = await open("", { key: keys.admin });
    const stored = await push(app, keys.write, message("chat-acme-sales"));
    const [fromA, fromB] = await Promise.all([a.next(), b.next()]);
    expect(fromA).toEqual({ kind: "memento.event.new", id: stored.id, payload: stored });
    expect(fromB).toEqual(fromA);
    expect(stored).toMatchObject({
      event_type: "CHAT_MESSAGE_SENT",
      instance_type: "chat",
      instance_id: "chat-acme-sales",
      actor_id: "igor",
      rendered: 'igor sent a message: "Pozdrav!"',
    });
  });

  it("filters by event_type, instance and actor", async () => {
    const { app, keys } = await start();
    const logins = await open("?event_type=USER_LOGIN", { key: keys.read });
    const chat = await open("?instance_type=chat&instance_id=chat-123", { key: keys.read });
    const marko = await open("?actor_id=marko", { key: keys.read });
    const everything = await open("", { key: keys.read });

    const sent = await push(app, keys.write, message("chat-123"));
    const other = await push(app, keys.write, message("chat-999", "marko"));
    const loggedIn = await push(app, keys.write, login);

    // Events arrive in push order, so the next event a filtered client sees is the
    // first one it matches: the ones before it were filtered out, not still in flight.
    expect((await logins.nextEvent()).id).toBe(loggedIn.id);
    expect((await chat.nextEvent()).id).toBe(sent.id);
    expect((await marko.nextEvent()).id).toBe(other.id);
    const all = [
      await everything.nextEvent(),
      await everything.nextEvent(),
      await everything.nextEvent(),
    ];
    expect(all.map((e) => e.id)).toEqual([sent.id, other.id, loggedIn.id]);

    // A subscriber on USER_LOGIN never sees CHAT_MESSAGE_SENT.
    const second = await push(app, keys.write, { ...login, actor_id: "ana" });
    expect((await logins.nextEvent()).id).toBe(second.id);
    expect(
      logins.messages
        .slice(1)
        .every((m) => m.kind === "memento.event.new" && m.payload.event_type === "USER_LOGIN"),
    ).toBe(true);
  });

  it("streams only the authenticated tenant's events", async () => {
    const { app, keys } = await start();
    const acme = await open("", { key: keys.read });
    const globex = await open("", { key: keys.otherRead });
    const theirs = await push(app, keys.otherWrite, login);
    const ours = await push(app, keys.write, login);
    expect((await acme.nextEvent()).id).toBe(ours.id);
    expect((await globex.nextEvent()).id).toBe(theirs.id);
    expect(globex.messages).toHaveLength(2);
  });

  it("re-renders events for ?locale", async () => {
    const { app, keys } = await start();
    const sr = await open("?locale=sr", { key: keys.read });
    await push(app, keys.write, message("chat-1"));
    expect(await sr.nextEvent()).toMatchObject({
      rendered: 'igor je poslao poruku: "Pozdrav!"',
      rendered_locale: "sr",
    });
  });

  it("streams chat messages sent through the chats API", async () => {
    const { app, keys } = await start();
    const created = await app.inject({
      method: "POST",
      url: "/memento/chats",
      headers: auth(keys.write),
      payload: { chat_id: "sales", participants: ["igor", "marko"] },
    });
    expect(created.statusCode).toBe(201);
    const client = await open("?instance_type=chat&instance_id=chat-sales", { key: keys.read });
    await app.inject({
      method: "POST",
      url: "/memento/chats/chat-sales/messages",
      headers: auth(keys.write),
      payload: { user_id: "igor", content: "Pozdrav!" },
    });
    expect(await client.nextEvent()).toMatchObject({
      event_type: "CHAT_MESSAGE_SENT",
      instance_id: "chat-sales",
    });
  });

  it("answers memento.ping, and cleans the subscription up on disconnect", async () => {
    const { keys } = await start();
    const client = await open("", { key: keys.read });
    expect(bus.subscribed()).toEqual(["acme"]);
    client.ws.send(JSON.stringify({ kind: "memento.ping" }));
    expect(await client.next()).toEqual({ kind: "memento.pong" });
    client.ws.close();
    await client.closed;
    await expect.poll(() => bus.subscribed()).toEqual([]);
  });

  it("keeps a client that answers pings, and closes clients with 1001 on shutdown", async () => {
    const { app, keys } = await start({ heartbeatIntervalMs: 20 });
    const client = await open("", { key: keys.read });
    await new Promise((resolve) => setTimeout(resolve, 100)); // several heartbeats
    expect(client.ws.readyState).toBe(WebSocket.OPEN);
    await app.close();
    fx = null;
    expect((await client.closed).code).toBe(1001);
  });
});

describe("Redis Pub/Sub", () => {
  it("streams events pushed through RedisPublisher → RedisFeed", async () => {
    const redisUrl = process.env.REDIS_URL || "redis://localhost:6379/0";
    const probe = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 0 });
    try {
      await probe.connect();
      await probe.ping();
    } catch {
      probe.disconnect();
      console.warn(`Redis not reachable at ${redisUrl}: skipping the Redis stream test`);
      return;
    }
    const prefix = `memento-test-ws-${process.pid}`;
    const errors: unknown[] = [];
    const publisher = new RedisPublisher(redisUrl, prefix);
    const feed = new RedisFeed(redisUrl, { prefix, onError: (error) => errors.push(error) });
    fx = await setupApp(handle, { publisher, stream: { feed } });
    await fx.app.listen({ host: "127.0.0.1", port: 0 });
    base = `ws://127.0.0.1:${(fx.app.server.address() as AddressInfo).port}/memento/ws`;
    try {
      const logins = await open("?event_type=USER_LOGIN", { key: fx.keys.read });
      const all = await open("", { key: fx.keys.read });
      expect(await probe.pubsub("NUMSUB", `${prefix}:acme`)).toEqual([`${prefix}:acme`, 1]);

      await probe.publish(`${prefix}:acme`, "not json");
      await probe.publish(`elsewhere:acme`, "{}");
      const chat = await push(fx.app, fx.keys.write, message("chat-1"));
      const loggedIn = await push(fx.app, fx.keys.write, login);
      expect((await all.nextEvent()).id).toBe(chat.id);
      expect((await all.nextEvent()).id).toBe(loggedIn.id);
      expect((await logins.nextEvent()).id).toBe(loggedIn.id);
      expect(errors).toHaveLength(1);

      logins.ws.close();
      all.ws.close();
      await Promise.all([logins.closed, all.closed]);
      await expect
        .poll(async () => probe.pubsub("NUMSUB", `${prefix}:acme`))
        .toEqual([`${prefix}:acme`, 0]);
    } finally {
      await fx.app.close();
      fx = null;
      await publisher.close();
      await feed.close();
      await probe.quit();
    }
  });
});

describe("without a stream", () => {
  it("has no /ws route and realtime stays false", async () => {
    const app = await buildApp({ db: handle.db, logger: false });
    const response = await app.inject({ method: "GET", url: "/memento/ws" });
    expect(response.statusCode).toBe(404);
    await app.close();
  });
});
