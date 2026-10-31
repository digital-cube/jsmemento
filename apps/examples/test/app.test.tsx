import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App, routerBasename } from "../src/App.js";
import { StatusBar } from "../src/examples/cpu-monitor/CpuMonitor.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";
import { udcServer } from "./udc-server.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };
const saved = () => JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  history.replaceState(null, "", "/examples/cpu-monitor");
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("the CPU monitor", () => {
  it("asks for a key first when the server has no demo key", async () => {
    const server = udcServer();
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    expect(await screen.findByText(/Paste an API key/)).toBeTruthy();
    expect(server.calls).toContain("/memento/api/demo");
    expect(new URLSearchParams(location.search).get("f")).toBeTruthy();
    expect(screen.getByTestId("key-badge").textContent).toBe("no key");
    expect(FakeSocket.all).toHaveLength(0);
  });

  it("draws the UDC table and refetches it when the stream reports an event", async () => {
    const server = udcServer();
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    fireEvent.change(await screen.findByPlaceholderText("mk_ab12cd34_…"), {
      target: { value: " mk_k " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(saved().apiKey).toBe("mk_k");

    await screen.findByText("backend-1");
    expect(server.lists[0]).toMatchObject({
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
    expect(server.lists).toHaveLength(2); // two events, one throttled refetch
  });

  it("switches collection and instance_type from its own bar", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    const server = udcServer();
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await screen.findByText("backend-1");
    fireEvent.change(screen.getByDisplayValue("cpu_load"), { target: { value: "events" } });
    fireEvent.change(screen.getByDisplayValue("server"), { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Apply" }));
    await waitFor(() => expect(server.lists.at(-1)).toMatchObject({ collection: "events" }));
    expect(server.lists.at(-1)?.filter).toBeFalsy();
    expect(saved()).toMatchObject({ collection: "events", instanceType: "", apiKey: "mk_k" });
    expect(new URLSearchParams(location.search).has("f")).toBe(false);
    expect(FakeSocket.last().query).toEqual({});
  });

  it("restores saved settings", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    const server = udcServer();
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await waitFor(() => expect(FakeSocket.all.length).toBeGreaterThan(0));
    // A key of the visitor's own: the demo key is not asked for.
    expect(server.calls).not.toContain("/memento/api/demo");
    expect(screen.getByTestId("key-badge").textContent).toBe("your key");
  });
});

describe("the demo key", () => {
  const demo = { api_key: "mk_demo", tenant: "demo" };

  it("connects at once with the server's demo key, no form", async () => {
    vi.stubGlobal("fetch", udcServer({ key: "mk_demo", demo }).fetch);
    render(<App />);
    await screen.findByText("backend-1");
    expect(screen.queryByText(/Paste an API key/)).toBeNull();
    expect(screen.queryByTestId("connection-form")).toBeNull();
    expect(FakeSocket.last().protocols).toEqual(["memento.v1", "bearer.mk_demo"]);
    expect(screen.getByTestId("key-badge").textContent).toBe("demo keytenant demo");
    // Never stored: a fresh demo key is asked for on every load.
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it("is shown badged in the settings, replaced by the visitor's own, and comes back", async () => {
    const server = udcServer({ key: "mk_demo", demo });
    vi.stubGlobal("fetch", server.fetch);
    render(<App />);
    await screen.findByText("backend-1");

    fireEvent.click(screen.getByTestId("settings-toggle"));
    const dialog = screen.getByRole("dialog", { name: "Settings" });
    const input = within(dialog).getByPlaceholderText("mk_ab12cd34_…") as HTMLInputElement;
    expect(input.value).toBe("mk_demo");
    expect(within(dialog).getByTestId("key-badge").textContent).toContain("demo key");
    // Connecting with the demo key unchanged keeps following it.
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect" }));
    expect(saved().apiKey).toBe("");
    expect(screen.queryByRole("dialog")).toBeNull();

    fireEvent.click(screen.getByTestId("settings-toggle"));
    fireEvent.change(screen.getByPlaceholderText("mk_ab12cd34_…"), {
      target: { value: "mk_mine" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(saved().apiKey).toBe("mk_mine");
    await waitFor(() =>
      expect(FakeSocket.last().protocols).toEqual(["memento.v1", "bearer.mk_mine"]),
    );
    expect(screen.getByTestId("key-badge").textContent).toBe("your key");

    fireEvent.click(screen.getByTestId("settings-toggle"));
    fireEvent.click(screen.getByRole("button", { name: "Use the demo key" }));
    expect(saved().apiKey).toBe("");
    await waitFor(() =>
      expect(FakeSocket.last().protocols).toEqual(["memento.v1", "bearer.mk_demo"]),
    );
  });

  it("closes the settings on Escape and on a click outside", () => {
    vi.stubGlobal("fetch", udcServer().fetch);
    render(<App />);
    fireEvent.click(screen.getByTestId("settings-toggle"));
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByTestId("settings-toggle"));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the site", () => {
  it("draws the sidebar from the menu collection, the active example highlighted", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    vi.stubGlobal("fetch", udcServer().fetch);
    render(<App />);
    const tree = await screen.findByTestId("menu-tree");
    await waitFor(() => expect(tree.dataset.source).toBe("menu"));
    const cpu = within(tree).getByTestId("menu-CPU_MONITOR");
    expect(cpu.getAttribute("aria-current")).toBe("page");
    expect(cpu.textContent).toBe("CPU monitor");
    fireEvent.click(within(tree).getByTestId("menu-COLLECTIONS"));
    expect(within(tree).getByTestId("nav-events").getAttribute("href")).toBe("/udc/events");
    expect(within(tree).getByTestId("nav-menu").textContent).toBe("menu");
  });

  it("draws the built-in entries without a key or without the menu collection", async () => {
    vi.stubGlobal("fetch", udcServer({ menu: false }).fetch);
    const view = render(<App />);
    const tree = await screen.findByTestId("menu-tree");
    expect(tree.dataset.source).toBe("builtin");
    expect(within(tree).getByTestId("menu-HOME").textContent).toBe("Home");
    expect(within(tree).getByTestId("menu-CPU_MONITOR")).toBeTruthy();
    view.unmount();

    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    render(<App />);
    await screen.findByText("backend-1");
    expect(screen.getByTestId("menu-tree").dataset.source).toBe("builtin");
    expect(screen.queryByTestId("menu-COLLECTIONS")).toBeNull();
  });

  it("leads / and unknown paths to the CPU monitor, /udc/:collection to a data view", async () => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    vi.stubGlobal("fetch", udcServer().fetch);
    history.replaceState(null, "", "/");
    const first = render(<App />);
    await waitFor(() => expect(location.pathname).toBe("/examples/cpu-monitor"));
    first.unmount();

    history.replaceState(null, "", "/nowhere");
    const second = render(<App />);
    await waitFor(() => expect(location.pathname).toBe("/examples/cpu-monitor"));
    second.unmount();

    const fresh = udcServer();
    vi.stubGlobal("fetch", fresh.fetch);
    history.replaceState(null, "", "/udc/events");
    render(<App />);
    await screen.findByText("backend-1");
    expect(fresh.lists).toEqual([expect.objectContaining({ collection: "events" })]);
    expect(screen.queryByText("CPU monitor", { selector: "h1" })).toBeNull();
  });

  it("keeps working under /en/", async () => {
    expect(routerBasename("/en/")).toBe("/en");
    expect(routerBasename("/en")).toBe("/en");
    expect(routerBasename("/en/examples/cpu-monitor")).toBe("/en");
    expect(routerBasename("/")).toBe("/");
    expect(routerBasename("/english")).toBe("/");
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    vi.stubGlobal("fetch", udcServer().fetch);
    history.replaceState(null, "", "/en/");
    render(<App />);
    await waitFor(() => expect(location.pathname).toBe("/en/examples/cpu-monitor"));
    await screen.findByText("backend-1");
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
