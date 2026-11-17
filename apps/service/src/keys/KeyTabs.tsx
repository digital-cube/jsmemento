import { hue, initials } from "@jsmemento/react";
import {
  type FeedItem,
  feedTime,
  MoreRows,
  uniqueFeedItems,
  usePolling,
  useSlidingWindow,
  WindowSelector,
} from "@jsmemento/ui-shell";
import type { Condition } from "@jsudc/core";
import { intlLocaleOf, UdcDataView, udcKeys, useI18n, useUdcCollection } from "@jsudc/react";
import { Button, Spinner, useToast } from "@jsudc/react/ui";
import { useQueryClient } from "@tanstack/react-query";
import { type CSSProperties, type FormEvent, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { API_BASE, api } from "../lib/api.js";
import { Banner, Field } from "../lib/ui.js";
import { useUrlCondition, withCondition } from "../lib/urlFilter.js";
import { serverErrors } from "../pages/forms.js";
import { useSignedIn } from "../session.js";
import type { KeyRow } from "./keys.js";
import { KEYS_COLLECTION, POLL_MS } from "./useKey.js";

export const ACTIVITY_COLLECTION = "api_key_activity";
export const EVENTS_COLLECTION = "api_key_events";
export const HISTORY_COLLECTION = "api_key_history";
export const USAGE_COLLECTION = "api_key_usage";

/** `api_key eq <prefix>`: how `api_key_activity`, `api_key_events` and `api_key_usage` name a key. */
export const byKey = (prefix: string): Condition => ({ field: "api_key", op: "eq", value: prefix });

/**
 * Activity: the examples' chart over `api_key_activity` — this key's events per minute and
 * type — with the window selector (15 min / 1 h / 6 h / 24 h), polled.
 */
export function ActivityTab({ apiKey }: { apiKey: KeyRow }) {
  const condition = byKey(apiKey.prefix);
  const slide = useSlidingWindow((search) => withCondition(search, condition));
  usePolling([ACTIVITY_COLLECTION], POLL_MS);
  return (
    <section data-testid="tab-activity-panel">
      <div className="tabbar">
        <WindowSelector value={slide.picked} onPick={slide.pick} />
      </div>
      <section className="view">
        {slide.ready ? <UdcDataView collection={ACTIVITY_COLLECTION} /> : null}
      </section>
    </section>
  );
}

/**
 * Events: the examples' feed over `api_key_events` — what this key wrote, newest on top,
 * "older" paging, polled. The key's own lifecycle (`instance_type = api_key`) was written by
 * the signed-in user, not the key: "Key history" shows it (`api_key_history`, `?view=history`).
 */
export function EventsTab({ apiKey }: { apiKey: KeyRow }) {
  const { t, locale } = useI18n();
  const [params, setParams] = useSearchParams();
  const history = params.get("view") === "history";
  const feed = useUdcCollection({
    collection: history ? HISTORY_COLLECTION : EVENTS_COLLECTION,
    filter: history
      ? { field: "instance_id", op: "eq", value: apiKey.prefix }
      : byKey(apiKey.prefix),
    sort: [{ field: "occurred_at", dir: "desc" }],
    mode: "infinite",
    pageLimit: 30,
    capabilities: { paging: ["offset"] },
    refetchInterval: POLL_MS,
  });
  const items = uniqueFeedItems(feed.rows);
  const intl = intlLocaleOf(locale);
  const show = (next: boolean) => setParams(next ? { view: "history" } : {}, { replace: true });
  return (
    <section data-testid="tab-events-panel" data-view={history ? "history" : "events"}>
      <div className="tabbar">
        <fieldset className="window">
          <button
            type="button"
            className="window__option"
            aria-pressed={!history}
            data-testid="events-written"
            onClick={() => show(false)}
          >
            {t("KEY", "EVENTS_WRITTEN")}
          </button>
          <button
            type="button"
            className="window__option"
            aria-pressed={history}
            data-testid="key-history"
            onClick={() => show(true)}
          >
            {t("KEY", "HISTORY")}
          </button>
        </fieldset>
        {history ? <span className="bar__sub">{t("KEY", "HISTORY_SUB")}</span> : null}
        {feed.total !== null ? <span className="bar__count num">{feed.total}</span> : null}
      </div>
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
          history ? (
            <div className="feed__empty" data-testid="feed-empty">
              <p>{t("KEY", "HISTORY_EMPTY")}</p>
            </div>
          ) : (
            <EmptyEvents prefix={apiKey.prefix} />
          )
        ) : (
          <ol className="feed__list" data-testid="feed">
            {items.map((item) => (
              <FeedLine key={item.id} item={item} intl={intl} />
            ))}
          </ol>
        )}
        {feed.hasNextPage ? (
          <MoreRows loading={feed.isFetchingNextPage} onMore={feed.fetchNextPage}>
            {t("KEY", "OLDER")}
          </MoreRows>
        ) : null}
      </section>
    </section>
  );
}

