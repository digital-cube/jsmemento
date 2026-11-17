import { type FeedItem, uniqueFeedItems } from "@jsmemento/ui-shell";
import type { FilterNode, Row, SortKey } from "@jsudc/core";

// The lines themselves (feedItem, feedTime) are @jsmemento/ui-shell's: the service site's key
// page draws the same feed over `api_key_events`.
export { type FeedItem, feedItem, feedTime } from "@jsmemento/ui-shell";

/** Where the feed's rows come from: every event of the tenant, as UDC serves them. */
export const FEED_COLLECTION = "events";
/** The CPU monitor's samples are not activity: everything else is. */
export const FEED_EXCLUDED_TYPE = "CPU_LOAD";
export const FEED_FILTER: FilterNode = {
  field: "event_type",
  op: "neq",
  value: FEED_EXCLUDED_TYPE,
};
/** Newest first. */
export const FEED_SORT: SortKey[] = [{ field: "occurred_at", dir: "desc" }];
/** Rows per page of the infinite list. */
export const FEED_PAGE_SIZE = 30;

/** The rows as feed lines, each event once and never a CPU sample. */
export function feedItems(rows: readonly Row[]): FeedItem[] {
  return uniqueFeedItems(rows, (row) => row.event_type === FEED_EXCLUDED_TYPE);
}
