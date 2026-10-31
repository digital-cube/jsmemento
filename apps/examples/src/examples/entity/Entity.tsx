import { intlLocaleOf, udcKeys, useI18n, useUdcClient, useUdcCollection } from "@jsudc/react";
import { Spinner } from "@jsudc/react/ui";
import { hue, initials } from "@memento/react";
import { useQuery } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { useSettings } from "../../connection.js";
import { useLive } from "../../live.js";
import { useThrottledRefresh } from "../../refresh.js";
import { Connected } from "../../shell/AppShell.js";
import { FeedStatus, MoreRows, SIMULATOR_COMMAND } from "../activity/Activity.js";
import type { FeedItem } from "../activity/feed.js";
import {
  actorInstance,
  defaultType,
  ENTITY_COLLECTION,
  entityFilter,
  entityPath,
  entityStreamFilter,
  pickerPath,
  RECENT_WINDOW,
  recentInstances,
  scanInstanceTypes,
  TIMELINE_PAGE_SIZE,
  TIMELINE_SORT,
  timelineItems,
  timelineSummary,
  timelineTime,
} from "./entity.js";

/** The query key of the picker's type scan: under the collection's lists, so it refreshes with them. */
export const INSTANCE_TYPES_KEY = [...udcKeys.lists(ENTITY_COLLECTION), "instance-types"] as const;

// --- the picker: /examples/entity ---------------------------------------------------------

/**
 * `/examples/entity`: which instance? The types the tenant has (walked from the `events`
 * collection), the most recently active instances of the chosen one with their event
 * counts, and a form for an id typed by hand.
 */
export function EntityPickerPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("ENTITY", "TITLE")}</h1>
          <span className="bar__sub">{t("ENTITY", "SUBTITLE")}</span>
        </div>
      </header>
      <Connected>
        <Picker key={`${connection.baseUrl}|${connection.apiKey}`} />
      </Connected>
    </div>
  );
}

function Picker() {
  const { t } = useI18n();
  const client = useUdcClient();
  const [params, setParams] = useSearchParams();
  const types = useQuery({
    queryKey: INSTANCE_TYPES_KEY,
    queryFn: () =>
      scanInstanceTypes(({ filter, sort, limit }) =>
        client.list({ collection: ENTITY_COLLECTION, filter, sort, page: { limit } }),
      ),
  });
  const all = types.data ?? [];
  const chosen = defaultType(all, params.get("type"));

  return (
    <section className="entity" data-testid="entity-picker">
      {types.error ? (
        <p className="feed__error" role="alert">
          {types.error.message}
        </p>
      ) : types.isLoading ? (
        <div className="page__center">
          <Spinner />
        </div>
      ) : all.length === 0 ? (
        <div className="feed__empty" data-testid="entity-none">
          <p>{t("ENTITY", "NONE")}</p>
          <code>{SIMULATOR_COMMAND}</code>
        </div>
      ) : (
        <>
          <h2 className="entity__heading">{t("ENTITY", "TYPES")}</h2>
          <div className="entity__types" role="tablist" data-testid="entity-types">
            {all.map((type) => (
              <button
                key={type}
                type="button"
                role="tab"
                aria-selected={type === chosen}
                className={type === chosen ? "entity__type is-on" : "entity__type"}
                onClick={() => setParams({ type }, { replace: true })}
              >
                {type}
              </button>
            ))}
          </div>
          {chosen ? <RecentIds key={chosen} instanceType={chosen} /> : null}
        </>
      )}
      <ById types={all} instanceType={chosen} />
    </section>
  );
}

