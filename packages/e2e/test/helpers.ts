import { randomUUID } from "node:crypto";
import { type MementoEvent, MementoStream, type StreamFilter } from "@memento/core";
import { connect, createApiKey, createTenant } from "@memento/server";
import { afterAll, afterEach, inject } from "vitest";
import WebSocket from "ws";

const servers = inject("servers");
/** The server events are pushed to, and the one streams are read from (another process
 * when the suite started two, so delivery goes through Redis). */
export const pushServer = servers[0] as string;
export const streamServer = (servers[1] ?? servers[0]) as string;

const handle = connect(inject("databaseUrl"), { max: 2 });
const streams: MementoStream[] = [];
afterEach(() => {
  for (const stream of streams.splice(0)) stream.close();
});
afterAll(() => handle.close());

export interface TenantKeys {
  slug: string;
  read: string;
  write: string;
}

/** A fresh tenant per call (unique slug), so suites never see each other's data. */
export async function newTenant(label: string): Promise<TenantKeys> {
  const slug = `e2e-${label}-${randomUUID().slice(0, 8)}`;
  await createTenant(handle.db, { slug, name: `E2E ${label}` });
  const key = async (scopes: string) =>
    (await createApiKey(handle.db, { tenant: slug, name: `e2e-${scopes}`, scopes })).key;
  return { slug, read: await key("read"), write: await key("write") };
}

export interface ApiResponse<T = unknown> {
  status: number;
  body: { ok: boolean; data: T; meta?: Record<string, unknown>; error?: { code: string } };
}

/** One HTTP call to the API; never throws on a non-2xx status. */
export async function api<T = unknown>(
  key: string,
  method: string,
  path: string,
  body?: unknown,
  base = pushServer,
): Promise<ApiResponse<T>> {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, body: (await response.json()) as ApiResponse<T>["body"] };
}

/** A live subscription whose events can be awaited one at a time. */
export class LiveFeed {
  readonly events: MementoEvent[] = [];
  private readonly waiting: ((event: MementoEvent) => void)[] = [];
  private seen = 0;

  private constructor(readonly stream: MementoStream) {}

  /** Connects to `/ws` of the stream server and resolves once the welcome arrived. */
  static open(key: string, filter: StreamFilter = {}): Promise<LiveFeed> {
    return new Promise((resolve, reject) => {
      let feed: LiveFeed | null = null;
      const timer = setTimeout(() => reject(new Error("no welcome within 10 s")), 10_000);
      const stream = new MementoStream({
        baseUrl: streamServer,
        apiKey: key,
        filter,
        WebSocket: WebSocket as never,
        reconnect: false,
        onEvent: (event) => {
          feed?.events.push(event);
          if (feed) feed.waiting.shift()?.(event);
        },
        onWelcome: () => {
          clearTimeout(timer);
          if (feed) resolve(feed);
        },
        onClose: ({ code, reason }) => {
          clearTimeout(timer);
          reject(new Error(`stream closed before welcome: ${code} ${reason}`));
        },
      });
      feed = new LiveFeed(stream);
      streams.push(stream);
    });
  }

  /** The next event not yet returned by `next`. */
  next(timeoutMs = 10_000): Promise<MementoEvent> {
    const index = this.seen++;
    const ready = this.events[index];
    if (ready) return Promise.resolve(ready);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`no event within ${timeoutMs} ms`)),
        timeoutMs,
      );
      this.waiting.push((event) => {
        clearTimeout(timer);
        resolve(event);
      });
    });
  }
}
