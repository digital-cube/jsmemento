import { intlLocaleOf, useI18n } from "@jsudc/react";
import { INSTANCE_TYPES } from "@memento/core";
import { type FormEvent, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useSettings } from "../../connection.js";
import type { Health } from "../../live.js";
import { Connected } from "../../shell/AppShell.js";
import { SIMULATOR_COMMAND } from "../activity/Activity.js";
import {
  closeText,
  type Frame,
  filtersFromSearch,
  filtersToSearch,
  isControl,
  MAX_FRAMES,
  NO_FILTERS,
  reconnectsOf,
  TAIL_EVENT_TYPES,
  type TailFilters,
  tailQuery,
  tailUrl,
} from "./tail.js";
import { type Tail, useTail } from "./useTail.js";

/**
 * The Live tail example (`/examples/tail`): `memento tail` in the browser. The page opens
 * `GET /memento/ws` with `MementoStream` and lists every frame the socket delivers — events,
 * the welcome, heartbeats, errors, the socket closing — with the stream's own filters, which
 * live in the page's URL.
 */
export function TailPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("TAIL", "TITLE")}</h1>
          <span className="bar__sub">{t("TAIL", "SUBTITLE")}</span>
        </div>
      </header>
      <Connected>
        <LiveTail key={`${connection.baseUrl}|${connection.apiKey}`} />
      </Connected>
    </div>
  );
}

function LiveTail() {
  const { t, locale } = useI18n();
  const { connection } = useSettings();
  const [params, setParams] = useSearchParams();
  const filters = filtersFromSearch(params);
  const query = tailQuery(filters);
  const url = tailUrl(connection.baseUrl, query.filter, locale);
  const tail = useTail({ baseUrl: connection.baseUrl, apiKey: connection.apiKey, query, locale });
  const [showControl, setShowControl] = useState(true);
  const setFilters = (next: TailFilters) => setParams(filtersToSearch(next, params).slice(1));

  const frames = showControl ? tail.state.frames : tail.state.frames.filter((f) => !isControl(f));
  return (
    <>
      <FilterBar filters={filters} onChange={setFilters} />
      <div className="tail__wire">
        <span className="tail__wire-label">{t("TAIL", "URL")}</span>
        <code className="tail__url" data-testid="tail-url">
          {url}
        </code>
        <ul className="tail__notes">
          <li>{t("TAIL", "KEY_NOTE")}</li>
          <li>{t("TAIL", "LOCALE_NOTE", { locale })}</li>
          {query.clientSide ? (
            <li data-testid="tail-client-side">
              {t("TAIL", "CLIENT_SIDE", { count: filters.event_types.length })}
            </li>
          ) : null}
          {query.error ? (
            <li className="tail__invalid" role="alert" data-testid="tail-invalid">
              {t("TAIL", "INVALID", { message: query.error })}
            </li>
          ) : null}
        </ul>
      </div>
      <TailStatus tail={tail} clientSide={query.clientSide} />
      <div className="tail__controls">
        {tail.state.paused ? (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => tail.dispatch({ type: "resume" })}
            data-testid="tail-resume"
          >
            {t("TAIL", "RESUME")}
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => tail.dispatch({ type: "pause" })}
            data-testid="tail-pause"
          >
            {t("TAIL", "PAUSE")}
          </button>
        )}
        <button
          type="button"
          className="btn"
          onClick={() => tail.dispatch({ type: "clear" })}
          data-testid="tail-clear"
        >
          {t("TAIL", "CLEAR")}
        </button>
        {tail.state.paused ? (
          <span className="tail__paused" data-testid="tail-paused" role="status">
            {t("TAIL", "PAUSED", { count: tail.state.pendingCount })}
          </span>
        ) : null}
        <label className="tail__toggle">
          <input
            type="checkbox"
            checked={showControl}
            onChange={(e) => setShowControl(e.target.checked)}
            data-testid="tail-control"
          />
          {t("TAIL", "CONTROL")}
        </label>
        <span className="tail__cap">{t("TAIL", "CAP", { max: MAX_FRAMES })}</span>
      </div>
      <section className="tail__frames">
        {frames.length === 0 ? (
          tail.state.paused || query.error ? null : (
            <div className="feed__empty" data-testid="tail-empty">
              <p>{t("TAIL", "EMPTY")}</p>
              <code>{SIMULATOR_COMMAND}</code>
            </div>
          )
        ) : (
          <ol className="tail__list" data-testid="tail-frames">
            {frames.map((frame) => (
              <FrameRow key={frame.seq} frame={frame} />
            ))}
          </ol>
        )}
      </section>
    </>
  );
}

/** One frame: the line of `memento tail`, opening to the frame's JSON. */
function FrameRow({ frame }: { frame: Frame }) {
  const control = isControl(frame);
  return (
    <li
      className={control ? "tail__frame is-control" : "tail__frame"}
      data-testid="tail-frame"
      data-kind={frame.kind}
    >
      <details>
        <summary className="tail__line" data-testid="tail-line">
          {frame.line}
        </summary>
        <pre className="tail__json" data-testid="tail-json">
          {frame.json === null ? frame.raw : JSON.stringify(frame.json, null, 2)}
        </pre>
      </details>
    </li>
  );
}

