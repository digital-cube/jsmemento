import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, LOCALE_HEADER } from "../src/App.js";
import { SIMULATOR_COMMAND } from "../src/examples/activity/Activity.js";
import { FEED_FILTER, feedItems, feedTime } from "../src/examples/activity/feed.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";
import { type FeedEvent, udcServer } from "./udc-server.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };

/** The n-th event of a ticket desk, a second apart. */
function event(n: number, overrides: Partial<FeedEvent> = {}): FeedEvent {
  const ticket = `T-${n}`;
  return {
    id: uuid(n),
    event_type: "TICKET_CREATED",
    instance_type: "ticket",
    instance_id: ticket,
    actor_id: "ana",
    occurred_at: new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString(),
    rendered: {
      en: `ana created ticket ${ticket}: "Bug ${n}".`,
      sr: `Korisnik ana je kreirao tiket ${ticket}: "Bug ${n}".`,
    },
    ...overrides,
  };
}

const cpu = (n: number) =>
  event(n, {
    event_type: "CPU_LOAD",
    instance_type: "server",
    instance_id: "stage",
    actor_id: "monitor",
    rendered: { en: "Server stage — CPU: 1, 1, 1", sr: "Server stage — opterećenje CPU: 1, 1, 1" },
  });

const texts = () => screen.getAllByTestId("feed-text").map((el) => el.textContent);

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  history.replaceState(null, "", "/examples/activity");
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("the activity feed", () => {
  it("shows the rendered events newest first, CPU samples left out", async () => {
    const feed = [
      event(1),
      cpu(2),
      event(3, {
        event_type: "USER_LOGIN",
        instance_type: "user",
        instance_id: "marko",
        actor_id: "marko",
        rendered: { en: "User marko logged in.", sr: "Korisnik marko se prijavio." },
      }),
    ];
    const server = udcServer({ feed });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await screen.findByText("User marko logged in.");
    expect(texts()).toEqual(["User marko logged in.", 'ana created ticket T-1: "Bug 1".']);
    expect(server.lists[0]).toMatchObject({
      collection: "events",
      filter: FEED_FILTER,
      sort: [{ field: "occurred_at", dir: "desc" }],
    });
    expect(server.locales[0]).toBe("en");

    const [first] = screen.getAllByTestId("feed-row");
    const row = within(first as HTMLElement);
    expect(row.getByText("user/marko")).toBeTruthy();
    expect(row.getByText("USER_LOGIN")).toBeTruthy();
    expect(row.getByText("MA")).toBeTruthy(); // initials avatar
    expect(row.getByText("marko", { selector: ".feed__actor" })).toBeTruthy();
    expect(screen.getByText("Activity feed", { selector: "h1" })).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy(); // total, CPU samples not counted
  });

  it("follows the header's language: SR re-renders the sentences in Serbian", async () => {
    const server = udcServer({ feed: [event(1), event(2)] });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await screen.findByText('ana created ticket T-2: "Bug 2".');

    fireEvent.click(screen.getByTestId("locale-sr"));
    await screen.findByText('Korisnik ana je kreirao tiket T-2: "Bug 2".');
    expect(texts()).toEqual([
      'Korisnik ana je kreirao tiket T-2: "Bug 2".',
      'Korisnik ana je kreirao tiket T-1: "Bug 1".',
    ]);
    expect(server.locales.at(-1)).toBe("sr");
    expect(screen.getByText("Tok aktivnosti", { selector: "h1" })).toBeTruthy();
    // Remembered for the next visit, and the UDC client keeps sending it.
    expect(localStorage.getItem("udc-locale")).toBe("sr");

    fireEvent.click(screen.getByTestId("locale-en"));
    await screen.findByText('ana created ticket T-2: "Bug 2".');
    expect(server.locales.at(-1)).toBe("en");
  });

  it("opens in the remembered language", async () => {
    localStorage.setItem("udc-locale", "sr");
    const server = udcServer({ feed: [event(1)] });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await screen.findByText('Korisnik ana je kreirao tiket T-1: "Bug 1".');
    expect(server.locales[0]).toBe("sr");
    expect(LOCALE_HEADER).toBe("x-memento-locale");
  });

  it("shows a new event without a reload; a CPU sample does not refetch", async () => {
    const feed = [event(1)];
    const server = udcServer({ feed });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await screen.findByText('ana created ticket T-1: "Bug 1".');
    const socket = FakeSocket.last();
    expect(socket.query).toEqual({});
    act(() => socket.welcome());
    await screen.findByText("Live");
    const before = server.lists.length;

    act(() => socket.push(uuid(50))); // CPU_LOAD
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(server.lists.length).toBe(before);

    feed.push(event(2));
    act(() => socket.push(uuid(2), { event_type: "TICKET_CREATED" }));
    await screen.findByText('ana created ticket T-2: "Bug 2".', {}, { timeout: 3000 });
    expect(texts()[0]).toBe('ana created ticket T-2: "Bug 2".');
    expect(screen.getAllByTestId("feed-row")[0]?.className).toContain("is-new");
  });

  it("pages further back on demand", async () => {
    const feed = Array.from({ length: 45 }, (_, i) => event(i + 1));
    const server = udcServer({ feed });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await screen.findByText('ana created ticket T-45: "Bug 45".');
    expect(screen.getAllByTestId("feed-row")).toHaveLength(30);
    fireEvent.click(screen.getByRole("button", { name: "Older events" }));
    await screen.findByText('ana created ticket T-1: "Bug 1".');
    expect(screen.getAllByTestId("feed-row")).toHaveLength(45);
    expect(server.lists.at(-1)).toMatchObject({ page: { limit: 30, offset: 30 } });
    expect(screen.queryByRole("button", { name: "Older events" })).toBeNull();
  });

  it("says what pushes these events when there are none", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: [cpu(1)] }).fetch);
    render(<App />);
    const empty = await screen.findByTestId("feed-empty");
    expect(empty.textContent).toContain("memento simulate");
    expect(within(empty).getByText(SIMULATOR_COMMAND)).toBeTruthy();
    fireEvent.click(screen.getByTestId("locale-sr"));
    await waitFor(() =>
      expect(screen.getByTestId("feed-empty").textContent).toContain("Još nema aktivnosti"),
    );
  });

  it("asks for a key first, like every page", async () => {
    localStorage.clear();
    vi.stubGlobal("fetch", udcServer({ feed: [] }).fetch);
    render(<App />);
    expect(await screen.findByText(/Paste an API key/)).toBeTruthy();
    expect(FakeSocket.all).toHaveLength(0);
  });
});

