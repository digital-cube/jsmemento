import type { MementoEvent } from "@memento/core";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
  closeFrame,
  eventLine,
  eventsPerSecond,
  filtersFromSearch,
  filtersToSearch,
  frameOf,
  INITIAL_TAIL,
  MAX_FRAMES,
  NO_FILTERS,
  PING_MESSAGE,
  reconnectsOf,
  type TailState,
  tailQuery,
  tailReducer,
  tapWebSocket,
} from "../src/examples/tail/tail.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";
import { udcServer } from "./udc-server.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };
const UTC = "UTC";

function ticket(n: number, overrides: Partial<MementoEvent> = {}): Record<string, unknown> {
  return {
    event_type: "TICKET_CREATED",
    instance_type: "ticket",
    instance_id: `T-${n}`,
    actor_id: "ana",
    occurred_at: new Date(Date.UTC(2026, 9, 31, 10, 0, n % 60)).toISOString(),
    rendered: `ana created ticket T-${n}.`,
    ...overrides,
  };
}

const lines = () => screen.queryAllByTestId("tail-line").map((el) => el.textContent);

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  history.replaceState(null, "", "/examples/tail");
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", udcServer({ feed: [] }).fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("the filters", () => {
  it("round-trip through the page's URL", () => {
    const filters = filtersFromSearch(
      new URLSearchParams(
        "event_type=TICKET_CREATED&event_type=NOTE,USER_LOGIN&instance_type=ticket&f=x",
      ),
    );
    expect(filters).toEqual({
      event_types: ["TICKET_CREATED", "NOTE", "USER_LOGIN"],
      instance_type: "ticket",
      instance_id: "",
      actor_id: "",
    });
    expect(filtersToSearch(filters, new URLSearchParams("f=x&instance_id=old"))).toBe(
      "?f=x&event_type=TICKET_CREATED&event_type=NOTE&event_type=USER_LOGIN&instance_type=ticket",
    );
    expect(filtersToSearch(NO_FILTERS)).toBe("");
  });

  it("send one event type to the stream, several are kept by the page", () => {
    const one = tailQuery({ ...NO_FILTERS, event_types: ["NOTE"], actor_id: " ana " });
    expect(one).toMatchObject({
      filter: { event_type: "NOTE", actor_id: "ana" },
      clientSide: false,
      error: null,
    });
    const many = tailQuery({ ...NO_FILTERS, event_types: ["NOTE", "USER_LOGIN"] });
    expect(many.filter).toEqual({});
    expect(many.clientSide).toBe(true);
    expect(many.matches({ event_type: "NOTE" } as MementoEvent)).toBe(true);
    expect(many.matches({ event_type: "CPU_LOAD" } as MementoEvent)).toBe(false);
    expect(many.key).not.toBe(one.key);
  });

  it("refuse what the stream would refuse", () => {
    expect(tailQuery({ ...NO_FILTERS, instance_type: "Ticket" }).error).toContain("snake_case");
    const bad = tailQuery({ ...NO_FILTERS, event_types: ["NOTE", "bad"] });
    expect(bad.error).toContain("SCREAMING_SNAKE_CASE");
    expect(bad.matches({ event_type: "NOTE" } as MementoEvent)).toBe(false);
  });
});

