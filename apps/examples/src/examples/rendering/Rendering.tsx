import type { Row } from "@jsudc/core";
import { intlLocaleOf, useI18n, useUdcClient, useUdcCollection } from "@jsudc/react";
import { Spinner } from "@jsudc/react/ui";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { Link, useSearchParams } from "react-router";
import { mementoUdcClient, useSettings } from "../../connection.js";
import { useLive } from "../../live.js";
import { useThrottledRefresh } from "../../refresh.js";
import { Connected } from "../../shell/AppShell.js";
import { SIMULATOR_COMMAND } from "../activity/Activity.js";
import { entityPath, timelineTime } from "../entity/entity.js";
import {
  latestEvent,
  RENDERING_COLLECTION,
  renderedIn,
  renderingKeys,
  text,
  typeFilter,
} from "./rendering.js";
import {
  BUILTIN_FORMAT,
  bundledStep,
  bundledTemplate,
  chosenType,
  GENERIC,
  GENERIC_TEMPLATE,
  lookupChain,
  overrideCommand,
  payloadEntries,
  payloadKeys,
  sourceParts,
  TEMPLATE_LOCALES,
  TEMPLATE_TYPES,
  type TemplateLocale,
} from "./templates.js";

/**
 * `/examples/rendering?type=TICKET_CLOSED`: how memento turns an event into a sentence. The
 * latest event of a type, the bundled `.en.hbs` / `.sr.hbs` sources (imported at build time),
 * and the sentence the server renders from each — the same event read twice through UDC, once
 * per `X-Memento-Locale`.
 */
export function RenderingPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("RENDERING", "TITLE")}</h1>
          <span className="bar__sub">{t("RENDERING", "SUBTITLE")}</span>
        </div>
      </header>
      <Connected>
        <Rendering key={`${connection.baseUrl}|${connection.apiKey}`} />
      </Connected>
    </div>
  );
}

function Rendering() {
  const { t } = useI18n();
  const { connection } = useSettings();
  const [params, setParams] = useSearchParams();
  const type = chosenType(params.get("type"));
  const refresh = useThrottledRefresh(RENDERING_COLLECTION);
  useLive({
    baseUrl: connection.baseUrl,
    apiKey: connection.apiKey,
    filter: { event_type: type },
    onEvent: refresh,
  });

  return (
    <section className="rendering" data-testid="rendering">
      <h2 className="entity__heading">{t("RENDERING", "TYPES")}</h2>
      <div className="entity__types" role="tablist" data-testid="rendering-types">
        {TEMPLATE_TYPES.map((x) => (
          <TypeTab
            key={x}
            type={x}
            selected={x === type}
            onPick={() => setParams({ type: x }, { replace: true })}
          />
        ))}
      </div>
      <Columns key={type} type={type} />
      <Lookup type={type} />
      <Generic />
    </section>
  );
}

/** A type of the selector, with how many events of it the tenant has (greyed at none). */
function TypeTab({
  type,
  selected,
  onPick,
}: {
  type: string;
  selected: boolean;
  onPick: () => void;
}) {
  const count = useUdcCollection({
    collection: RENDERING_COLLECTION,
    filter: typeFilter(type),
    mode: "pages",
    pageLimit: 1,
  });
  const empty = count.total === 0;
  const cls = ["entity__type", "rendering__type", selected && "is-on", empty && "is-empty"];
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      className={cls.filter(Boolean).join(" ")}
      onClick={onPick}
      data-type={type}
    >
      {type}
      <span className="rendering__count" data-testid="type-count">
        {count.total ?? "…"}
      </span>
    </button>
  );
}

