import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Row } from "@jsudc/core";
import { UdcClient } from "@jsudc/core/client";
import {
  createUdcQueryClient,
  FALLBACK_ICON,
  LUCIDE_ICONS,
  resolveIcon,
  UdcI18nProvider,
  UdcProvider,
} from "@jsudc/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { Circle, Kanban } from "lucide-react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";
import { EXAMPLES_MESSAGES } from "../src/i18n/messages.js";
import { MenuTree, RemoteMenu } from "../src/shell/MenuTree.js";
import {
  activeLeaf,
  BUILTIN_MENU_ROWS,
  buildMenu,
  loadMenuExpanded,
  MENU_EXPAND_KEY,
  menuLabel,
  parseMenuUrl,
  saveMenuExpanded,
  visibleItems,
  withOpen,
} from "../src/shell/menu.js";
import { caps, node, SERVED_MENU } from "./udc-server.js";

// Ported from the jsudc example (frontend/test/menu.test.tsx, MIT).

beforeEach(() => localStorage.clear());

const repo = (path: string) => join(import.meta.dirname, "..", "..", "..", path);

// Out of order on purpose: the tree sorts siblings by `order`.
const ROWS: Row[] = [
  node("VIEWS", 2, { translation_key: "MENU_VIEWS", icon: "lucide:layout-grid" }),
  node("HOME", 0, { translation_key: "MENU_HOME", icon: "lucide:house", url: "/" }),
  node("COLLECTIONS", 1, { translation_key: "MENU_COLLECTIONS", icon: "lucide:layers" }),
  node("COLLECTIONS/DATABASE", 0, { translation_key: "MENU_DATABASE" }),
  node("COLLECTIONS/DATABASE/COLLECTION_TICKETS", 1, {
    translation_key: "COLLECTIONS_TICKETS",
    icon: "lucide:kanban",
    url: "/udc/tickets",
    is_dynamic: true,
  }),
  node("COLLECTIONS/DATABASE/COLLECTION_COMPANIES", 0, {
    translation_key: "COLLECTIONS_COMPANIES",
    icon: "lucide:no-such-icon",
    url: "/udc/companies",
    is_dynamic: true,
  }),
  node("VIEWS/TICKETS_KANBAN", 0, {
    translation_key: "MENU_VIEW_TICKETS",
    icon: "lucide:kanban",
    url: "/udc/tickets?tab=kanban",
  }),
  node("VIEWS/DOC_ORG", 1, { translation_key: "UNTRANSLATED_THING", url: "/udc/org?tab=doc" }),
  node("VIEWS/ORG_PLAIN", 2, { translation_key: "MENU_ORG", url: "/udc/org/" }),
  node("COLLECTIONS/DATABASE/COLLECTION_ORG", 2, {
    translation_key: "COLLECTIONS_ORG",
    url: "/udc/org",
    is_dynamic: true,
  }),
  node("ORPHAN", 0, { parent_id: "NOWHERE", url: "/x" }),
];

const EN: Record<string, string> = { "MENU.HOME": "Home", "COLLECTIONS.TICKETS": "Tickets" };
const tEn = (section: string, term: string) => EN[`${section}.${term}`] ?? null;

const built = () => buildMenu(ROWS, (key, code) => menuLabel(key, code, tEn));

describe("menu labels (label_i18n)", () => {
  it("splits on the first underscore and reads t(section, term)", () => {
    expect(menuLabel("MENU_HOME", "HOME", tEn)).toBe("Home");
    expect(menuLabel("COLLECTIONS_TICKETS", "X", tEn)).toBe("Tickets");
  });

  it("falls back to the raw key, and to the code without one", () => {
    expect(menuLabel("UNTRANSLATED_THING", "X", tEn)).toBe("UNTRANSLATED_THING");
    expect(menuLabel("NOUNDERSCORE", "X", tEn)).toBe("NOUNDERSCORE");
    expect(menuLabel(null, "CODE", tEn)).toBe("CODE");
  });
});

