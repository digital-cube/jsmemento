import {
  EVENT_TYPES,
  type MementoEvent,
  STREAM_FILTER_FIELDS,
  type StreamFilter,
  StreamFilterSchema,
  StreamMessageSchema,
  streamUrl,
  type WebSocketConstructor,
  type WebSocketLike,
} from "@memento/core";

/**
 * The Live tail example's logic, apart from React: the page's filters and their URL, the
 * `/ws` URL they become, one frame as a line of `memento tail`, and the frame buffer (newest
 * first, capped, paused).
 */

/** Frames kept in memory; older ones are dropped. The paused buffer has the same cap. */
export const MAX_FRAMES = 500;

/** The window `events/s` is measured over. */
export const RATE_WINDOW_MS = 10_000;

/** The event types the multi-select offers: memento's vocabulary (`lookups.yaml`). */
export const TAIL_EVENT_TYPES: readonly string[] = EVENT_TYPES;

/**
 * What the page filters on: the stream's own query-string filters (docs/STREAMING.md), with
 * `event_type` as a list because the page lets you pick several.
 */
export interface TailFilters {
  event_types: string[];
  instance_type: string;
  instance_id: string;
  actor_id: string;
}

export const NO_FILTERS: TailFilters = {
  event_types: [],
  instance_type: "",
  instance_id: "",
  actor_id: "",
};

/** The page's filters from its URL (`?event_type=A&event_type=B&instance_type=ticket`). */
export function filtersFromSearch(search: URLSearchParams): TailFilters {
  const types = search
    .getAll("event_type")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    event_types: [...new Set(types)],
    instance_type: search.get("instance_type")?.trim() ?? "",
    instance_id: search.get("instance_id")?.trim() ?? "",
    actor_id: search.get("actor_id")?.trim() ?? "",
  };
}

/**
 * `filters` written into `search` (other parameters kept): one `event_type` per type, the
 * others only when set, so a link reproduces exactly what the page shows.
 */
export function filtersToSearch(filters: TailFilters, search = new URLSearchParams()): string {
  const next = new URLSearchParams(search);
  for (const field of STREAM_FILTER_FIELDS) next.delete(field);
  for (const type of filters.event_types) next.append("event_type", type);
  for (const field of ["instance_type", "instance_id", "actor_id"] as const) {
    const value = filters[field].trim();
    if (value) next.set(field, value);
  }
  const text = next.toString();
  return text ? `?${text}` : "";
}

export interface TailQuery {
  /** The filter the stream applies (its query string): exact values only. */
  filter: StreamFilter;
  /**
   * Whether an event is shown. The stream takes one `event_type`; with several picked the
   * page subscribes without it and keeps only those types itself.
   */
  matches: (event: MementoEvent) => boolean;
  /** True when part of the filter runs in the page rather than on the server. */
  clientSide: boolean;
  /** Why the stream would refuse this filter (422 before the upgrade), or `null`. */
  error: string | null;
  /** Names the whole filter, the page's part too: another one is another connection. */
  key: string;
}

export function tailQuery(filters: TailFilters): TailQuery {
  const types = filters.event_types;
  const candidate: Record<string, string> = {};
  if (types.length === 1) candidate.event_type = types[0] as string;
  for (const field of ["instance_type", "instance_id", "actor_id"] as const) {
    const value = filters[field].trim();
    if (value) candidate[field] = value;
  }
  // Several types: each one is checked here, since the stream never sees them.
  const key = JSON.stringify([candidate, types]);
  for (const type of types.length > 1 ? types : []) {
    const check = StreamFilterSchema.safeParse({ event_type: type });
    if (!check.success) return refused(key, check.error.issues[0]?.message);
  }
  const parsed = StreamFilterSchema.safeParse(candidate);
  if (!parsed.success) return refused(key, parsed.error.issues[0]?.message);
  const wanted = new Set(types);
  const clientSide = types.length > 1;
  return {
    filter: parsed.data,
    clientSide,
    error: null,
    key,
    matches: (event) => !clientSide || wanted.has(event.event_type),
  };
}

function refused(key: string, message = "invalid filter"): TailQuery {
  return { filter: {}, matches: () => false, clientSide: false, error: message, key };
}

/** The `ws://…/memento/ws?…` URL the page connects to, exactly as the socket opens it. */
export function tailUrl(baseUrl: string, filter: StreamFilter, locale: string): string {
  return streamUrl(baseUrl, filter, locale);
}