describe("a frame", () => {
  const at = Date.UTC(2026, 9, 31, 9, 59, 58);

  it("is an event as memento tail prints it", () => {
    const event = { ...ticket(3), id: uuid(3) } as unknown as MementoEvent;
    expect(eventLine(event, UTC)).toBe(
      "[10:00:03] TICKET_CREATED ticket/T-3 — ana created ticket T-3.",
    );
    expect(eventLine({ ...event, rendered: null }, UTC)).toBe(
      "[10:00:03] TICKET_CREATED ticket/T-3",
    );
    const raw = JSON.stringify({
      kind: "memento.event.new",
      id: uuid(3),
      payload: {
        ...event,
        received_at: event.occurred_at,
        payload: {},
        rendered_locale: "en",
        archived_at: null,
      },
    });
    const frame = frameOf(raw, at, 1, UTC);
    expect(frame.kind).toBe("memento.event.new");
    expect(frame.event?.instance_id).toBe("T-3");
  });

  it("names the control messages and anything unknown", () => {
    const welcome = frameOf(
      JSON.stringify({
        kind: "memento.welcome",
        payload: {
          protocol_version: "1",
          tenant: "demo",
          filter: { event_type: "NOTE" },
          heartbeat_interval_ms: 30000,
          max_buffered_messages: 1000,
        },
      }),
      at,
      1,
      UTC,
    );
    expect(welcome.line).toBe(
      "[09:59:58] memento.welcome — tenant demo, event_type=NOTE, heartbeat 30 s",
    );
    expect(frameOf('{"kind":"memento.pong"}', at, 2, UTC).line).toBe(
      "[09:59:58] memento.pong — heartbeat answered",
    );
    expect(
      frameOf(
        JSON.stringify({ kind: "memento.error", payload: { code: "bad_request", message: "no" } }),
        at,
        3,
        UTC,
      ).line,
    ).toBe("[09:59:58] memento.error — bad_request: no");
    expect(frameOf('{"kind":"later.thing"}', at, 4, UTC)).toMatchObject({
      kind: "unknown",
      line: "[09:59:58] later.thing",
    });
    expect(frameOf("[1]", at, 5, UTC).line).toBe("[09:59:58] [1]");
    expect(frameOf("not json", at, 6, UTC)).toMatchObject({ kind: "unknown", json: null });
    expect(
      closeFrame({ code: 4008, reason: "slow consumer", reconnectInMs: 1500 }, at, 7, UTC).line,
    ).toBe("[09:59:58] closed — 4008 slow consumer, reconnecting in 2 s");
    expect(closeFrame({ code: 1006, reason: "", reconnectInMs: null }, at, 8, UTC).line).toBe(
      "[09:59:58] closed — 1006",
    );
  });
});

