import { evaluateFilter } from "@jsudc/core";
import { decodeFilterParam } from "@jsudc/react/headless";
import type { Filter, MementoEvent } from "@memento/core";
import { dayStart, type MementoSearchValues } from "@memento/react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
  curlLine,
  type Exchange,
  maskKey,
  responseShape,
  searchFromParams,
  searchToParams,
  tapFetch,
  toUdcFilter,
  udcEventsPath,
} from "../src/examples/search/search.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";
import { udcServer } from "./udc-server.js";

const KEY = "mk_live_secret_9f3a";
const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: KEY };

function ticketEvent(n: number, overrides: Partial<MementoEvent> = {}): MementoEvent {
  const at = new Date(Date.UTC(2026, 9, 20 + (n % 10), 10, 0, n)).toISOString();
  return {
    id: uuid(n),
    occurred_at: at,
    received_at: at,
    event_type: "TICKET_CREATED",
    instance_type: "ticket",
    instance_id: `T-${n}`,
    actor_id: "ana",
    payload: {},
    rendered: `ana created ticket T-${n}.`,
    rendered_locale: "en",
    archived_at: null,
    ...overrides,
  };
}

/** memento's own evaluation of the conditions the search sends (eq, prefix, gte, lt, and). */
function mementoMatches(filter: Filter | null | undefined, event: MementoEvent): boolean {
  if (!filter) return true;
  if ("and" in filter) return filter.and.every((f) => mementoMatches(f, event));
  if ("or" in filter) return filter.or.some((f) => mementoMatches(f, event));
  if ("not" in filter) return !mementoMatches(filter.not, event);
  const actual = String(event[filter.field as keyof MementoEvent] ?? "");
  const value = String(filter.value);
  switch (filter.op) {
    case "eq":
      return actual === value;
    case "prefix":
      return actual.startsWith(value);
    case "gte":
      return Date.parse(actual) >= Date.parse(value);
    case "lt":
      return Date.parse(actual) < Date.parse(value);
    default:
      throw new Error(`stub: op ${filter.op}`);
  }
}

/**
 * The UDC stub with memento's `POST /events/query` on top: `events` filtered with the body's
 * Filter DSL tree, newest first, `rendered` in the body's `locale`.
 */
function server(events: MementoEvent[]) {
  const udc = udcServer({ key: KEY, feed: [] });
  const queries: { url: string; body: Record<string, unknown> }[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.endsWith("/events/query")) return udc.fetch(input, init);
    expect(new Headers(init?.headers).get("authorization")).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init?.body)) as { filter?: Filter | null; locale?: string };
    queries.push({ url, body });
    const data = events
      .filter((e) => mementoMatches(body.filter, e))
      .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at))
      .map((e) =>
        body.locale === "sr" ? { ...e, rendered: `SR: ${e.rendered}`, rendered_locale: "sr" } : e,
      );
    return new Response(
      JSON.stringify({
        ok: true,
        data,
        meta: { limit: 100, count: data.length, next_cursor: null },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  return { fetch, queries, udc };
}

const EVENTS = [
  ticketEvent(1),
  ticketEvent(10),
  ticketEvent(12),
  ticketEvent(2),
  ticketEvent(3, { instance_type: "user", instance_id: "T-1x" }),
];

let stub: ReturnType<typeof server>;

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  stub = server(EVENTS);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", stub.fetch);
});
afterEach(() => vi.unstubAllGlobals());

const pane = (id: string) => screen.getByTestId(id).textContent ?? "";

async function searchFor(values: Partial<MementoSearchValues>) {
  const form = await screen.findByRole("button", { name: "Search" });
  if (values.instanceType !== undefined) {
    fireEvent.change(screen.getByLabelText("Instance type"), {
      target: { value: values.instanceType },
    });
  }
  if (values.instanceId !== undefined) {
    fireEvent.change(screen.getByLabelText("Instance ID"), {
      target: { value: values.instanceId },
    });
  }
  if (values.from !== undefined) {
    fireEvent.change(screen.getByLabelText("From"), { target: { value: values.from } });
  }
  if (values.to !== undefined) {
    fireEvent.change(screen.getByLabelText("To"), { target: { value: values.to } });
  }
  fireEvent.click(form);
}

