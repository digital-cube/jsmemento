import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import {
  liveFilter,
  type MementoEvent,
  MementoStream,
  type StreamStatus,
  streamEvent,
  streamUrl,
  type WebSocketLike,
} from "../src/index.js";

const event: MementoEvent = {
  id: "0199a000-0000-7000-8000-000000000001",
  occurred_at: "2026-10-30T21:00:00.000Z",
  received_at: "2026-10-30T21:00:00.100Z",
  event_type: "CHAT_MESSAGE_SENT",
  instance_type: "chat",
  instance_id: "chat-acme-sales",
  actor_id: "igor",
  payload: { content: "Pozdrav!" },
  rendered: 'igor je poslao poruku: "Pozdrav!"',
  rendered_locale: "sr",
  archived_at: null,
};

const welcome = (filter = {}) =>
  JSON.stringify({
    kind: "memento.welcome",
    payload: {
      protocol_version: "1",
      tenant: "acme",
      filter,
      heartbeat_interval_ms: 30000,
      max_buffered_messages: 1000,
    },
  });

/** A WebSocket double the test drives by hand. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  closed: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.instances.push(this);
  }
  send(): void {}
  close(code?: number, reason?: string): void {
    this.closed = { code, reason };
  }
  receive(data: string): void {
    this.onmessage?.({ data });
  }
  drop(code = 1006, reason = ""): void {
    this.onerror?.({});
    this.onclose?.({ code, reason });
  }
}

afterEach(() => {
  FakeSocket.instances = [];
  vi.useRealTimers();
});

describe("streamUrl", () => {
  it("turns the API base URL into the ws URL with the filter", () => {
    expect(streamUrl("http://localhost:8000/memento/")).toBe("ws://localhost:8000/memento/ws");
    expect(
      streamUrl(
        "https://m.example.com/memento",
        { event_type: "USER_LOGIN", actor_id: "igor" },
        "sr",
      ),
    ).toBe("wss://m.example.com/memento/ws?event_type=USER_LOGIN&actor_id=igor&locale=sr");
    expect(streamUrl("ws://h/m")).toBe("ws://h/m/ws");
  });

  it("resolves a relative base against the page location", () => {
    vi.stubGlobal("location", { href: "https://app.example.com/dashboard" });
    try {
      expect(streamUrl("/memento", { instance_type: "chat" })).toBe(
        "wss://app.example.com/memento/ws?instance_type=chat",
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("liveFilter", () => {
  it("sends exact values to the server and applies prefixes locally", () => {
    const { filter, matches } = liveFilter({
      event_type: "CHAT_*",
      instance_type: "chat",
      instance_id: " ",
      actor_id: undefined,
    });
    expect(filter).toEqual({ instance_type: "chat" });
    expect(matches(event)).toBe(true);
    expect(matches({ ...event, event_type: "USER_LOGIN" })).toBe(false);
    expect(matches({ ...event, instance_type: "user" })).toBe(false);
  });

  it("treats a bare * as no filter and a null actor as no match for a prefix", () => {
    expect(liveFilter({ event_type: "*" }).filter).toEqual({});
    expect(liveFilter({ event_type: "*" }).matches(event)).toBe(true);
    expect(liveFilter({ actor_id: "ig*" }).matches({ ...event, actor_id: null })).toBe(false);
    expect(liveFilter({ actor_id: "ig*" }).matches(event)).toBe(true);
  });
});

describe("MementoStream", () => {
  const open = (options: Partial<ConstructorParameters<typeof MementoStream>[0]> = {}) => {
    const statuses: StreamStatus[] = [];
    const events: MementoEvent[] = [];
    const stream = new MementoStream({
      baseUrl: "http://localhost:8000/memento",
      apiKey: "mk_abc_def",
      WebSocket: FakeSocket,
      onStatus: (s) => statuses.push(s),
      onEvent: (e) => events.push(e),
      ...options,
    });
    return { stream, statuses, events };
  };

  it("authenticates with subprotocols and is live after the welcome", () => {
    const onWelcome = vi.fn();
    const { stream, statuses, events } = open({
      filter: { event_type: "CHAT_MESSAGE_SENT" },
      onWelcome,
    });
    const socket = FakeSocket.instances[0] as FakeSocket;
    expect(socket.url).toBe("ws://localhost:8000/memento/ws?event_type=CHAT_MESSAGE_SENT");
    expect(socket.protocols).toEqual(["memento.v1", "bearer.mk_abc_def"]);
    expect(stream.status).toBe("connecting");
    socket.receive(welcome({ event_type: "CHAT_MESSAGE_SENT" }));
    expect(stream.status).toBe("live");
    expect(onWelcome).toHaveBeenCalledWith(expect.objectContaining({ tenant: "acme" }));
    socket.receive(JSON.stringify(streamEvent(event)));
    socket.receive("not json");
    socket.receive(JSON.stringify({ kind: "something.else" }));
    socket.receive(JSON.stringify({ kind: "memento.pong" }));
    expect(events).toEqual([event]);
    stream.close();
    expect(socket.closed).toEqual({ code: 1000, reason: "client closed" });
    expect(statuses).toEqual(["live", "closed"]);
  });

  it("reconnects with exponential backoff after a drop", () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const { stream, statuses } = open({
      reconnect: { initialDelayMs: 100, maxDelayMs: 250 },
      onClose,
    });
    (FakeSocket.instances[0] as FakeSocket).drop(1006);
    expect(stream.status).toBe("offline");
    expect(onClose).toHaveBeenLastCalledWith({ code: 1006, reason: "", reconnectInMs: 100 });
    vi.advanceTimersByTime(100);
    expect(FakeSocket.instances).toHaveLength(2);
    (FakeSocket.instances[1] as FakeSocket).drop(1011, "feed down");
    expect(onClose).toHaveBeenLastCalledWith({
      code: 1011,
      reason: "feed down",
      reconnectInMs: 200,
    });
    vi.advanceTimersByTime(200);
    (FakeSocket.instances[2] as FakeSocket).drop();
    expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ reconnectInMs: 250 }));
    vi.advanceTimersByTime(250);
    // A welcome resets the backoff.
    (FakeSocket.instances[3] as FakeSocket).receive(welcome());
    (FakeSocket.instances[3] as FakeSocket).drop();
    expect(onClose).toHaveBeenLastCalledWith(expect.objectContaining({ reconnectInMs: 100 }));
    stream.close();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.instances).toHaveLength(4);
    expect(statuses).toEqual([
      "offline",
      "connecting",
      "offline",
      "connecting",
      "offline",
      "connecting",
      "live",
      "offline",
      "closed",
    ]);
  });

  it("stays offline when reconnecting is off, and ignores a stale socket", () => {
    vi.useFakeTimers();
    const { stream } = open({ reconnect: false });
    const socket = FakeSocket.instances[0] as FakeSocket;
    const onclose = socket.onclose;
    socket.drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.instances).toHaveLength(1);
    expect(stream.status).toBe("offline");
    onclose?.({ code: 1006, reason: "" });
    expect(stream.status).toBe("offline");
    stream.close();
  });

  it("needs a WebSocket implementation", () => {
    vi.stubGlobal("WebSocket", undefined);
    try {
      expect(() => new MementoStream({ baseUrl: "http://h/m", apiKey: "k" })).toThrow(
        /no WebSocket implementation/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("talks to a real WebSocket server with Node's global WebSocket", async () => {
    const server = new WebSocketServer({
      port: 0,
      host: "127.0.0.1",
      handleProtocols: (protocols) => (protocols.has("memento.v1") ? "memento.v1" : false),
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const seen: { url: string | undefined; protocol: string | undefined }[] = [];
    server.on("connection", (socket, request) => {
      seen.push({ url: request.url, protocol: request.headers["sec-websocket-protocol"] });
      socket.send(welcome({ instance_type: "chat" }));
      socket.send(JSON.stringify(streamEvent(event)));
    });
    const port = (server.address() as AddressInfo).port;
    const received = new Promise<MementoEvent>((resolve) => {
      const stream = new MementoStream({
        baseUrl: `http://127.0.0.1:${port}/memento`,
        apiKey: "mk_abc_def",
        filter: { instance_type: "chat" },
        onEvent: (e) => {
          stream.close();
          resolve(e);
        },
      });
    });
    try {
      expect(await received).toEqual(event);
      expect(seen).toEqual([
        { url: "/memento/ws?instance_type=chat", protocol: "memento.v1, bearer.mk_abc_def" },
      ]);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
