import { ChartOptionsSchema, evaluateFilter, type Row, type SortKey } from "@jsudc/core";
import { expect, vi } from "vitest";

export const caps = {
  mutate: false,
  subscribe: false,
  total_count: true,
  schema_edit: false,
  config_edit: false,
  reindex: false,
  tree_reparent: false,
  source_yaml: false,
  paging: ["offset" as const],
  supported_filter_ops: ["eq", "gt"],
};

export const describeCpu = {
  collection: "cpu_load",
  capabilities: caps,
  source_kind: "postgres_jsonb",
  schema: {
    version: "v1",
    core_fields: [],
    field_order: ["occurred_at", "instance_type", "instance_id", "load_1min"],
    fields: {
      occurred_at: { type: "datetime" },
      instance_type: { type: "string" },
      instance_id: { type: "string" },
      load_1min: { type: "decimal" },
    },
  },
  view: {
    default_renderer: "table",
    available_renderers: ["table"],
    columns: [{ field: "occurred_at" }, { field: "instance_id" }, { field: "load_1min" }],
    page_size_default: 50,
    pagination: "pages",
    default_column_width: 160,
    row_actions: [],
  },
  filterable: {
    fields: [
      {
        field: "instance_type",
        type: "string",
        ops: ["eq", "contains"],
        default_op: "contains",
        widget: "text",
      },
    ],
  },
};

/** The `activity` collection as memento describes it (its three own fields, chart first). */
export const describeActivity = {
  collection: "activity",
  capabilities: { ...caps, supported_filter_ops: ["eq", "gte", "lte"] },
  source_kind: "postgres_jsonb",
  schema: {
    version: "v1",
    core_fields: [],
    field_order: ["minute", "event_type", "count", "cpu_load"],
    fields: {
      minute: { type: "datetime", index: true },
      event_type: { type: "string", index: true },
      count: { type: "integer" },
      cpu_load: { type: "integer" },
    },
  },
  view: {
    default_renderer: "chart",
    available_renderers: ["chart", "table"],
    columns: [{ field: "minute" }, { field: "event_type" }, { field: "count" }],
    page_size_default: 50,
    pagination: "pages",
    default_column_width: 160,
    row_actions: [],
    chart_options: ChartOptionsSchema.parse({
      type: "line",
      x_field: "minute",
      series: [{ field: "cpu_load", label: "CPU_LOAD", agg: "sum" }],
    }),
  },
  filterable: {
    fields: [
      {
        field: "minute",
        type: "datetime",
        ops: ["gte", "lte"],
        default_op: "gte",
        widget: "datetime",
      },
      { field: "event_type", type: "string", ops: ["eq"], default_op: "eq", widget: "text" },
    ],
  },
};

const listing = (name: string, source_kind = "postgres_jsonb") => ({
  name,
  default_renderer: "table",
  capabilities: caps,
  source_kind,
  group: source_kind === "yaml_menu" ? "files" : "database",
});

/** A menu row as the yaml_menu source flattens it; ids are the path, for readability. */
export function node(path: string, order: number, fields: Record<string, unknown> = {}): Row {
  const codes = path.split("/");
  const ancestors = codes.slice(0, -1).map((_, i) => codes.slice(0, i + 1).join("/"));
  return {
    __meta: { id: path, version: 1 },
    code: codes.at(-1),
    translation_key: null,
    icon: null,
    url: null,
    parent_id: ancestors.at(-1) ?? null,
    order,
    depth: ancestors.length,
    ancestor_ids: ancestors,
    children_count: 0,
    is_dynamic: false,
    ...fields,
  };
}

/** What memento's menu.yaml flattens to, `udc:collections` resolved. */
export const SERVED_MENU: Row[] = [
  node("HOME", 0, { translation_key: "MENU_HOME", icon: "lucide:house", url: "/" }),
  node("EXAMPLES", 1, { translation_key: "MENU_EXAMPLES", icon: "lucide:layout-dashboard" }),
  ...[
    ["CPU_MONITOR", "activity", "cpu-monitor"],
    ["ACTIVITY", "file-text", "activity"],
    ["ENTITY", "folder-open", "entity"],
    ["CHAT", "messages-square", "chat"],
    ["TAIL", "network", "tail"],
    ["SEARCH", "database", "search"],
    ["RENDERING", "globe", "rendering"],
    ["CHART", "chart-line", "chart"],
  ].map(([code, icon, slug], i) =>
    node(`EXAMPLES/${code}`, i, {
      translation_key: `MENU_${code}`,
      icon: `lucide:${icon}`,
      url: `/examples/${slug}`,
    }),
  ),
  node("COLLECTIONS", 2, { translation_key: "MENU_COLLECTIONS", icon: "lucide:layers" }),
  ...["events", "cpu_load", "menu"].map((name, i) =>
    node(`COLLECTIONS/COLLECTION_${name.toUpperCase()}`, i, {
      translation_key: `COLLECTIONS_${name.toUpperCase()}`,
      icon: "lucide:table",
      url: `/udc/${name}`,
      is_dynamic: true,
    }),
  ),
];

/** An event of the feed stub: its `rendered` text per locale, as memento would render it. */
export interface FeedEvent {
  id: string;
  event_type: string;
  instance_type: string;
  instance_id: string;
  actor_id: string | null;
  occurred_at: string;
  rendered: { en: string; sr: string };
  payload?: Record<string, unknown>;
}