describe("icons", () => {
  it("resolves lucide:<kebab-name>, a circle for an unknown name, nothing for none", () => {
    expect(resolveIcon("lucide:kanban")).toBe(Kanban);
    expect(FALLBACK_ICON).toBe(Circle);
    expect(resolveIcon("lucide:no-such-icon")).toBe(Circle);
    expect(resolveIcon(null)).toBeNull();
  });

  it("knows every lucide: name of menu.yaml, the server's collection icons and the built-ins", () => {
    const names = new Set<string>();
    for (const text of [
      readFileSync(repo("menu.yaml"), "utf8"),
      readFileSync(repo("packages/server/src/udc/menu.ts"), "utf8"),
      JSON.stringify(BUILTIN_MENU_ROWS),
    ]) {
      for (const m of text.matchAll(/lucide:([a-z0-9-]+)/g)) names.add(m[1] as string);
    }
    expect(names.size).toBeGreaterThan(5);
    const missing = [...names].filter((n) => !(n in LUCIDE_ICONS));
    expect(missing, "not in @jsudc/react's LUCIDE_ICONS: pick another, or add it upstream").toEqual(
      [],
    );
  });
});

describe("the menu tree from flat rows", () => {
  it("nests children under their parent, siblings by order, orphans dropped", () => {
    const items = built();
    expect(items.map((i) => i.code)).toEqual(["HOME", "COLLECTIONS", "VIEWS"]);
    const db = items[1]?.children[0];
    expect(db?.code).toBe("DATABASE");
    expect(db?.children.map((c) => [c.code, c.isDynamic])).toEqual([
      ["COLLECTION_COMPANIES", true],
      ["COLLECTION_TICKETS", true],
      ["COLLECTION_ORG", true],
    ]);
    expect(items[0]).toMatchObject({ label: "Home", icon: "lucide:house", url: "/" });
    expect(db?.children[1]?.label).toBe("Tickets");
  });

  it("lists what is on screen: roots and the children of open items", () => {
    const items = built();
    const codes = (open: string[]) => visibleItems(items, new Set(open)).map((i) => i.code);
    expect(codes([])).toEqual(["HOME", "COLLECTIONS", "VIEWS"]);
    expect(codes(["COLLECTIONS"])).toEqual(["HOME", "COLLECTIONS", "DATABASE", "VIEWS"]);
    // A closed parent hides an open child.
    expect(codes(["COLLECTIONS/DATABASE"])).toEqual(["HOME", "COLLECTIONS", "VIEWS"]);
  });

  it("builds the built-in HOME and EXAMPLES › every example of menu.yaml", () => {
    const items = buildMenu(BUILTIN_MENU_ROWS, (key, code) => key ?? code);
    expect(items.map((i) => i.code)).toEqual(["HOME", "EXAMPLES"]);
    expect(items[1]?.children.map((c) => [c.code, c.url])).toEqual([
      ["CPU_MONITOR", "/examples/cpu-monitor"],
      ["ACTIVITY", "/examples/activity"],
      ["ENTITY", "/examples/entity"],
      ["CHAT", "/examples/chat"],
      ["TAIL", "/examples/tail"],
      ["SEARCH", "/examples/search"],
      ["RENDERING", "/examples/rendering"],
      ["CHART", "/examples/chart"],
    ]);
    expect(items[1]?.children[0]?.ancestors).toEqual([items[1]?.id]);
  });
});

