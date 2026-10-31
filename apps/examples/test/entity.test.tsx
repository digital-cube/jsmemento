import type { Row } from "@jsudc/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
  actorInstance,
  defaultType,
  entityFilter,
  entityPath,
  nextTypeQuery,
  recentInstances,
  scanInstanceTypes,
  timelineItems,
  timelineSummary,
} from "../src/examples/entity/entity.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";
import { type FeedEvent, udcServer } from "./udc-server.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };

let n = 0;
/** The next event of the story, a second after the last one. */
function ev(
  event_type: string,
  instance: string,
  actor_id: string | null,
  en: string,
  sr = `SR: ${en}`,
): FeedEvent {
  n += 1;
  const [instance_type = "", instance_id = ""] = instance.split("/");
  return {
    id: uuid(n),
    event_type,
    instance_type,
    instance_id,
    actor_id,
    occurred_at: new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString(),
    rendered: { en, sr },
  };
}

/** A small ticket desk: T-3's whole story, with other instances around it. */
function story(): FeedEvent[] {
  n = 0;
  return [
    ev("USER_LOGIN", "user/ana", "ana", "ana logged in."),
    ev("TICKET_CREATED", "ticket/T-3", "ana", "ana created T-3.", "ana je kreirala T-3."),
    ev("USER_LOGIN", "user/marko", "marko", "marko logged in."),
    ev("TICKET_MODIFIED", "ticket/T-3", "marko", "marko assigned T-3.", "marko je dodelio T-3."),
    ev("CPU_LOAD", "server/stage", "monitor", "Server stage — CPU"),
    ev("TICKET_CREATED", "ticket/T-4", "marko", "marko created T-4."),
    ev("NOTE", "ticket/T-3", "marko", "Fix is in review.", "Ispravka je na pregledu."),
    ev("TICKET_CLOSED", "ticket/T-3", "ana", "ana closed T-3.", "ana je zatvorila T-3."),
  ];
}

const entries = () => screen.getAllByTestId("entry-text").map((el) => el.textContent);

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("the picker", () => {
  it("offers the tenant's instance types and the latest instances, with their counts", async () => {
    const server = udcServer({ feed: story() });
    vi.stubGlobal("fetch", server.fetch);
    history.replaceState(null, "", "/examples/entity");
    render(<App />);

    const types = await screen.findByTestId("entity-types");
    expect(
      within(types)
        .getAllByRole("tab")
        .map((b) => b.textContent),
    ).toEqual(["server", "ticket", "user"]);
    // `ticket` first when the tenant has tickets; newest instance first.
    expect(within(types).getByRole("tab", { selected: true }).textContent).toBe("ticket");
    const ids = await screen.findAllByTestId("entity-id");
    expect(ids.map((a) => a.dataset.id)).toEqual(["T-3", "T-4"]);
    expect(ids[0]?.getAttribute("href")).toBe("/examples/entity/ticket/T-3");
    await waitFor(() =>
      expect(screen.getAllByTestId("entity-count").map((c) => c.textContent)).toEqual([
        "4 events",
        "1 event",
      ]),
    );

    fireEvent.click(within(types).getByRole("tab", { name: "user" }));
    await waitFor(() =>
      expect(screen.getAllByTestId("entity-id").map((a) => a.dataset.id)).toEqual(["marko", "ana"]),
    );
    expect(location.search).toBe("?type=user");
  });

  it("opens an instance typed by hand", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: story() }).fetch);
    history.replaceState(null, "", "/examples/entity?type=user");
    render(<App />);
    await screen.findAllByTestId("entity-id");
    const form = screen.getByTestId("entity-form");
    const type = within(form).getByLabelText("Instance type") as HTMLInputElement;
    expect(type.value).toBe("user");
    fireEvent.change(type, { target: { value: "ticket" } });
    fireEvent.change(within(form).getByLabelText("Instance id"), { target: { value: "T-3" } });
    fireEvent.click(within(form).getByRole("button", { name: "Open timeline" }));
    await waitFor(() => expect(location.pathname).toBe("/examples/entity/ticket/T-3"));
    expect(await screen.findByText("ana closed T-3.")).toBeTruthy();
  });

  it("says so when the tenant has no events at all", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: [] }).fetch);
    history.replaceState(null, "", "/examples/entity");
    render(<App />);
    expect((await screen.findByTestId("entity-none")).textContent).toContain("memento simulate");
  });
});

