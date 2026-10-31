import type { FilterNode, Row, SortKey } from "@jsudc/core";
import { type FeedItem, feedItem } from "../activity/feed.js";

/**
 * The Entity timeline's data: one instance's events (`ticket/T-17`, `user/ana`). The rows
 * are the `events` UDC collection narrowed to `instance_type` + `instance_id` — the same
 * events `GET /memento/entities/:instance_type/:instance_id/events` returns, read through
 * the protocol every list of the site uses.
 */
export const ENTITY_COLLECTION = "events";
/** The timeline: newest at the top, oldest at the bottom. */
export const TIMELINE_SORT: SortKey[] = [{ field: "occurred_at", dir: "desc" }];
/** Rows per page of the timeline. */
export const TIMELINE_PAGE_SIZE = 50;
/** How many of the latest events of a type the picker reads its instances from. */
export const RECENT_WINDOW = 200;
/** How many instances of a type the picker offers. */
export const RECENT_IDS = 12;
/** The distinct-type scan stops here, whatever the tenant has. */
export const MAX_TYPES = 50;

/** Where the timeline of an instance lives. */
export function entityPath(instanceType: string, instanceId: string): string {
  return `/examples/entity/${encodeURIComponent(instanceType)}/${encodeURIComponent(instanceId)}`;
}

/** The picker, opened on one type. */
export function pickerPath(instanceType?: string | null): string {
  return instanceType
    ? `/examples/entity?type=${encodeURIComponent(instanceType)}`
    : "/examples/entity";
}

/** The events of one instance (exact match on both fields). */
export function entityFilter(instanceType: string, instanceId: string): FilterNode {
  return {
    and: [
      { field: "instance_type", op: "eq", value: instanceType },
      { field: "instance_id", op: "eq", value: instanceId },
    ],
  };
}

/** What the WebSocket stream is narrowed to while a timeline is open. */
export function entityStreamFilter(
  instanceType: string,
  instanceId: string,
): { instance_type: string; instance_id: string } {
  return { instance_type: instanceType, instance_id: instanceId };
}

/**
 * The step of the distinct-type scan: the one event with the smallest `instance_type`
 * after `after` (the first one when `after` is null). UDC has no `distinct`, so the types
 * are walked one request each, in the collection's own order — exact, and a handful of
 * one-row requests for the few types a tenant has.
 */
export function nextTypeQuery(after: string | null): { filter: FilterNode; sort: SortKey[] } {
  return {
    filter:
      after === null
        ? { field: "instance_type", op: "is_not_null" }
        : { field: "instance_type", op: "gt", value: after },
    sort: [{ field: "instance_type", dir: "asc" }],
  };
}

/** One page of a UDC list, as the scan needs it. */
export type ListPage = (req: {
  filter: FilterNode;
  sort: SortKey[];
  limit: number;
}) => Promise<{ rows: readonly Row[] }>;

/** Every distinct `instance_type` of the collection, in its order (at most `max`). */
export async function scanInstanceTypes(list: ListPage, max = MAX_TYPES): Promise<string[]> {
  const types: string[] = [];
  let after: string | null = null;
  while (types.length < max) {
    const { rows } = await list({ ...nextTypeQuery(after), limit: 1 });
    const type = rows[0]?.instance_type;
    if (typeof type !== "string" || type === "" || type === after) break;
    types.push(type);
    after = type;
  }
  return types;
}

/** The type the picker opens on: the one asked for, `ticket` when there is one, else the first. */
export function defaultType(types: readonly string[], wanted: string | null): string | null {
  if (wanted && types.includes(wanted)) return wanted;
  if (types.includes("ticket")) return "ticket";
  return types[0] ?? null;
}

/** An instance the picker offers. */
export interface RecentInstance {
  id: string;
  /** When its latest event happened. */
  lastAt: string;
}

/**
 * The most recently active instances among `rows` (the latest events of one type, newest
 * first): each id once, in the order its latest event came, at most `max`.
 */
export function recentInstances(rows: readonly Row[], max = RECENT_IDS): RecentInstance[] {
  const seen = new Set<string>();
  const out: RecentInstance[] = [];
  for (const row of rows) {
    const id = row.instance_id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, lastAt: typeof row.occurred_at === "string" ? row.occurred_at : "" });
    if (out.length >= max) break;
  }
  return out;
}

/** The events of the timeline, newest first, each once (offset pages shift as events arrive). */
export function timelineItems(rows: readonly Row[]): FeedItem[] {
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const row of rows) {
    if (seen.has(row.__meta.id)) continue;
    seen.add(row.__meta.id);
    items.push(feedItem(row));
  }
  return items.sort((a, b) => b.at.localeCompare(a.at));
}

/** The line above the timeline. */
export interface TimelineSummary {
  /** ISO time of the oldest event (`firstAt` from its own query when not every page is loaded). */
  firstSeen: string | null;
  lastSeen: string | null;
  count: number;
  /** Distinct actors among the loaded events. */
  actors: number;
  /** Not every event is loaded: `actors` is a lower bound. */
  partial: boolean;
}

export function timelineSummary(
  items: readonly FeedItem[],
  total: number | null,
  firstAt: string | null = null,
): TimelineSummary {
  const count = total ?? items.length;
  const actors = new Set(items.map((i) => i.actor).filter((a): a is string => a !== null));
  return {
    firstSeen: firstAt ?? items.at(-1)?.at ?? null,
    lastSeen: items[0]?.at ?? null,
    count,
    actors: actors.size,
    partial: items.length < count,
  };
}

/**
 * The other instance an event names, as a link target: its actor is `user/<actor>` — unless
 * that is the instance whose timeline this is.
 */
export function actorInstance(
  actor: string | null,
  current: { instanceType: string; instanceId: string },
): { instanceType: string; instanceId: string } | null {
  if (!actor) return null;
  if (current.instanceType === "user" && current.instanceId === actor) return null;
  return { instanceType: "user", instanceId: actor };
}

/** Date and time of an entry, in the page's language. */
export function timelineTime(iso: string, intlLocale: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  return new Intl.DateTimeFormat(intlLocale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(at);
}
