import { type MementoEvent, MementoStream, type StreamStatus } from "@memento/core";
import { useEffect, useRef, useState } from "react";

/** The dot in the header: green while both the stream and the server are up. */
export type Health = "live" | "connecting" | "offline";

export function healthOf(stream: StreamStatus | "off", serverUp: boolean | null): Health {
  if (serverUp === false || stream === "offline" || stream === "closed") return "offline";
  if (stream === "live" && serverUp) return "live";
  return "connecting";
}

/** Events per second over the timestamps of the last `windowMs`. */
export function rateOf(stamps: readonly number[], now: number, windowMs = 10_000): number {
  const recent = stamps.filter((t) => now - t <= windowMs);
  return recent.length / (windowMs / 1000);
}

export interface LiveOptions {
  baseUrl: string;
  apiKey: string;
  filter: { event_type?: string; instance_type?: string };
  /** Called for every event the stream delivers (throttle what it triggers yourself). */
  onEvent: (event: MementoEvent) => void;
  /** How often `/api/health` is polled. Default 5000. */
  healthIntervalMs?: number;
  fetch?: typeof fetch;
}

export interface LiveState {
  health: Health;
  stream: StreamStatus | "off";
  serverUp: boolean | null;
  lastEventAt: number | null;
  /** Events per second over the last 10 s. */
  rate: number;
}

/**
 * Subscribes to memento's WebSocket stream (`/ws`, filtered like the table) and polls the
 * server's health. Not a data fetch: the rows come from UDC; this only says when to refetch.
 */
export function useLive(options: LiveOptions): LiveState {
  const { baseUrl, apiKey, filter, healthIntervalMs = 5000 } = options;
  const onEvent = useRef(options.onEvent);
  onEvent.current = options.onEvent;
  const doFetch = options.fetch ?? globalThis.fetch;
  const [stream, setStream] = useState<StreamStatus | "off">("off");
  const [serverUp, setServerUp] = useState<boolean | null>(null);
  const [stamps, setStamps] = useState<number[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const filterKey = JSON.stringify(filter);

  useEffect(() => {
    if (!apiKey) {
      setStream("off");
      return;
    }
    setStream("connecting");
    setStamps([]);
    const live = new MementoStream({
      baseUrl,
      apiKey,
      filter: JSON.parse(filterKey),
      onStatus: setStream,
      onEvent: (event) => {
        const at = Date.now();
        setStamps((prev) => [...prev.filter((t) => at - t <= 10_000), at]);
        onEvent.current(event);
      },
    });
    return () => live.close();
  }, [baseUrl, apiKey, filterKey]);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}/api/health`);
        if (!cancelled) setServerUp(response.ok);
      } catch {
        if (!cancelled) setServerUp(false);
      }
      if (!cancelled) setNow(Date.now());
    };
    void check();
    const timer = setInterval(check, healthIntervalMs);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [baseUrl, healthIntervalMs, doFetch]);

  return {
    health: healthOf(stream, serverUp),
    stream,
    serverUp,
    lastEventAt: stamps.at(-1) ?? null,
    rate: rateOf(stamps, Math.max(now, stamps.at(-1) ?? 0)),
  };
}