describe("the timeline", () => {
  it("tells one instance's story, newest on top, with a summary line", async () => {
    const server = udcServer({ feed: story() });
    vi.stubGlobal("fetch", server.fetch);
    history.replaceState(null, "", "/examples/entity/ticket/T-3");
    render(<App />);
    await screen.findByText("ana closed T-3.");
    expect(entries()).toEqual([
      "ana closed T-3.",
      "Fix is in review.",
      "marko assigned T-3.",
      "ana created T-3.",
    ]);
    expect(screen.getByTestId("entity-title").textContent).toBe("ticket/T-3");
    expect(server.lists).toContainEqual(
      expect.objectContaining({
        collection: "events",
        filter: entityFilter("ticket", "T-3"),
        sort: [{ field: "occurred_at", dir: "desc" }],
      }),
    );
    const summary = screen.getByTestId("entity-summary").textContent ?? "";
    expect(summary).toMatch(
      /^First seen .*10:00:02.* · last seen .*10:00:08.* · 4 events · 2 actors$/,
    );

    const [top] = screen.getAllByTestId("entry");
    expect(within(top as HTMLElement).getByText("TICKET_CLOSED")).toBeTruthy();
    // The actor is another instance: a link to its own timeline.
    const actor = within(top as HTMLElement).getByTestId("entry-actor");
    expect(actor.textContent).toBe("user/ana");
    expect(actor.getAttribute("href")).toBe("/examples/entity/user/ana");
  });

  it("renders in the header's language", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: story() }).fetch);
    history.replaceState(null, "", "/examples/entity/ticket/T-3");
    render(<App />);
    await screen.findByText("ana closed T-3.");
    fireEvent.click(screen.getByTestId("locale-sr"));
    await screen.findByText("ana je zatvorila T-3.");
    expect(entries()[0]).toBe("ana je zatvorila T-3.");
    expect(screen.getByTestId("entity-summary").textContent).toContain("događaja: 4");
  });

  it("follows the stream of this instance only, and shows a new event without a reload", async () => {
    const feed = story();
    const server = udcServer({ feed });
    vi.stubGlobal("fetch", server.fetch);
    history.replaceState(null, "", "/examples/entity/ticket/T-3");
    render(<App />);
    await screen.findByText("ana closed T-3.");
    const socket = FakeSocket.last();
    expect(socket.query).toEqual({ instance_type: "ticket", instance_id: "T-3" });
    act(() => socket.welcome());

    const reopen = ev("TICKET_MODIFIED", "ticket/T-3", "marko", "marko reopened T-3.");
    feed.push(reopen);
    act(() =>
      socket.push(reopen.id, {
        event_type: reopen.event_type,
        instance_type: "ticket",
        instance_id: "T-3",
      }),
    );
    await screen.findByText("marko reopened T-3.", {}, { timeout: 3000 });
    expect(entries()[0]).toBe("marko reopened T-3.");
    expect(screen.getAllByTestId("entry")[0]?.className).toContain("is-new");
  });

  it("says so for an instance with no events, and offers the picker", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: story() }).fetch);
    history.replaceState(null, "", "/examples/entity/ticket/T-999");
    render(<App />);
    const empty = await screen.findByTestId("entity-empty");
    expect(empty.textContent).toContain("ticket/T-999");
    const pick = within(empty).getByRole("link", { name: "Pick another instance" });
    expect(pick.getAttribute("href")).toBe("/examples/entity?type=ticket");
  });

  it("does not link the instance to itself: on user/ana, ana is plain text", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: story() }).fetch);
    history.replaceState(null, "", "/examples/entity/user/ana");
    render(<App />);
    await screen.findByText("ana logged in.");
    expect(screen.queryByTestId("entry-actor")).toBeNull();
  });
});

describe("from the feed to a timeline", () => {
  it("every instance chip links to its timeline, and back works", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: story() }).fetch);
    history.replaceState(null, "", "/examples/activity");
    render(<App />);
    await screen.findByText("ana closed T-3.");
    const chips = screen.getAllByTestId("feed-instance");
    expect(chips[0]?.textContent).toBe("ticket/T-3");
    expect(chips[0]?.getAttribute("href")).toBe("/examples/entity/ticket/T-3");

    fireEvent.click(chips[0] as HTMLElement);
    await waitFor(() => expect(location.pathname).toBe("/examples/entity/ticket/T-3"));
    await screen.findByTestId("timeline");
    expect(entries()).toHaveLength(4);

    // An actor on the timeline leads to that user's own timeline.
    fireEvent.click(screen.getAllByTestId("entry-actor")[1] as HTMLElement);
    await waitFor(() => expect(location.pathname).toBe("/examples/entity/user/marko"));
    await screen.findByText("marko logged in.");

    act(() => history.back());
    await waitFor(() => expect(location.pathname).toBe("/examples/entity/ticket/T-3"));
    act(() => history.back());
    await waitFor(() => expect(location.pathname).toBe("/examples/activity"));
    expect(await screen.findByTestId("feed")).toBeTruthy();
  });
});

