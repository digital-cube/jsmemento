import type { Row } from "@jsudc/core";
import { i18nKey, storage } from "@jsudc/react";

/*
 * Ported from the jsudc example (frontend/src/shell/menu.ts, MIT).
 *
 * The sidebar's pure parts: the menu collection's flat rows (MENU_SCHEMA) as
 * a tree, the label of a node, the leaf the current location activates and
 * the expand state kept in localStorage.
 */

export interface MenuItem {
  id: string;
  code: string;
  label: string;
  icon: string | null;
  url: string | null;
  depth: number;
  ancestors: string[];
  isDynamic: boolean;
  children: MenuItem[];
}

const text = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/**
 * `label_i18n`: `<SECTION>_<TERM>` split on the first underscore and read
 * through `tMaybe(section, term)`; the raw value when it has no translation.
 */
export function menuLabel(
  key: string | null,
  code: string,
  tMaybe: (section: string, term: string) => string | null,
): string {
  if (!key) return code;
  const split = i18nKey(key);
  return (split && tMaybe(split[0], split[1])) || key;
}

/**
 * The rows as a tree: children under their `parent_id`, siblings by
 * `order`. A row whose parent is not among the rows is dropped (with its
 * subtree), never drawn as a root.
 */
export function buildMenu(
  rows: readonly Row[],
  label: (key: string | null, code: string) => string,
): MenuItem[] {
  const byId = new Map<string, MenuItem>();
  const order = new Map<string, number>();
  for (const r of rows) {
    const code = text(r.code) ?? r.__meta.id;
    byId.set(r.__meta.id, {
      id: r.__meta.id,
      code,
      label: label(text(r.translation_key), code),
      icon: text(r.icon),
      url: text(r.url),
      depth: num(r.depth),
      ancestors: Array.isArray(r.ancestor_ids)
        ? r.ancestor_ids.filter((a): a is string => typeof a === "string")
        : [],
      isDynamic: r.is_dynamic === true,
      children: [],
    });
    order.set(r.__meta.id, num(r.order));
  }
  const roots: MenuItem[] = [];
  for (const r of rows) {
    const item = byId.get(r.__meta.id) as MenuItem;
    const parent = text(r.parent_id);
    if (parent === null) roots.push(item);
    else byId.get(parent)?.children.push(item);
  }
  const sort = (level: MenuItem[]): MenuItem[] => {
    level.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
    for (const i of level) sort(i.children);
    return level;
  };
  return sort(roots);
}

/** Every item, depth first. */
export function* walkMenu(items: readonly MenuItem[]): Generator<MenuItem> {
  for (const i of items) {
    yield i;
    yield* walkMenu(i.children);
  }
}

/** A node's `url` as a path and the `?tab=` it asks for (`null`: any tab). */
export function parseMenuUrl(url: string): { pathname: string; tab: string | null } {
  const q = url.indexOf("?");
  const pathname = q === -1 ? url : url.slice(0, q);
  const tab = q === -1 ? null : new URLSearchParams(url.slice(q + 1)).get("tab");
  return { pathname: pathname.replace(/(.)\/+$/, "$1"), tab };
}

/**
 * The leaf the location activates: its path equals the current one and,
 * when its url has `?tab=`, the current tab is that one. A leaf naming the
 * tab beats one that does not (on `/udc/tickets?tab=kanban` the Views entry
 * wins over the collection's), then a written leaf beats one a `udc:`
 * reference added (`/udc/menu` lights MENU, not the collection's leaf);
 * among equals the first in menu order.
 */
export function activeLeaf(
  items: readonly MenuItem[],
  location: { pathname: string; search: string },
): MenuItem | null {
  const path = location.pathname.replace(/(.)\/+$/, "$1");
  const tab = new URLSearchParams(location.search).get("tab");
  let best: MenuItem | null = null;
  let bestScore = -1;
  for (const item of walkMenu(items)) {
    if (!item.url) continue;
    const want = parseMenuUrl(item.url);
    if (want.pathname !== path) continue;
    if (want.tab !== null && want.tab !== tab) continue;
    const score = (want.tab === null ? 0 : 2) + (item.isDynamic ? 0 : 1);
    if (score > bestScore) {
      best = item;
      bestScore = score;
    }
  }
  return best;
}

// expand state ------------------------------------------------------------------

export const MENU_EXPAND_KEY = "udc:menu:expanded";

/** The ids the user has open; `null` before the first toggle (first visit). */
export function loadMenuExpanded(): string[] | null {
  const raw = storage.get(MENU_EXPAND_KEY);
  if (!raw) return null;
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((i): i is string => typeof i === "string") : null;
  } catch {
    return null;
  }
}

export function saveMenuExpanded(ids: readonly string[]): void {
  storage.set(MENU_EXPAND_KEY, JSON.stringify(ids));
}

/** `open` with every id of `add` in it, in order, without duplicates; the same array when nothing is new. */
export function withOpen(open: readonly string[], add: readonly string[]): readonly string[] {
  const missing = add.filter((id) => !open.includes(id));
  return missing.length === 0 ? open : [...open, ...missing];
}

/** The items on screen, in order: the roots and the children of every open item. */
export function visibleItems(items: readonly MenuItem[], open: ReadonlySet<string>): MenuItem[] {
  const out: MenuItem[] = [];
  const walk = (level: readonly MenuItem[]) => {
    for (const i of level) {
      out.push(i);
      if (i.children.length > 0 && open.has(i.id)) walk(i.children);
    }
  };
  walk(items);
  return out;
}

// built-in menu -------------------------------------------------------------------

/** One row as the `yaml_menu` source flattens it (`MENU_SCHEMA`); the id is the path of codes. */
function builtinRow(path: string, order: number, fields: Record<string, unknown>): Row {
  const codes = path.split("/");
  const ancestors = codes.slice(0, -1).map((_, i) => codes.slice(0, i + 1).join("/"));
  return {
    __meta: { id: `builtin:${path}`, version: 1 },
    code: codes.at(-1),
    translation_key: null,
    icon: null,
    url: null,
    parent_id: ancestors.length > 0 ? `builtin:${ancestors.at(-1)}` : null,
    order,
    depth: ancestors.length,
    ancestor_ids: ancestors.map((a) => `builtin:${a}`),
    children_count: 0,
    is_dynamic: false,
    ...fields,
  };
}

/**
 * The sidebar when the server serves no `menu` collection (no menu.yaml, no key yet, an
 * error): HOME and EXAMPLES of the repository's menu.yaml, so the site never renders empty.
 */
export const BUILTIN_MENU_ROWS: readonly Row[] = [
  builtinRow("HOME", 0, { translation_key: "MENU_HOME", icon: "lucide:house", url: "/" }),
  builtinRow("EXAMPLES", 1, {
    translation_key: "MENU_EXAMPLES",
    icon: "lucide:layout-dashboard",
    children_count: 1,
  }),
  builtinRow("EXAMPLES/CPU_MONITOR", 0, {
    translation_key: "MENU_CPU_MONITOR",
    icon: "lucide:activity",
    url: "/examples/cpu-monitor",
  }),
];