describe("the active leaf", () => {
  const at = (pathname: string, search = "") => activeLeaf(built(), { pathname, search })?.id;

  it("parses a menu url into a path and a tab", () => {
    expect(parseMenuUrl("/udc/tickets?tab=kanban")).toEqual({
      pathname: "/udc/tickets",
      tab: "kanban",
    });
    expect(parseMenuUrl("/udc/tickets/")).toEqual({ pathname: "/udc/tickets", tab: null });
  });

  it("without ?tab= in its url a leaf matches the path on any tab", () => {
    expect(at("/udc/tickets")).toBe("COLLECTIONS/DATABASE/COLLECTION_TICKETS");
    expect(at("/udc/companies", "?tab=map&q=x")).toBe("COLLECTIONS/DATABASE/COLLECTION_COMPANIES");
  });

  it("with ?tab= it needs that tab, and then beats the plain one", () => {
    expect(at("/udc/tickets", "?tab=kanban")).toBe("VIEWS/TICKETS_KANBAN");
    expect(at("/udc/org", "?tab=doc")).toBe("VIEWS/DOC_ORG");
    expect(at("/udc/tickets", "?tab=calendar")).toBe("COLLECTIONS/DATABASE/COLLECTION_TICKETS");
  });

  it("a written leaf beats a dynamic one on the same path, trailing slash or not", () => {
    expect(at("/udc/org")).toBe("VIEWS/ORG_PLAIN");
    expect(at("/udc/org/", "?tab=tree&q=x")).toBe("VIEWS/ORG_PLAIN");
  });

  it("matches the root path, and nothing elsewhere", () => {
    expect(at("/")).toBe("HOME");
    expect(at("/udc/nothing")).toBeUndefined();
  });
});

describe("expand persistence", () => {
  it("round-trips the open ids under udc:menu:expanded", () => {
    expect(loadMenuExpanded()).toBeNull();
    saveMenuExpanded(["a", "b"]);
    expect(localStorage.getItem(MENU_EXPAND_KEY)).toBe('["a","b"]');
    expect(loadMenuExpanded()).toEqual(["a", "b"]);
    localStorage.setItem(MENU_EXPAND_KEY, "{not json");
    expect(loadMenuExpanded()).toBeNull();
    localStorage.setItem(MENU_EXPAND_KEY, '["a", 3, null]');
    expect(loadMenuExpanded()).toEqual(["a"]);
  });

  it("adds ids once, and keeps the array when nothing is new", () => {
    const open = ["a"];
    expect(withOpen(open, ["a"])).toBe(open);
    expect(withOpen(open, ["b", "a", "c"])).toEqual(["a", "b", "c"]);
  });
});

// --- the tree on screen ------------------------------------------------------------------

function renderTree(url: string, rows: readonly Row[] = ROWS) {
  return render(
    <UdcI18nProvider messages={EXAMPLES_MESSAGES}>
      <MemoryRouter initialEntries={[url]}>
        <MenuTree rows={rows} source="menu" />
      </MemoryRouter>
    </UdcI18nProvider>,
  );
}

const attr = (el: HTMLElement, name: string) => el.getAttribute(name);