/**
 * The stream's filters, as inputs. Event types are a multi-select of memento's vocabulary
 * and apply at once; the text fields apply on Enter / Apply (each change is a reconnect).
 */
function FilterBar({
  filters,
  onChange,
}: {
  filters: TailFilters;
  onChange: (next: TailFilters) => void;
}) {
  const { t } = useI18n();
  const [draft, setDraft] = useState(filters);
  const key = JSON.stringify(filters);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `key` is `filters` by value
  useEffect(() => setDraft(filters), [key]);
  const set =
    (field: "instance_type" | "instance_id" | "actor_id") => (e: { target: { value: string } }) =>
      setDraft((d) => ({ ...d, [field]: e.target.value }));
  const toggle = (type: string) => {
    const on = filters.event_types.includes(type);
    const event_types = on
      ? filters.event_types.filter((x) => x !== type)
      : [...filters.event_types, type];
    onChange({ ...draft, event_types });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onChange({ ...draft, event_types: filters.event_types });
  };
  return (
    <form className="tail__filters" onSubmit={submit} data-testid="tail-filters">
      <fieldset className="tail__types">
        <legend>
          {t("TAIL", "EVENT_TYPES")}
          {filters.event_types.length === 0 ? (
            <span className="tail__hint"> · {t("TAIL", "ALL_TYPES")}</span>
          ) : null}
        </legend>
        {TAIL_EVENT_TYPES.map((type) => {
          const on = filters.event_types.includes(type);
          return (
            <button
              key={type}
              type="button"
              className={on ? "tail__type is-on" : "tail__type"}
              aria-pressed={on}
              onClick={() => toggle(type)}
              data-testid={`tail-type-${type}`}
            >
              {type}
            </button>
          );
        })}
      </fieldset>
      <div className="settings">
        <label>
          {t("TAIL", "INSTANCE_TYPE")}
          <input
            value={draft.instance_type}
            onChange={set("instance_type")}
            placeholder="ticket"
            list="tail-instance-types"
            data-testid="tail-instance-type"
          />
        </label>
        <datalist id="tail-instance-types">
          {INSTANCE_TYPES.map((v) => (
            <option key={v} value={v} />
          ))}
        </datalist>
        <label>
          {t("TAIL", "INSTANCE_ID")}
          <input
            value={draft.instance_id}
            onChange={set("instance_id")}
            placeholder="T-17"
            data-testid="tail-instance-id"
          />
        </label>
        <label>
          {t("TAIL", "ACTOR_ID")}
          <input
            value={draft.actor_id}
            onChange={set("actor_id")}
            placeholder="ana"
            data-testid="tail-actor-id"
          />
        </label>
        <button type="submit" data-testid="tail-apply">
          {t("TAIL", "APPLY")}
        </button>
        <button
          type="button"
          className="tail__reset"
          onClick={() => onChange(NO_FILTERS)}
          data-testid="tail-reset"
        >
          {t("TAIL", "RESET")}
        </button>
      </div>
    </form>
  );
}

function healthOf(status: Tail["status"]): Health {
  if (status === "live") return "live";
  if (status === "connecting") return "connecting";
  return "offline";
}

/** The dot (connecting / live / closed with the close code) and the counters. */
function TailStatus({ tail, clientSide }: { tail: Tail; clientSide: boolean }) {
  const { t, locale } = useI18n();
  const { state, status } = tail;
  const health = healthOf(status);
  const label =
    status === "live"
      ? t("TAIL", "LIVE")
      : status === "connecting"
        ? t("TAIL", "CONNECTING")
        : status === "off"
          ? t("TAIL", "OFF")
          : state.lastClose
            ? t("TAIL", "CLOSED_CODE", { close: closeText(state.lastClose) })
            : t("TAIL", "CLOSED");
  const since = state.connectedSince
    ? new Date(state.connectedSince).toLocaleTimeString(intlLocaleOf(locale), { hour12: false })
    : "—";
  return (
    <div className="status" role="status" aria-live="polite">
      <span className="health" data-health={health} data-testid="tail-health">
        <span className="health__dot" aria-hidden="true" />
        {label}
      </span>
      <span className="status__item">
        <strong className="num" data-testid="tail-received">
          {state.received}
        </strong>{" "}
        {t("TAIL", "RECEIVED")}
      </span>
      <span className="status__item">
        <strong className="num" data-testid="tail-rate">
          {tail.rate.toFixed(1)}
        </strong>{" "}
        {t("TAIL", "RATE")}
      </span>
      <span className="status__item">
        {t("TAIL", "SINCE")}{" "}
        <strong className="num" data-testid="tail-since">
          {since}
        </strong>
      </span>
      <span className="status__item">
        <strong className="num" data-testid="tail-reconnects">
          {reconnectsOf(state)}
        </strong>{" "}
        {t("TAIL", "RECONNECTS")}
      </span>
      {clientSide ? (
        <span className="status__item">
          <strong className="num" data-testid="tail-filtered">
            {state.filteredOut}
          </strong>{" "}
          {t("TAIL", "FILTERED")}
        </span>
      ) : null}
    </div>
  );
}