/** The event, then one column per locale: template source → the sentence memento renders. */
function Columns({ type }: { type: string }) {
  const { t } = useI18n();
  const client = useUdcClient();
  const latest = useQuery({
    queryKey: renderingKeys.latest(type),
    queryFn: () => latestEvent(client, type),
  });
  const pair = bundledTemplate(type);
  const keys = useMemo(
    () => [...new Set([...payloadKeys(pair?.en ?? null), ...payloadKeys(pair?.sr ?? null)])],
    [pair],
  );
  const event = latest.data ?? null;

  return (
    <div className="rendering__columns">
      <article className="rendering__col" data-testid="rendering-event">
        <h3 className="rendering__col-title">{t("RENDERING", "EVENT")}</h3>
        {latest.error ? (
          <p className="feed__error" role="alert">
            {latest.error.message}
          </p>
        ) : latest.isLoading ? (
          <Spinner />
        ) : event ? (
          <EventPane event={event} keys={keys} />
        ) : (
          <div className="rendering__none" data-testid="rendering-none">
            <p>{t("RENDERING", "NONE", { type })}</p>
            <code>{SIMULATOR_COMMAND}</code>
          </div>
        )}
      </article>
      {TEMPLATE_LOCALES.map((locale) => (
        <LocaleColumn
          key={locale}
          type={type}
          locale={locale}
          source={pair?.[locale] ?? null}
          eventId={event?.__meta.id ?? null}
        />
      ))}
    </div>
  );
}

/** The latest event: who, what, when, and its payload with the keys the templates read lit up. */
function EventPane({ event, keys }: { event: Row; keys: readonly string[] }) {
  const { t, locale } = useI18n();
  const instanceType = text(event, "instance_type");
  const instanceId = text(event, "instance_id");
  const actor = text(event, "actor_id");
  const at = text(event, "occurred_at");
  const entries = payloadEntries(event.payload, keys);
  return (
    <>
      <dl className="rendering__fields">
        <dt>event_type</dt>
        <dd>
          <span className="feed__type">{text(event, "event_type")}</span>
        </dd>
        <dt>instance</dt>
        <dd>
          {instanceType && instanceId ? (
            <Link className="feed__chip feed__chip--link" to={entityPath(instanceType, instanceId)}>
              {instanceType}/{instanceId}
            </Link>
          ) : (
            "—"
          )}
        </dd>
        <dt>actor_id</dt>
        <dd data-testid="rendering-actor">{actor ?? "—"}</dd>
        <dt>occurred_at</dt>
        <dd className="num">{at ? timelineTime(at, intlLocaleOf(locale)) : "—"}</dd>
      </dl>
      <div className="search__pane">
        <div className="search__pane-head">
          <h4 className="search__pane-title">payload</h4>
          {keys.length > 0 ? (
            <span className="rendering__legend">
              <mark>{t("RENDERING", "READ_KEYS")}</mark>
            </span>
          ) : null}
        </div>
        <pre className="search__code rendering__payload" data-testid="rendering-payload">
          {"{"}
          {entries.map((e, i) => (
            <span key={e.key}>
              {"\n  "}
              {e.used ? (
                <mark data-testid="payload-used" data-key={e.key}>
                  {e.text}
                </mark>
              ) : (
                e.text
              )}
              {i < entries.length - 1 ? "," : ""}
            </span>
          ))}
          {entries.length ? "\n}" : "}"}
        </pre>
      </div>
    </>
  );
}

