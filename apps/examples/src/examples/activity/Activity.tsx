import { intlLocaleOf, useI18n, useUdcCollection } from "@jsudc/react";
import { Spinner } from "@jsudc/react/ui";
import { hue, initials } from "@memento/react";
import { type CSSProperties, useEffect, useRef } from "react";
import { Link } from "react-router";
import { useSettings } from "../../connection.js";
import { type Health, useLive } from "../../live.js";
import { useThrottledRefresh } from "../../refresh.js";
import { Connected } from "../../shell/AppShell.js";
import { entityPath } from "../entity/entity.js";
import {
  FEED_COLLECTION,
  FEED_EXCLUDED_TYPE,
  FEED_FILTER,
  FEED_PAGE_SIZE,
  FEED_SORT,
  type FeedItem,
  feedItems,
  feedTime,
} from "./feed.js";

/** The compose command that starts the story the feed shows. */
export const SIMULATOR_COMMAND =
  "docker compose -f docker-compose.yaml --profile demo up -d simulator";

/**
 * The Activity feed (`/examples/activity`): the tenant's events as sentences, newest first.
 * `memento simulate` pushes a ticket desk; the `events` UDC collection serves the rows,
 * rendered by memento in the header's language; the WebSocket stream says when to refetch.
 */
export function ActivityPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("ACTIVITY", "TITLE")}</h1>
          <span className="bar__sub">{t("ACTIVITY", "SUBTITLE")}</span>
        </div>
      </header>
      <Connected>
        <Feed key={`${connection.baseUrl}|${connection.apiKey}`} />
      </Connected>
    </div>
  );
}

function Feed() {
  const { t, locale } = useI18n();
  const { connection } = useSettings();
  const refresh = useThrottledRefresh(FEED_COLLECTION);
  const live = useLive({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    // The stream cannot exclude a type: every event arrives, CPU samples are not news here.
    filter: {},
    onEvent: (event) => {
      if (event.event_type !== FEED_EXCLUDED_TYPE) refresh();
    },
  });
  const feed = useUdcCollection({
    collection: FEED_COLLECTION,
    filter: FEED_FILTER,
    sort: FEED_SORT,
    mode: "infinite",
    pageLimit: FEED_PAGE_SIZE,
    capabilities: { paging: ["offset"] },
  });
  const items = feedItems(feed.rows);
  const intl = intlLocaleOf(locale);

  // Lines that were not there on the last render (a new event) fade in.
  const known = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (known.current) for (const i of items) if (!known.current.has(i.id)) fresh.add(i.id);
  useEffect(() => {
    if (items.length > 0) known.current = new Set(items.map((i) => i.id));
  });

  return (
    <>
      <FeedStatus health={live.health} lastEventAt={live.lastEventAt} total={feed.total} />
      <section className="feed" aria-busy={feed.isFetching}>
        {feed.error ? (
          <p className="feed__error" role="alert">
            {feed.error.message}
          </p>
        ) : feed.isLoading ? (
          <div className="page__center">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <EmptyFeed />
        ) : (
          <ol className="feed__list" data-testid="feed">
            {items.map((item) => (
              <FeedLine key={item.id} item={item} intl={intl} fresh={fresh.has(item.id)} />
            ))}
          </ol>
        )}
        {feed.hasNextPage ? (
          <MoreRows loading={feed.isFetchingNextPage} onMore={feed.fetchNextPage}>
            {t("ACTIVITY", "MORE")}
          </MoreRows>
        ) : null}
      </section>
    </>
  );
}

function FeedLine({ item, intl, fresh }: { item: FeedItem; intl: string; fresh: boolean }) {
  const actor = item.actor ?? "—";
  return (
    <li className={fresh ? "feed__row is-new" : "feed__row"} data-testid="feed-row">
      <time className="feed__time num" dateTime={item.at}>
        {feedTime(item.at, intl)}
      </time>
      <span
        className="feed__avatar"
        aria-hidden="true"
        style={{ "--feed-hue": hue(actor) } as CSSProperties}
      >
        {initials(actor)}
      </span>
      <div className="feed__body">
        <p className="feed__text" data-testid="feed-text">
          {item.text}
        </p>
        <div className="feed__meta">
          <span className="feed__actor">{actor}</span>
          <InstanceChip item={item} />
          <span className="feed__type">{item.eventType}</span>
        </div>
      </div>
    </li>
  );
}

/** The instance of a line: a link to its timeline when the event names both type and id. */
function InstanceChip({ item }: { item: FeedItem }) {
  if (!item.instance) return null;
  if (!item.instanceType || !item.instanceId) {
    return <span className="feed__chip">{item.instance}</span>;
  }
  return (
    <Link
      className="feed__chip feed__chip--link"
      to={entityPath(item.instanceType, item.instanceId)}
      data-testid="feed-instance"
    >
      {item.instance}
    </Link>
  );
}

/** The next page: as soon as the end of the list scrolls into view, or on a click. */
export function MoreRows({
  loading,
  onMore,
  children,
}: {
  loading: boolean;
  onMore: () => void;
  children: string;
}) {
  const ref = useRef<HTMLButtonElement>(null);
  const more = useRef(onMore);
  more.current = onMore;
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) more.current();
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <button ref={ref} type="button" className="feed__more" disabled={loading} onClick={onMore}>
      {loading ? <Spinner /> : children}
    </button>
  );
}

function EmptyFeed() {
  const { t } = useI18n();
  return (
    <div className="feed__empty" data-testid="feed-empty">
      <p>{t("ACTIVITY", "EMPTY")}</p>
      <code>{SIMULATOR_COMMAND}</code>
    </div>
  );
}

export function FeedStatus({
  health,
  lastEventAt,
  total,
}: {
  health: Health;
  lastEventAt: number | null;
  total: number | null;
}) {
  const { t, locale } = useI18n();
  const last = lastEventAt
    ? new Date(lastEventAt).toLocaleTimeString(intlLocaleOf(locale), { hour12: false })
    : "—";
  const label = { live: "LIVE", connecting: "CONNECTING", offline: "OFFLINE" }[health];
  return (
    <div className="status" role="status" aria-live="polite">
      <span className="health" data-health={health}>
        <span className="health__dot" aria-hidden="true" />
        {t("ACTIVITY", label)}
      </span>
      <span className="status__item">
        {t("ACTIVITY", "LAST_EVENT")} <strong className="num">{last}</strong>
      </span>
      {total !== null ? (
        <span className="status__item">
          <strong className="num">{total}</strong> {t("ACTIVITY", "EVENTS")}
        </span>
      ) : null}
    </div>
  );
}
