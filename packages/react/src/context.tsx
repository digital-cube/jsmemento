import {
  MementoClient,
  MementoStream,
  type MementoStreamOptions,
  type ReconnectOptions,
  type WebSocketConstructor,
} from "@memento/core";
import { createContext, type ReactNode, useContext, useMemo } from "react";

export interface MementoContextValue {
  client: MementoClient;
  baseUrl: string;
  apiKey: string;
  /** Locale `rendered` is requested in, when set. */
  locale: string | undefined;
  /** Opens a stream bound to this provider's server and key. */
  openStream: (
    options: Omit<
      MementoStreamOptions,
      "baseUrl" | "apiKey" | "WebSocket" | "reconnect" | "locale"
    >,
  ) => MementoStream;
}

const MementoContext = createContext<MementoContextValue | null>(null);

export interface MementoProviderProps {
  /** API base URL: `http://localhost:8000/memento`, or `/memento` behind a proxy. */
  baseUrl: string;
  /** A key with `read` (and `write` for sending chat messages). */
  apiKey: string;
  /** Render `rendered` in this locale (`sr`, `sr-Latn`, …). Default: the server's. */
  locale?: string;
  /** Default: `globalThis.fetch`. */
  fetch?: typeof fetch;
  /** Default: `globalThis.WebSocket`. */
  WebSocket?: WebSocketConstructor;
  /** Reconnect policy of every stream. Default: exponential backoff, 0.5 s → 15 s. */
  reconnect?: boolean | ReconnectOptions;
  children?: ReactNode;
}

/** Where every memento component finds its server, key and WebSocket. */
export function MementoProvider({
  baseUrl,
  apiKey,
  locale,
  fetch,
  WebSocket,
  reconnect,
  children,
}: MementoProviderProps) {
  const value = useMemo<MementoContextValue>(
    () => ({
      client: new MementoClient({ baseUrl, apiKey, ...(fetch ? { fetch } : {}) }),
      baseUrl,
      apiKey,
      locale,
      openStream: (options) =>
        new MementoStream({
          ...options,
          baseUrl,
          apiKey,
          ...(locale ? { locale } : {}),
          ...(WebSocket ? { WebSocket } : {}),
          ...(reconnect !== undefined ? { reconnect } : {}),
        }),
    }),
    [baseUrl, apiKey, locale, fetch, WebSocket, reconnect],
  );
  return <MementoContext.Provider value={value}>{children}</MementoContext.Provider>;
}

/** The nearest `MementoProvider`'s client and settings. */
export function useMemento(): MementoContextValue {
  const value = useContext(MementoContext);
  if (!value) throw new Error("memento components must be rendered inside <MementoProvider>");
  return value;
}