/** One locale: the bundled source, and the sentence the server rendered in that locale. */
function LocaleColumn({
  type,
  locale,
  source,
  eventId,
}: {
  type: string;
  locale: TemplateLocale;
  source: string | null;
  eventId: string | null;
}) {
  const { t } = useI18n();
  const { connection } = useSettings();
  // The page's client renders in the header's language; this one always in `locale`.
  const client = useMemo(
    () => mementoUdcClient(connection.baseUrl, connection.apiKey, locale),
    [connection.baseUrl, connection.apiKey, locale],
  );
  const rendered = useQuery({
    queryKey: renderingKeys.rendered(eventId ?? "", locale),
    queryFn: () => renderedIn(client, eventId as string),
    enabled: eventId !== null,
  });
  const file = `${type}.${locale}.hbs`;
  return (
    <article className="rendering__col" data-testid={`rendering-${locale}`}>
      <h3 className="rendering__col-title">
        {t("RENDERING", locale === "en" ? "ENGLISH" : "SERBIAN")}
      </h3>
      <div className="search__pane">
        <div className="search__pane-head">
          <h4 className="search__pane-title">{file}</h4>
          <span className="badge">{t("RENDERING", "BUNDLED")}</span>
        </div>
        <TemplateSource source={source} testId={`template-${locale}`} />
      </div>
      <p className="rendering__via">
        ↓ <code>POST /memento/udc/read</code> · <code>X-Memento-Locale: {locale}</code>
      </p>
      <div className="rendering__out" data-testid={`rendered-${locale}`}>
        {eventId === null ? (
          <span className="rendering__dim">{t("RENDERING", "NO_EVENT")}</span>
        ) : rendered.error ? (
          <span className="feed__error">{rendered.error.message}</span>
        ) : rendered.isLoading ? (
          <Spinner />
        ) : (
          (rendered.data ?? "")
        )}
      </div>
    </article>
  );
}

/** A template's source, its `{{…}}` tags and the `payload.x` they read set apart. */
function TemplateSource({ source, testId }: { source: string | null; testId: string }) {
  return (
    <pre className="search__code search__code--wrap rendering__source" data-testid={testId}>
      {source === null
        ? "—"
        : sourceParts(source).map((part, i) =>
            part.kind === "text" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
              <span key={i}>{part.text}</span>
            ) : part.kind === "tag" ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
              <span key={i} className="rendering__tag">
                {part.text}
              </span>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the parts of one fixed string
              <mark key={i} data-testid="template-payload">
                {part.text}
              </mark>
            ),
          )}
    </pre>
  );
}

/** Where the template comes from: the lookup chain per locale, and how a tenant overrides a step. */
function Lookup({ type }: { type: string }) {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <section className="rendering__lookup" data-testid="rendering-lookup">
      <h2 className="entity__heading">{t("RENDERING", "LOOKUP")}</h2>
      <p className="rendering__text">{t("RENDERING", "LOOKUP_TEXT")}</p>
      <div className="rendering__chains">
        {TEMPLATE_LOCALES.map((locale) => {
          const used = bundledStep(type, locale);
          return (
            <ol key={locale} className="rendering__chain" data-testid={`chain-${locale}`}>
              <li className="rendering__chain-head">?locale={locale}</li>
              {lookupChain(type, locale).map((step) => (
                <li key={step} className={step === used ? "is-used" : undefined}>
                  <code>{step}</code>
                  <span className="rendering__dim">
                    {" "}
                    {t("RENDERING", "STEP")}
                    {step === used ? ` ← ${t("RENDERING", "USED")}` : ""}
                  </span>
                </li>
              ))}
              <li>
                <code>{BUILTIN_FORMAT}</code>
              </li>
            </ol>
          );
        })}
      </div>
      <p className="rendering__text">{t("RENDERING", "OVERRIDE_TEXT")}</p>
      <code className="rendering__cmd" data-testid="override-command">
        {overrideCommand(connection.tenant, type, "sr")}
      </code>
    </section>
  );
}

/** `_generic`: the template of every event type that has none of its own. */
function Generic() {
  const { t } = useI18n();
  return (
    <section className="rendering__generic" data-testid="rendering-generic">
      <h2 className="entity__heading">{t("RENDERING", "GENERIC")}</h2>
      <p className="rendering__text">{t("RENDERING", "GENERIC_TEXT")}</p>
      <div className="rendering__chains">
        {TEMPLATE_LOCALES.map((locale) => (
          <div key={locale} className="search__pane">
            <div className="search__pane-head">
              <h4 className="search__pane-title">
                {GENERIC}.{locale}.hbs
              </h4>
            </div>
            <TemplateSource source={GENERIC_TEMPLATE[locale]} testId={`generic-${locale}`} />
          </div>
        ))}
      </div>
      <p className="rendering__text">{t("RENDERING", "NOTE_TEXT")}</p>
    </section>
  );
}
