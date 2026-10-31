import { randomUUID } from "node:crypto";
import {
  type MementoEvent,
  matchesStreamFilter,
  PROTOCOL_VERSION,
  STREAM_CLOSE_CODES,
  type StreamFilter,
  type StreamMessage,
  streamEvent,
} from "@memento/core";
import type { FastifyBaseLogger } from "fastify";
import type { TenantContext } from "../context.js";
import type { PublishedEvent } from "../publisher.js";
import { localizeEvents } from "../services/events.js";
import type { EventRenderer } from "../templates/renderer.js";
import type { EventFeed } from "./feed.js";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;
export const DEFAULT_MAX_BUFFERED_MESSAGES = 1000;
/** How long a slow consumer gets to complete the close handshake before it is cut off. */
const SLOW_CLOSE_GRACE_MS = 5_000;
const OPEN = 1; // WebSocket.OPEN

/** The part of a `ws` WebSocket the hub uses (a fake one in unit tests). */
export interface StreamSocket {
  readonly readyState: number;
  send(data: string, callback: (error?: Error) => void): void;
  ping(): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: "close", listener: () => void): unknown;
  on(event: "pong", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
}

export interface ConnectionInfo {
  tenant: TenantContext;
  filter: StreamFilter;
  /** Re-render `rendered` in this locale; default: as the event was stored. */
  locale?: string;
}

/**
 * One client. Messages go out through `send`; those `ws` has not yet handed to the kernel
 * are counted, and a client that lets `maxBuffered` of them pile up is disconnected.
 */
export class StreamConnection {
  readonly id = randomUUID();
  readonly tenant: TenantContext;
  readonly filter: StreamFilter;
  readonly locale: string | undefined;
  readonly log: FastifyBaseLogger;
  /** Messages handed to the socket whose write has not completed yet. */
  pending = 0;
  /** True once the welcome went out; events are only delivered to ready connections. */
  ready = false;
  closed = false;
  private alive = true;

  constructor(
    private readonly socket: StreamSocket,
    info: ConnectionInfo,
    private readonly maxBuffered: number,
    log: FastifyBaseLogger,
  ) {
    this.log = log.child({ tenant: info.tenant.tenantSlug, connection: this.id });
    this.tenant = info.tenant;
    this.filter = info.filter;
    this.locale = info.locale;
    socket.on("pong", () => {
      this.alive = true;
    });
    socket.on("message", (data) => this.receive(data));
  }

  /** Sends the welcome and starts delivering events. */
  open(welcome: StreamMessage): void {
    if (this.closed) return;
    this.ready = true;
    this.send(welcome);
  }

  /** Queues one message; `false` when it was not sent (closed, or too slow and now dropped). */
  send(message: StreamMessage): boolean {
    if (this.closed || this.socket.readyState !== OPEN) return false;
    if (this.pending >= this.maxBuffered) {
      this.dropSlow();
      return false;
    }
    this.pending++;
    this.socket.send(JSON.stringify(message), (error) => {
      this.pending--;
      if (error) this.log.debug({ err: error }, "stream send failed");
    });
    return true;
  }

  matches(event: MementoEvent): boolean {
    return this.ready && !this.closed && matchesStreamFilter(this.filter, event);
  }

  /** One heartbeat tick: cut off a client that did not answer the previous ping. */
  heartbeat(): void {
    if (this.closed) return;
    if (!this.alive) {
      this.log.info("stream client missed a heartbeat; terminating");
      this.closed = true;
      this.socket.terminate();
      return;
    }
    this.alive = false;
    this.socket.ping();
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;
    this.socket.close(code, reason);
  }

  private dropSlow(): void {
    this.log.warn(
      { pending: this.pending, max_buffered_messages: this.maxBuffered },
      "slow consumer threshold exceeded; disconnecting",
    );
    this.close(STREAM_CLOSE_CODES.slow_consumer, "slow consumer");
    // The close frame queues behind everything the client has not read: do not wait for it.
    setTimeout(() => this.socket.terminate(), SLOW_CLOSE_GRACE_MS).unref();
  }

  private receive(data: unknown): void {
    this.alive = true;
    let kind: unknown;
    try {
      kind = (JSON.parse(String(data)) as { kind?: unknown })?.kind;
    } catch {
      kind = undefined;
    }
    if (kind === "memento.ping") this.send({ kind: "memento.pong" });
    else {
      this.send({
        kind: "memento.error",
        payload: {
          code: "bad_request",
          message: 'the only client message is {"kind":"memento.ping"}',
        },
      });
    }
  }
}

export interface StreamHubOptions {
  feed: EventFeed;
  log: FastifyBaseLogger;
  /** Ping every connection this often; one that missed the last ping is cut off. Default 30 s. */
  heartbeatIntervalMs?: number;
  /** Unwritten messages a connection may accumulate before it is dropped. Default 1000. */
  maxBufferedMessages?: number;
  /** Renders events for connections that asked for a `?locale`. */
  renderer?: EventRenderer;
}

