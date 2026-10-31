import { decodeFilterParam } from "@jsudc/react/headless";
import { describe, expect, it } from "vitest";
import {
  defaultSettings,
  loadSettings,
  STORAGE_KEY,
  saveSettings,
  settingsFilter,
  streamFilter,
  withSettingsFilter,
} from "../src/settings.js";

const defaults = defaultSettings({} as ImportMetaEnv);
const store = (value: string | null) => ({ getItem: () => value });

describe("settings", () => {
  it("defaults to the proxied server, the cpu_load collection and servers", () => {
    expect(defaults).toEqual({
      baseUrl: "/memento",
      apiKey: "",
      collection: "cpu_load",
      instanceType: "server",
    });
    expect(
      defaultSettings({
        VITE_MEMENTO_API_KEY: "mk_x",
        VITE_MEMENTO_BASE_URL: "http://h/memento",
      } as ImportMetaEnv),
    ).toMatchObject({ apiKey: "mk_x", baseUrl: "http://h/memento" });
  });

  it("loads what was saved, the defaults for anything missing or broken", () => {
    const saved: Record<string, string> = {};
    saveSettings(
      {
        setItem: (k, v) => {
          saved[k] = v;
        },
      },
      { ...defaults, apiKey: "mk_a" },
    );
    expect(loadSettings(store(saved[STORAGE_KEY] ?? null), defaults).apiKey).toBe("mk_a");
    expect(loadSettings(store(null), defaults)).toEqual(defaults);
    expect(loadSettings(store("{oops"), defaults)).toEqual(defaults);
    expect(loadSettings(store("42"), defaults)).toEqual(defaults);
    expect(
      loadSettings(
        store(JSON.stringify({ baseUrl: "", instanceType: "", collection: 3 })),
        defaults,
      ),
    ).toEqual({ ...defaults, instanceType: "" });
  });

  it("turns instance_type into the data view's filter parameter", () => {
    expect(settingsFilter(defaults)).toEqual({ field: "instance_type", op: "eq", value: "server" });
    expect(settingsFilter({ ...defaults, instanceType: " " })).toBeNull();
    const search = withSettingsFilter("?tab=table&p=3", defaults);
    const params = new URLSearchParams(search);
    expect(params.get("tab")).toBe("table");
    expect(params.has("p")).toBe(false);
    expect(decodeFilterParam(params.get("f"))).toEqual(settingsFilter(defaults));
    expect(withSettingsFilter(search, { ...defaults, instanceType: "" })).toBe("?tab=table");
    expect(withSettingsFilter("", { ...defaults, instanceType: "" })).toBe("");
  });

  it("follows CPU_LOAD only for the cpu_load collection", () => {
    expect(streamFilter(defaults)).toEqual({ event_type: "CPU_LOAD", instance_type: "server" });
    expect(streamFilter({ ...defaults, collection: "events", instanceType: "" })).toEqual({});
  });
});