/** `10:00:00`, 24-hour clock, like `memento tail`'s stamps. */
export function clock(at: string | number, timeZone?: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
    ...(timeZone ? { timeZone } : {}),
  }).format(new Date(at));
}

/** One event as `memento tail` prints it: `[10:00:00] TICKET_CREATED ticket/T-3 — rendered`. */
export function eventLine(event: MementoEvent, timeZone?: string): string {
  const head = `[${clock(event.occurred_at, timeZone)}] ${event.event_type} ${event.instance_type}/${event.instance_id}`;
  return event.rendered ? `${head} — ${event.rendered}` : head;
}

/**
 * What a frame is: an event, one of the stream's control messages, the socket closing
 * (not a frame on the wire: the page notes it in the same list), or something unparseable.
 */
export type FrameKind =
  | "memento.event.new"
  | "memento.welcome"
  | "memento.pong"
  | "memento.error"
  | "close"
  | "unknown";

export interface Frame {
  /** Increasing per page: the React key and the order. */
  seq: number;
  /** When the page received it (ms). */
  at: number;
  kind: FrameKind;
  /** The frame's text as it came off the socket. */
  raw: string;
  /** The parsed JSON (pretty-printed when a row is opened), `null` when it is not JSON. */
  json: unknown;
  /** The one-line summary. */
  line: string;
  /** For an event frame: its type, for filtering. */
  event: MementoEvent | null;
}

/** Everything but events: shown dimmed, and can be hidden. */
export function isControl(frame: Frame): boolean {
  return frame.kind !== "memento.event.new";
}

/** A frame from the text the socket delivered. */
export function frameOf(raw: string, at: number, seq: number, timeZone?: string): Frame {
  const stamp = `[${clock(at, timeZone)}]`;
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    return { seq, at, kind: "unknown", raw, json: null, line: `${stamp} ${raw}`, event: null };
  }
  const message = StreamMessageSchema.safeParse(json);
  const base = { seq, at, raw, json, event: null };
  if (!message.success) {
    const kind = (json as { kind?: unknown } | null)?.kind;
    return { ...base, kind: "unknown", line: `${stamp} ${typeof kind === "string" ? kind : raw}` };
  }
  const m = message.data;
  switch (m.kind) {
    case "memento.event.new":
      return { ...base, kind: m.kind, event: m.payload, line: eventLine(m.payload, timeZone) };
    case "memento.welcome": {
      const filter = Object.entries(m.payload.filter)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      return {
        ...base,
        kind: m.kind,
        line: `${stamp} memento.welcome — tenant ${m.payload.tenant}, ${filter || "every event"}, heartbeat ${m.payload.heartbeat_interval_ms / 1000} s`,
      };
    }
    case "memento.pong":
      return { ...base, kind: m.kind, line: `${stamp} memento.pong — heartbeat answered` };
    case "memento.error":
      return {
        ...base,
        kind: m.kind,
        line: `${stamp} memento.error — ${m.payload.code}: ${m.payload.message}`,
      };
  }
}

/** What the WebSocket reported when it closed. */
export interface CloseInfo {
  code: number;
  reason: string;
  reconnectInMs: number | null;
}

/** `4008 slow consumer`, or the code alone when the server gave no reason. */
export function closeText({ code, reason }: Pick<CloseInfo, "code" | "reason">): string {
  return reason ? `${code} ${reason}` : String(code);
}

/** The socket closing, as a (dimmed) row of the list. */
export function closeFrame(info: CloseInfo, at: number, seq: number, timeZone?: string): Frame {
  const next =
    info.reconnectInMs === null
      ? ""
      : `, reconnecting in ${Math.ceil(info.reconnectInMs / 1000)} s`;
  const json = {
    kind: "(socket closed)",
    code: info.code,
    reason: info.reason,
    reconnect_in_ms: info.reconnectInMs,
  };
  return {
    seq,
    at,
    kind: "close",
    raw: JSON.stringify(json),
    json,
    line: `[${clock(at, timeZone)}] closed — ${closeText(info)}${next}`,
    event: null,
  };
}

/** The application-level ping the page sends so that heartbeats show up in the list. */
export const PING_MESSAGE = JSON.stringify({ kind: "memento.ping" });

/**
 * A WebSocket constructor that hands every text frame to `onFrame` before the socket's own
 * handler sees it. `MementoStream` keeps parsing, reconnecting and backing off; the page only
 * listens in, so it shows the frames exactly as they arrive. `onSocket` gets each new socket
 * (to send the ping on).
 */
