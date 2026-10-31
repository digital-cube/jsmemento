import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, StatusBar } from "../src/App.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };

const describeCpu = {
  collection: "cpu_load",
  capabilities: {
    mutate: false,
    subscribe: false,
    total_count: true,
    schema_edit: false,
    config_edit: false,
    reindex: false,
    tree_reparent: false,
    source_yaml: false,
    paging: ["offset"],
    supported_filter_ops: ["eq", "gt"],
  },
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

let lists: unknown[];
function udcServer() {
  lists = [];
  let n = 0;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/api/health")) return new Response('{"ok":true}', { status: 200 });
    const body = JSON.parse(String(init?.body ?? "{}"));
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer mk_k");
    const action = url.split("/udc/")[1];
    const ok = (payload: unknown) =>
      new Response(JSON.stringify({ kind: `udc.${action}.ok`, id: "", payload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    if (action === "describe") return ok(describeCpu);
    if (action === "list") {
      lists.push(body);
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
}

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  history.replaceState(null, "", "/");
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("App", () => {
  it("asks for a key first", () => {
    vi.stubGlobal("fetch", udcServer());
    render(<App />);
    expect(screen.getByText(/Paste an API key/)).toBeTruthy();
    expect(new URLSearchParams(location.search).get("f")).toBeTruthy();
  });

  it("draws the UDC table and refetches it when the stream reports an event", async () => {
    vi.stubGlobal("fetch", udcServer());
    render(<App />);
    fireEvent.change(screen.getByPlaceholderText("mk_ab12cd34_…"), {
      target: { value: " mk_k " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}").apiKey).toBe("mk_k");

    await screen.findByText("backend-1");
    expect(lists[0]).toMatchObject({
      collection: "cpu_load",
      filter: { field: "instance_type", op: "eq", value: "server" },
    });
    const socket = FakeSocket.last();
    expect(socket.query).toEqual({ event_type: "CPU_LOAD", instance_type: "server" });
    act(() => socket.welcome());
    await screen.findByText("Live");

    act(() => {
      socket.push(uuid(1));
      socket.push(uuid(2));
    });
    await screen.findByText("backend-2", {}, { timeout: 3000 });
    expect(lists).toHaveLength(2); // two events, one throttled refetch
  });
});

describe("StatusBar", () => {
  it("says why it is not green", () => {
    const base = { health: "offline" as const, lastEventAt: null, rate: 0 };
    const { rerender } = render(
      <StatusBar live={{ ...base, stream: "live", serverUp: false }} settings={settings} />,
    );
    expect(screen.getByText("server unreachable")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    rerender(
      <StatusBar live={{ ...base, stream: "offline", serverUp: true }} settings={settings} />,
    );
    expect(screen.getByText("stream reconnecting")).toBeTruthy();
    rerender(
      <StatusBar
        live={{ ...base, health: "connecting", stream: "connecting", serverUp: null }}
        settings={settings}
      />,
    );
    expect(screen.getByText("connecting to stream")).toBeTruthy();
  });
});

it("restores saved settings", async () => {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  vi.stubGlobal("fetch", udcServer());
  render(<App />);
  await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
});
