import type { AddressInfo } from "node:net";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import {
  dayStart,
  MementoDataView,
  MementoProvider,
  MementoSearch,
  searchQuery,
  type WebSocketConstructor,
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

describe("MementoSearch", () => {
  it("waits for a search, then queries the instance and date range", async () => {
    const hit = makeEvent({ instance_type: "ticket", instance_id: "T-7" });
    const fetch = fakeFetch(() => [hit]);
    render(<MementoSearch instanceTypes={["ticket", "user"]} />, { wrapper: wrapper(fetch) });
    expect(screen.getByText("Pick an instance and a date range, then search.")).toBeTruthy();
    expect(fetch).not.toHaveBeenCalled();
    expect(FakeSocket.all).toHaveLength(0);

    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: " T-7 " } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-01" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-31" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));

    await waitFor(() => expect(rows()).toEqual([hit.id]));
    // The search is a Filter DSL tree in the body of POST /events/query.
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("http://memento.test/memento/events/query");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({
      filter: {
        and: [
          { field: "instance_type", op: "eq", value: "ticket" },
          { field: "instance_id", op: "eq", value: "T-7" },
          { field: "occurred_at", op: "gte", value: dayStart("2026-10-01") },
          { field: "occurred_at", op: "lt", value: dayStart("2026-11-01") },
        ],
      },
      limit: 100,
    });
    // A closed range is history: nothing to stream.
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("streams results while the range is open-ended, and only matching ones", async () => {
    const fetch = fakeFetch(() => []);
    render(<MementoSearch />, { wrapper: wrapper(fetch) });
    fireEvent.change(screen.getByLabelText("Instance type"), { target: { value: "user" } });
    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: "igor-*" } });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-30" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await screen.findByText("Nothing found for this search.");

    const socket = FakeSocket.last();
    expect(socket.query).toEqual({ instance_type: "user" });
    act(() => socket.welcome());
    expect(screen.getByRole("status").textContent).toBe("Live");
    const match = makeEvent({ instance_type: "user", instance_id: "igor-1" });
    const other = makeEvent({ instance_type: "user", instance_id: "marko-1" });
    const tooEarly = makeEvent({
      instance_type: "user",
      instance_id: "igor-2",
      occurred_at: "2026-10-01T00:00:00.000Z",
    });
    act(() => {
      socket.push(match);
      socket.push(other);
      socket.push(tooEarly);
    });
    expect(rows()).toEqual([match.id]);
  });

  it("rejects a range that ends before it starts, and any type", async () => {
    const fetch = fakeFetch(() => []);
    render(<MementoSearch />, { wrapper: wrapper(fetch) });
    fireEvent.change(screen.getByLabelText("From"), { target: { value: "2026-10-31" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "2026-10-01" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(screen.getByRole("alert").textContent).toBe("The start date is after the end date.");
    expect(fetch).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText("Instance type"), { target: { value: "" } });
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(screen.queryByRole("alert")).toBeNull();
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      filter: { field: "occurred_at", op: "gte", value: dayStart("2026-10-31") },
      limit: 100,
    });
  });

  it("sends a prefix as `prefix`, no filter for an empty search, and the provider's locale", async () => {
    const fetch = fakeFetch(() => []);
    render(<MementoSearch />, { wrapper: wrapper(fetch, { locale: "sr" }) });
    fireEvent.change(screen.getByLabelText("Instance type"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({
      filter: null,
      limit: 100,
      locale: "sr",
    });

    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: "T-1*" } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body)).filter).toEqual({
      field: "instance_id",
      op: "prefix",
      value: "T-1",
    });
  });

  it("can be controlled: shows the given search, reports submits, follows changes", async () => {
    const fetch = fakeFetch(() => [makeEvent({ instance_type: "ticket", instance_id: "T-3" })]);
    const onSearch = vi.fn();
    const search = { instanceType: "ticket", instanceId: "T-3", from: "", to: "2026-10-31" };
    const { rerender } = render(
      <MementoSearch search={search} onSearch={onSearch} instanceTypes={["ticket", "user"]} />,
      { wrapper: wrapper(fetch) },
    );
    // A search given from outside runs at once, and the form shows it.
    await waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    expect((screen.getByLabelText("Instance ID") as HTMLInputElement).value).toBe("T-3");
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("2026-10-31");

    // Submitting reports the values; it is the caller who changes the search.
    fireEvent.change(screen.getByLabelText("Instance ID"), { target: { value: " T-4 " } });
    fireEvent.click(screen.getByRole("button", { name: "Search" }));
    expect(onSearch).toHaveBeenCalledWith({ ...search, instanceId: "T-4" });
    expect(fetch).toHaveBeenCalledOnce();

    // The caller's search changes (browser back): the form follows.
    rerender(
      <MementoSearch
        search={{ ...search, instanceType: "user", instanceId: "ana" }}
        onSearch={onSearch}
        instanceTypes={["ticket", "user"]}
      />,
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect((screen.getByLabelText("Instance ID") as HTMLInputElement).value).toBe("ana");
    expect((screen.getByLabelText("Instance type") as HTMLSelectElement).value).toBe("user");

    // No search: the hint, the form back to its defaults.
    rerender(
      <MementoSearch search={null} onSearch={onSearch} instanceTypes={["ticket", "user"]} />,
    );
    await screen.findByText("Pick an instance and a date range, then search.");
    expect((screen.getByLabelText("Instance ID") as HTMLInputElement).value).toBe("");
  });

  it("renders the instance cell with `renderInstance`", async () => {
    const hit = makeEvent({ instance_type: "ticket", instance_id: "T-9" });
    render(
      <MementoSearch
        search={{ instanceType: "ticket", instanceId: "T-9", from: "", to: "2026-10-31" }}
        renderInstance={(event) => <a href={`/t/${event.instance_id}`}>{event.instance_id}</a>}
      />,
      { wrapper: wrapper(fakeFetch(() => [hit])) },
    );
    const link = await screen.findByRole("link", { name: "T-9" });
    expect(link.getAttribute("href")).toBe("/t/T-9");
  });

  it("maps form values to the events query", () => {
    expect(searchQuery({ instanceType: "", instanceId: "  ", from: "", to: "" })).toEqual({
      instance_type: undefined,
      instance_id: undefined,
      after: undefined,
      before: undefined,
    });
    expect(
      searchQuery({
        instanceType: "ticket",
        instanceId: "T-1*",
        from: "2026-10-01",
        to: "2026-10-31",
      }),
    ).toEqual({
      instance_type: "ticket",
      instance_id: "T-1*",
      after: dayStart("2026-10-01"),
      before: dayStart("2026-11-01"),
    });
  });

  it("parses calendar days", () => {
    expect(dayStart("")).toBeUndefined();
    expect(dayStart("31.10.2026")).toBeUndefined();
    expect(dayStart("2026-10-31")).toBe(new Date(2026, 9, 31).toISOString());
    expect(dayStart("2026-12-31", 1)).toBe(new Date(2027, 0, 1).toISOString());
  });
});