function FeedLine({ item, intl }: { item: FeedItem; intl: string }) {
  const actor = item.actor ?? "—";
  return (
    <li className="feed__row" data-testid="feed-row">
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
          {item.text || item.eventType}
        </p>
        <div className="feed__meta">
          <span className="feed__actor">{actor}</span>
          {item.instance ? <span className="feed__chip">{item.instance}</span> : null}
          <span className="feed__type">{item.eventType}</span>
        </div>
      </div>
    </li>
  );
}

/** No event yet: how to push one with this key. */
function EmptyEvents({ prefix }: { prefix: string }) {
  const { t } = useI18n();
  const url = `${window.location.origin}${API_BASE}/events`;
  const curl = [
    `curl -X POST ${url} \\`,
    `  -H "Authorization: Bearer mk_${prefix}_…" -H "Content-Type: application/json" \\`,
    `  -d '{"event_type":"NOTE","instance_type":"server","instance_id":"web-1","payload":{"text":"hello"}}'`,
  ].join("\n");
  return (
    <div className="feed__empty" data-testid="feed-empty">
      <p>{t("KEY", "EVENTS_EMPTY")}</p>
      <pre className="mono">{curl}</pre>
    </div>
  );
}

/** Usage: `api_key_usage` for this key — one row per hour, newest first, the five counters. */
export function UsageTab({ apiKey }: { apiKey: KeyRow }) {
  const ready = useUrlCondition(byKey(apiKey.prefix));
  usePolling([USAGE_COLLECTION], POLL_MS);
  return (
    <section className="view" data-testid="tab-usage-panel">
      {ready ? <UdcDataView collection={USAGE_COLLECTION} /> : null}
    </section>
  );
}

/** Settings: the name and the daily limit (`PATCH /keys/:id`), up to the server's ceiling. */
export function SettingsTab({ apiKey }: { apiKey: KeyRow }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const { limits } = useSignedIn();
  const queryClient = useQueryClient();
  const [name, setName] = useState(apiKey.name);
  const [limit, setLimit] = useState(apiKey.daily_limit === null ? "" : String(apiKey.daily_limit));
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const max = limits.max_daily_limit;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const text = limit.trim();
    const value = text === "" ? null : Number(text);
    if (!name.trim()) return setErrors({ name: t("AUTH", "REQUIRED") });
    if (value !== null && (!Number.isInteger(value) || value < 1)) {
      return setErrors({ daily_limit: t("NEW_KEY", "LIMIT_POSITIVE") });
    }
    if (value !== null && max !== null && value > max) {
      return setErrors({ daily_limit: t("NEW_KEY", "LIMIT_RANGE", { max }) });
    }
    setErrors({});
    setBusy(true);
    try {
      await api("PATCH", `/keys/${apiKey.id}`, { name: name.trim(), daily_limit: value });
      toast({ title: t("APP", "SAVED"), variant: "success" });
      await queryClient.invalidateQueries({ queryKey: udcKeys.lists(KEYS_COLLECTION) });
    } catch (error) {
      setErrors(serverErrors(error, t));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="panel" data-testid="tab-settings-panel">
      <form className="form form--narrow" onSubmit={submit} noValidate>
        {errors.form ? <Banner tone="bad">{errors.form}</Banner> : null}
        <Field label={t("KEY", "SETTINGS_NAME")} error={errors.name}>
          {(id, describedBy) => (
            <input
              id={id}
              className="input"
              value={name}
              aria-describedby={describedBy}
              data-testid="settings-name"
              onChange={(e) => setName(e.target.value)}
            />
          )}
        </Field>
        <Field
          label={t("KEY", "SETTINGS_LIMIT")}
          hint={
            <>
              {t("KEY", "SETTINGS_LIMIT_DEFAULT", { limit: limits.default_daily_limit })}
              {max !== null ? ` · ${t("NEW_KEY", "DAILY_MAX", { max })}` : ""}
            </>
          }
          error={errors.daily_limit}
        >
          {(id, describedBy) => (
            <input
              id={id}
              className="input num"
              type="number"
              min={1}
              max={max ?? undefined}
              value={limit}
              aria-describedby={describedBy}
              data-testid="settings-limit"
              onChange={(e) => setLimit(e.target.value)}
            />
          )}
        </Field>
        <Button type="submit" variant="primary" disabled={busy} data-testid="settings-save">
          {t("APP", "SAVE")}
        </Button>
      </form>
      <p className="auth__alt">
        <Link to="/keys">{t("MENU", "KEYS")}</Link>
      </p>
    </section>
  );
}