describe("entity helpers", () => {
  const row = (id: string, fields: Record<string, unknown> = {}): Row => ({
    __meta: { id, version: 1 },
    event_type: "NOTE",
    instance_type: "ticket",
    instance_id: "T-1",
    actor_id: "ana",
    occurred_at: "2026-10-31T10:00:00Z",
    rendered: "x",
    ...fields,
  });

  it("walks the distinct types one request each, in the collection's order", async () => {
    const types = ["server", "ticket", "user"];
    const list = vi.fn(async ({ filter }: { filter: unknown }) => {
      const after = (filter as { value?: string }).value;
      const next = types.find((t) => after === undefined || t > after);
      return { rows: next ? [row(next, { instance_type: next })] : [] };
    });
    expect(await scanInstanceTypes(list)).toEqual(types);
    expect(list).toHaveBeenCalledTimes(4);
    expect(list.mock.calls[0]?.[0]).toEqual({ ...nextTypeQuery(null), limit: 1 });
    expect(list.mock.calls[1]?.[0]).toMatchObject({
      filter: { field: "instance_type", op: "gt", value: "server" },
      sort: [{ field: "instance_type", dir: "asc" }],
    });
    expect(await scanInstanceTypes(list, 2)).toEqual(["server", "ticket"]);
  });

  it("opens on the asked type, else ticket, else the first", () => {
    expect(defaultType(["server", "ticket", "user"], "user")).toBe("user");
    expect(defaultType(["server", "ticket", "user"], "nope")).toBe("ticket");
    expect(defaultType(["server", "user"], null)).toBe("server");
    expect(defaultType([], "user")).toBeNull();
  });

  it("derives the most recently active ids, each once, newest first", () => {
    const rows = [
      row("a", { instance_id: "T-9", occurred_at: "2026-10-31T10:00:09Z" }),
      row("b", { instance_id: "T-2", occurred_at: "2026-10-31T10:00:08Z" }),
      row("c", { instance_id: "T-9", occurred_at: "2026-10-31T10:00:07Z" }),
      row("d", { instance_id: "", occurred_at: "2026-10-31T10:00:06Z" }),
      row("e", { instance_id: "T-1", occurred_at: "2026-10-31T10:00:05Z" }),
    ];
    expect(recentInstances(rows)).toEqual([
      { id: "T-9", lastAt: "2026-10-31T10:00:09Z" },
      { id: "T-2", lastAt: "2026-10-31T10:00:08Z" },
      { id: "T-1", lastAt: "2026-10-31T10:00:05Z" },
    ]);
    expect(recentInstances(rows, 2).map((r) => r.id)).toEqual(["T-9", "T-2"]);
  });

  it("orders the timeline newest first and sums it up", () => {
    const items = timelineItems([
      row("a", { occurred_at: "2026-10-31T10:00:01Z", actor_id: "ana" }),
      row("c", { occurred_at: "2026-10-31T10:00:03Z", actor_id: "ana" }),
      row("b", { occurred_at: "2026-10-31T10:00:02Z", actor_id: "marko" }),
      row("b", { occurred_at: "2026-10-31T10:00:02Z", actor_id: "marko" }),
    ]);
    expect(items.map((i) => i.id)).toEqual(["c", "b", "a"]);
    expect(timelineSummary(items, 3)).toEqual({
      firstSeen: "2026-10-31T10:00:01Z",
      lastSeen: "2026-10-31T10:00:03Z",
      count: 3,
      actors: 2,
      partial: false,
    });
    // Not every page loaded: the first event comes from its own query, actors are a lower bound.
    expect(timelineSummary(items, 120, "2026-10-01T00:00:00Z")).toMatchObject({
      firstSeen: "2026-10-01T00:00:00Z",
      count: 120,
      partial: true,
    });
    expect(timelineSummary([], 0)).toMatchObject({ firstSeen: null, lastSeen: null, count: 0 });
  });

  it("links an actor as user/<id>, but not the instance to itself", () => {
    const ticket = { instanceType: "ticket", instanceId: "T-1" };
    expect(actorInstance("ana", ticket)).toEqual({ instanceType: "user", instanceId: "ana" });
    expect(actorInstance("ana", { instanceType: "user", instanceId: "ana" })).toBeNull();
    expect(actorInstance(null, ticket)).toBeNull();
  });

  it("encodes ids in the timeline's path", () => {
    expect(entityPath("chat", "igor marko/2026")).toBe("/examples/entity/chat/igor%20marko%2F2026");
  });
});