describe("against a mock WebSocket server", () => {
  it("streams a real-time update into the table through a real socket", async () => {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port: 0,
      handleProtocols: (protocols) => (protocols.has("memento.v1") ? "memento.v1" : false),
    });
    await new Promise<void>((resolve) => server.once("listening", resolve));
    const port = (server.address() as AddressInfo).port;
    const live = makeEvent({ rendered: "pushed by the server" });
    const urls: (string | undefined)[] = [];
    server.on("connection", (socket, request) => {
      urls.push(request.url);
      socket.send(
        JSON.stringify({
          kind: "memento.welcome",
          payload: {
            protocol_version: "1",
            tenant: "acme",
            filter: { event_type: "USER_LOGIN" },
            heartbeat_interval_ms: 30000,
            max_buffered_messages: 1000,
          },
        }),
      );
      socket.send(JSON.stringify({ kind: "memento.event.new", id: live.id, payload: live }));
    });
    try {
      render(
        <MementoProvider
          baseUrl={`http://127.0.0.1:${port}/memento`}
          apiKey="mk_test_key"
          fetch={fakeFetch(() => [])}
          // jsdom's globals and Node's own WebSocket disagree on `Event`; use the `ws` client.
          WebSocket={WsClient as unknown as WebSocketConstructor}
        >
          <MementoDataView initialFilter={{ event_type: "USER_LOGIN" }} />
        </MementoProvider>,
      );
      await screen.findByText("pushed by the server");
      expect(screen.getByRole("status").textContent).toBe("Live");
      expect(urls).toEqual(["/memento/ws?event_type=USER_LOGIN"]);
    } finally {
      for (const client of server.clients) client.terminate();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
