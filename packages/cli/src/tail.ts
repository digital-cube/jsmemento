import {
  CHAT_EVENT_TYPES,
  CHAT_INSTANCE_TYPE,
  chatInstanceId,
  type LiveQuery,
  liveFilter,
  MementoClient,
  type MementoEvent,
  MementoStream,
  type WebSocketConstructor,
} from "@memento/core";
import type { CliIO } from "./program.js";
import type { Ui } from "./ui.js";

export const DEFAULT_SERVER_URL = "http://localhost:8000/memento";

export interface TailOptions {
  url: string;
  apiKey?: string;
  chatId?: string;
  eventType?: string;
  instanceType?: string;
  instanceId?: string;
  actor?: string;
  locale?: string;
  lines: number;
}

export interface TailDeps {
  io: CliIO;
  ui: Ui;
  json: boolean;
  /** Stops tailing; without one, `tail` runs until the process is interrupted. */
  signal?: AbortSignal | undefined;
  fetch?: typeof fetch | undefined;
  WebSocket?: WebSocketConstructor | undefined;
  /** IANA zone for the `[HH:MM:SS]` stamps. Default: the system's. */
  timeZone?: string | undefined;
}

/** `10:00:00` in `timeZone` (24-hour clock). */
export function clock(iso: string, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(iso));
}

/** One line of `tail`: `[10:00:00] igor: Pozdrav!` for a message, the story otherwise. */
export function tailLine(event: MementoEvent, ui: Ui, timeZone?: string): string {
  const { c } = ui;
  const stamp = c.dim(`[${clock(event.occurred_at, timeZone)}]`);
  if (event.event_type === CHAT_EVENT_TYPES.messageSent) {
    const sender =
      typeof event.payload.sender_user_id === "string"
        ? event.payload.sender_user_id
        : (event.actor_id ?? "?");
    const content =
      typeof event.payload.content === "string" ? event.payload.content : (event.rendered ?? "");
    return `${stamp} ${c.bold(`${sender}:`)} ${content}`;
  }
  const where = c.cyan(`${event.instance_type}/${event.instance_id}`);
  return `${stamp} ${c.yellow(event.event_type)} ${where} ${event.rendered ?? ""}`.trimEnd();
}

/** The filter `tail` follows: a chat's messages, or the explicit flags. */
export function tailQuery(options: TailOptions): LiveQuery {
  if (options.chatId) {
    return {
      instance_type: CHAT_INSTANCE_TYPE,
      instance_id: chatInstanceId(options.chatId),
      event_type: options.eventType ?? CHAT_EVENT_TYPES.messageSent,
      actor_id: options.actor,
    };
  }
  return {
    event_type: options.eventType,
    instance_type: options.instanceType,
    instance_id: options.instanceId,
    actor_id: options.actor,
  };
}

/**
 * `memento tail`: prints the last `lines` matching events, then every new one as it is
 * stored, like `tail -f`. Reconnects by itself; returns when `signal` aborts.
 */
export async function runTail(options: TailOptions, deps: TailDeps): Promise<void> {
  const { io, ui, json, signal } = deps;
  const { c } = ui;
  if (!options.apiKey) {
    throw new TailError("no API key: pass --api-key or set MEMENTO_API_KEY (scope read)");
  }
  const query = tailQuery(options);
  const { filter, matches } = liveFilter(query);
  const client = new MementoClient({
    baseUrl: options.url,
    apiKey: options.apiKey,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
  const show = (event: MementoEvent) =>
    io.out(json ? JSON.stringify(event) : tailLine(event, ui, deps.timeZone));
  const seen = new Set<string>();
  const print = (event: MementoEvent) => {
    if (seen.has(event.id)) return;
    seen.add(event.id);
    show(event);
  };

  // Also checks the URL and the key before streaming, with the server's own error message.
  const history = await ui.step(`Connecting to ${options.url}`, () =>
    client.listEvents({
      ...Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined)),
      limit: Math.max(1, options.lines),
      ...(options.locale ? { locale: options.locale } : {}),
    }),
  );
  if (options.lines > 0) for (const event of history.data.slice().reverse()) print(event);

  const what = options.chatId ? chatInstanceId(options.chatId) : describeFilter(query);
  await new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    let wasLive = false;
    const stream = new MementoStream({
      baseUrl: options.url,
      apiKey: options.apiKey as string,
      filter,
      ...(options.locale ? { locale: options.locale } : {}),
      ...(deps.WebSocket ? { WebSocket: deps.WebSocket } : {}),
      onWelcome: () => {
        io.err(
          c.green(`● live: ${wasLive ? "reconnected to" : "following"} ${what} (Ctrl+C to stop)`),
        );
        wasLive = true;
      },
      onEvent: (event) => {
        if (matches(event)) print(event);
      },
      onClose: ({ code, reconnectInMs }) => {
        const why = code === 4008 ? "too slow to keep up" : `code ${code}`;
        const next =
          reconnectInMs === null ? "" : `, reconnecting in ${Math.ceil(reconnectInMs / 1000)}s`;
        io.err(c.red(`○ offline: connection closed (${why})${next}`));
      },
    });
    signal?.addEventListener(
      "abort",
      () => {
        stream.close();
        resolve();
      },
      { once: true },
    );
  });
}

function describeFilter(query: LiveQuery): string {
  const parts = Object.entries(query)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${v}`);
  return parts.length > 0 ? parts.join(" ") : "every event";
}

/** A usage problem of `tail` (reported like a domain error, exit 1). */
export class TailError extends Error {
  override readonly name = "TailError";
}