describe("the sidebar tree", () => {
  it("opens the way to the active leaf and highlights it", () => {
    renderTree("/udc/companies");
    const tree = screen.getByTestId("menu-tree");
    const active = within(tree).getByTestId("nav-companies");
    expect(attr(active, "aria-current")).toBe("page");
    expect(attr(active, "data-active")).toBe("true");
    expect(within(tree).getByTestId("menu-HOME").textContent).toBe("Home");
    expect(attr(within(tree).getByTestId("menu-COLLECTIONS"), "aria-expanded")).toBe("true");
    expect(attr(within(tree).getByTestId("menu-VIEWS"), "aria-expanded")).toBe("false");
    // An unknown icon still draws (the fallback), with the name kept.
    expect(attr(within(active).getByTestId("menu-icon"), "data-icon")).toBe("lucide:no-such-icon");
    expect(JSON.parse(localStorage.getItem(MENU_EXPAND_KEY) ?? "[]")).toEqual([
      "COLLECTIONS",
      "COLLECTIONS/DATABASE",
    ]);
  });

  it("toggles a branch, persists it, and opens it again on the next mount", async () => {
    const first = renderTree("/udc/companies");
    fireEvent.click(screen.getByTestId("menu-VIEWS"));
    expect(await screen.findByTestId("menu-TICKETS_KANBAN")).toBeTruthy();
    expect(loadMenuExpanded()).toContain("VIEWS");
    first.unmount();

    renderTree("/");
    expect(await screen.findByTestId("menu-TICKETS_KANBAN")).toBeTruthy();
    fireEvent.click(screen.getByTestId("menu-VIEWS"));
    await waitFor(() => expect(screen.queryByTestId("menu-TICKETS_KANBAN")).toBeNull());
    expect(loadMenuExpanded()).not.toContain("VIEWS");
  });

  it("moves with the arrow keys as the tree renderer does", async () => {
    renderTree("/");
    const home = screen.getByTestId("menu-HOME");
    home.focus();
    fireEvent.keyDown(home, { key: "ArrowDown" });
    const coll = screen.getByTestId("menu-COLLECTIONS");
    expect(document.activeElement).toBe(coll);
    fireEvent.keyDown(coll, { key: "ArrowRight" });
    expect(await screen.findByTestId("menu-DATABASE")).toBeTruthy();
    fireEvent.keyDown(coll, { key: "ArrowRight" });
    expect(document.activeElement).toBe(screen.getByTestId("menu-DATABASE"));
    fireEvent.keyDown(screen.getByTestId("menu-DATABASE"), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(coll);
    fireEvent.keyDown(coll, { key: "ArrowUp" });
    expect(document.activeElement).toBe(home);
    fireEvent.keyDown(home, { key: "ArrowRight" }); // a leaf: nothing to open
    fireEvent.keyDown(coll, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.queryByTestId("menu-DATABASE")).toBeNull());
  });

  it("labels memento's menu through the site's messages, in Serbian too", () => {
    localStorage.setItem("udc-locale", "sr");
    renderTree("/examples/cpu-monitor", SERVED_MENU);
    expect(screen.getByTestId("menu-EXAMPLES").textContent).toBe("Primeri");
    expect(screen.getByTestId("menu-CPU_MONITOR").textContent).toBe("CPU monitor");
    expect(attr(screen.getByTestId("menu-CPU_MONITOR"), "aria-current")).toBe("page");
  });
});

describe("the served menu", () => {
  const listing = {
    name: "menu",
    default_renderer: "table",
    capabilities: caps,
    source_kind: "yaml_menu" as const,
  };

  function renderRemote(reply: () => Response) {
    const fetch = async () => reply();
    const client = new UdcClient({
      httpUrl: "",
      fetch: fetch as unknown as typeof globalThis.fetch,
    });
    return render(
      <QueryClientProvider client={createUdcQueryClient()}>
        <UdcI18nProvider messages={EXAMPLES_MESSAGES}>
          <UdcProvider client={client}>
            <MemoryRouter initialEntries={["/"]}>
              <RemoteMenu listing={listing} />
            </MemoryRouter>
          </UdcProvider>
        </UdcI18nProvider>
      </QueryClientProvider>,
    );
  }

  it("loads the menu collection's rows", async () => {
    renderRemote(
      () =>
        new Response(
          JSON.stringify({
            kind: "udc.list.ok",
            id: "",
            payload: { rows: SERVED_MENU, next_cursor: null, total: SERVED_MENU.length },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    expect(screen.getByTestId("menu-loading")).toBeTruthy();
    const tree = await screen.findByTestId("menu-tree");
    expect(tree.dataset.source).toBe("menu");
    expect(screen.getByTestId("menu-COLLECTIONS")).toBeTruthy();
  });

  it("falls back to the built-in entries when it cannot be read", async () => {
    renderRemote(
      () =>
        new Response(
          JSON.stringify({
            kind: "udc.list.err",
            id: "",
            payload: { code: "forbidden", message: "nope" },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    );
    const tree = await screen.findByTestId("menu-tree", {}, { timeout: 5000 });
    expect(tree.dataset.source).toBe("builtin");
    expect(screen.queryByTestId("menu-COLLECTIONS")).toBeNull();
  });
});
