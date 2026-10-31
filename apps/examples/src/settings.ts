import type { FilterNode } from "@jsudc/core";
import { encodeFilterParam, PARAM } from "@jsudc/react/headless";

/**
 * What the visitor can set: where the server is and which key (the header's settings), which
 * collection and which instances (the CPU monitor's bar). Kept in localStorage.
 */
export interface Settings {
  /** API base URL: `/memento` through the dev server's proxy, or `http://host:port/memento`. */
  baseUrl: string;
  /** The visitor's own key; empty: the server's demo key (`GET /api/demo`), when it has one. */
  apiKey: string;
  /** A UDC collection memento serves: `cpu_load` (the demo) or `events` (every event). */
  collection: string;
  /** `instance_type` the table and the live stream are narrowed to; empty for all. */
  instanceType: string;
}

export const STORAGE_KEY = "memento-cpu-monitor:settings";
export const COLLECTIONS = ["cpu_load", "events"] as const;

export function defaultSettings(env: ImportMetaEnv = import.meta.env): Settings {
  return {
    baseUrl: env.VITE_MEMENTO_BASE_URL || "/memento",
    apiKey: env.VITE_MEMENTO_API_KEY ?? "",
    collection: "cpu_load",
    instanceType: "server",
  };
}

/** Settings from `storage`, every missing or malformed field from the defaults. */
export function loadSettings(storage: Pick<Storage, "getItem">, defaults: Settings): Settings {
  try {
    const raw = JSON.parse(storage.getItem(STORAGE_KEY) ?? "null") as Partial<Settings> | null;
    if (!raw || typeof raw !== "object") return defaults;
    const pick = (key: keyof Settings) =>
      typeof raw[key] === "string" ? (raw[key] as string) : defaults[key];
    return {
      baseUrl: pick("baseUrl") || defaults.baseUrl,
      apiKey: pick("apiKey"),
      collection: pick("collection") || defaults.collection,
      instanceType: pick("instanceType"),
    };
  } catch {
    return defaults;
  }
}

export function saveSettings(storage: Pick<Storage, "setItem">, settings: Settings): void {
  storage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

/** The UDC filter tree of the settings: `instance_type = <instanceType>`, or none. */
export function settingsFilter(settings: Settings): FilterNode | null {
  const value = settings.instanceType.trim();
  return value ? { field: "instance_type", op: "eq", value } : null;
}

/**
 * `search` with the data view's filter parameter set to the settings' filter (and its page
 * reset), so `<UdcDataView>` opens already narrowed, with the condition visible and editable
 * in its filter builder. Everything else in the query string is kept.
 */
export function withSettingsFilter(search: string, settings: Settings): string {
  const params = new URLSearchParams(search);
  const encoded = encodeFilterParam(settingsFilter(settings));
  if (encoded) params.set(PARAM.filter, encoded);
  else params.delete(PARAM.filter);
  params.delete(PARAM.page);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/** The memento stream filter for the settings: CPU_LOAD only for the cpu_load collection. */
export function streamFilter(settings: Settings): { event_type?: string; instance_type?: string } {
  return {
    ...(settings.collection === "cpu_load" ? { event_type: "CPU_LOAD" } : {}),
    ...(settings.instanceType.trim() ? { instance_type: settings.instanceType.trim() } : {}),
  };
}
