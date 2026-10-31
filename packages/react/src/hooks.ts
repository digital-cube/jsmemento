import {
  CHAT_EVENT_TYPES,
  CHAT_INSTANCE_TYPE,
  type ChatMessageResult,
  type ChatParticipant,
  chatInstanceId,
  eventQueryToFilter,
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
  /**
   * `list`: the query as `GET /events`'s query string. `query`: the same query as a Filter
   * DSL tree in the body of `POST /events/query` (`eventQueryToFilter`). Default `list`.
   */
  endpoint?: "list" | "query";
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
  const { client, openStream, locale } = useMemento();
  const { limit = 50, live = true, enabled = true, maxEvents = 1000, endpoint = "list" } = options;
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
    const rendering = locale ? { locale } : {};
    const load =
      endpoint === "query"
        ? client.queryEvents({ filter: eventQueryToFilter(normalized), limit, ...rendering })
        : client.listEvents({ ...normalized, limit, ...rendering });
    load
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
  }, [client, normalized, limit, enabled, maxEvents, endpoint, locale, generation]);

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
  /**
   * With `seen`: the chat's participants with their read watermarks, kept current from the
   * stream (CHAT_MESSAGE_SEEN, CHAT_PARTICIPANT_ADDED). Empty otherwise.
   */
  participants: ChatParticipant[];
  /** With `system`: the chat's CHAT_PARTICIPANT_ADDED events, oldest first. Empty otherwise. */
  notices: MementoEvent[];
}

export interface UseChatOptions {
  /** Messages loaded at first. Default 100. */
  limit?: number;
  /** Load the participants and follow their read watermarks. Default `false`. */
  seen?: boolean;
  /** Load and follow the chat's system events (somebody was added). Default `false`. */
  system?: boolean;
}

/** `participants` after one CHAT_MESSAGE_SEEN / CHAT_PARTICIPANT_ADDED event of the chat. */
export function applyChatEvent(
  participants: ChatParticipant[],
  event: MementoEvent,
): ChatParticipant[] {
  const userId = event.payload.user_id;
  if (typeof userId !== "string") return participants;
  if (event.event_type === CHAT_EVENT_TYPES.messageSeen) {
    const upTo = event.payload.messages_read_up_to;
    if (typeof upTo !== "string") return participants;
    return participants.map((p) =>
      p.user_id === userId
        ? { ...p, last_seen_event_id: upTo, last_seen_at: event.occurred_at }
        : p,
    );
  }
  if (event.event_type === CHAT_EVENT_TYPES.participantAdded) {
    if (participants.some((p) => p.user_id === userId)) return participants;
    return [
      ...participants,
      {
        user_id: userId,
        added_at: event.occurred_at,
        last_seen_event_id: null,
        last_seen_at: null,
      },
    ];
  }
  return participants;
}

const oldestFirst = (a: MementoEvent, b: MementoEvent) => newestFirst(b, a);

/** The messages of one chat as `userId` sees them, live, with a `send` for that user. */
export function useMementoChat(
  chatId: string,
  userId: string,
  options: UseChatOptions = {},
): ChatState {
  const { client, openStream, locale } = useMemento();
  const { limit = 100, seen = false, system = false } = options;
  const instanceId = chatInstanceId(chatId);
  const [messages, setMessages] = useState<MementoEvent[]>([]);
  const [status, setStatus] = useState<LiveStatus>("connecting");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [sending, setSending] = useState(false);
  const [participants, setParticipants] = useState<ChatParticipant[]>([]);
  const [notices, setNotices] = useState<MementoEvent[]>([]);

  const add = useCallback((incoming: MementoEvent[]) => {
    setMessages((current) => mergeEvents(current, incoming).sort(oldestFirst));
  }, []);
  const notice = useCallback((incoming: MementoEvent[]) => {
    setNotices((current) => mergeEvents(current, incoming).sort(oldestFirst));
  }, []);

  useEffect(() => {
    let active = true;
    setMessages([]);
    setNotices([]);
    setParticipants([]);
    setError(null);
    setLoading(true);
    const failed = (cause: unknown) => {
      if (active) setError(cause instanceof Error ? cause : new Error(String(cause)));
    };
    const read = { user_id: userId, limit, order: "desc" as const, ...(locale ? { locale } : {}) };
    // Newest page, shown oldest first.
    const loads: Promise<unknown>[] = [
      client.chatMessages(instanceId, read).then((page) => {
        if (active) add(page.data);
      }),
    ];
    if (system) {
      loads.push(
        client
          .chatMessages(instanceId, { ...read, event_type: CHAT_EVENT_TYPES.participantAdded })
          .then((page) => {
            if (active) notice(page.data);
          }),
      );
    }
    if (seen) {
      loads.push(
        client.getChat(instanceId, { user_id: userId }).then((chat) => {
          // Events the stream delivered while the chat loaded are applied on top.
          if (active) setParticipants(chat.participants);
        }),
      );
    }
    Promise.all(loads)
      .catch(failed)
      .finally(() => {
        if (active) setLoading(false);
      });
    // Seen markers and system lines need the chat's other events: subscribe to all of them.
    const everything = seen || system;
    const stream = openStream({
      filter: {
        instance_type: CHAT_INSTANCE_TYPE,
        instance_id: instanceId,
        ...(everything ? {} : { event_type: CHAT_EVENT_TYPES.messageSent }),
      },
      onStatus: setStatus,
      onEvent: (event) => {
        if (event.event_type === CHAT_EVENT_TYPES.messageSent) add([event]);
        else if (event.event_type === CHAT_EVENT_TYPES.participantAdded && system) notice([event]);
        if (seen) setParticipants((current) => applyChatEvent(current, event));
      },
    });
    setStatus(stream.status);
    return () => {
      active = false;
      stream.close();
    };
  }, [client, openStream, instanceId, userId, limit, locale, add, notice, seen, system]);

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

  return { messages, status, loading, error, sending, send, participants, notices };
}
