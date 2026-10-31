import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { healthOf, rateOf, useLive } from "../src/live.js";
import { FakeSocket, uuid } from "./fake-socket.js";

beforeEach(() => {
  FakeSocket.all = [];
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("health", () => {
  it("is green only with a live stream and a healthy server", () => {
    expect(healthOf("live", true)).toBe("live");
    expect(healthOf("live", null)).toBe("connecting");
    expect(healthOf("connecting", true)).toBe("connecting");
    expect(healthOf("off", true)).toBe("connecting");
    expect(healthOf("live", false)).toBe("offline");
    expect(healthOf("offline", true)).toBe("offline");
    expect(healthOf("closed", null)).toBe("offline");
  });

  it("counts events per second over the window", () => {
    expect(rateOf([1000, 11_000, 15_000, 20_000], 20_000)).toBe(0.3);
    expect(rateOf([], 0)).toBe(0);
  });
});

describe("useLive", () => {
  it("follows the stream with the settings' filter and polls health", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const onEvent = vi.fn();
    const { result, unmount } = renderHook(() =>
      useLive({
        baseUrl: "/memento/",
        apiKey: "mk_k",
        filter: { event_type: "CPU_LOAD", instance_type: "server" },
        onEvent,
        fetch,
      }),
    );
    expect(result.current.health).toBe("connecting");
    const socket = FakeSocket.last();
    expect(socket.url).toContain("/memento/ws?event_type=CPU_LOAD&instance_type=server");
    expect(socket.protocols).toEqual(["memento.v1", "bearer.mk_k"]);
    act(() => socket.welcome());
    await waitFor(() => expect(result.current.health).toBe("live"));
    expect(fetch).toHaveBeenCalledWith("/memento/api/health");

    act(() => socket.push(uuid(1)));
    act(() => socket.push(uuid(2)));
    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(result.current.lastEventAt).not.toBeNull();
    expect(result.current.rate).toBeCloseTo(0.2);

    unmount();
    expect(socket.closed).toBe(true);
  });

  it("goes red when the stream drops", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const { result } = renderHook(() =>
      useLive({ baseUrl: "/memento", apiKey: "mk_k", filter: {}, onEvent: () => {}, fetch }),
    );
    act(() => FakeSocket.last().welcome());
    await waitFor(() => expect(result.current.health).toBe("live"));
    act(() => FakeSocket.last().drop());
    expect(result.current.health).toBe("offline");
  });

  it("is offline when the server is unreachable, and off without a key", async () => {
    const down = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const { result } = renderHook(() =>
      useLive({ baseUrl: "/memento", apiKey: "", filter: {}, onEvent: () => {}, fetch: down }),
    );
    expect(result.current.stream).toBe("off");
    expect(FakeSocket.all).toHaveLength(0);
    await waitFor(() => expect(result.current.health).toBe("offline"));
    expect(result.current.serverUp).toBe(false);
  });
});