/** The latest instances of one type, each a link to its timeline. */
function RecentIds({ instanceType }: { instanceType: string }) {
  const { t, locale } = useI18n();
  const recent = useUdcCollection({
    collection: ENTITY_COLLECTION,
    filter: { field: "instance_type", op: "eq", value: instanceType },
    sort: TIMELINE_SORT,
    mode: "pages",
    pageLimit: RECENT_WINDOW,
  });
  const ids = recentInstances(recent.rows);
  const intl = intlLocaleOf(locale);
  if (recent.isLoading) return <Spinner />;
  return (
    <>
      <h2 className="entity__heading">{t("ENTITY", "RECENT", { type: instanceType })}</h2>
      <ul className="entity__ids" data-testid="entity-ids">
        {ids.map(({ id, lastAt }) => (
          <li key={id}>
            <Link
              className="entity__id"
              to={entityPath(instanceType, id)}
              data-testid="entity-id"
              data-id={id}
            >
              <span className="entity__name">
                {instanceType}/{id}
              </span>
              <span className="entity__when num">{timelineTime(lastAt, intl)}</span>
              <EventCount instanceType={instanceType} instanceId={id} />
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

/** How many events an instance has: the `total` of a one-row list of its events. */
function EventCount({ instanceType, instanceId }: { instanceType: string; instanceId: string }) {
  const { t } = useI18n();
  const count = useUdcCollection({
    collection: ENTITY_COLLECTION,
    filter: entityFilter(instanceType, instanceId),
    sort: TIMELINE_SORT,
    mode: "pages",
    pageLimit: 1,
  });
  return (
    <span className="entity__count" data-testid="entity-count">
      {count.total === null
        ? "…"
        : t("ENTITY", count.total === 1 ? "COUNT_ONE" : "COUNT", { count: count.total })}
    </span>
  );
}

/** Any instance by hand: a type (the tenant's offered, any accepted) and an id. */
function ById({ types, instanceType }: { types: readonly string[]; instanceType: string | null }) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const [type, setType] = useState(instanceType ?? "");
  const [id, setId] = useState("");
  useEffect(() => {
    if (instanceType) setType(instanceType);
  }, [instanceType]);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (type.trim() && id.trim()) void navigate(entityPath(type.trim(), id.trim()));
  };
  return (
    <form className="entity__form" onSubmit={submit} data-testid="entity-form">
      <h2 className="entity__heading">{t("ENTITY", "BY_HAND")}</h2>
      <div className="entity__fields">
        <input
          aria-label={t("ENTITY", "TYPE")}
          placeholder="ticket"
          list="entity-types"
          value={type}
          onChange={(e) => setType(e.target.value)}
        />
        <datalist id="entity-types">
          {types.map((x) => (
            <option key={x} value={x} />
          ))}
        </datalist>
        <span aria-hidden="true">/</span>
        <input
          aria-label={t("ENTITY", "ID")}
          placeholder="T-17"
          value={id}
          onChange={(e) => setId(e.target.value)}
        />
        <button type="submit" className="btn btn--primary" disabled={!type.trim() || !id.trim()}>
          {t("ENTITY", "OPEN")}
        </button>
      </div>
    </form>
  );
}

// --- the timeline: /examples/entity/:instance_type/:instance_id ---------------------------

/**
 * `/examples/entity/:instance_type/:instance_id`: everything that happened to one instance,
 * newest at the top, live.
 */
export function EntityTimelinePage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const { instance_type: instanceType = "", instance_id: instanceId = "" } = useParams();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1 data-testid="entity-title">
            {instanceType}/{instanceId}
          </h1>
          <span className="bar__sub">{t("ENTITY", "TIMELINE_SUB")}</span>
        </div>
        <Link className="entity__back" to={pickerPath(instanceType)}>
          {t("ENTITY", "ALL")}
        </Link>
      </header>
      <Connected>
        <Timeline
          key={`${connection.baseUrl}|${connection.apiKey}|${instanceType}|${instanceId}`}
          instanceType={instanceType}
          instanceId={instanceId}
        />
      </Connected>
    </div>
  );
}

function Timeline({ instanceType, instanceId }: { instanceType: string; instanceId: string }) {
  const { t, locale } = useI18n();
  const { connection } = useSettings();
  const refresh = useThrottledRefresh(ENTITY_COLLECTION);
  const live = useLive({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    filter: entityStreamFilter(instanceType, instanceId),
    onEvent: refresh,
  });
  const filter = entityFilter(instanceType, instanceId);
  const list = useUdcCollection({
    collection: ENTITY_COLLECTION,
    filter,
    sort: TIMELINE_SORT,
    mode: "infinite",
    pageLimit: TIMELINE_PAGE_SIZE,
    capabilities: { paging: ["offset"] },
  });
  // More pages than loaded: the first event comes from its own one-row list.
  const first = useUdcCollection({
    collection: ENTITY_COLLECTION,
    filter,
    sort: [{ field: "occurred_at", dir: "asc" }],
    mode: "pages",
    pageLimit: 1,
    enabled: list.hasNextPage,
  });
  const firstAt = list.hasNextPage ? ((first.rows[0]?.occurred_at as string) ?? null) : null;
  const items = timelineItems(list.rows);
  const summary = timelineSummary(items, list.total, firstAt);
  const intl = intlLocaleOf(locale);
  const current = { instanceType, instanceId };

  const known = useRef<Set<string> | null>(null);
  const fresh = new Set<string>();
  if (known.current) for (const i of items) if (!known.current.has(i.id)) fresh.add(i.id);
  useEffect(() => {
    if (items.length > 0) known.current = new Set(items.map((i) => i.id));
  });

  return (
    <>
      <FeedStatus health={live.health} lastEventAt={live.lastEventAt} total={null} />
      <section className="feed" aria-busy={list.isFetching}>
        {list.error ? (
          <p className="feed__error" role="alert">
            {list.error.message}
          </p>
        ) : list.isLoading ? (
          <div className="page__center">
            <Spinner />
          </div>
        ) : items.length === 0 ? (
          <div className="feed__empty" data-testid="entity-empty">
            <p>{t("ENTITY", "EMPTY", { instance: `${instanceType}/${instanceId}` })}</p>
            <Link className="planned__back" to={pickerPath(instanceType)}>
              {t("ENTITY", "PICK")}
            </Link>
          </div>
        ) : (
          <>
            <p className="entity__summary" data-testid="entity-summary">
              {t("ENTITY", "SUMMARY", {
                first: summary.firstSeen ? timelineTime(summary.firstSeen, intl) : "—",
                last: summary.lastSeen ? timelineTime(summary.lastSeen, intl) : "—",
                count: summary.count,
                actors: `${summary.actors}${summary.partial ? "+" : ""}`,
              })}
            </p>
            <ol className="timeline" data-testid="timeline">
              {items.map((item) => (
                <Entry
                  key={item.id}
                  item={item}
                  intl={intl}
                  fresh={fresh.has(item.id)}
                  current={current}
                />
              ))}
            </ol>
          </>
        )}
        {list.hasNextPage ? (
          <MoreRows loading={list.isFetchingNextPage} onMore={list.fetchNextPage}>
            {t("ENTITY", "MORE")}
          </MoreRows>
        ) : null}
      </section>
    </>
  );
}

function Entry({
  item,
  intl,
  fresh,
  current,
}: {
  item: FeedItem;
  intl: string;
  fresh: boolean;
  current: { instanceType: string; instanceId: string };
}) {
  const actor = item.actor ?? "—";
  const other = actorInstance(item.actor, current);
  return (
    <li className={fresh ? "timeline__entry is-new" : "timeline__entry"} data-testid="entry">
      <span
        className="feed__avatar timeline__dot"
        aria-hidden="true"
        style={{ "--feed-hue": hue(actor) } as CSSProperties}
      >
        {initials(actor)}
      </span>
      <div className="feed__body">
        <div className="feed__meta timeline__head">
          <time className="num" dateTime={item.at}>
            {timelineTime(item.at, intl)}
          </time>
          {other ? (
            <Link
              className="feed__actor feed__chip--link"
              to={entityPath(other.instanceType, other.instanceId)}
              data-testid="entry-actor"
            >
              {other.instanceType}/{other.instanceId}
            </Link>
          ) : (
            <span className="feed__actor">{actor}</span>
          )}
          <span className="feed__type">{item.eventType}</span>
        </div>
        <p className="feed__text" data-testid="entry-text">
          {item.text}
        </p>
      </div>
    </li>
  );
}
