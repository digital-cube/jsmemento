import type { MementoEvent, WebSocketLike } from "@memento/core";
import type { ReactNode } from "react";
import { vi } from "vitest";
import { MementoProvider } from "../src/index.js";

let seq = 0;
/** An event with sensible defaults; ids sort in creation order. */
export function makeEvent(overrides: Partial<MementoEvent> = {}): MementoEvent {
  seq += 1;
  const n = String(seq).padStart(12, "0");
  return {
    id: `0199a000-0000-7000-8000-${n}`,
    occurred_at: new Date(Date.UTC(2026, 9, 30, 10, 0, seq)).toISOString(),
    received_at: new Date(Date.UTC(2026, 9, 30, 10, 0, seq)).toISOString(),
    event_type: "USER_LOGIN",
    instance_type: "user",
    instance_id: "42",
    actor_id: "igor",
    payload: {},
    rendered: `event ${seq}`,
    rendered_locale: "en",
    archived_at: null,
    ...overrides,
  };
}

/** A WebSocket double: tests see every socket the components open and drive it. */
export class FakeSocket implements WebSocketLike {
  static all: FakeSocket[] = [];
  onopen: WebSocketLike["onopen"] = null;
  onmessage: WebSocketLike["onmessage"] = null;
  onclose: WebSocketLike["onclose"] = null;
  onerror: WebSocketLike["onerror"] = null;
  closed = false;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {
    FakeSocket.all.push(this);
  }

  static open(): FakeSocket[] {
    return FakeSocket.all.filter((socket) => !socket.closed);
  }

  static last(): FakeSocket {
    const socket = FakeSocket.open().at(-1);
    if (!socket) throw new Error("no open socket");
    return socket;
  }

  get query(): Record<string, string> {
    return Object.fromEntries(new URL(this.url).searchParams);
  }

  send(): void {}
  close(): void {
    this.closed = true;
  }

  welcome(): void {
    this.onmessage?.({
      data: JSON.stringify({
        kind: "memento.welcome",
        payload: {
          protocol_version: "1",
          tenant: "acme",
          filter: {},
          heartbeat_interval_ms: 30000,
          max_buffered_messages: 1000,
        },
      }),
    });
  }

  push(event: MementoEvent): void {
    this.onmessage?.({
      data: JSON.stringify({ kind: "memento.event.new", id: event.id, payload: event }),
    });
  }

  drop(): void {
    this.closed = true;
    this.onclose?.({ code: 1006, reason: "" });
  }
}

type Handler = (url: URL, init: RequestInit) => unknown;

/** A fetch that answers with `handler`'s data in a success envelope (or throws its error). */
export function fakeFetch(handler: Handler) {
  return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    try {
      const data = await handler(url, init);
      return new Response(
        JSON.stringify({ ok: true, data, meta: { limit: 50, count: 0, next_cursor: null } }),
        { status: 200 },
      );
    } catch (error) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: { code: "forbidden", message: (error as Error).message },
        }),
        { status: 403 },
      );
    }
  });
}

export function wrapper(fetch: typeof globalThis.fetch, extra: { locale?: string } = {}) {
  return ({ children }: { children: ReactNode }) => (
    <MementoProvider
      baseUrl="http://memento.test/memento"
      apiKey="mk_test_key"
      fetch={fetch}
      WebSocket={FakeSocket}
      reconnect={{ initialDelayMs: 10, maxDelayMs: 10 }}
      {...extra}
    >
      {children}
    </MementoProvider>
  );
}
