import { isCondition } from "@jsudc/core";
import { useI18n } from "@jsudc/react";
import { decodeFilterParam, PARAM } from "@jsudc/react/headless";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { CHART_WINDOWS, type ChartWindow, msToNextMinute, windowOf, withWindow } from "./chart.js";

/** Whether `search`'s `?f=` still has a window (`minute gte …` at its top level). */
export function hasWindow(search: string): boolean {
  const tree = decodeFilterParam(new URLSearchParams(search).get(PARAM.filter));
  if (!tree) return false;
  const top = isCondition(tree) ? [tree] : "and" in tree ? tree.and : [];
  return top.some((n) => isCondition(n) && n.field === "minute" && n.op === "gte");
}

export interface SlidingWindow {
  /** The window of `?w=` (the default when it names none). */
  picked: ChartWindow;
  /** Picks another window: `?w=` and the `minute` condition of `?f=`. */
  pick: (window: ChartWindow) => void;
  /**
   * `false` until the URL carries the window: mount the data view only then, so its first
   * list is already narrowed.
   */
  ready: boolean;
}

/**
 * The window of a per-minute chart in the URL. On the first visit the window ending now (and
 * `initial`'s extra conditions, e.g. the key page's `api_key`) goes into `?f=` before the view
 * mounts; at every whole minute its start moves on, unless the visitor removed the window's
 * chip from the filter (then the filter is all theirs).
 */
export function useSlidingWindow(initial?: (search: string) => string): SlidingWindow {
  const navigate = useNavigate();
  const location = useLocation();
  const picked = windowOf(location.search);

  const [first] = useState(() => {
    const start = initial ? initial(location.search) : location.search;
    const search = withWindow(start, picked, new Date());
    return search === location.search ? null : search;
  });
  const arrived = useRef(first === null);
  if (!arrived.current && location.search === first) arrived.current = true;
  const asked = useRef(false);
  useEffect(() => {
    if (first === null || asked.current) return;
    asked.current = true;
    navigate({ search: first }, { replace: true });
  }, [first, navigate]);

  const search = useRef(location.search);
  search.current = location.search;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = new Date();
      if (hasWindow(search.current)) {
        navigate(
          { search: withWindow(search.current, windowOf(search.current), now) },
          { replace: true },
        );
      }
      timer = setTimeout(tick, msToNextMinute(now));
    };
    timer = setTimeout(tick, msToNextMinute(new Date()));
    return () => clearTimeout(timer);
  }, [navigate]);

  return {
    picked,
    pick: (next) => navigate({ search: withWindow(location.search, next, new Date()) }),
    ready: arrived.current,
  };
}

/** 15 min / 1 h / 6 h / 24 h: the `CHART.WINDOW*` strings of the site's messages. */
export function WindowSelector({
  value,
  onPick,
}: {
  value: ChartWindow;
  onPick: (window: ChartWindow) => void;
}) {
  const { t } = useI18n();
  return (
    <fieldset className="window" data-testid="chart-window">
      <legend>{t("CHART", "WINDOW")}</legend>
      {CHART_WINDOWS.map(({ key }) => (
        <button
          key={key}
          type="button"
          className="window__option"
          aria-pressed={key === value}
          data-testid={`window-${key}`}
          onClick={() => onPick(key)}
        >
          {t("CHART", `WINDOW_${key.toUpperCase()}`)}
        </button>
      ))}
    </fieldset>
  );
}
