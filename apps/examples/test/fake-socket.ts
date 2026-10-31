import type { WebSocketLike } from "@memento/core";

/** A valid event id for the n-th test event. */
export const uuid = (n: number) => `0199a000-0000-7000-8000-${String(n).padStart(12, "0")}`;

/** A WebSocket double: tests see every socket the app opens and drive it. */
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

  static last(): FakeSocket {
    const socket = FakeSocket.all.filter((s) => !s.closed).at(-1);
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
    this.onopen?.({});
    this.onmessage?.({
      data: JSON.stringify({
        kind: "memento.welcome",
        payload: {
          protocol_version: "1",
          tenant: "demo",
          filter: {},
          heartbeat_interval_ms: 30000,
          max_buffered_messages: 1000,
        },
      }),
    });
  }

  /** A `memento.event.new` (a CPU sample unless `event` says otherwise). */
  push(id: string, event: Record<string, unknown> = {}): void {
    this.onmessage?.({
      data: JSON.stringify({
        kind: "memento.event.new",
        id,
        payload: {
          id,
          occurred_at: new Date().toISOString(),
          received_at: new Date().toISOString(),
          event_type: "CPU_LOAD",
          instance_type: "server",
          instance_id: "backend-01",
          actor_id: "monitor",
          payload: { load_1min: 1, load_5min: 1, load_15min: 1 },
          rendered: "x",
          rendered_locale: "en",
          archived_at: null,
          ...event,
        },
      }),
    });
  }

  drop(): void {
    this.onclose?.({ code: 1006, reason: "" });
  }
}
