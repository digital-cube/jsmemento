import type { FilterNode, Condition as UdcCondition } from "@jsudc/core";
import { encodeFilterParam, PARAM } from "@jsudc/react/headless";
import type { Filter } from "@memento/core";
import type { MementoSearchValues } from "@memento/react";

/** The UDC collection the same search can be made on. */
export const SEARCH_COLLECTION = "events";

/** The page's URL parameters, one per control of the form. */
export const SEARCH_PARAMS = { type: "type", id: "id", from: "from", to: "to" } as const;

/**
 * The search in the page's URL, or `null` when none was made. `type` is always written by a
 * search (empty for "any type"), so its presence is what says a search was made.
 */
export function searchFromParams(params: URLSearchParams): MementoSearchValues | null {
  const type = params.get(SEARCH_PARAMS.type);
  if (type === null) return null;
  return {
    instanceType: type,
    instanceId: params.get(SEARCH_PARAMS.id) ?? "",
    from: params.get(SEARCH_PARAMS.from) ?? "",
    to: params.get(SEARCH_PARAMS.to) ?? "",
  };
}

/** `params` with `values` as the search (empty controls left out, every other key kept). */
export function searchToParams(
  values: MementoSearchValues,
  params: URLSearchParams = new URLSearchParams(),
): URLSearchParams {
  const next = new URLSearchParams(params);
  next.set(SEARCH_PARAMS.type, values.instanceType);
  const optional: [string, string][] = [
    [SEARCH_PARAMS.id, values.instanceId],
    [SEARCH_PARAMS.from, values.from],
    [SEARCH_PARAMS.to, values.to],
  ];
  for (const [key, value] of optional) {
    if (value) next.set(key, value);
    else next.delete(key);
  }
  return next;
}

/** The body `MementoSearch` sent to `POST /events/query`: the filter and the parameters. */
export interface QueryBody {
  filter?: Filter | null;
  limit?: number;
  locale?: string;
  [key: string]: unknown;
}

/** One request to `POST /events/query` as it went over the wire, and what came back. */
export interface Exchange {
  /** Counts the requests of the page; the last one is shown. */
  seq: number;
  /** As passed to `fetch`: `/memento/events/query` behind the proxy. */
  url: string;
  body: QueryBody;
  /** `null` while the answer is pending. */
  status: number | null;
  /** The parsed response envelope; `null` while pending or when it was not JSON. */
  response: unknown;
  /** Set when the request could not be made at all. */
  error?: string;
}

const isQueryRequest = (url: string, init: RequestInit | undefined): boolean =>
  (init?.method ?? "GET").toUpperCase() === "POST" &&
  /\/events\/query$/.test(url.split(/[?#]/, 1)[0] ?? "");

const parseBody = (body: BodyInit | null | undefined): QueryBody => {
  if (typeof body !== "string") return {};
  try {
    const parsed = JSON.parse(body) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as QueryBody) : {};
  } catch {
    return {};
  }
};

/**
 * A `fetch` for `MementoProvider` that lets every request through unchanged and reports each
 * `POST …/events/query` to `onExchange` — once when it is sent, again with its answer — so
 * the page shows exactly what the component sent, not a reconstruction of it. An answer to a
 * request that has since been superseded is not reported.
 */
export function tapFetch(
  onExchange: (exchange: Exchange) => void,
  base?: typeof fetch,
): typeof fetch {
  let latest = 0;
  return async (input, init) => {
    const doFetch = base ?? globalThis.fetch;
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    if (!isQueryRequest(url, init)) return doFetch(input, init);
    latest += 1;
    const sent: Exchange = {
      seq: latest,
      url,
      body: parseBody(init?.body),
      status: null,
      response: null,
    };
    onExchange(sent);
    try {
      const response = await doFetch(input, init);
      const json = (await response
        .clone()
        .json()
        .catch(() => null)) as unknown;
      if (sent.seq === latest) onExchange({ ...sent, status: response.status, response: json });
      return response;
    } catch (cause) {
      if (sent.seq === latest) {
        onExchange({ ...sent, error: cause instanceof Error ? cause.message : String(cause) });
      }
      throw cause;
    }
  };
}

/** The key as shown on the page: the prefix and the last four characters. */
export function maskKey(key: string): string {
  if (key.length <= 8) return "mk_…";
  const prefix = key.startsWith("mk_") ? "mk_" : "";
  return `${prefix}…${key.slice(-4)}`;
}

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;

/** The request as a `curl` command to paste in a shell (`origin` resolves a relative URL). */
export function curlLine(url: string, apiKey: string, body: unknown, origin: string): string {
  const absolute = new URL(url, origin).href;
  return [
    `curl -X POST ${shellQuote(absolute)}`,
    `  -H ${shellQuote(`Authorization: Bearer ${maskKey(apiKey)}`)}`,
    `  -H 'Content-Type: application/json'`,
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join(" \\\n");
}

/**
 * The response envelope with its rows cut to the first one: `ok`, `meta` and `data[0]`, then
 * how many rows were left out. Anything that is not a success envelope is shown as it is.
 */
export function responseShape(response: unknown): unknown {
  if (!response || typeof response !== "object") return response;
  const envelope = response as { data?: unknown };
  if (!Array.isArray(envelope.data)) return response;
  const rows = envelope.data;
  const rest = rows.length - 1;
  return {
    ...envelope,
    data: rows.length === 0 ? [] : [rows[0], ...(rest > 0 ? [`… ${rest} more`] : [])],
  };
}

/** memento's operator names → UDC's (the rest are spelled the same). */
const UDC_OPS = { ne: "neq", nin: "not_in", prefix: "starts_with" } as const;

/**
 * The memento Filter DSL tree as a UDC filter tree: the same shape (`field` / `op` / `value`
 * conditions under `and` / `or` / `not`), with UDC's spelling of three operators and of
 * `is_null: false`.
 */
export function toUdcFilter(filter: Filter | null | undefined): FilterNode | null {
  if (!filter) return null;
  if ("and" in filter) return { and: filter.and.map((f) => toUdcFilter(f) as FilterNode) };
  if ("or" in filter) return { or: filter.or.map((f) => toUdcFilter(f) as FilterNode) };
  if ("not" in filter) return { not: toUdcFilter(filter.not) as FilterNode };
  if (filter.op === "is_null") {
    return { field: filter.field, op: filter.value ? "is_null" : "is_not_null" };
  }
  const op = (UDC_OPS as Record<string, UdcCondition["op"]>)[filter.op] ?? filter.op;
  return { field: filter.field, op: op as UdcCondition["op"], value: filter.value };
}

/**
 * The UDC table of the `events` collection opened with the same filter: the filter in the
 * `?f=` parameter `UdcDataView` reads its filter tree from (`encodeFilterParam`).
 */
export function udcEventsPath(filter: Filter | null | undefined): string {
  const encoded = encodeFilterParam(toUdcFilter(filter));
  const path = `/udc/${SEARCH_COLLECTION}`;
  return encoded ? `${path}?${new URLSearchParams({ [PARAM.filter]: encoded })}` : path;
}
