import { z } from "zod";
import { EventTypeSchema, InstanceTypeSchema, SlugSchema } from "./common.js";
import { EventSchema, type MementoEvent } from "./event.js";

/**
 * Real-time stream (`GET /memento/ws`, WebSocket). Browsers cannot set headers on a
 * WebSocket, so the API key travels as a subprotocol: `bearer.<api_key>`. Offer
 * `memento.v1` next to it and the server selects that one, so the key is never echoed back.
 */
export const BEARER_SUBPROTOCOL_PREFIX = "bearer.";
export const STREAM_SUBPROTOCOL = "memento.v1";

/** The subprotocols a client offers: `[STREAM_SUBPROTOCOL, "bearer.<key>"]`. */
export function streamSubprotocols(apiKey: string): string[] {
  return [STREAM_SUBPROTOCOL, `${BEARER_SUBPROTOCOL_PREFIX}${apiKey}`];
}

/** The API key in a `Sec-WebSocket-Protocol` header (`…, bearer.<key>, …`), or `null`. */
export function extractSubprotocolKey(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) return null;
  for (const protocol of value.split(",")) {
    const trimmed = protocol.trim();
    if (trimmed.startsWith(BEARER_SUBPROTOCOL_PREFIX)) {
      const key = trimmed.slice(BEARER_SUBPROTOCOL_PREFIX.length);
      if (key) return key;
    }
  }
  return null;
}

/** Query-string filters of the stream; every one that is set must match (AND). */
export const StreamFilterSchema = z.strictObject({
  event_type: EventTypeSchema.optional(),
  instance_type: InstanceTypeSchema.optional(),
  instance_id: z.string().trim().min(1).max(200).optional(),
  actor_id: z.string().trim().min(1).max(200).optional(),
});
export type StreamFilter = z.infer<typeof StreamFilterSchema>;

export const STREAM_FILTER_FIELDS = [
  "event_type",
  "instance_type",
  "instance_id",
  "actor_id",
] as const;

/** Whether `event` passes `filter` (exact match on every field the filter sets). */
export function matchesStreamFilter(filter: StreamFilter, event: MementoEvent): boolean {
  return STREAM_FILTER_FIELDS.every((field) => {
    const wanted = filter[field];
    return wanted === undefined || event[field] === wanted;
  });
}

/** WebSocket close codes the server uses (4000–4999 is the application range). */
export const STREAM_CLOSE_CODES = {
  /** The server is shutting down. */
  going_away: 1001,
  /** The server could not subscribe to the event feed (Redis down). */
  feed_unavailable: 1011,
  /** The client read too slowly: its outbound buffer filled up. */
  slow_consumer: 4008,
} as const;

/** First message on every connection. */
export const StreamWelcomeSchema = z.object({
  kind: z.literal("memento.welcome"),
  payload: z.object({
    protocol_version: z.string(),
    tenant: SlugSchema,
    filter: StreamFilterSchema,
    heartbeat_interval_ms: z.number().int().positive(),
    max_buffered_messages: z.number().int().positive(),
  }),
});
export type StreamWelcome = z.infer<typeof StreamWelcomeSchema>;

/** A newly stored event that passed the connection's filter. */
export const StreamEventSchema = z.object({
  kind: z.literal("memento.event.new"),
  id: z.string(),
  payload: EventSchema,
});
export type StreamEvent = z.infer<typeof StreamEventSchema>;

/** Answer to a client's `{"kind":"memento.ping"}` (for clients that cannot send ping frames). */
export const StreamPongSchema = z.object({ kind: z.literal("memento.pong") });

/** Sent for a client message the server does not understand; the connection stays open. */
export const StreamErrorSchema = z.object({
  kind: z.literal("memento.error"),
  payload: z.object({ code: z.string(), message: z.string() }),
});

export const StreamMessageSchema = z.discriminatedUnion("kind", [
  StreamWelcomeSchema,
  StreamEventSchema,
  StreamPongSchema,
  StreamErrorSchema,
]);
export type StreamMessage = z.infer<typeof StreamMessageSchema>;

/** The stream message announcing `event`. */
export function streamEvent(event: MementoEvent): StreamEvent {
  return { kind: "memento.event.new", id: event.id, payload: event };
}
