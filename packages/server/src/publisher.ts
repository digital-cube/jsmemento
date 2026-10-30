import type { MementoEvent } from "@memento/core";
import { Redis } from "ioredis";

/** A stored event, announced to real-time subscribers (WebSocket hub, Phase 4). */
export interface PublishedEvent {
  tenant: string;
  event: MementoEvent;
}

export interface EventPublisher {
  publish(message: PublishedEvent): Promise<void>;
  close(): Promise<void>;
}

/** Drops everything: used when `REDIS_URL` is not set. */
export class NoopPublisher implements EventPublisher {
  async publish(): Promise<void> {}
  async close(): Promise<void> {}
}

/** Keeps messages in memory: for tests and embedded use. */
export class MemoryPublisher implements EventPublisher {
  readonly messages: PublishedEvent[] = [];
  async publish(message: PublishedEvent): Promise<void> {
    this.messages.push(message);
  }
  async close(): Promise<void> {}
}

/** Publishes each event as JSON on `<prefix>:<tenant_slug>`. */
export class RedisPublisher implements EventPublisher {
  private readonly redis: Redis;
  private readonly prefix: string;

  constructor(url: string, prefix = "memento:events") {
    this.redis = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.prefix = prefix;
  }

  channel(tenant: string): string {
    return `${this.prefix}:${tenant}`;
  }

  async publish(message: PublishedEvent): Promise<void> {
    await this.redis.publish(this.channel(message.tenant), JSON.stringify(message.event));
  }

  async close(): Promise<void> {
    await this.redis.quit().catch(() => this.redis.disconnect());
  }
}
