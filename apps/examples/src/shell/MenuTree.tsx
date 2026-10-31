import type { CollectionListing, Row } from "@jsudc/core";
import { cn, resolveIcon, useI18n, useUdcAllRows } from "@jsudc/react";
import { Skeleton } from "@jsudc/react/ui";
import { ChevronRight } from "lucide-react";
import { type KeyboardEvent, useCallback, useEffect, useMemo, useState } from "react";
import { Link, useLocation } from "react-router";
import {
  activeLeaf,
  BUILTIN_MENU_ROWS,
  buildMenu,
  loadMenuExpanded,
  type MenuItem,
  menuLabel,
  saveMenuExpanded,
  withOpen,
} from "./menu.js";

/*
 * Ported from the jsudc example (frontend/src/shell/MenuTree.tsx, MIT): the same tree,
 * keyboard and expand state, styled by this app's CSS (app.css `.menu*`) instead of
 * Tailwind utilities.
 */

/** The collection the sidebar is drawn from; another deployment may name its own. */
export const MENU_COLLECTION = import.meta.env.VITE_MENU_COLLECTION?.trim() || "menu";

const INDENT = 14;

/** A collection's own leaf: `nav-<collection>`; every other row `menu-<code>`. */
function testIdOf(item: MenuItem): string {
  const m = item.isDynamic && item.url ? /^\/udc\/([a-z0-9_]+)$/.exec(item.url) : null;
  return m ? `nav-${m[1]}` : `menu-${item.code}`;
}

/** Move the focus to the previous / next row on screen, or to the row with `id`. */
function focusRow(from: HTMLElement, where: -1 | 1 | string) {
  const tree = from.closest('[role="tree"]');
  if (!tree) return;
  const rows = [...tree.querySelectorAll<HTMLElement>("[data-menu-row]")];
  const target =
    typeof where === "string"
      ? rows.find((r) => r.dataset.id === where)
      : rows[rows.indexOf(from) + where];
  target?.focus();
}

/**
 * The menu collection (`yaml_menu`) as the sidebar: every row in one list (the server has
 * already resolved `udc:collections`), drawn by `MenuTree`. While it loads, skeleton rows;
 * when it cannot be read, the built-in entries.
 */
export function RemoteMenu({ listing }: { listing: CollectionListing }) {
  const data = useUdcAllRows({ collection: listing.name, capabilities: listing.capabilities });
  if (data.isLoading) {
    return (
      <div className="menu__loading" data-testid="menu-loading">
        <Skeleton className="menu__skeleton" />
        <Skeleton className="menu__skeleton" />
        <Skeleton className="menu__skeleton" />
      </div>
    );
  }
  return (
    <MenuTree
      rows={data.error ? BUILTIN_MENU_ROWS : data.rows}
      source={data.error ? "builtin" : "menu"}
    />
  );
}

/**
 * A menu tree from flat `MENU_SCHEMA` rows. A node with children is a toggle, a leaf a
 * link to its `url`; the leaf the location activates is highlighted and, when it changes,
 * the way to it is opened. What is open is kept under `udc:menu:expanded`.
 */
export function MenuTree({
  rows,
  source,
}: {
  rows: readonly Row[];
  /** `menu`: the collection; `builtin`: `BUILTIN_MENU_ROWS`. Shown as `data-source`. */
  source: "menu" | "builtin";
}) {
  const { t, tMaybe } = useI18n();
  const location = useLocation();
  const items = useMemo(
    () => buildMenu(rows, (key, code) => menuLabel(key, code, tMaybe)),
    [rows, tMaybe],
  );
  const active = useMemo(() => activeLeaf(items, location), [items, location]);

  const [open, setOpen] = useState<readonly string[]>(() => loadMenuExpanded() ?? []);
  const update = useCallback((next: (o: readonly string[]) => readonly string[]) => {
    setOpen((o) => {
      const n = next(o);
      if (n !== o) saveMenuExpanded(n);
      return n;
    });
  }, []);
  const toggle = useCallback(
    (id: string, expand: boolean) =>
      update((o) => (expand ? withOpen(o, [id]) : o.filter((i) => i !== id))),
    [update],
  );
  // The way to the active leaf is open on load and after every navigation.
  const activeId = active?.id;
  const activeAncestors = active?.ancestors;
  useEffect(() => {
    if (activeId && activeAncestors) update((o) => withOpen(o, activeAncestors));
  }, [activeId, activeAncestors, update]);

  const openSet = useMemo(() => new Set(open), [open]);

  return (
    <div
      role="tree"
      aria-label={t("APP", "NAV_MENU")}
      data-testid="menu-tree"
      data-source={source}
      className="menu"
    >
      {items.map((item) => (
        <MenuNode
          key={item.id}
          item={item}
          level={0}
          open={openSet}
          activeId={activeId}
          onToggle={toggle}
        />
      ))}
    </div>
  );
}

function MenuNode({
  item,
  level,
  open,
  activeId,
  onToggle,
}: {
  item: MenuItem;
  level: number;
  open: ReadonlySet<string>;
  activeId: string | undefined;
  onToggle: (id: string, expand: boolean) => void;
}) {
  const hasChildren = item.children.length > 0;
  const expanded = hasChildren && open.has(item.id);
  const isActive = item.id === activeId;
  const Icon = resolveIcon(item.icon);

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    const el = e.currentTarget;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      focusRow(el, e.key === "ArrowDown" ? 1 : -1);
    } else if (e.key === "ArrowRight") {
      if (!hasChildren) return;
      e.preventDefault();
      if (!expanded) onToggle(item.id, true);
      else focusRow(el, 1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      const parent = item.ancestors.at(-1);
      if (expanded) onToggle(item.id, false);
      else if (parent) focusRow(el, parent);
    }
  };

  const body = (
    <>
      {hasChildren ? (
        <ChevronRight
          aria-hidden
          data-testid="menu-chevron"
          className={cn("menu__chevron", expanded && "menu__chevron--open")}
        />
      ) : (
        <span aria-hidden className="menu__chevron" />
      )}
      {Icon ? (
        <Icon aria-hidden data-testid="menu-icon" data-icon={item.icon} className="menu__icon" />
      ) : null}
      <span className="menu__label">{item.label}</span>
    </>
  );
  const common = {
    role: "treeitem",
    "aria-level": level + 1,
    "aria-expanded": hasChildren ? expanded : undefined,
    "aria-selected": isActive,
    "data-menu-row": true,
    "data-id": item.id,
    "data-code": item.code,
    "data-active": isActive || undefined,
    "data-testid": testIdOf(item),
    onKeyDown,
    className: "menu__row",
    style: { paddingLeft: 6 + level * INDENT },
    title: item.label,
  } as const;

  return (
    <div>
      {item.url && !hasChildren ? (
        <Link to={item.url} aria-current={isActive ? "page" : undefined} {...common}>
          {body}
        </Link>
      ) : (
        <button type="button" {...common} onClick={() => onToggle(item.id, !expanded)}>
          {body}
        </button>
      )}
      {expanded ? (
        // biome-ignore lint/a11y/useSemanticElements: an ARIA tree group has no native element
        <div role="group" className="menu__group">
          {item.children.map((child) => (
            <MenuNode
              key={child.id}
              item={child}
              level={level + 1}
              open={open}
              activeId={activeId}
              onToggle={onToggle}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}
