import type { Row } from "@jsudc/core";

/** One line of an event feed (the `events`-shaped collections: `events`, `api_key_events`…). */
export interface FeedItem {
  id: string;
  /** ISO timestamp the event happened at. */
  at: string;
  eventType: string;
  /** `ticket/T-17` */
  instance: string;
  /** `ticket`, or null when the event names no type. */
  instanceType: string | null;
  /** `T-17`, or null. */
  instanceId: string | null;
  actor: string | null;
  /** The sentence memento rendered for the page's language. */
  text: string;
}

const str = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null);

/** A row of an event collection as a feed line. */
export function feedItem(row: Row): FeedItem {
  const type = str(row.instance_type);
  const id = str(row.instance_id);
  return {
    id: row.__meta.id,
    at: str(row.occurred_at) ?? "",
    eventType: str(row.event_type) ?? "",
    instance: type && id ? `${type}/${id}` : (id ?? type ?? ""),
    instanceType: type,
    instanceId: id,
    actor: str(row.actor_id),
    text: str(row.rendered) ?? "",
  };
}

/**
 * The rows as feed lines, each event once (offset pages shift while new events arrive, so the
 * next page can repeat the last row of the one before it), without the rows `skip` refuses.
 */
export function uniqueFeedItems(rows: readonly Row[], skip?: (row: Row) => boolean): FeedItem[] {
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const row of rows) {
    if (seen.has(row.__meta.id) || skip?.(row)) continue;
    seen.add(row.__meta.id);
    items.push(feedItem(row));
  }
  return items;
}

/**
 * The time of a line in the page's language: `14:05:09` today, `31. 10. 14:05` (sr) or
 * `Oct 31, 14:05` (en) before.
 */
export function feedTime(iso: string, intlLocale: string, now: Date = new Date()): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "";
  const today = at.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    intlLocale,
    today
      ? { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false },
  ).format(at);
}
