import { udcKeys } from "@jsudc/react";
import { decodeFilterParam } from "@jsudc/react/headless";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
  CHART_COLLECTION,
  CHART_REFRESH_MS,
  msToNextMinute,
  windowOf,
  windowStart,
  withWindow,
  withWindowCondition,
} from "../src/examples/chart/chart.js";
import { useThrottledRefresh } from "../src/refresh.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket } from "./fake-socket.js";
import { udcServer } from "./udc-server.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };
const NOW = new Date("2026-10-31T10:05:30Z");
const filterOf = (search: string) => decodeFilterParam(new URLSearchParams(search).get("f"));

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  vi.stubGlobal("WebSocket", FakeSocket);
  // The chart renderer measures its plot; jsdom has no layout to observe.
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the window", () => {
  it("starts N whole minutes back, the current minute included", () => {
    expect(windowStart("15m", NOW)).toBe("2026-10-31T09:51:00.000Z");
    expect(windowStart("1h", NOW)).toBe("2026-10-31T09:06:00.000Z");
    expect(windowStart("6h", NOW)).toBe("2026-10-31T04:06:00.000Z");
    expect(windowStart("24h", NOW)).toBe("2026-10-30T10:06:00.000Z");
    expect(msToNextMinute(NOW)).toBe(30_000);
  });

  it("is read from ?w=, 1 h by default", () => {
    expect(windowOf("")).toBe("1h");
    expect(windowOf("?w=6h")).toBe("6h");
    expect(windowOf("?w=2y")).toBe("1h");
  });

  it("writes the minute range into the data view's ?f= and resets its page", () => {
    const search = withWindow("?p=3&x=1", "15m", NOW);
    const params = new URLSearchParams(search);
    expect(params.get("w")).toBe("15m");
    expect(params.get("p")).toBeNull();
    expect(params.get("x")).toBe("1");
    expect(filterOf(search)).toEqual({
      field: "minute",
      op: "gte",
      value: "2026-10-31T09:51:00.000Z",
    });
  });

  it("replaces only its own condition, keeping the visitor's chips", () => {
    const window = { field: "minute", op: "gte" as const, value: "B" };
    const chip = { field: "event_type", op: "eq" as const, value: "CPU_LOAD" };
    const old = { field: "minute", op: "gte" as const, value: "A" };
    expect(withWindowCondition(null, window)).toEqual(window);
    expect(withWindowCondition(old, window)).toEqual(window);
    expect(withWindowCondition(chip, window)).toEqual({ and: [chip, window] });
    expect(withWindowCondition({ and: [old, chip] }, window)).toEqual({ and: [chip, window] });
    const either = { or: [chip, old] };
    expect(withWindowCondition(either, window)).toEqual({ and: [either, window] });

    const six = withWindow(withWindow("", "1h", NOW), "6h", NOW);
    expect(filterOf(six)).toEqual({ field: "minute", op: "gte", value: windowStart("6h", NOW) });
  });
});

describe("the live refresh", () => {
  it("refetches the activity lists at most once per 5 s", () => {
    vi.useFakeTimers();
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries").mockResolvedValue();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useThrottledRefresh(CHART_COLLECTION, CHART_REFRESH_MS), {
      wrapper,
    });
    expect(CHART_REFRESH_MS).toBe(5000);
    for (let i = 0; i < 20; i++) result.current();
    vi.advanceTimersByTime(4999);
    expect(invalidate).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith({ queryKey: udcKeys.lists("activity") });
    result.current();
    vi.advanceTimersByTime(5000);
    expect(invalidate).toHaveBeenCalledTimes(2);
  });
});

describe("the Activity chart page", () => {
  it("opens on the last hour, the window in the activity list's filter", async () => {
    const server = udcServer();
    vi.stubGlobal("fetch", server.fetch);
    history.replaceState(null, "", "/examples/chart");
    const before = Date.now();
    render(<App />);

    await waitFor(() => expect(new URLSearchParams(location.search).get("w")).toBe("1h"));
    const tree = filterOf(location.search) as { field: string; op: string; value: string };
    expect(tree).toMatchObject({ field: "minute", op: "gte" });
    const start = Date.parse(tree.value);
    expect(start).toBeLessThanOrEqual(before - 59 * 60_000);
    expect(start).toBeGreaterThan(before - 61 * 60_000);

    await waitFor(() =>
      expect(server.lists.some((l) => l.collection === CHART_COLLECTION)).toBe(true),
    );
    const list = server.lists.find((l) => l.collection === CHART_COLLECTION);
    expect(list?.filter).toEqual(tree);
    expect(screen.getByTestId("chart-note").textContent).toContain("lookups.yaml");
    expect(screen.getByTestId("window-1h").getAttribute("aria-pressed")).toBe("true");
    // The stream: every event of the tenant, no filter.
    expect(FakeSocket.last().query).toEqual({});
  });

  it("writes the picked window into ?f= and lists again", async () => {
    const server = udcServer();
    vi.stubGlobal("fetch", server.fetch);
    history.replaceState(null, "", "/examples/chart");
    render(<App />);
    await waitFor(() =>
      expect(server.lists.some((l) => l.collection === CHART_COLLECTION)).toBe(true),
    );

    act(() => fireEvent.click(screen.getByTestId("window-6h")));
    await waitFor(() => expect(new URLSearchParams(location.search).get("w")).toBe("6h"));
    const tree = filterOf(location.search) as { value: string };
    expect(Date.now() - Date.parse(tree.value)).toBeGreaterThan(359 * 60_000);
    expect(screen.getByTestId("window-6h").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("window-1h").getAttribute("aria-pressed")).toBe("false");
    await waitFor(() =>
      expect(
        server.lists.some(
          (l) =>
            l.collection === CHART_COLLECTION &&
            (l.filter as { value?: string } | undefined)?.value === tree.value,
        ),
      ).toBe(true),
    );
  });

  it("speaks the header's language", async () => {
    vi.stubGlobal("fetch", udcServer().fetch);
    history.replaceState(null, "", "/examples/chart");
    render(<App />);
    await screen.findByRole("heading", { name: "Activity chart" });
    fireEvent.click(screen.getByTestId("locale-sr"));
    await screen.findByRole("heading", { name: "Grafikon aktivnosti" });
    expect(screen.getByText("Period")).toBeTruthy();
  });
});
