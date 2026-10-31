import { describe, expect, it } from "vitest";
import {
  extractSubprotocolKey,
  type MementoEvent,
  matchesStreamFilter,
  STREAM_SUBPROTOCOL,
  StreamFilterSchema,
  StreamMessageSchema,
  streamEvent,
  streamSubprotocols,
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
  rendered: 'Igor je poslao poruku: "Pozdrav!"',
  rendered_locale: "sr",
  archived_at: null,
};

describe("stream subprotocol auth", () => {
  it("offers memento.v1 next to the bearer protocol", () => {
    expect(streamSubprotocols("mk_abc_def")).toEqual([STREAM_SUBPROTOCOL, "bearer.mk_abc_def"]);
  });

  it("finds the key in a Sec-WebSocket-Protocol header", () => {
    expect(extractSubprotocolKey("memento.v1, bearer.mk_abc_def")).toBe("mk_abc_def");
    expect(extractSubprotocolKey(["memento.v1", "bearer.k"])).toBe("k");
    expect(extractSubprotocolKey("bearer.")).toBeNull();
    expect(extractSubprotocolKey("memento.v1")).toBeNull();
    expect(extractSubprotocolKey(undefined)).toBeNull();
    expect(extractSubprotocolKey("")).toBeNull();
  });
});

describe("stream filter", () => {
  it("matches when every set field is equal", () => {
    expect(matchesStreamFilter({}, event)).toBe(true);
    expect(matchesStreamFilter({ event_type: "CHAT_MESSAGE_SENT" }, event)).toBe(true);
    expect(matchesStreamFilter({ event_type: "USER_LOGIN" }, event)).toBe(false);
    expect(
      matchesStreamFilter({ instance_type: "chat", instance_id: "chat-acme-sales" }, event),
    ).toBe(true);
    expect(matchesStreamFilter({ instance_type: "chat", instance_id: "chat-other" }, event)).toBe(
      false,
    );
    expect(matchesStreamFilter({ actor_id: "igor" }, event)).toBe(true);
    expect(matchesStreamFilter({ actor_id: "marko" }, event)).toBe(false);
    expect(matchesStreamFilter({ actor_id: "igor" }, { ...event, actor_id: null })).toBe(false);
  });

  it("validates the query string and rejects unknown parameters", () => {
    expect(StreamFilterSchema.parse({ event_type: "USER_LOGIN" })).toEqual({
      event_type: "USER_LOGIN",
    });
    expect(StreamFilterSchema.safeParse({ event_type: "user_login" }).success).toBe(false);
    expect(StreamFilterSchema.safeParse({ instance_type: "Chat" }).success).toBe(false);
    expect(StreamFilterSchema.safeParse({ nope: "x" }).success).toBe(false);
  });
});

describe("stream messages", () => {
  it("wraps an event as memento.event.new", () => {
    const message = streamEvent(event);
    expect(message).toEqual({ kind: "memento.event.new", id: event.id, payload: event });
    expect(StreamMessageSchema.parse(message)).toEqual(message);
  });

  it("validates every message kind", () => {
    expect(StreamMessageSchema.safeParse({ kind: "memento.pong" }).success).toBe(true);
    expect(
      StreamMessageSchema.safeParse({
        kind: "memento.welcome",
        payload: {
          protocol_version: "1",
          tenant: "acme",
          filter: {},
          heartbeat_interval_ms: 30000,
          max_buffered_messages: 1000,
        },
      }).success,
    ).toBe(true);
    expect(StreamMessageSchema.safeParse({ kind: "memento.other" }).success).toBe(false);
  });
});