describe("the frame buffer", () => {
  const frame = (seq: number, raw = '{"kind":"memento.pong"}') => frameOf(raw, seq * 1000, seq);
  const feed = (state: TailState, from: number, to: number) => {
    let next = state;
    for (let n = from; n <= to; n++)
      next = tailReducer(next, { type: "frame", frame: frame(n), shown: true });
    return next;
  };

  it("keeps the newest 500, newest first", () => {
    const state = feed(INITIAL_TAIL, 1, MAX_FRAMES + 20);
    expect(state.frames).toHaveLength(MAX_FRAMES);
    expect(state.frames[0]?.seq).toBe(MAX_FRAMES + 20);
    expect(state.frames.at(-1)?.seq).toBe(21);
    expect(state.received).toBe(MAX_FRAMES + 20);
  });

  it("buffers while paused and puts the buffer on top on resume", () => {
    let state = feed(INITIAL_TAIL, 1, 2);
    state = tailReducer(state, { type: "pause" });
    expect(tailReducer(state, { type: "pause" })).toBe(state);
    state = feed(state, 3, 5);
    expect(state.frames.map((f) => f.seq)).toEqual([2, 1]);
    expect(state.pendingCount).toBe(3);
    state = tailReducer(state, { type: "resume" });
    expect(state.frames.map((f) => f.seq)).toEqual([5, 4, 3, 2, 1]);
    expect(state.pendingCount).toBe(0);
    state = tailReducer(state, { type: "clear" });
    expect(state.frames).toEqual([]);
    expect(state.received).toBe(5);
  });

  it("counts reconnects, the page's own filtering and the event rate", () => {
    const welcome = (seq: number) =>
      frameOf(
        JSON.stringify({
          kind: "memento.welcome",
          payload: {
            protocol_version: "1",
            tenant: "demo",
            filter: {},
            heartbeat_interval_ms: 1,
            max_buffered_messages: 1,
          },
        }),
        seq,
        seq,
      );
    let state = tailReducer(INITIAL_TAIL, { type: "frame", frame: welcome(1), shown: true });
    expect(reconnectsOf(state)).toBe(0);
    state = tailReducer(state, {
      type: "closed",
      info: { code: 1006, reason: "", reconnectInMs: 500 },
      frame: closeFrame({ code: 1006, reason: "", reconnectInMs: 500 }, 2, 2),
    });
    expect(state.connectedSince).toBeNull();
    state = tailReducer(state, { type: "frame", frame: welcome(3), shown: true });
    expect(reconnectsOf(state)).toBe(1);
    expect(state.lastClose).toBeNull();
    const event = { ...frame(4), kind: "memento.event.new" as const };
    state = tailReducer(state, { type: "frame", frame: event, shown: false });
    expect(state.filteredOut).toBe(1);
    expect(state.stamps).toEqual([4000]);
    expect(eventsPerSecond([1000, 11_000, 15_000, 20_000], 20_000)).toBe(0.3);
    expect(tailReducer({ ...state, paused: true }, { type: "reset" })).toEqual({
      ...INITIAL_TAIL,
      paused: true,
    });
  });

  it("listens in on the socket without changing what it delivers", () => {
    const seen: string[] = [];
    const sockets: unknown[] = [];
    const Tapped = tapWebSocket(
      FakeSocket,
      (raw) => seen.push(raw),
      (s) => sockets.push(s),
    );
    const socket = new Tapped("ws://x/ws", ["memento.v1"]);
    const inner = FakeSocket.last();
    const got: unknown[] = [];
    socket.onmessage = (m) => got.push(m.data);
    socket.onopen = () => {};
    socket.onclose = () => {};
    socket.onerror = () => {};
    expect([socket.onopen, socket.onclose, socket.onerror]).toEqual([
      inner.onopen,
      inner.onclose,
      inner.onerror,
    ]);
    expect(socket.onmessage).toBe(inner.onmessage);
    inner.raw("hello");
    expect(seen).toEqual(["hello"]);
    expect(got).toEqual(["hello"]);
    socket.send(PING_MESSAGE);
    expect(inner.sent).toEqual([PING_MESSAGE]);
    socket.onmessage = null;
    expect(inner.onmessage).toBeNull();
    socket.close();
    expect(inner.closed).toBe(true);
    expect(sockets).toEqual([inner]);
  });
});

