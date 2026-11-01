// The window helpers (`?w=`, the `minute gte` condition in `?f=`) are @memento/ui-shell's:
// the service site's key page draws the same chart over `api_key_activity`.
export {
  CHART_WINDOWS,
  type ChartWindow,
  DEFAULT_WINDOW,
  isChartWindow,
  msToNextMinute,
  WINDOW_PARAM,
  windowCondition,
  windowMinutes,
  windowOf,
  windowStart,
  withWindow,
  withWindowCondition,
} from "@memento/ui-shell";

/** The UDC collection the page draws: events per minute and per event_type. */
export const CHART_COLLECTION = "activity";

/**
 * At most one refetch per 5 s: a bucket changes once a minute, so the CPU monitor's 250 ms
 * would only make the server count the same minutes again.
 */
export const CHART_REFRESH_MS = 5000;
