import { EventEmitter } from "node:events";
import type { MementoEvent, StreamMessage } from "@memento/core";
import type { FastifyBaseLogger } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantContext } from "../src/context.js";
import { LocalBus } from "../src/stream/feed.js";
import { type ConnectionInfo, StreamHub, type StreamSocket } from "../src/stream/hub.js";

/** A `ws` look-alike: records what is sent; `flush` decides whether writes ever complete. */
class FakeSocket extends EventEmitter implements StreamSocket {
  readyState = 1;
  sent: StreamMessage[] = [];
  callbacks: ((error?: Error) => void)[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  terminated = false;
  pings = 0;

  constructor(private readonly flush = true) {
    super();
  }

  send(data: string, callback: (error?: Error) => void): void {
    this.sent.push(JSON.parse(data));
    if (this.flush) callback();
    else this.callbacks.push(callback);
  }
  ping(): void {
    this.pings++;
  }
  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
    this.emit("close");
  }
  terminate(): void {
    this.terminated = true;
    this.readyState = 3;
    this.emit("close");
  }
  events(): MementoEvent[] {
    return this.sent.flatMap((m) => (m.kind === "memento.event.new" ? [m.payload] : []));
  }
}

interface LogLine {
  level: string;
  args: unknown[];
}
function fakeLogger(lines: LogLine[]): FastifyBaseLogger {
  const logger: Record<string, unknown> = { level: "info" };
  for (const level of ["fatal", "error", "warn", "info", "debug", "trace", "silent"]) {
    logger[level] = (...args: unknown[]) => lines.push({ level, args });
  }
  logger.child = () => logger;
  return logger as unknown as FastifyBaseLogger;
}

const tenant = (slug: string): TenantContext => ({
  tenantId: `id-${slug}`,
  tenantSlug: slug,
  tenantName: slug,
  apiKeyId: "k",
  scopes: ["read"],
});

let n = 0;
const event = (overrides: Partial<MementoEvent> = {}): MementoEvent => ({
  id: `evt-${++n}`,
  occurred_at: "2026-10-30T21:00:00.000Z",
  received_at: "2026-10-30T21:00:00.000Z",
  event_type: "CHAT_MESSAGE_SENT",
  instance_type: "chat",
  instance_id: "chat-1",
  actor_id: "igor",
  payload: {},
  rendered: "igor sent a message",
  rendered_locale: "en",
  archived_at: null,
  ...overrides,
});

let bus: LocalBus;
let logs: LogLine[];
let hub: StreamHub;

function makeHub(options: { maxBufferedMessages?: number; heartbeatIntervalMs?: number } = {}) {
  hub = new StreamHub({ feed: bus, log: fakeLogger(logs), ...options });
  return hub;
}

async function connect(info: Partial<ConnectionInfo> = {}, socket = new FakeSocket()) {
  const connection = await hub.add(socket, { tenant: tenant("acme"), filter: {}, ...info });
  return { socket, connection };
}

async function publish(slug: string, e: MementoEvent) {
  await bus.publish({ tenant: slug, event: e });
  await hub.idle();
}

beforeEach(() => {
  bus = new LocalBus();
  logs = [];
});
afterEach(() => {
  hub?.close();
  vi.useRealTimers();
});

