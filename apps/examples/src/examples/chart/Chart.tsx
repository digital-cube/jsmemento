import { UdcDataView, useI18n } from "@jsudc/react";
import { useLive, useSlidingWindow, useThrottledRefresh, WindowSelector } from "@memento/ui-shell";
import { useSettings } from "../../connection.js";
import { Connected } from "../../shell/AppShell.js";
import { FeedStatus } from "../activity/Activity.js";
import { CHART_COLLECTION, CHART_REFRESH_MS } from "./chart.js";

/**
 * The Activity chart (`/examples/chart`): the `activity` UDC collection — the tenant's events
 * counted per minute and per event_type by the server — in `UdcDataView`, chart tab first.
 * The window selector writes the `minute` range into the view's `?f=`; the stream refetches.
 */
export function ChartPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const slide = useSlidingWindow();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("CHART", "TITLE")}</h1>
          <span className="bar__sub">{t("CHART", "SUBTITLE")}</span>
        </div>
        <WindowSelector value={slide.picked} onPick={slide.pick} />
      </header>
      <Connected>
        {slide.ready ? <Activity key={`${connection.baseUrl}|${connection.apiKey}`} /> : null}
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

export { WindowSelector };
