import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { localized, PLANNED_EXAMPLES } from "../src/examples/planned/planned.js";
import { EXAMPLES_MESSAGES } from "../src/i18n/messages.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { BUILTIN_MENU_ROWS } from "../src/shell/menu.js";
import { FakeSocket } from "./fake-socket.js";
import { udcServer } from "./udc-server.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };
const SLUGS = ["tail", "search", "rendering", "chart"];
/** The examples with a page of their own. */
const BUILT = ["/examples/cpu-monitor", "/examples/activity", "/examples/entity", "/examples/chat"];

/** The EXAMPLES entries of the repository's menu.yaml: [code, translation_key, url]. */
function menuYamlExamples(): [string, string, string][] {
  const yaml = readFileSync(join(import.meta.dirname, "..", "..", "..", "menu.yaml"), "utf8");
  const branch = yaml.slice(yaml.indexOf("- code: EXAMPLES"), yaml.indexOf("- code: COLLECTIONS"));
  return [
    ...branch.matchAll(/- code: (\w+)\n\s+translation_key: (\w+)\n\s+icon: \S+\n\s+url: (\S+)/g),
  ].map((m) => [m[1], m[2], m[3]] as [string, string, string]);
}

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", udcServer({ feed: [] }).fetch);
});
afterEach(() => vi.unstubAllGlobals());

describe("menu.yaml", () => {
  it("lists every example of the series, in order, each with a page or a planned page", () => {
    const entries = menuYamlExamples();
    expect(entries.map(([code]) => code)).toEqual([
      "CPU_MONITOR",
      "ACTIVITY",
      "ENTITY",
      "CHAT",
      "TAIL",
      "SEARCH",
      "RENDERING",
      "CHART",
    ]);
    for (const [code, key, url] of entries) {
      expect(key).toBe(`MENU_${code}`);
      const label = EXAMPLES_MESSAGES.MENU?.[code];
      expect(label?.en, code).toBeTruthy();
      expect(label?.sr, code).toBeTruthy();
      const slug = url.replace("/examples/", "");
      expect(BUILT.includes(url) || slug in PLANNED_EXAMPLES, url).toBe(true);
    }
    expect(Object.keys(PLANNED_EXAMPLES)).toEqual(SLUGS);
  });

  it("is what the built-in sidebar shows without the server's menu", () => {
    const builtin = BUILTIN_MENU_ROWS.filter((r) => r.parent_id === "builtin:EXAMPLES").map((r) => [
      r.code,
      r.translation_key,
      r.url,
    ]);
    expect(builtin).toEqual(menuYamlExamples());
  });
});

describe("a planned example", () => {
  it.each(SLUGS)(
    "/examples/%s says it is planned, what it will show, and links back",
    async (slug) => {
      history.replaceState(null, "", `/examples/${slug}`);
      render(<App />);
      const page = await screen.findByTestId("planned");
      const planned = PLANNED_EXAMPLES[slug] as (typeof PLANNED_EXAMPLES)[string];
      expect(page.dataset.slug).toBe(slug);
      expect(within(page).getByText("Planned")).toBeTruthy();
      expect(within(page).getByRole("heading", { name: planned.title.en })).toBeTruthy();
      expect(within(page).getByText(planned.summary.en)).toBeTruthy();
      const back = within(page).getByRole("link", { name: "← Back to the activity feed" });
      expect(back.getAttribute("href")).toBe("/examples/activity");

      fireEvent.click(screen.getByTestId("locale-sr"));
      expect(await within(page).findByText(planned.summary.sr)).toBeTruthy();
      expect(within(page).getByText("Planirano")).toBeTruthy();
      expect(within(page).getByRole("heading", { name: planned.title.sr })).toBeTruthy();

      fireEvent.click(within(page).getByRole("link", { name: "← Nazad na tok aktivnosti" }));
      await waitFor(() => expect(location.pathname).toBe("/examples/activity"));
      expect(await screen.findByTestId("feed-empty")).toBeTruthy();
    },
  );

  it("names every summary of the series", () => {
    expect(localized(PLANNED_EXAMPLES.tail?.summary ?? { en: "", sr: "" }, "sr")).toContain(
      "memento tail",
    );
    expect(PLANNED_EXAMPLES.tail?.summary.en).toContain("memento tail");
    expect(PLANNED_EXAMPLES.search?.summary.en).toContain("POST /events/query");
    expect(PLANNED_EXAMPLES.rendering?.summary.en).toContain("Handlebars");
    expect(PLANNED_EXAMPLES.chart?.summary.en).toContain("UDC chart");
  });

  it("leads an unknown example home", async () => {
    history.replaceState(null, "", "/examples/nope");
    render(<App />);
    await waitFor(() => expect(location.pathname).toBe("/examples/cpu-monitor"));
  });
});

describe("the sidebar", () => {
  it("opens every example: its page, or its planned page", async () => {
    history.replaceState(null, "", "/examples/activity");
    render(<App />);
    const tree = await screen.findByTestId("menu-tree");
    await waitFor(() => expect(tree.dataset.source).toBe("menu"));
    for (const [code, , url] of menuYamlExamples()) {
      fireEvent.click(within(tree).getByTestId(`menu-${code}`));
      await waitFor(() => expect(location.pathname).toBe(url));
      if (BUILT.includes(url)) expect(screen.queryByTestId("planned")).toBeNull();
      else expect((await screen.findByTestId("planned")).dataset.slug).toBe(url.slice(10));
    }
  });
});
