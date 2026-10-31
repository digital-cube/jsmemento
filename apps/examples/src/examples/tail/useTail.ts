import {
  MementoStream,
  type StreamStatus,
  type WebSocketConstructor,
  type WebSocketLike,
} from "@memento/core";
import { type Dispatch, useEffect, useReducer, useRef, useState } from "react";
import {
  closeFrame,
  eventsPerSecond,
  frameOf,
  INITIAL_TAIL,
  PING_MESSAGE,
  type TailAction,
  type TailQuery,
  type TailState,
  tailReducer,
  tapWebSocket,
} from "./tail.js";

export interface TailOptions {
  baseUrl: string;
  apiKey: string;
  query: TailQuery;
  /** The header's language: the stream re-renders `rendered` in it (`?locale=`). */
  locale: string;
}

export interface Tail {
  state: TailState;
  dispatch: Dispatch<TailAction>;
  /** `off` when the filter is invalid and nothing is connected. */
  status: StreamStatus | "off";
  /** Events per second over the last 10 s, refreshed every second. */
  rate: number;
  now: number;
}

/**
 * Follows `/ws` with `MementoStream` (subprotocol auth, welcome, reconnect with backoff) and
 * lists every frame the socket delivers, not only the events. A new filter or language is a
 * new connection (the stream's filters are fixed for the life of one) and a fresh list.
 */
export function useTail({ baseUrl, apiKey, query, locale }: TailOptions): Tail {
  const [state, dispatch] = useReducer(tailReducer, INITIAL_TAIL);
  const [status, setStatus] = useState<StreamStatus | "off">("off");
  const [now, setNow] = useState(() => Date.now());
  const matches = useRef(query.matches);
  matches.current = query.matches;
  const { key, error } = query;
  const filterKey = JSON.stringify(query.filter);

  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` names the whole filter
  useEffect(() => {
    dispatch({ type: "reset" });
    if (error || !apiKey) {
      setStatus("off");
      return;
    }
    let seq = 0;
    let socket: WebSocketLike | null = null;
    let ping: ReturnType<typeof setInterval> | null = null;
    const Impl = (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
    if (!Impl) return;
    const stream = new MementoStream({
      baseUrl,
      apiKey,
      filter: JSON.parse(filterKey),
      locale,
      WebSocket: tapWebSocket(
        Impl,
        (raw) => {
          const frame = frameOf(raw, Date.now(), ++seq);
          const shown = frame.event ? matches.current(frame.event) : true;
          dispatch({ type: "frame", frame, shown });
        },
        (opened) => {
          socket = opened;
        },
      ),
      onStatus: setStatus,
      // Browsers answer the server's WebSocket pings without showing them, so the page
      // sends the stream's own `memento.ping` at the heartbeat interval: its pong is a row.
      onWelcome: ({ heartbeat_interval_ms }) => {
        if (ping) clearInterval(ping);
        ping = setInterval(() => socket?.send(PING_MESSAGE), heartbeat_interval_ms);
      },
      onClose: (info) => {
        if (ping) clearInterval(ping);
        ping = null;
        dispatch({ type: "closed", info, frame: closeFrame(info, Date.now(), ++seq) });
      },
    });
    setStatus(stream.status);
    return () => {
      if (ping) clearInterval(ping);
      stream.close();
    };
  }, [baseUrl, apiKey, key, filterKey, locale, error]);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const at = Math.max(now, state.stamps.at(-1) ?? 0);
  return { state, dispatch, status, rate: eventsPerSecond(state.stamps, at), now: at };
}
