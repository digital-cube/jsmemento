import type { AddressInfo } from "node:net";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, WebSocket as WsClient } from "ws";
import {
  dayStart,
  MementoDataView,
  MementoProvider,
  MementoSearch,
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
    const url = new URL(String(fetch.mock.calls[0]?.[0]));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      instance_type: "ticket",
      instance_id: "T-7",
      after: dayStart("2026-10-01"),
      before: dayStart("2026-11-01"),
      limit: "100",
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
    expect(Object.fromEntries(new URL(String(fetch.mock.calls[0]?.[0])).searchParams)).toEqual({
      after: dayStart("2026-10-31"),
      limit: "100",
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
