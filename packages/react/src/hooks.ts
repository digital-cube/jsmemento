import {
  CHAT_EVENT_TYPES,
  CHAT_INSTANCE_TYPE,
  type ChatMessageResult,
  chatInstanceId,
  liveFilter,
  type MementoEvent,
  type StreamStatus,
} from "@memento/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useMemento } from "./context.js";

/** `off` when the hook was asked not to stream. */
export type LiveStatus = StreamStatus | "off";

export interface EventsQuery {
  /** Exact, or a prefix with a trailing `*` (`CHAT_*`). */
  event_type?: string | undefined;
  instance_type?: string | undefined;
  instance_id?: string | undefined;
  actor_id?: string | undefined;
  /** `occurred_at >= after` (ISO-8601). */
  after?: string | undefined;
  /** `occurred_at < before` (ISO-8601). */
  before?: string | undefined;
}

export interface UseEventsOptions {
  /** Page loaded from `GET /events`. Default 50. */
  limit?: number;
  /** Subscribe to `/ws` and add new events as they are stored. Default `true`. */
  live?: boolean;
  /** `false` to load nothing (e.g. before a search form is submitted). Default `true`. */
  enabled?: boolean;
  /** Most events kept while live updates pile up. Default 1000. */
  maxEvents?: number;
}

export interface EventsState {
  /** Newest first. */
  events: MementoEvent[];
  status: LiveStatus;
  loading: boolean;
  error: Error | null;
  /** Ids of the events that arrived over the stream (for highlighting). */
  liveIds: ReadonlySet<string>;
  /** Loads the page again. */
  reload: () => void;
}

const newestFirst = (a: MementoEvent, b: MementoEvent) =>
  a.occurred_at === b.occurred_at
    ? b.id.localeCompare(a.id)
    : Date.parse(b.occurred_at) - Date.parse(a.occurred_at);

/** `events` with `incoming` merged in by id, newest first, at most `max`. */
export function mergeEvents(
  events: MementoEvent[],
  incoming: MementoEvent[],
  max = Number.POSITIVE_INFINITY,
): MementoEvent[] {
  const byId = new Map(events.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort(newestFirst).slice(0, max);
}

function inRange(event: MementoEvent, query: EventsQuery): boolean {
  const at = Date.parse(event.occurred_at);
  if (query.after && at < Date.parse(query.after)) return false;
  if (query.before && at >= Date.parse(query.before)) return false;
  return true;
}

/**
 * Events matching `query`: the newest page from `GET /events`, then every new one the
 * stream delivers. Changing the query reloads the page and re-subscribes with the new
 * filter (exact values go to the server, `prefix*` ones are applied here).
 */
export function useMementoEvents(query: EventsQuery, options: UseEventsOptions = {}): EventsState {
  const { client, openStream } = useMemento();
  const { limit = 50, live = true, enabled = true, maxEvents = 1000 } = options;
  const [events, setEvents] = useState<MementoEvent[]>([]);
  const [liveIds, setLiveIds] = useState<ReadonlySet<string>>(() => new Set());
  const [status, setStatus] = useState<LiveStatus>("off");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [generation, setGeneration] = useState(0);

  // A stable key: effects re-run when the query's content changes, not its identity.
  const key = JSON.stringify([
    query.event_type?.trim() || null,
    query.instance_type?.trim() || null,
    query.instance_id?.trim() || null,
    query.actor_id?.trim() || null,
    query.after || null,
    query.before || null,
  ]);
  const normalized = useMemo<EventsQuery>(() => {
    const [event_type, instance_type, instance_id, actor_id, after, before] = JSON.parse(key) as (
      | string
      | null
    )[];
    const q: EventsQuery = {};
    if (event_type) q.event_type = event_type;
    if (instance_type) q.instance_type = instance_type;
    if (instance_id) q.instance_id = instance_id;
    if (actor_id) q.actor_id = actor_id;
    if (after) q.after = after;
    if (before) q.before = before;
    return q;
  }, [key]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `generation` is the reload trigger.
  useEffect(() => {
    setEvents([]);
    setLiveIds(new Set());
    setError(null);
    if (!enabled) {
      setLoading(false);
      return;
    }
    let active = true;
    setLoading(true);
    client
      .listEvents({ ...normalized, limit })
      .then((page) => {
        if (active) setEvents((current) => mergeEvents(current, page.data, maxEvents));
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [client, normalized, limit, enabled, maxEvents, generation]);

  useEffect(() => {
    if (!enabled || !live) {
      setStatus("off");
      return;
    }
    const { filter, matches } = liveFilter(normalized);
    const stream = openStream({
      filter,
      onStatus: setStatus,
      onEvent: (event) => {
        if (!matches(event) || !inRange(event, normalized)) return;
        setEvents((current) => mergeEvents(current, [event], maxEvents));
        setLiveIds((current) => new Set(current).add(event.id));
      },
    });
    setStatus(stream.status);
    return () => stream.close();
  }, [openStream, normalized, enabled, live, maxEvents]);

  const reload = useCallback(() => setGeneration((n) => n + 1), []);
  return { events, status, loading, error, liveIds, reload };
}

export interface ChatState {
  /** Oldest first, the way a chat reads. */
  messages: MementoEvent[];
  status: LiveStatus;
  loading: boolean;
  error: Error | null;
  sending: boolean;
  /** Sends `content` as the hook's user; resolves once stored. */
  send: (content: string) => Promise<ChatMessageResult>;
}

const oldestFirst = (a: MementoEvent, b: MementoEvent) => newestFirst(b, a);

/** The messages of one chat as `userId` sees them, live, with a `send` for that user. */
export function useMementoChat(
  chatId: string,
  userId: string,
  options: { limit?: number } = {},
): ChatState {
  const { client, openStream, locale } = useMemento();
  const { limit = 100 } = options;
  const instanceId = chatInstanceId(chatId);
  const [messages, setMessages] = useState<MementoEvent[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);

  const add = useCallback((incoming: MementoEvent[]) => {
    setMessages((current) => mergeEvents(current, incoming).sort(oldestFirst));
  }, []);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setError(null);
    setLoading(true);
    // Newest page, shown oldest first.
    client
      .chatMessages(instanceId, {
        user_id: userId,
        limit,
        order: "desc",
        ...(locale ? { locale } : {}),
      })
      .then((page) => {
        if (active) add(page.data);
      })
      .catch((cause: unknown) => {
        if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    const stream = openStream({
      filter: {
        instance_type: CHAT_INSTANCE_TYPE,
        instance_id: instanceId,
        event_type: CHAT_EVENT_TYPES.messageSent,
      },
      onStatus: setStatus,
      onEvent: (event) => add([event]),
    });
    setStatus(stream.status);
    return () => {
      active = false;
      stream.close();
    };
  }, [client, openStream, instanceId, userId, limit, locale, add]);

  const send = useCallback(
    async (content: string) => {
      setSending(true);
      setError(null);
      try {
        const result = await client.sendMessage(
          instanceId,
          { user_id: userId, content },
          locale ? { locale } : {},
        );
        // Shown at once; the stream's copy of the same event is merged by id.
        add([result.message]);
        return result;
      } catch (cause) {
        const failure = cause instanceof Error ? cause : new Error(String(cause));
        setError(failure);
        throw failure;
      } finally {
        setSending(false);
      }
    },
    [client, instanceId, userId, locale, add],
  );

  return { messages, status, loading, error, sending, send };
}