describe("the Search page", () => {
  it("waits for a search: no request, the panes empty", async () => {
    history.replaceState(null, "", "/examples/search");
    render(<App />);
    expect(await screen.findByText("Pick an instance and a date range, then search.")).toBeTruthy();
    expect(screen.getByText(/Run a search/)).toBeTruthy();
    expect(pane("search-dsl")).toBe("—");
    expect(screen.queryByTestId("search-udc")).toBeNull();
    expect(stub.queries).toHaveLength(0);
  });

  it("shows exactly the Filter DSL the hook sent, the curl line and the response's shape", async () => {
    history.replaceState(null, "", "/examples/search");
    render(<App />);
    await searchFor({ instanceType: "ticket", instanceId: "T-1*", to: "2026-10-31" });

    await waitFor(() => expect(stub.queries).toHaveLength(1));
    const sent = stub.queries[0]?.body as { filter: Filter };
    // The pane is the body the fetch carried, not a reconstruction.
    await waitFor(() => expect(pane("search-dsl")).toBe(JSON.stringify(sent.filter, null, 2)));
    expect(sent.filter).toEqual({
      and: [
        { field: "instance_type", op: "eq", value: "ticket" },
        { field: "instance_id", op: "prefix", value: "T-1" },
        { field: "occurred_at", op: "lt", value: dayStart("2026-11-01") },
      ],
    });
    expect(sent).toMatchObject({ limit: 100, locale: "en" });

    const curl = pane("search-curl");
    expect(curl).toContain(`curl -X POST '${location.origin}/memento/events/query'`);
    expect(curl).toContain("Authorization: Bearer mk_…9f3a");
    expect(curl).not.toContain(KEY);
    expect(curl).toContain(`-d '${JSON.stringify(sent)}'`);

    // T-12, T-1, T-10 match (newest first: Oct 22, 21, 20); the user T-1x and the ticket T-2 do not.
    await waitFor(() => expect(pane("search-response")).toContain('"ok": true'));
    const response = pane("search-response");
    expect(response).toContain("HTTP 200");
    expect(response).toContain('"count": 3');
    expect(response).toContain("ana created ticket T-12.");
    expect(response).toContain("… 2 more");
    expect(response).not.toContain("ana created ticket T-10.");

    // Results: the instance chip leads to the instance's timeline.
    const chips = await screen.findAllByTestId("search-instance");
    expect(chips.map((c) => c.textContent)).toEqual(["ticket/T-12", "ticket/T-1", "ticket/T-10"]);
    expect(chips[0]?.getAttribute("href")).toBe("/examples/entity/ticket/T-12");
  });

  it("keeps the search in the URL: a link reproduces it, back restores the last one", async () => {
    history.replaceState(null, "", "/examples/search?type=user&id=T-1x&from=2026-10-01");
    render(<App />);
    // A search in the URL runs at once, the form shows it.
    await waitFor(() => expect(stub.queries).toHaveLength(1));
    expect(stub.queries[0]?.body.filter).toEqual({
      and: [
        { field: "instance_type", op: "eq", value: "user" },
        { field: "instance_id", op: "eq", value: "T-1x" },
        { field: "occurred_at", op: "gte", value: dayStart("2026-10-01") },
      ],
    });
    expect((screen.getByLabelText("Instance ID") as HTMLInputElement).value).toBe("T-1x");
    expect((screen.getByLabelText("Instance type") as HTMLSelectElement).value).toBe("user");
    expect((screen.getByLabelText("From") as HTMLInputElement).value).toBe("2026-10-01");

    await searchFor({ instanceType: "", instanceId: "T-2", from: "" });
    await waitFor(() => expect(location.search).toBe("?type=&id=T-2"));
    await waitFor(() =>
      expect(stub.queries.at(-1)?.body.filter).toEqual({
        field: "instance_id",
        op: "eq",
        value: "T-2",
      }),
    );

    act(() => history.back());
    await waitFor(() =>
      expect((screen.getByLabelText("Instance ID") as HTMLInputElement).value).toBe("T-1x"),
    );
    expect(location.search).toBe("?type=user&id=T-1x&from=2026-10-01");
  });

  it("links to the UDC events table with an equivalent filter, which opens it", async () => {
    history.replaceState(null, "", "/examples/search");
    render(<App />);
    await searchFor({ instanceType: "ticket", instanceId: "T-1*", from: "2026-10-01" });
    const link = await screen.findByTestId("search-udc");
    const sent = stub.queries.at(-1)?.body.filter as Filter;
    const href = new URL(link.getAttribute("href") ?? "", location.origin);
    expect(href.pathname).toBe("/udc/events");
    const udcFilter = decodeFilterParam(href.searchParams.get("f"));
    expect(udcFilter).toEqual({
      and: [
        { field: "instance_type", op: "eq", value: "ticket" },
        { field: "instance_id", op: "starts_with", value: "T-1" },
        { field: "occurred_at", op: "gte", value: dayStart("2026-10-01") },
      ],
    });
    // Equivalent: both select the same events.
    for (const event of EVENTS) {
      expect(
        evaluateFilter(udcFilter, event as unknown as Record<string, unknown>),
        event.instance_id,
      ).toBe(mementoMatches(sent, event));
    }

    fireEvent.click(link);
    await waitFor(() => expect(location.pathname).toBe("/udc/events"));
    // The data view lists the collection with that filter.
    await waitFor(() =>
      expect(
        stub.udc.lists.some((l) => JSON.stringify(l.filter) === JSON.stringify(udcFilter)),
      ).toBe(true),
    );
  });

  it("follows the header's language: the query carries the locale, the text comes back in it", async () => {
    history.replaceState(null, "", "/examples/search?type=ticket&id=T-2");
    render(<App />);
    expect(await screen.findByText("ana created ticket T-2.")).toBeTruthy();
    fireEvent.click(screen.getByTestId("locale-sr"));
    expect(await screen.findByText("SR: ana created ticket T-2.")).toBeTruthy();
    expect(stub.queries.at(-1)?.body.locale).toBe("sr");
    expect(screen.getByRole("heading", { name: "Šta je poslato" })).toBeTruthy();
    await waitFor(() => expect(pane("search-curl")).toContain('"locale":"sr"'));
  });

  it("says when the search filters on nothing", async () => {
    history.replaceState(null, "", "/examples/search?type=");
    render(<App />);
    await waitFor(() => expect(pane("search-dsl")).toBe("null"));
    expect(screen.getByText(/filter is null/)).toBeTruthy();
    expect(screen.getByTestId("search-udc").getAttribute("href")).toBe("/udc/events");
    const sent = within(screen.getByRole("complementary")).getByTestId("search-curl");
    expect(sent.textContent).toContain('"filter":null');
  });
});