describe("feed helpers", () => {
  const row = (id: string, fields: Record<string, unknown> = {}) => ({
    __meta: { id, version: 1 },
    event_type: "NOTE",
    instance_type: "ticket",
    instance_id: "T-1",
    actor_id: "ana",
    occurred_at: "2026-10-31T10:00:00Z",
    rendered: "Fix is in review.",
    ...fields,
  });

  it("keeps each event once and never a CPU sample", () => {
    const items = feedItems([row("a"), row("a"), row("b", { event_type: "CPU_LOAD" }), row("c")]);
    expect(items.map((i) => i.id)).toEqual(["a", "c"]);
    expect(items[0]).toEqual({
      id: "a",
      at: "2026-10-31T10:00:00Z",
      eventType: "NOTE",
      instance: "ticket/T-1",
      actor: "ana",
      text: "Fix is in review.",
    });
    expect(feedItems([row("x", { instance_type: null, actor_id: "", rendered: null })])[0]).toEqual(
      expect.objectContaining({ instance: "T-1", actor: null, text: "" }),
    );
  });

  it("formats the time in the page's language: the time today, the date before", () => {
    const now = new Date("2026-10-31T12:00:00");
    expect(feedTime("2026-10-31T10:05:09", "en-US", now)).toBe("10:05:09");
    expect(feedTime("2026-10-30T10:05:09", "en-US", now)).toMatch(/Oct 30.*10:05/);
    expect(feedTime("2026-10-30T10:05:09", "sr-Latn-RS", now)).toMatch(/30.*10:05/);
    expect(feedTime("not a date", "en-US", now)).toBe("");
  });
});