describe("the Live tail page", () => {
  it("shows every frame as it arrives, newest on top, each opening to its JSON", async () => {
    render(<App />);
    await screen.findByTestId("tail-filters");
    const socket = FakeSocket.last();
    expect(socket.url).toBe("ws://localhost:3000/memento/ws?locale=en");
    expect(socket.protocols).toEqual(["memento.v1", "bearer.mk_k"]);
    expect(screen.getByTestId("tail-url").textContent).toBe(socket.url);
    expect(screen.getByTestId("tail-health").dataset.health).toBe("connecting");
    expect(await screen.findByTestId("tail-empty")).toBeTruthy();

    act(() => socket.welcome());
    await waitFor(() => expect(screen.getByTestId("tail-health").textContent).toBe("Live"));
    act(() => socket.push(uuid(1), ticket(1)));
    act(() => socket.push(uuid(2), ticket(2, { event_type: "NOTE", rendered: "ana noted." })));
    act(() => socket.raw({ kind: "memento.pong" }));

    const rows = screen.getAllByTestId("tail-frame");
    expect(rows.map((r) => r.dataset.kind)).toEqual([
      "memento.pong",
      "memento.event.new",
      "memento.event.new",
      "memento.welcome",
    ]);
    expect(rows[0]?.className).toContain("is-control");
    expect(lines()[1]).toMatch(/^\[\d\d:\d\d:\d\d\] NOTE ticket\/T-2 — ana noted\.$/);
    expect(lines()[3]).toContain("memento.welcome — tenant demo, every event, heartbeat 30 s");
    const json = within(rows[1] as HTMLElement).getByTestId("tail-json").textContent ?? "";
    expect(JSON.parse(json)).toMatchObject({
      kind: "memento.event.new",
      payload: { instance_id: "T-2" },
    });
    expect(json).toContain('\n  "kind": "memento.event.new"');
    expect(screen.getByTestId("tail-received").textContent).toBe("4");
    expect(screen.getByTestId("tail-rate").textContent).toBe("0.2");
    expect(screen.getByTestId("tail-since").textContent).not.toBe("—");
    expect(screen.getByTestId("tail-reconnects").textContent).toBe("0");

    // The control frames can be hidden.
    fireEvent.click(screen.getByTestId("tail-control"));
    expect(screen.getAllByTestId("tail-frame").map((r) => r.dataset.kind)).toEqual([
      "memento.event.new",
      "memento.event.new",
    ]);
  });

  it("keeps the newest 500 frames", async () => {
    render(<App />);
    await screen.findByTestId("tail-filters");
    const socket = FakeSocket.last();
    act(() => {
      socket.welcome();
      for (let n = 1; n <= MAX_FRAMES + 5; n++) socket.push(uuid(n), ticket(n));
    });
    const rows = screen.getAllByTestId("tail-frame");
    expect(rows).toHaveLength(MAX_FRAMES);
    expect(lines()[0]).toContain(`ticket/T-${MAX_FRAMES + 5} `);
    expect(lines().at(-1)).toContain("ticket/T-6 ");
    expect(screen.getByTestId("tail-received").textContent).toBe(String(MAX_FRAMES + 6));
  });

  it("buffers while paused, shows how many, and puts them on top on resume", async () => {
    render(<App />);
    await screen.findByTestId("tail-filters");
    const socket = FakeSocket.last();
    act(() => {
      socket.welcome();
      socket.push(uuid(1), ticket(1));
    });
    fireEvent.click(screen.getByTestId("tail-pause"));
    act(() => {
      socket.push(uuid(2), ticket(2));
      socket.push(uuid(3), ticket(3));
    });
    expect(screen.getAllByTestId("tail-frame")).toHaveLength(2);
    expect(screen.getByTestId("tail-paused").textContent).toBe("2 new while paused");
    expect(screen.getByTestId("tail-received").textContent).toBe("4");

    fireEvent.click(screen.getByTestId("tail-resume"));
    expect(screen.queryByTestId("tail-paused")).toBeNull();
    expect(
      lines()
        .slice(0, 3)
        .map((l) => l?.match(/T-\d+/)?.[0]),
    ).toEqual(["T-3", "T-2", "T-1"]);

    fireEvent.click(screen.getByTestId("tail-clear"));
    expect(screen.queryAllByTestId("tail-frame")).toHaveLength(0);
  });

  it("reconnects with the new query string when a filter changes, and keeps it in the URL", async () => {
    render(<App />);
    await screen.findByTestId("tail-filters");
    const first = FakeSocket.last();
    act(() => {
      first.welcome();
      first.push(uuid(1), ticket(1, { event_type: "NOTE" }));
    });

    fireEvent.click(screen.getByTestId("tail-type-TICKET_CREATED"));
    await waitFor(() => expect(first.closed).toBe(true));
    const second = FakeSocket.last();
    expect(second.query).toEqual({ event_type: "TICKET_CREATED", locale: "en" });
    expect(screen.getByTestId("tail-url").textContent).toBe(second.url);
    expect(location.search).toBe("?event_type=TICKET_CREATED");
    expect(screen.getByTestId("tail-type-TICKET_CREATED").getAttribute("aria-pressed")).toBe(
      "true",
    );
    // A fresh list for the new filter.
    expect(screen.queryAllByTestId("tail-frame")).toHaveLength(0);
    expect(screen.getByTestId("tail-received").textContent).toBe("0");

    fireEvent.change(screen.getByTestId("tail-instance-type"), { target: { value: "ticket" } });
    fireEvent.change(screen.getByTestId("tail-instance-id"), { target: { value: "T-3" } });
    fireEvent.change(screen.getByTestId("tail-actor-id"), { target: { value: "ana" } });
    fireEvent.click(screen.getByTestId("tail-apply"));
    await waitFor(() => expect(second.closed).toBe(true));
    expect(FakeSocket.last().query).toEqual({
      event_type: "TICKET_CREATED",
      instance_type: "ticket",
      instance_id: "T-3",
      actor_id: "ana",
      locale: "en",
    });
    expect(location.search).toBe(
      "?event_type=TICKET_CREATED&instance_type=ticket&instance_id=T-3&actor_id=ana",
    );

    // Two types: the stream gets none, the page keeps only those two.
    fireEvent.click(screen.getByTestId("tail-type-NOTE"));
    await waitFor(() => expect(FakeSocket.last().query.event_type).toBeUndefined());
    const third = FakeSocket.last();
    expect(screen.getByTestId("tail-client-side").textContent).toContain("With 2 picked");
    act(() => {
      third.welcome();
      third.push(uuid(5), ticket(5, { event_type: "NOTE" }));
      third.push(uuid(6), ticket(6, { event_type: "USER_LOGIN" }));
    });
    expect(screen.getAllByTestId("tail-frame").map((r) => r.dataset.kind)).toEqual([
      "memento.event.new",
      "memento.welcome",
    ]);
    expect(screen.getByTestId("tail-filtered").textContent).toBe("1");

    fireEvent.click(screen.getByTestId("tail-reset"));
    await waitFor(() => expect(location.search).toBe(""));
    expect(FakeSocket.last().query).toEqual({ locale: "en" });
  });

  it("opens with the filters of its URL and the header's language", async () => {
    history.replaceState(null, "", "/examples/tail?event_type=TICKET_CREATED&instance_id=T-3");
    render(<App />);
    await screen.findByTestId("tail-filters");
    expect(FakeSocket.last().query).toEqual({
      event_type: "TICKET_CREATED",
      instance_id: "T-3",
      locale: "en",
    });
    expect((screen.getByTestId("tail-instance-id") as HTMLInputElement).value).toBe("T-3");

    fireEvent.click(screen.getByTestId("locale-sr"));
    await waitFor(() => expect(FakeSocket.last().query.locale).toBe("sr"));
    expect(screen.getByTestId("tail-url").textContent).toContain("locale=sr");
    expect(screen.getByText(/locale=sr prati EN \/ SR/)).toBeTruthy();
  });

  it("does not connect with a filter the stream would refuse", async () => {
    history.replaceState(null, "", "/examples/tail?instance_type=Ticket");
    render(<App />);
    expect((await screen.findByTestId("tail-invalid")).textContent).toContain("422");
    expect(FakeSocket.all).toHaveLength(0);
    expect(screen.getByTestId("tail-health").textContent).toBe("Not connected");
  });

  it("shows the close code and reason, then counts the reconnect", async () => {
    render(<App />);
    await screen.findByTestId("tail-filters");
    const socket = FakeSocket.last();
    act(() => socket.welcome());
    act(() => socket.drop(4008, "slow consumer"));
    const health = screen.getByTestId("tail-health");
    expect(health.dataset.health).toBe("offline");
    expect(health.textContent).toBe("Closed 4008 slow consumer");
    expect(lines()[0]).toMatch(/closed — 4008 slow consumer, reconnecting in 1 s$/);
    expect(screen.getAllByTestId("tail-frame")[0]?.dataset.kind).toBe("close");
    expect(screen.getByTestId("tail-since").textContent).toBe("—");

    await waitFor(() => expect(FakeSocket.all.filter((s) => !s.closed)).toHaveLength(2), {
      timeout: 2000,
    });
    act(() => FakeSocket.last().welcome());
    await waitFor(() => expect(health.textContent).toBe("Live"));
    expect(screen.getByTestId("tail-reconnects").textContent).toBe("1");
  });

  it("pings at the heartbeat interval so heartbeats show up", async () => {
    render(<App />);
    await screen.findByTestId("tail-filters");
    const socket = FakeSocket.last();
    act(() => socket.welcome(20));
    await waitFor(() => expect(socket.sent).toContain(PING_MESSAGE));
  });
});
