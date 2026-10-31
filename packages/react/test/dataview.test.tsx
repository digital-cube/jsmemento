import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  EventTable,
  eventTypeFamilies,
  MementoDataView,
  MementoProvider,
  mergeEvents,
  StatusIndicator,
  sortEvents,
  useMemento,
} from "../src/index.js";
import { FakeSocket, fakeFetch, makeEvent, wrapper } from "./fixtures.js";

afterEach(() => {
  FakeSocket.all = [];
});

const rows = () =>
  screen
    .getAllByRole("row")
    .slice(1)
    .map((row) => row.getAttribute("data-event-id"));

describe("MementoDataView", () => {
  it("mounts, loads the newest page and goes live", async () => {
    const older = makeEvent({ rendered: "igor logged in" });
    const newer = makeEvent({
      event_type: "TICKET_CREATED",
      instance_type: "ticket",
      actor_id: null,
    });
    const fetch = fakeFetch(() => [newer, older]);
    render(<MementoDataView title="Activity" timeZone="UTC" locale="en-GB" />, {
      wrapper: wrapper(fetch),
    });

    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(screen.getByText("Loading events…")).toBeTruthy();
    await waitFor(() => expect(rows()).toEqual([newer.id, older.id]));
    expect(String(fetch.mock.calls[0]?.[0])).toBe("http://memento.test/memento/events?limit=50");
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({
      headers: { authorization: "Bearer mk_test_key" },
    });

    const row = screen.getByText("igor logged in").closest("tr") as HTMLElement;
    expect(within(row).getByText("USER_LOGIN")).toBeTruthy();
    expect(within(row).getByText("10:00:01")).toBeTruthy();
    expect(within(row).getByText("42")).toBeTruthy();
    expect(screen.getByText("none")).toBeTruthy();

    const socket = FakeSocket.last();
    expect(socket.url).toBe("ws://memento.test/memento/ws");
    expect(socket.protocols).toEqual(["memento.v1", "bearer.mk_test_key"]);
    expect(screen.getByRole("status").textContent).toBe("Connecting");
    act(() => socket.welcome());
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("live");
    expect(screen.getByRole("status").textContent).toBe("Live");
  });

  it("adds streamed events at the top without a reload, highlighted", async () => {
    const first = makeEvent();
    const fetch = fakeFetch(() => [first]);
    render(<MementoDataView />, { wrapper: wrapper(fetch) });
    await waitFor(() => expect(rows()).toEqual([first.id]));
    const socket = FakeSocket.last();
    act(() => socket.welcome());

    const live = makeEvent({ rendered: "marko logged in", actor_id: "marko" });
    act(() => socket.push(live));
    expect(rows()).toEqual([live.id, first.id]);
    expect(screen.getByText("marko logged in").closest("tr")?.className).toBe("memento-row--new");
    // The same event again (e.g. after a reconnect) is not duplicated.
    act(() => socket.push(live));
    expect(rows()).toHaveLength(2);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("re-subscribes with the new filter when a filter changes", async () => {
    const fetch = fakeFetch(() => []);
    render(<MementoDataView />, { wrapper: wrapper(fetch) });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    const firstSocket = FakeSocket.last();

    fireEvent.change(screen.getByLabelText("Instance type"), { target: { value: "chat" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(firstSocket.closed).toBe(true);
    expect(FakeSocket.last().query).toEqual({ instance_type: "chat" });
    expect(String(fetch.mock.calls[1]?.[0])).toContain("instance_type=chat");

    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "CHAT_MESSAGE_SENT" } });
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    expect(FakeSocket.open()).toHaveLength(1);
    expect(FakeSocket.last().query).toEqual({
      event_type: "CHAT_MESSAGE_SENT",
      instance_type: "chat",
    });
  });

  it("applies a family filter (CHAT_*) on the client: the stream gets no event_type", async () => {
    const fetch = fakeFetch(() => []);
    render(<MementoDataView />, { wrapper: wrapper(fetch) });
    fireEvent.change(screen.getByLabelText("Event"), { target: { value: "CHAT_*" } });
    await waitFor(() => expect(String(fetch.mock.lastCall?.[0])).toContain("event_type=CHAT_*"));
    const socket = FakeSocket.last();
    expect(socket.query).toEqual({});
    act(() => socket.welcome());

    const login = makeEvent({ event_type: "USER_LOGIN" });
    const message = makeEvent({ event_type: "CHAT_MESSAGE_SENT", instance_type: "chat" });
    act(() => {
      socket.push(login);
      socket.push(message);
    });
    expect(rows()).toEqual([message.id]);
  });

  it("sorts by any column and starts newest first", async () => {
    const a = makeEvent({ event_type: "USER_LOGIN", actor_id: "zoran", instance_id: "1" });
    const b = makeEvent({ event_type: "NOTE", actor_id: "ana", instance_id: "3" });
    const c = makeEvent({ event_type: "TICKET_CLOSED", actor_id: "marko", instance_id: "2" });
    render(<MementoDataView />, { wrapper: wrapper(fakeFetch(() => [a, b, c])) });
    await waitFor(() => expect(rows()).toEqual([c.id, b.id, a.id]));
    const header = (name: string) => screen.getByRole("button", { name: new RegExp(name) });
    const when = screen.getByRole("columnheader", { name: /When/ });
    expect(when.getAttribute("aria-sort")).toBe("descending");

    fireEvent.click(header("When"));
    expect(rows()).toEqual([a.id, b.id, c.id]);
    expect(when.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(header("Event"));
    expect(rows()).toEqual([b.id, c.id, a.id]);
    expect(when.getAttribute("aria-sort")).toBe("none");
    fireEvent.click(header("Event"));
    expect(rows()).toEqual([a.id, c.id, b.id]);

    fireEvent.click(header("Actor"));
    expect(rows()).toEqual([b.id, c.id, a.id]);
    fireEvent.click(header("Instance"));
    expect(rows()).toEqual([a.id, c.id, b.id]);
  });

  it("shows a load error with a retry, and the offline status after a drop", async () => {
    let fail = true;
    const fetch = fakeFetch(() => {
      if (fail) throw new Error("key lacks read");
      return [];
    });
    render(
      <MementoDataView initialFilter={{ event_type: "CUSTOM_THING", instance_type: "invoice" }} />,
      {
        wrapper: wrapper(fetch),
      },
    );
    expect((screen.getByLabelText("Event") as HTMLSelectElement).value).toBe("CUSTOM_THING");
    expect((screen.getByLabelText("Instance type") as HTMLSelectElement).value).toBe("invoice");
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Could not load events: key lacks read");
    fail = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
    expect(screen.getByText("No events match these filters yet.")).toBeTruthy();

    act(() => FakeSocket.last().drop());
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("offline");
    // The provider's reconnect policy (10 ms) opens a new socket.
    await waitFor(() => expect(FakeSocket.open()).toHaveLength(1));
    act(() => FakeSocket.last().welcome());
    expect(screen.getByRole("status").getAttribute("data-status")).toBe("live");
  });

  it("does not stream when live is off", async () => {
    const fetch = fakeFetch(() => []);
    render(<MementoDataView live={false} />, { wrapper: wrapper(fetch) });
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(FakeSocket.all).toHaveLength(0);
    expect(screen.getByRole("status").textContent).toBe("Not live");
  });
});

function Probe() {
  useMemento();
  return null;
}

describe("building blocks", () => {
  it("useMemento needs a provider", () => {
    expect(() => render(<Probe />)).toThrow(/inside <MementoProvider>/);
  });

  it("passes the provider locale to the stream", () => {
    render(
      <MementoProvider
        baseUrl="https://m.test/memento"
        apiKey="k"
        locale="sr"
        WebSocket={FakeSocket}
        fetch={fakeFetch(() => [])}
      >
        <MementoDataView />
      </MementoProvider>,
    );
    expect(FakeSocket.last().url).toBe("wss://m.test/memento/ws?locale=sr");
  });

  it("derives event type families", () => {
    expect(eventTypeFamilies(["USER_LOGIN", "USER_LOGOUT", "NOTE", "TICKET_CREATED"])).toEqual([
      "USER_*",
    ]);
  });

  it("merges by id, newest first, capped", () => {
    const a = makeEvent();
    const b = makeEvent();
    const c = makeEvent({ occurred_at: b.occurred_at });
    expect(mergeEvents([a], [b, a], 10).map((e) => e.id)).toEqual([b.id, a.id]);
    expect(mergeEvents([a, b], [c], 2).map((e) => e.id)).toEqual([c.id, b.id]);
  });

  it("sorts ties newest first and renders a custom empty state", () => {
    const a = makeEvent({ actor_id: "x" });
    const b = makeEvent({ actor_id: "x" });
    expect(sortEvents([a, b], { field: "actor_id", dir: "asc" }).map((e) => e.id)).toEqual([
      b.id,
      a.id,
    ]);
    render(<EventTable events={[]} empty="Nothing here" caption="Recent" />);
    expect(screen.getByText("Nothing here")).toBeTruthy();
    expect(screen.getByText("Recent")).toBeTruthy();
  });

  it("labels every status", () => {
    const { rerender } = render(<StatusIndicator status="closed" />);
    expect(screen.getByRole("status").textContent).toBe("Disconnected");
    rerender(<StatusIndicator status="offline" label="Down" />);
    expect(screen.getByRole("status").textContent).toBe("Down");
  });
});
