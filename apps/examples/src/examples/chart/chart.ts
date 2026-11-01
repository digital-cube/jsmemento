import { type Condition, type FilterNode, isCondition } from "@jsudc/core";
import { decodeFilterParam, encodeFilterParam, PARAM } from "@jsudc/react/headless";

/** The UDC collection the page draws: events per minute and per event_type. */
export const CHART_COLLECTION = "activity";

/**
 * At most one refetch per 5 s: a bucket changes once a minute, so the CPU monitor's 250 ms
 * would only make the server count the same minutes again.
 */
export const CHART_REFRESH_MS = 5000;

/** The window selector's choices, in its order. */
export const CHART_WINDOWS = [
  { key: "15m", minutes: 15 },
  { key: "1h", minutes: 60 },
  { key: "6h", minutes: 360 },
  { key: "24h", minutes: 1440 },
] as const;
export type ChartWindow = (typeof CHART_WINDOWS)[number]["key"];
export const DEFAULT_WINDOW: ChartWindow = "1h";

/** The page's own query parameter: which window is picked (`?w=6h`). */
export const WINDOW_PARAM = "w";

const MINUTE_MS = 60_000;

export function isChartWindow(value: unknown): value is ChartWindow {
  return CHART_WINDOWS.some((w) => w.key === value);
}

export function windowMinutes(window: ChartWindow): number {
  return CHART_WINDOWS.find((w) => w.key === window)?.minutes ?? 60;
}

/** The window of `search` (`?w=`), the default when it has none or an unknown one. */
export function windowOf(search: string): ChartWindow {
  const value = new URLSearchParams(search).get(WINDOW_PARAM);
  return isChartWindow(value) ? value : DEFAULT_WINDOW;
}

/**
 * The first minute of `window` ending at `now`: the last N whole minutes, the current one
 * included (`1h` at 10:05:30 starts at 09:06), as the server's default window counts them.
 */
export function windowStart(window: ChartWindow, now: Date): string {
  const minute = Math.floor(now.getTime() / MINUTE_MS);
  return new Date((minute - (windowMinutes(window) - 1)) * MINUTE_MS).toISOString();
}

/** The condition of a window: `minute gte <start>`. */
export function windowCondition(window: ChartWindow, now: Date): Condition {
  return { field: "minute", op: "gte", value: windowStart(window, now) };
}

const isWindowCondition = (node: FilterNode): boolean =>
  isCondition(node) && node.field === "minute" && node.op === "gte";

/**
 * `tree` with its window replaced: a top-level `minute gte` condition is the window (the one
 * this page wrote), every other condition — the chips the visitor added in the data view —
 * is kept as it is.
 */
export function withWindowCondition(tree: FilterNode | null, condition: Condition): FilterNode {
  if (!tree || isWindowCondition(tree)) return condition;
  if (!isCondition(tree) && "and" in tree) {
    const rest = tree.and.filter((n) => !isWindowCondition(n));
    return rest.length ? { and: [...rest, condition] } : condition;
  }
  return { and: [tree, condition] };
}

/**
 * `search` with `window` picked: `?w=` set and the data view's `?f=` filter carrying the
 * window's `minute` range (its page reset), so `<UdcDataView>` reads it like any filter —
 * the chip shows in its filter bar. Everything else in the query string is kept.
 */
export function withWindow(search: string, window: ChartWindow, now: Date): string {
  const params = new URLSearchParams(search);
  const tree = withWindowCondition(
    decodeFilterParam(params.get(PARAM.filter)),
    windowCondition(window, now),
  );
  params.set(PARAM.filter, encodeFilterParam(tree) ?? "");
  params.set(WINDOW_PARAM, window);
  params.delete(PARAM.page);
  return `?${params.toString()}`;
}

/** Milliseconds until the next whole minute after `now` (when the window slides on). */
export function msToNextMinute(now: Date): number {
  return MINUTE_MS - (now.getTime() % MINUTE_MS);
}
