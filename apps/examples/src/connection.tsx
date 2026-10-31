import { UdcClient } from "@jsudc/core/client";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import type { Settings } from "./settings.js";

/**
 * The header the UDC client names the page's language in: memento renders the rows'
 * `rendered` text in it (`X-Memento-Locale`, docs/TEMPLATES.md).
 */
export const LOCALE_HEADER = "x-memento-locale";

/** A UDC client of memento at `baseUrl`, with `apiKey`, whose rows are rendered in `locale`. */
export function mementoUdcClient(baseUrl: string, apiKey: string, locale: string): UdcClient {
  return new UdcClient({
    httpUrl: baseUrl.replace(/\/+$/, ""),
    headers: {
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
      [LOCALE_HEADER]: locale,
    },
  });
}

/** What `GET <baseUrl>/api/demo` answers: the deployment's read-only demo key. */
export interface DemoKey {
  apiKey: string;
  tenant: string;
}

/**
 * The demo key the server hands out (`MEMENTO_DEMO_API_KEY`), or `null` when it has none
 * (404), answers something else, or cannot be reached. Not list data — one value of the
 * deployment's configuration, so a plain request, not UDC.
 */
export async function fetchDemoKey(
  baseUrl: string,
  doFetch: typeof fetch = globalThis.fetch,
): Promise<DemoKey | null> {
  try {
    const response = await doFetch(`${baseUrl.replace(/\/+$/, "")}/api/demo`, {
      headers: { accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { data?: { api_key?: unknown; tenant?: unknown } };
    const key = body?.data?.api_key;
    if (typeof key !== "string" || key === "") return null;
    const tenant = body.data?.tenant;
    return { apiKey: key, tenant: typeof tenant === "string" ? tenant : "" };
  } catch {
    return null;
  }
}

export type DemoState =
  /** Not asked: the visitor has a key of their own. */
  | { status: "off" }
  | { status: "loading" }
  /** The server has no demo key (or could not be asked). */
  | { status: "none" }
  | { status: "ready"; key: DemoKey };

/** Asks the server for its demo key while `enabled` (no key of the visitor's own). */
export function useDemoKey(
  baseUrl: string,
  enabled: boolean,
  doFetch: typeof fetch = globalThis.fetch,
): DemoState {
  const [state, setState] = useState<DemoState>(() =>
    enabled ? { status: "loading" } : { status: "off" },
  );
  useEffect(() => {
    if (!enabled) {
      setState({ status: "off" });
      return;
    }
    let cancelled = false;
    setState({ status: "loading" });
    void fetchDemoKey(baseUrl, doFetch).then((key) => {
      if (!cancelled) setState(key ? { status: "ready", key } : { status: "none" });
    });
    return () => {
      cancelled = true;
    };
  }, [baseUrl, enabled, doFetch]);
  return state;
}

/** Where the key in use comes from. */
export type KeySource = "own" | "demo" | "pending" | "none";

/** The server and key every page talks to: the visitor's own key wins over the demo key. */
export interface Connection {
  baseUrl: string;
  apiKey: string;
  source: KeySource;
  /** The demo key's tenant, when `source` is `demo`. */
  tenant: string | null;
}

export function connectionOf(settings: Settings, demo: DemoState): Connection {
  if (settings.apiKey) {
    return { baseUrl: settings.baseUrl, apiKey: settings.apiKey, source: "own", tenant: null };
  }
  if (demo.status === "ready") {
    return {
      baseUrl: settings.baseUrl,
      apiKey: demo.key.apiKey,
      source: "demo",
      tenant: demo.key.tenant,
    };
  }
  const pending = demo.status === "loading";
  return {
    baseUrl: settings.baseUrl,
    apiKey: "",
    source: pending ? "pending" : "none",
    tenant: null,
  };
}

export interface SettingsContextValue {
  settings: Settings;
  connection: Connection;
  /** Saves `next` (localStorage) and connects with it. */
  apply: (next: Settings) => void;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  value,
  children,
}: {
  value: SettingsContextValue;
  children: ReactNode;
}) {
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (!value) throw new Error("useSettings outside <SettingsProvider>");
  return value;
}