describe("StreamHub", () => {
  it("welcomes a connection with its tenant, filter and limits", async () => {
    makeHub();
    const { socket } = await connect({ filter: { event_type: "USER_LOGIN" } });
    expect(socket.sent).toEqual([
      {
        kind: "memento.welcome",
        payload: {
          protocol_version: "1",
          tenant: "acme",
          filter: { event_type: "USER_LOGIN" },
          heartbeat_interval_ms: 30_000,
          max_buffered_messages: 1000,
        },
      },
    ]);
  });

  it("delivers matching events of the connection's tenant only", async () => {
    makeHub();
    const all = await connect();
    const logins = await connect({ filter: { event_type: "USER_LOGIN" } });
    const chat = await connect({ filter: { instance_type: "chat", instance_id: "chat-2" } });
    const igor = await connect({ filter: { actor_id: "igor" } });
    const globex = await connect({ tenant: tenant("globex") });

    const message = event();
    const login = event({ event_type: "USER_LOGIN", instance_type: "user", actor_id: "ana" });
    const inChat2 = event({ instance_id: "chat-2", actor_id: "marko" });
    await publish("acme", message);
    await publish("acme", login);
    await publish("acme", inChat2);

    expect(all.socket.events()).toEqual([message, login, inChat2]);
    expect(logins.socket.events()).toEqual([login]);
    expect(chat.socket.events()).toEqual([inChat2]);
    expect(igor.socket.events()).toEqual([message]);
    expect(globex.socket.events()).toEqual([]);
    expect(all.socket.sent[1]).toEqual({
      kind: "memento.event.new",
      id: message.id,
      payload: message,
    });
  });

  it("subscribes a tenant on its first connection and unsubscribes after its last", async () => {
    makeHub();
    const a = await connect();
    const b = await connect();
    await connect({ tenant: tenant("globex") });
    expect(bus.subscribed()).toEqual(["acme", "globex"]);
    expect(hub.stats()).toEqual({ acme: 2, globex: 1 });
    a.socket.close();
    expect(bus.subscribed()).toEqual(["acme", "globex"]);
    b.socket.close();
    await Promise.resolve();
    expect(bus.subscribed()).toEqual(["globex"]);
    expect(hub.stats()).toEqual({ globex: 1 });
    await publish("acme", event());
    expect(a.socket.events()).toEqual([]);
    hub.remove(a.connection); // already gone: no-op
  });

  it("disconnects a slow consumer once 1000 messages are unwritten, and warns", async () => {
    vi.useFakeTimers();
    makeHub();
    const slow = await connect({}, new FakeSocket(false));
    const fast = await connect();
    // The welcome is the first unwritten message, 999 events fill the buffer.
    for (let i = 0; i < 999; i++) await publish("acme", event());
    expect(slow.connection.pending).toBe(1000);
    expect(slow.socket.closedWith).toBeNull();

    await publish("acme", event());
    expect(slow.socket.closedWith).toEqual({ code: 4008, reason: "slow consumer" });
    expect(slow.socket.sent).toHaveLength(1000); // welcome + 999 events
    expect(fast.socket.events()).toHaveLength(1000);
    const warning = logs.find((line) => line.level === "warn");
    expect(warning?.args).toEqual([
      { pending: 1000, max_buffered_messages: 1000 },
      "slow consumer threshold exceeded; disconnecting",
    ]);
    expect(hub.stats()).toEqual({ acme: 1 });

    vi.advanceTimersByTime(5_000);
    expect(slow.socket.terminated).toBe(true);
  });

  it("keeps a consumer whose writes complete, however many messages it gets", async () => {
    makeHub({ maxBufferedMessages: 3 });
    const socket = new FakeSocket(false);
    const { connection } = await connect({}, socket);
    for (let i = 0; i < 10; i++) {
      await publish("acme", event());
      for (const done of socket.callbacks.splice(0)) done(i === 5 ? new Error("boom") : undefined);
    }
    expect(connection.pending).toBe(0);
    expect(socket.events()).toHaveLength(10);
    expect(socket.closedWith).toBeNull();
  });

  it("pings every interval and terminates a client that missed a pong", async () => {
    vi.useFakeTimers();
    makeHub({ heartbeatIntervalMs: 1000 });
    const healthy = await connect();
    const dead = await connect();
    vi.advanceTimersByTime(1000);
    expect([healthy.socket.pings, dead.socket.pings]).toEqual([1, 1]);
    healthy.socket.emit("pong");
    vi.advanceTimersByTime(1000);
    expect(healthy.socket.pings).toBe(2);
    expect(healthy.socket.terminated).toBe(false);
    expect(dead.socket.terminated).toBe(true);
    expect(hub.stats()).toEqual({ acme: 1 });
  });

  it("answers memento.ping and rejects other client messages", async () => {
    makeHub();
    const { socket } = await connect();
    socket.emit("message", Buffer.from('{"kind":"memento.ping"}'));
    socket.emit("message", Buffer.from("not json"));
    socket.emit("message", Buffer.from('{"kind":"subscribe"}'));
    expect(socket.sent.slice(1).map((m) => m.kind)).toEqual([
      "memento.pong",
      "memento.error",
      "memento.error",
    ]);
  });

  it("closes with 1011 when the feed cannot subscribe", async () => {
    makeHub();
    vi.spyOn(bus, "subscribe").mockRejectedValueOnce(new Error("redis down"));
    const { socket } = await connect();
    expect(socket.closedWith).toEqual({ code: 1011, reason: "event feed unavailable" });
    expect(socket.sent).toEqual([]);
    expect(hub.stats()).toEqual({});
    expect(logs.some((line) => line.level === "error")).toBe(true);
    // The next connection subscribes again.
    const again = await connect();
    expect(again.socket.sent[0]?.kind).toBe("memento.welcome");
  });

  it("does not welcome a socket that closed while subscribing", async () => {
    makeHub();
    const socket = new FakeSocket();
    const pending = hub.add(socket, { tenant: tenant("acme"), filter: {} });
    socket.close();
    await pending;
    expect(socket.sent).toEqual([]);
  });

  it("logs a failed unsubscribe and a failed dispatch", async () => {
    makeHub();
    const { socket } = await connect({ locale: "sr" });
    vi.spyOn(bus, "unsubscribe").mockRejectedValueOnce(new Error("redis down"));
    socket.close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(logs.some((l) => l.level === "warn" && l.args[1] === "feed unsubscribe failed")).toBe(
      true,
    );

    const failing = new StreamHub({
      feed: new LocalBus(),
      log: fakeLogger(logs),
      renderer: {
        renderMany: async () => {
          throw new Error("render failed");
        },
      } as never,
    });
    const feed = (failing as unknown as { feed: LocalBus }).feed;
    await failing.add(new FakeSocket(), { tenant: tenant("acme"), filter: {}, locale: "sr" });
    await feed.publish({ tenant: "acme", event: event() });
    await failing.idle();
    expect(logs.some((l) => l.level === "error" && l.args[1] === "stream dispatch failed")).toBe(
      true,
    );
    failing.close();
  });

  it("re-renders for a connection's locale once per event", async () => {
    const renderMany = vi.fn(async (_tenantId: string, list: MementoEvent[], locale?: string) =>
      list.map(() => ({ text: `rendered in ${locale}`, locale: locale ?? "en", template: null })),
    );
    hub = new StreamHub({ feed: bus, log: fakeLogger(logs), renderer: { renderMany } as never });
    const sr1 = await connect({ locale: "sr" });
    const sr2 = await connect({ locale: "sr" });
    const en = await connect({ locale: "en" });
    const plain = await connect();
    const e = event();
    await publish("acme", e);
    expect(sr1.socket.events()[0]?.rendered).toBe("rendered in sr");
    expect(sr2.socket.events()[0]?.rendered_locale).toBe("sr");
    expect(en.socket.events()[0]).toEqual(e); // already in en: not re-rendered
    expect(plain.socket.events()[0]).toEqual(e);
    expect(renderMany).toHaveBeenCalledTimes(1);
  });

  it("closes every connection with 1001 on shutdown", async () => {
    makeHub();
    const a = await connect();
    const b = await connect({ tenant: tenant("globex") });
    hub.close();
    expect(a.socket.closedWith).toEqual({ code: 1001, reason: "server shutting down" });
    expect(b.socket.closedWith?.code).toBe(1001);
    expect(a.connection.send({ kind: "memento.pong" })).toBe(false);
  });
});