interface TenantGroup {
  connections: Set<StreamConnection>;
  /** The feed subscription of this tenant (shared by all its connections). */
  subscribed: Promise<void>;
}

/**
 * Fans stored events out to WebSocket connections. Connections are grouped by tenant:
 * the feed carries a tenant's events only while it has connections, and an event is only
 * ever offered to connections of the tenant it was published for.
 */
export class StreamHub {
  readonly heartbeatIntervalMs: number;
  readonly maxBufferedMessages: number;
  private readonly feed: EventFeed;
  private readonly log: FastifyBaseLogger;
  private readonly renderer: EventRenderer | undefined;
  private readonly groups = new Map<string, TenantGroup>();
  private readonly timer: NodeJS.Timeout;
  /** Events are dispatched one after another, so every client sees them in publish order. */
  private queue: Promise<void> = Promise.resolve();

  constructor(options: StreamHubOptions) {
    this.feed = options.feed;
    this.log = options.log;
    this.renderer = options.renderer;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.maxBufferedMessages = options.maxBufferedMessages ?? DEFAULT_MAX_BUFFERED_MESSAGES;
    this.feed.onEvent((message) => {
      this.queue = this.queue
        .then(() => this.dispatch(message))
        .catch((error) => this.log.error({ err: error }, "stream dispatch failed"));
    });
    this.timer = setInterval(() => this.heartbeat(), this.heartbeatIntervalMs);
    this.timer.unref();
  }

  /** Registers a connected socket; resolves once it is subscribed and welcomed. */
  async add(socket: StreamSocket, info: ConnectionInfo): Promise<StreamConnection> {
    const slug = info.tenant.tenantSlug;
    const connection = new StreamConnection(socket, info, this.maxBufferedMessages, this.log);
    let group = this.groups.get(slug);
    if (!group) {
      group = { connections: new Set(), subscribed: this.feed.subscribe(slug) };
      this.groups.set(slug, group);
    }
    group.connections.add(connection);
    socket.on("close", () => this.remove(connection));
    try {
      await group.subscribed;
    } catch (error) {
      connection.log.error({ err: error }, "could not subscribe to the event feed");
      connection.close(STREAM_CLOSE_CODES.feed_unavailable, "event feed unavailable");
      return connection;
    }
    connection.open({
      kind: "memento.welcome",
      payload: {
        protocol_version: PROTOCOL_VERSION,
        tenant: slug,
        filter: info.filter,
        heartbeat_interval_ms: this.heartbeatIntervalMs,
        max_buffered_messages: this.maxBufferedMessages,
      },
    });
    connection.log.info({ filter: info.filter }, "stream client connected");
    return connection;
  }

  /** Forgets a closed connection; the last one of a tenant ends its feed subscription. */
  remove(connection: StreamConnection): void {
    connection.closed = true;
    const slug = connection.tenant.tenantSlug;
    const group = this.groups.get(slug);
    if (!group?.connections.delete(connection)) return;
    connection.log.info("stream client disconnected");
    if (group.connections.size > 0) return;
    this.groups.delete(slug);
    this.feed
      .unsubscribe(slug)
      .catch((error) => this.log.warn({ err: error, tenant: slug }, "feed unsubscribe failed"));
  }

  /** Open connections per tenant slug. */
  stats(): Record<string, number> {
    return Object.fromEntries([...this.groups].map(([slug, g]) => [slug, g.connections.size]));
  }

  /** Resolves when every event received so far has been dispatched. */
  idle(): Promise<void> {
    return this.queue;
  }

  private async dispatch({ tenant, event }: PublishedEvent): Promise<void> {
    const group = this.groups.get(tenant);
    if (!group) return;
    const targets = [...group.connections].filter((connection) => connection.matches(event));
    if (targets.length === 0) return;
    const byLocale = new Map<string | undefined, MementoEvent>([[undefined, event]]);
    for (const connection of targets) {
      let localized = byLocale.get(connection.locale);
      if (!localized) {
        localized = this.renderer
          ? ((
              await localizeEvents(
                this.renderer,
                connection.tenant.tenantId,
                [event],
                connection.locale,
              )
            )[0] ?? event)
          : event;
        byLocale.set(connection.locale, localized);
      }
      connection.send(streamEvent(localized));
    }
  }

  private heartbeat(): void {
    for (const group of this.groups.values()) {
      for (const connection of group.connections) connection.heartbeat();
    }
  }

  /** Closes every connection (1001) and stops the heartbeat. The feed is the caller's. */
  close(): void {
    clearInterval(this.timer);
    for (const group of this.groups.values()) {
      for (const connection of group.connections) {
        connection.close(STREAM_CLOSE_CODES.going_away, "server shutting down");
      }
    }
  }
}