describe("search helpers", () => {
  it("round-trips the search through the URL, keeping other parameters", () => {
    const cases: MementoSearchValues[] = [
      { instanceType: "ticket", instanceId: "T-1", from: "2026-10-01", to: "2026-10-31" },
      { instanceType: "", instanceId: "", from: "", to: "" },
      { instanceType: "user", instanceId: "igor-*", from: "", to: "2026-10-31" },
    ];
    for (const values of cases) {
      const params = searchToParams(values, new URLSearchParams("tab=x&id=old"));
      expect(params.get("tab")).toBe("x");
      expect(searchFromParams(new URLSearchParams(params.toString()))).toEqual(values);
    }
    expect(searchToParams(cases[1] as MementoSearchValues).toString()).toBe("type=");
    expect(searchFromParams(new URLSearchParams("id=T-1"))).toBeNull();
  });

  it("taps only POST …/events/query and shows the last request's answer", async () => {
    const seen: Exchange[] = [];
    let answerFirst: (response: Response) => void = () => {};
    const base = vi.fn(
      (input: RequestInfo | URL) =>
        new Promise<Response>((resolve) => {
          if (String(input).includes("first")) answerFirst = resolve;
          else resolve(new Response('{"ok":true,"data":[]}', { status: 200 }));
        }),
    );
    const tapped = tapFetch((e) => seen.push(e), base as unknown as typeof fetch);
    await tapped("/memento/events?limit=1", { method: "GET" });
    expect(seen).toEqual([]);

    const first = tapped("/memento/events/query?first", {
      method: "POST",
      body: '{"filter":null}',
    });
    expect(seen.at(-1)).toMatchObject({ seq: 1, status: null, body: { filter: null } });
    await tapped("/memento/events/query", { method: "POST", body: '{"limit":1}' });
    expect(seen.at(-1)).toMatchObject({
      seq: 2,
      status: 200,
      body: { limit: 1 },
      response: { ok: true, data: [] },
    });
    // The first request answers late: the page keeps showing the second.
    answerFirst(new Response("{}"));
    await first;
    expect(seen.at(-1)?.seq).toBe(2);
  });

  it("masks the key and quotes the curl line for a shell", () => {
    expect(maskKey("mk_abcdefghijkl")).toBe("mk_…ijkl");
    expect(maskKey("mk_k")).toBe("mk_…");
    const line = curlLine("/memento/events/query", "mk_abcdefghijkl", { a: "it's" }, "http://h");
    expect(line).toBe(
      [
        "curl -X POST 'http://h/memento/events/query'",
        "  -H 'Authorization: Bearer mk_…ijkl'",
        "  -H 'Content-Type: application/json'",
        `  -d '{"a":"it'\\''s"}'`,
      ].join(" \\\n"),
    );
  });

  it("cuts the response to its first row", () => {
    expect(responseShape({ ok: true, data: [1, 2, 3], meta: { count: 3 } })).toEqual({
      ok: true,
      data: [1, "… 2 more"],
      meta: { count: 3 },
    });
    expect(responseShape({ ok: true, data: [] })).toEqual({ ok: true, data: [] });
    expect(responseShape({ ok: false, error: { code: "x" } })).toEqual({
      ok: false,
      error: { code: "x" },
    });
  });

  it("translates every operator to UDC's spelling", () => {
    expect(
      toUdcFilter({
        or: [
          { field: "event_type", op: "ne", value: "CPU_LOAD" },
          { field: "actor_id", op: "nin", value: ["a"] },
          { not: { field: "actor_id", op: "is_null", value: true } },
          { field: "actor_id", op: "is_null", value: false },
          { field: "occurred_at", op: "between", value: ["a", "b"] },
        ],
      }),
    ).toEqual({
      or: [
        { field: "event_type", op: "neq", value: "CPU_LOAD" },
        { field: "actor_id", op: "not_in", value: ["a"] },
        { not: { field: "actor_id", op: "is_null" } },
        { field: "actor_id", op: "is_not_null" },
        { field: "occurred_at", op: "between", value: ["a", "b"] },
      ],
    });
    expect(toUdcFilter(null)).toBeNull();
    expect(udcEventsPath(null)).toBe("/udc/events");
  });
});
