import { isCondition } from "@jsudc/core";
import { UdcDataView, useI18n } from "@jsudc/react";
import { decodeFilterParam, PARAM } from "@jsudc/react/headless";
import { useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useSettings } from "../../connection.js";
import { useLive } from "../../live.js";
import { useThrottledRefresh } from "../../refresh.js";
import { Connected } from "../../shell/AppShell.js";
import { FeedStatus } from "../activity/Activity.js";
import {
  CHART_COLLECTION,
  CHART_REFRESH_MS,
  CHART_WINDOWS,
  type ChartWindow,
  msToNextMinute,
  windowOf,
  withWindow,
} from "./chart.js";

/** Whether `search`'s `?f=` still has a window (`minute gte …` at its top level). */
function hasWindow(search: string): boolean {
  const tree = decodeFilterParam(new URLSearchParams(search).get(PARAM.filter));
  if (!tree) return false;
  const top = isCondition(tree) ? [tree] : "and" in tree ? tree.and : [];
  return top.some((n) => isCondition(n) && n.field === "minute" && n.op === "gte");
}

/**
 * The Activity chart (`/examples/chart`): the `activity` UDC collection — the tenant's events
 * counted per minute and per event_type by the server — in `UdcDataView`, chart tab first.
 * The window selector writes the `minute` range into the view's `?f=`; the stream refetches.
 */
export function ChartPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const navigate = useNavigate();
  const location = useLocation();
  const picked = windowOf(location.search);

  // First visit (or a link from earlier): the window ending now goes into `?f=` before the
  // view mounts, so the first list is already narrowed (as the CPU monitor's instance_type).
  const [first] = useState(() => {
    const search = withWindow(location.search, picked, new Date());
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

  // The window slides: at every whole minute its start moves on, unless the visitor removed
  // the window's chip from the filter (then the filter is all theirs).
  const search = useRef(location.search);
  search.current = location.search;
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = new Date();
      if (hasWindow(search.current)) {
        navigate(
          { search: withWindow(search.current, windowOf(search.current), now) },
          {
            replace: true,
          },
        );
      }
      timer = setTimeout(tick, msToNextMinute(now));
    };
    timer = setTimeout(tick, msToNextMinute(new Date()));
    return () => clearTimeout(timer);
  }, [navigate]);

  const pick = (next: ChartWindow) =>
    navigate({ search: withWindow(location.search, next, new Date()) });

  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("CHART", "TITLE")}</h1>
          <span className="bar__sub">{t("CHART", "SUBTITLE")}</span>
        </div>
        <WindowSelector value={picked} onPick={pick} />
      </header>
      <Connected>
        {arrived.current ? <Activity key={`${connection.baseUrl}|${connection.apiKey}`} /> : null}
      </Connected>
    </div>
  );
}

function Activity() {
  const { t } = useI18n();
  const { connection } = useSettings();
  // Every event may change the current minute's buckets: refetch, at most once per 5 s.
  const refresh = useThrottledRefresh(CHART_COLLECTION, CHART_REFRESH_MS);
  const live = useLive({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    filter: {},
    onEvent: refresh,
  });
  return (
    <>
      <FeedStatus health={live.health} lastEventAt={live.lastEventAt} total={null} />
      <p className="chart__note" data-testid="chart-note">
        {t("CHART", "NOTE")}
      </p>
      <section className="view">
        <UdcDataView collection={CHART_COLLECTION} />
      </section>
    </>
  );
}

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