export function tapWebSocket(
  Impl: WebSocketConstructor,
  onFrame: (raw: string) => void,
  onSocket: (socket: WebSocketLike) => void = () => {},
): WebSocketConstructor {
  return class TappedSocket implements WebSocketLike {
    private readonly inner: WebSocketLike;
    constructor(url: string, protocols: string[]) {
      this.inner = new Impl(url, protocols);
      onSocket(this.inner);
    }
    get onopen() {
      return this.inner.onopen;
    }
    set onopen(handler) {
      this.inner.onopen = handler;
    }
    get onclose() {
      return this.inner.onclose;
    }
    set onclose(handler) {
      this.inner.onclose = handler;
    }
    get onerror() {
      return this.inner.onerror;
    }
    set onerror(handler) {
      this.inner.onerror = handler;
    }
    get onmessage() {
      return this.inner.onmessage;
    }
    set onmessage(handler) {
      this.inner.onmessage = handler
        ? (message) => {
            onFrame(String(message.data));
            handler(message);
          }
        : null;
    }
    send(data: string) {
      this.inner.send(data);
    }
    close(code?: number, reason?: string) {
      this.inner.close(code, reason);
    }
  };
}

/** The list and its counters. */
export interface TailState {
  /** Shown rows, newest first, at most `MAX_FRAMES`. */
  frames: Frame[];
  paused: boolean;
  /** Rows that arrived while paused, newest first, at most `MAX_FRAMES`. */
  pending: Frame[];
  /** How many arrived while paused (may exceed what `pending` keeps). */
  pendingCount: number;
  /** Frames the socket delivered, since the page (or the filter) started. */
  received: number;
  /** Events the page itself left out (several event types picked). */
  filteredOut: number;
  /** Arrival times of the events of the last `RATE_WINDOW_MS`, for `events/s`. */
  stamps: number[];
  /** When the current connection was welcomed; `null` while not live. */
  connectedSince: number | null;
  welcomes: number;
  lastClose: CloseInfo | null;
}

export const INITIAL_TAIL: TailState = {
  frames: [],
  paused: false,
  pending: [],
  pendingCount: 0,
  received: 0,
  filteredOut: 0,
  stamps: [],
  connectedSince: null,
  welcomes: 0,
  lastClose: null,
};

/** Reconnects: every welcome after the first one. */
export function reconnectsOf(state: TailState): number {
  return Math.max(0, state.welcomes - 1);
}

export type TailAction =
  /** A frame off the socket; `shown` false when the page's own filter leaves it out. */
  | { type: "frame"; frame: Frame; shown: boolean }
  | { type: "closed"; frame: Frame; info: CloseInfo }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "clear" }
  | { type: "reset" };

const capped = (frames: Frame[]) =>
  frames.length > MAX_FRAMES ? frames.slice(0, MAX_FRAMES) : frames;

function add(state: TailState, frame: Frame): TailState {
  if (state.paused) {
    return {
      ...state,
      pending: capped([frame, ...state.pending]),
      pendingCount: state.pendingCount + 1,
    };
  }
  return { ...state, frames: capped([frame, ...state.frames]) };
}

export function tailReducer(state: TailState, action: TailAction): TailState {
  switch (action.type) {
    case "frame": {
      const { frame } = action;
      let next: TailState = { ...state, received: state.received + 1 };
      if (frame.kind === "memento.event.new") {
        next.stamps = [...state.stamps.filter((t) => frame.at - t <= RATE_WINDOW_MS), frame.at];
      }
      if (frame.kind === "memento.welcome") {
        next = { ...next, connectedSince: frame.at, welcomes: state.welcomes + 1, lastClose: null };
      }
      if (!action.shown) return { ...next, filteredOut: next.filteredOut + 1 };
      return add(next, frame);
    }
    case "closed":
      return add({ ...state, connectedSince: null, lastClose: action.info }, action.frame);
    case "pause":
      return state.paused ? state : { ...state, paused: true, pending: [], pendingCount: 0 };
    case "resume":
      return {
        ...state,
        paused: false,
        frames: capped([...state.pending, ...state.frames]),
        pending: [],
        pendingCount: 0,
      };
    case "clear":
      return { ...state, frames: [], pending: [], pendingCount: 0 };
    case "reset":
      return { ...INITIAL_TAIL, paused: state.paused };
  }
}

/** Events per second over the last `RATE_WINDOW_MS`. */
export function eventsPerSecond(stamps: readonly number[], now: number): number {
  return stamps.filter((t) => now - t <= RATE_WINDOW_MS).length / (RATE_WINDOW_MS / 1000);
}
