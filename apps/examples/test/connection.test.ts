import { renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { connectionOf, fetchDemoKey, useDemoKey } from "../src/connection.js";
import { defaultSettings } from "../src/settings.js";

const json = (status: number, body: unknown) => async () =>
  new Response(JSON.stringify(body), { status });

describe("fetchDemoKey", () => {
  it("reads the key and tenant of GET <base>/api/demo", async () => {
    const fetch = vi.fn(json(200, { ok: true, data: { api_key: "mk_d", tenant: "demo" } }));
    expect(await fetchDemoKey("/memento/", fetch)).toEqual({ apiKey: "mk_d", tenant: "demo" });
    expect(fetch).toHaveBeenCalledWith("/memento/api/demo", expect.anything());
  });

  it("is null for a 404, a strange answer or a server that cannot be reached", async () => {
    expect(await fetchDemoKey("/m", json(404, { ok: false }))).toBeNull();
    expect(await fetchDemoKey("/m", json(200, { ok: true, data: {} }))).toBeNull();
    expect(await fetchDemoKey("/m", json(200, { ok: true, data: { api_key: "" } }))).toBeNull();
    expect(await fetchDemoKey("/m", json(200, null))).toBeNull();
    expect(await fetchDemoKey("/m", json(200, { data: { api_key: "mk_d", tenant: 3 } }))).toEqual({
      apiKey: "mk_d",
      tenant: "",
    });
    const down = async () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await fetchDemoKey("/m", down)).toBeNull();
  });
});

describe("useDemoKey", () => {
  it("asks only while enabled", async () => {
    const fetch = vi.fn(json(200, { data: { api_key: "mk_d", tenant: "demo" } }));
    const { result, rerender } = renderHook(({ on }) => useDemoKey("/m", on, fetch), {
      initialProps: { on: false },
    });
    expect(result.current).toEqual({ status: "off" });
    expect(fetch).not.toHaveBeenCalled();
    rerender({ on: true });
    expect(result.current.status).toBe("loading");
    await waitFor(() =>
      expect(result.current).toEqual({ status: "ready", key: { apiKey: "mk_d", tenant: "demo" } }),
    );
    rerender({ on: false });
    expect(result.current).toEqual({ status: "off" });
  });

  it("says none when the server has no demo key", async () => {
    const missing = json(404, {}); // one function: a new one per render would ask again
    const { result } = renderHook(() => useDemoKey("/m", true, missing));
    await waitFor(() => expect(result.current).toEqual({ status: "none" }));
  });
});

describe("connectionOf", () => {
  const settings = defaultSettings({} as ImportMetaEnv);
  const ready = { status: "ready" as const, key: { apiKey: "mk_d", tenant: "demo" } };

  it("prefers the visitor's own key, then the demo key", () => {
    expect(connectionOf({ ...settings, apiKey: "mk_me" }, ready)).toMatchObject({
      apiKey: "mk_me",
      source: "own",
      tenant: null,
    });
    expect(connectionOf(settings, ready)).toMatchObject({
      apiKey: "mk_d",
      source: "demo",
      tenant: "demo",
    });
    expect(connectionOf(settings, { status: "loading" }).source).toBe("pending");
    expect(connectionOf(settings, { status: "none" })).toMatchObject({
      apiKey: "",
      source: "none",
    });
  });
});
