import type { Row } from "@jsudc/core";
import { createUdcQueryClient } from "@jsudc/react";
import { UdcReactRouterUrlState } from "@jsudc/react/react-router";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { vi } from "vitest";
import { ServiceProviders } from "../src/App.js";
import { serviceUdcClient } from "../src/lib/udc.js";
import type { Me } from "../src/session.js";

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
  supported_filter_ops: ["eq", "neq"],
};

export function me(overrides: { verified?: boolean; admin?: boolean; maxKeys?: number } = {}): Me {
  return {
    user: {
      id: "u1",
      email: "ana@example.com",
      name: "Ana",
      locale: "en",
      email_verified: overrides.verified ?? true,
      is_admin: overrides.admin ?? false,
      created_at: "2026-11-01T08:00:00Z",
    },
    tenant: {
      id: "t1",
      slug: "t-ana",
      name: "Ana",
      plan: "free",
      max_keys: overrides.maxKeys ?? null,
      retention_days: null,
    },
    limits: { default_max_keys: 10, default_daily_limit: 100_000, max_daily_limit: 500_000 },
  };
}

/** One node of menu-service.yaml as the `yaml_menu` source serves it. */
export function menuNode(code: string, order: number, url: string): Row {
  return {
    __meta: { id: `menu:${code}`, version: 1 },
    code,
    translation_key: `MENU_${code}`,
    icon: null,
    url,
    parent_id: null,
    order,
    depth: 0,
    ancestor_ids: [],
    children_count: 0,
    is_dynamic: false,
  };
}

export const SERVED_MENU: Row[] = [
  menuNode("HOME", 0, "/"),
  menuNode("KEYS", 1, "/keys"),
  menuNode("CLIENTS", 2, "/clients"),
  menuNode("ACCOUNT", 3, "/account"),
  menuNode("ADMIN", 4, "/admin/users"),
];

const json = (status: number, body: unknown) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

export type Handler = (body: Record<string, unknown>, init: RequestInit) => Response | undefined;

export interface FakeOptions {
  /** `GET /auth/me`; `null` → 401. */
  me?: Me | null;
  /** Rows of a UDC list per collection. */
  lists?: Record<string, { rows: Row[]; total?: number }>;
  /** Extra answers by `METHOD /path` (under /memento). */
  routes?: Record<string, Handler>;
}

/** A `fetch` that plays the memento server of the service site. */
export function fakeServer({ me: who = null, lists = {}, routes = {} }: FakeOptions = {}) {
  const calls: {
    method: string;
    path: string;
    body: Record<string, unknown>;
    credentials?: string;
  }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), "http://localhost");
    const path = url.pathname.replace(/^\/memento/, "");
    const method = (init.method ?? "GET").toUpperCase();
    const body = init.body ? JSON.parse(String(init.body)) : {};
    calls.push({ method, path, body, credentials: init.credentials });
    const own = routes[`${method} ${path}`]?.(body, init);
    if (own) return own;
    if (path === "/auth/me") {
      return who
        ? json(200, { ok: true, data: who })
        : json(401, { ok: false, error: { code: "unauthorized", message: "not signed in" } });
    }
    if (path.startsWith("/udc/")) {
      const action = path.slice("/udc/".length);
      const ok = (payload: unknown) => json(200, { kind: `udc.${action}.ok`, id: "", payload });
      if (action === "describe") {
        return ok({
          collection: body.collection,
          capabilities: caps,
          source_kind: "postgres_jsonb",
          schema: {
            version: "v1",
            core_fields: [],
            field_order: ["name"],
            fields: { name: { type: "string" } },
          },
          view: {
            default_renderer: "table",
            available_renderers: ["table"],
            columns: [{ field: "name" }],
            page_size_default: 50,
            pagination: "pages",
            default_column_width: 160,
            row_actions: [],
          },
          filterable: { fields: [] },
        });
      }
      if (action === "list") {
        const list = lists[String(body.collection)] ?? { rows: [] };
        return ok({ rows: list.rows, next_cursor: null, total: list.total ?? list.rows.length });
      }
    }
    return json(404, { ok: false, error: { code: "not_found", message: `${method} ${path}` } });
  });
  return { fetch, calls };
}

/** `ui` inside the site's providers and a router at `path`, with `server` as `fetch`. */
export function renderAt(ui: ReactNode, server: ReturnType<typeof fakeServer>, path = "/") {
  vi.stubGlobal("fetch", server.fetch);
  const queryClient = createUdcQueryClient();
  const result = render(
    <ServiceProviders
      locale="en"
      onLocaleChange={() => undefined}
      queryClient={queryClient}
      client={serviceUdcClient("en")}
    >
      <MemoryRouter initialEntries={[path]}>
        <UdcReactRouterUrlState>{ui}</UdcReactRouterUrlState>
      </MemoryRouter>
    </ServiceProviders>,
  );
  return { ...result, queryClient };
}

export const ok = (data: unknown, status = 200) => json(status, { ok: true, data });
export const fail = (status: number, code: string, message: string, details?: unknown) =>
  json(status, { ok: false, error: { code, message, details } });
