import type { MementoEvent } from "./event.js";
import {
  STREAM_FILTER_FIELDS,
  type StreamFilter,
  StreamMessageSchema,
  type StreamWelcome,
  streamSubprotocols,
} from "./stream.js";

/**
 * Client side of the real-time stream (`GET /memento/ws`), shared by `@memento/react` and the
 * CLI's `memento tail`. Works with any WHATWG-style WebSocket: the browser's, Node's global
 * one (Node ≥ 22), or a test double.
 */

/**
 * An event handler checked bivariantly (like a method), so the DOM's own `WebSocket`, whose
 * handlers take `MessageEvent`/`CloseEvent`, is assignable to `WebSocketLike`.
 */
type Handler<E> = { bivariant(event: E): void }["bivariant"];

/** The part of the WHATWG `WebSocket` the client uses. */
export interface WebSocketLike {
  onopen: Handler<unknown> | null;
  onmessage: Handler<{ data: unknown }> | null;
  onclose: Handler<{ code: number; reason: string }> | null;
  onerror: Handler<unknown> | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketConstructor = new (url: string, protocols: string[]) => WebSocketLike;

/**
 * `connecting` until the server's welcome arrives, `live` while subscribed, `offline` after a
 * drop (a reconnect is scheduled), `closed` once `close()` was called.
 */
export type StreamStatus = "connecting" | "live" | "offline" | "closed";

/** The `/ws` URL for an API base URL (`http://host:8000/memento`, or `/memento` in a browser). */
export function streamUrl(baseUrl: string, filter: StreamFilter = {}, locale?: string): string {
  const base = (globalThis as { location?: { href: string } }).location?.href;
  const url = new URL(`${baseUrl.replace(/\/+$/, "")}/ws`, base);
  url.protocol =
    url.protocol === "https:" ? "wss:" : url.protocol === "http:" ? "ws:" : url.protocol;
  for (const field of STREAM_FILTER_FIELDS) {
    const value = filter[field];
    if (value !== undefined) url.searchParams.set(field, value);
  }
  if (locale) url.searchParams.set("locale", locale);
  return url.toString();
}

/** The four filterable fields as a UI or `GET /events` takes them: exact, or `prefix*`. */
export type LiveQuery = Partial<Record<(typeof STREAM_FILTER_FIELDS)[number], string | undefined>>;

/**
 * Splits a query into what the stream can filter on (exact values; the stream has no
 * wildcards) and a predicate that also applies the `prefix*` parts on the client.
 */
export function liveFilter(query: LiveQuery): {
  filter: StreamFilter;
  matches: (event: MementoEvent) => boolean;
} {
  const filter: StreamFilter = {};
  const prefixes: [(typeof STREAM_FILTER_FIELDS)[number], string][] = [];
  for (const field of STREAM_FILTER_FIELDS) {
    const value = query[field]?.trim();
    if (!value) continue;
    if (value.endsWith("*")) {
      const prefix = value.slice(0, -1);
      if (prefix) prefixes.push([field, prefix]);
    } else {
      filter[field] = value;
    }
  }
  return {
    filter,
    matches: (event) =>
      STREAM_FILTER_FIELDS.every((field) => {
        const wanted = filter[field];
        return wanted === undefined || event[field] === wanted;
      }) && prefixes.every(([field, prefix]) => event[field]?.startsWith(prefix) ?? false),
  };
}

export interface ReconnectOptions {
  /** First delay after a drop. Default 500 ms; doubles on every failed attempt. */
  initialDelayMs?: number;
  /** Upper bound of the delay. Default 15 000 ms. */
  maxDelayMs?: number;
}

export interface MementoStreamOptions {
  /** API base URL, e.g. `http://localhost:8000/memento` (or `/memento` in a browser). */
  baseUrl: string;
  apiKey: string;
  filter?: StreamFilter;
  /** Re-render `rendered` in this locale. */
  locale?: string;
  /** Default: `globalThis.WebSocket`. */
  WebSocket?: WebSocketConstructor;
  /** `false` to stay offline after a drop. Default: reconnect with exponential backoff. */
  reconnect?: boolean | ReconnectOptions;
  onEvent?: (event: MementoEvent) => void;
  onStatus?: (status: StreamStatus) => void;
  onWelcome?: (welcome: StreamWelcome["payload"]) => void;
  /** A connection closed; `code`/`reason` as the WebSocket reported them. */
  onClose?: (info: { code: number; reason: string; reconnectInMs: number | null }) => void;
}

/** One subscription to `/memento/ws` that keeps itself connected. Call `close()` to stop. */
export class MementoStream {
  private socket: WebSocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private current: StreamStatus = "connecting";
  private readonly impl: WebSocketConstructor;

  constructor(private readonly options: MementoStreamOptions) {
    const impl =
      options.WebSocket ??
      (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket ??
      undefined;
    if (!impl) throw new Error("no WebSocket implementation available: pass options.WebSocket");
    this.impl = impl;
    this.connect();
  }

  get status(): StreamStatus {
    return this.current;
  }

  get url(): string {
    return streamUrl(this.options.baseUrl, this.options.filter, this.options.locale);
  }

  /** Disconnects for good; no reconnect is scheduled. */
  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      detach(socket);
      socket.close(1000, "client closed");
    }
    this.setStatus("closed");
  }

  private setStatus(status: StreamStatus): void {
    if (status === this.current) return;
    this.current = status;
    this.options.onStatus?.(status);
  }

  private connect(): void {
    this.timer = null;
    this.setStatus("connecting");
    const socket = new this.impl(this.url, streamSubprotocols(this.options.apiKey));
    this.socket = socket;
    socket.onmessage = (message) => this.receive(message.data);
    socket.onclose = (event) => {
      if (this.socket !== socket) return;
      this.socket = null;
      detach(socket);
      const delay = this.nextDelay();
      this.setStatus("offline");
      this.options.onClose?.({ code: event.code, reason: event.reason, reconnectInMs: delay });
      if (delay !== null) this.timer = setTimeout(() => this.connect(), delay);
    };
    // An error is always followed by a close, which is where the reconnect happens.
    socket.onerror = () => {};
  }

  private receive(data: unknown): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(data));
    } catch {
      return;
    }
    const message = StreamMessageSchema.safeParse(parsed);
    if (!message.success) return;
    if (message.data.kind === "memento.welcome") {
      this.attempt = 0;
      this.setStatus("live");
      this.options.onWelcome?.(message.data.payload);
    } else if (message.data.kind === "memento.event.new") {
      this.options.onEvent?.(message.data.payload);
    }
  }

  /** `null` when reconnecting is off. */
  private nextDelay(): number | null {
    const reconnect = this.options.reconnect ?? true;
    if (reconnect === false) return null;
    const { initialDelayMs = 500, maxDelayMs = 15_000 } = reconnect === true ? {} : reconnect;
    const delay = Math.min(maxDelayMs, initialDelayMs * 2 ** this.attempt);
    this.attempt += 1;
    return delay;
  }
}

function detach(socket: WebSocketLike): void {
  socket.onmessage = null;
  socket.onclose = null;
  socket.onerror = null;
  socket.onopen = null;
}
