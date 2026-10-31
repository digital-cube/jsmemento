import type { MementoEvent } from "@memento/core";
import { Redis } from "ioredis";
import type { EventPublisher, PublishedEvent } from "../publisher.js";

/**
 * Where the stream hub receives stored events from. The hub subscribes a tenant when its
 * first connection opens and unsubscribes it when the last one closes, so a feed only ever
 * carries events somebody is listening to.
 */
export interface EventFeed {
  /** Called for every event of a subscribed tenant. Set once, by the hub. */
  onEvent(listener: (message: PublishedEvent) => void): void;
  subscribe(tenant: string): Promise<void>;
  unsubscribe(tenant: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * In-process publisher + feed: what is published is delivered straight to the hub. For a
 * single server without Redis, embedded use and tests.
 */
export class LocalBus implements EventPublisher, EventFeed {
  private listener: ((message: PublishedEvent) => void) | null = null;
  private readonly tenants = new Set<string>();

  onEvent(listener: (message: PublishedEvent) => void): void {
    this.listener = listener;
  }

  async subscribe(tenant: string): Promise<void> {
    this.tenants.add(tenant);
  }

  async unsubscribe(tenant: string): Promise<void> {
    this.tenants.delete(tenant);
  }

  /** Tenants with at least one open connection. */
  subscribed(): string[] {
    return [...this.tenants].sort();
  }

  async publish(message: PublishedEvent): Promise<void> {
    if (this.tenants.has(message.tenant)) this.listener?.(message);
  }

  async close(): Promise<void> {
    this.tenants.clear();
  }
}

export interface RedisFeedOptions {
  /** Channel prefix; events of tenant `acme` arrive on `<prefix>:acme`. */
  prefix?: string;
  /** A connection error, or a message that is not an event's JSON (dropped). */
  onError?: (error: unknown, channel?: string) => void;
}

/**
 * Subscribes to the channels `RedisPublisher` publishes on (`<prefix>:<tenant_slug>`), on a
 * dedicated connection (a subscribed Redis connection cannot run other commands). Every
 * server process runs one, so an event pushed to any process reaches every client.
 */
export class RedisFeed implements EventFeed {
  private readonly redis: Redis;
  private readonly prefix: string;
  private listener: ((message: PublishedEvent) => void) | null = null;

  constructor(url: string, options: RedisFeedOptions = {}) {
    this.prefix = options.prefix ?? "memento:events";
    this.redis = new Redis(url, { lazyConnect: true });
    this.redis.on("message", (channel: string, raw: string) => {
      const tenant = this.tenantOf(channel);
      if (tenant === null) return;
      let event: MementoEvent;
      try {
        event = JSON.parse(raw) as MementoEvent;
      } catch (error) {
        options.onError?.(error, channel);
        return;
      }
      this.listener?.({ tenant, event });
    });
    // ioredis reconnects and re-subscribes on its own; without a listener an `error`
    // event would crash the process.
    this.redis.on("error", (error) => options.onError?.(error));
  }

  channel(tenant: string): string {
    return `${this.prefix}:${tenant}`;
  }

  private tenantOf(channel: string): string | null {
    const head = `${this.prefix}:`;
    return channel.startsWith(head) ? channel.slice(head.length) : null;
  }

  onEvent(listener: (message: PublishedEvent) => void): void {
    this.listener = listener;
  }

  async subscribe(tenant: string): Promise<void> {
    await this.redis.subscribe(this.channel(tenant));
  }

  async unsubscribe(tenant: string): Promise<void> {
    await this.redis.unsubscribe(this.channel(tenant));
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