export interface ServerOptions {
  /** The key every UDC request must carry. */
  key?: string;
  /** What `GET /api/demo` answers; `null` → 404. */
  demo?: { api_key: string; tenant: string } | null;
  /** Serve the `menu` collection. Default true. */
  menu?: boolean;
  /**
   * Serve these as the `events` collection (newest last; the stub applies the request's
   * filter and sort — `occurred_at` desc by default — pages by offset and renders in
   * `X-Memento-Locale`). Tests may
   * push to the array while the app runs. Default: one new CPU row per list, like `cpu_load`.
   */
  feed?: FeedEvent[];
}

/**
 * A `fetch` that plays memento: `/api/health`, `/api/demo`, and the UDC actions
 * (`collections`, `describe`, `list` — the menu rows, or one new CPU row per list — and
 * `read` of a feed event, rendered in its `X-Memento-Locale`).
 */
export function udcServer({ key = "mk_k", demo = null, menu = true, feed }: ServerOptions = {}) {
  const lists: Record<string, unknown>[] = [];
  /** The `X-Memento-Locale` of every list, in order. */
  const locales: (string | null)[] = [];
  /** Every `read` of the feed: the event id and the `X-Memento-Locale` it was asked in. */
  const reads: { id: string; locale: string | null }[] = [];
  const calls: string[] = [];
  let n = 0;
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push(url);
    if (url.endsWith("/api/health")) return new Response('{"ok":true}', { status: 200 });
    if (url.endsWith("/api/demo")) {
      return demo
        ? new Response(JSON.stringify({ ok: true, data: demo }), { status: 200 })
        : new Response('{"ok":false,"error":{"code":"not_found","message":"no demo key"}}', {
            status: 404,
          });
    }
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${key}`);
    const action = url.split("/udc/")[1];
    const ok = (payload: unknown) =>
      new Response(JSON.stringify({ kind: `udc.${action}.ok`, id: "", payload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (action === "collections") {
      return ok({
        collections: [
          listing("events"),
          listing("cpu_load"),
          ...(menu ? [listing("menu", "yaml_menu")] : []),
        ],
      });
    }
    if (action === "describe") {
      if (body.collection === "activity") return ok(describeActivity);
      return ok({ ...describeCpu, collection: body.collection });
    }
    if (action === "read" && feed && body.collection === "events") {
      const locale = new Headers(init?.headers).get("x-memento-locale");
      reads.push({ id: body.id, locale });
      const found = feed.find((e) => e.id === body.id);
      if (!found) {
        return new Response(
          JSON.stringify({
            kind: "udc.read.err",
            id: "",
            payload: { code: "not_found", message: `no event ${body.id}` },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      const { id, rendered, ...e } = found;
      return ok({
        row: {
          __meta: { id, version: 1 },
          ...e,
          rendered: locale === "sr" ? rendered.sr : rendered.en,
        },
      });
    }
    if (action === "list") {
      if (body.collection === "menu") {
        return ok({ rows: SERVED_MENU, next_cursor: null, total: SERVED_MENU.length });
      }
      lists.push(body);
      locales.push(new Headers(init?.headers).get("x-memento-locale"));
      if (feed && body.collection === "events") {
        const sr = new Headers(init?.headers).get("x-memento-locale") === "sr";
        const sort: SortKey[] = body.sort?.length
          ? body.sort
          : [{ field: "occurred_at", dir: "desc" }];
        const all = feed
          .filter((e) => evaluateFilter(body.filter, e as unknown as Record<string, unknown>))
          .sort((a, b) => {
            for (const { field, dir } of sort) {
              const x = String((a as unknown as Record<string, unknown>)[field] ?? "");
              const y = String((b as unknown as Record<string, unknown>)[field] ?? "");
              const c = x < y ? -1 : x > y ? 1 : 0;
              if (c !== 0) return dir === "desc" ? -c : c;
            }
            return 0;
          });
        const offset = body.page?.offset ?? 0;
        const limit = body.page?.limit ?? 50;
        return ok({
          rows: all.slice(offset, offset + limit).map(({ id, rendered, ...e }) => ({
            __meta: { id, version: 1 },
            ...e,
            rendered: sr ? rendered.sr : rendered.en,
          })),
          next_cursor: null,
          total: all.length,
        });
      }
      if (body.collection === "activity") {
        const row = (minute: string, event_type: string, count: number) => ({
          __meta: { id: `${minute}|${event_type}`, version: 1 },
          minute,
          event_type,
          count,
          cpu_load: event_type === "CPU_LOAD" ? count : 0,
        });
        const minute = `${new Date().toISOString().slice(0, 16)}:00.000Z`;
        const rows = [row(minute, "CPU_LOAD", 60), row(minute, "TICKET_CREATED", 2)];
        return ok({ rows, next_cursor: null, total: rows.length });
      }
      n += 1;
      return ok({
        rows: [
          {
            __meta: { id: `r${n}`, version: 1 },
            occurred_at: "2026-10-31T10:00:00Z",
            instance_id: `backend-${n}`,
            load_1min: 0.5,
          },
        ],
        next_cursor: null,
        total: 1,
      });
    }
    return ok({});
  });
  return { fetch, lists, locales, reads, calls };
}
