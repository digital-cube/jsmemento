import "@memento/react/styles.css";
import { intlLocaleOf, useI18n } from "@jsudc/react";
import type { MementoEvent } from "@memento/core";
import { MementoProvider, MementoSearch, type MementoSearchValues } from "@memento/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router";
import { useSettings } from "../../connection.js";
import { Connected } from "../../shell/AppShell.js";
import { entityPath } from "../entity/entity.js";
import {
  curlLine,
  type Exchange,
  responseShape,
  searchFromParams,
  searchToParams,
  tapFetch,
  toUdcFilter,
  udcEventsPath,
} from "./search.js";

/**
 * The Search example (`/examples/search`): `MementoSearch` from `@memento/react` on the left;
 * on the right what it sent — the Filter DSL tree, the request as `curl`, the shape of the
 * answer — read off the wire, and a link to the UDC `events` table with the same filter. The
 * search lives in the page's URL.
 */
export function SearchPage() {
  const { t } = useI18n();
  const { connection } = useSettings();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("SEARCH", "TITLE")}</h1>
          <span className="bar__sub">{t("SEARCH", "SUBTITLE")}</span>
        </div>
      </header>
      <Connected>
        <SearchExample key={`${connection.baseUrl}|${connection.apiKey}`} />
      </Connected>
    </div>
  );
}

/** The instance of a result: a chip linking to its timeline. */
function instanceChip(event: MementoEvent) {
  return (
    <Link
      className="feed__chip feed__chip--link"
      to={entityPath(event.instance_type, event.instance_id)}
      data-testid="search-instance"
    >
      {event.instance_type}/{event.instance_id}
    </Link>
  );
}

function SearchExample() {
  const { locale } = useI18n();
  const { connection } = useSettings();
  const [params, setParams] = useSearchParams();
  const search = searchFromParams(params);
  const [exchange, setExchange] = useState<Exchange | null>(null);
  // One tap for the life of the page: a new `fetch` would make the provider a new client.
  const tapped = useMemo(() => tapFetch(setExchange), []);
  const onSearch = useCallback(
    (values: MementoSearchValues) => setParams((current) => searchToParams(values, current)),
    [setParams],
  );

  return (
    <div className="search">
      <section className="search__form">
        {/* The header's language: memento renders `rendered` in it (`locale` in the body). */}
        <MementoProvider
          baseUrl={connection.baseUrl}
          apiKey={connection.apiKey}
          locale={locale}
          fetch={tapped}
        >
          <MementoSearch
            search={search}
            onSearch={onSearch}
            renderInstance={instanceChip}
            locale={intlLocaleOf(locale)}
          />
        </MementoProvider>
      </section>
      <WhatWasSent exchange={search ? exchange : null} apiKey={connection.apiKey} />
    </div>
  );
}

function WhatWasSent({ exchange, apiKey }: { exchange: Exchange | null; apiKey: string }) {
  const { t } = useI18n();
  const filter = exchange?.body.filter ?? null;
  const dsl = exchange ? JSON.stringify(filter, null, 2) : null;
  return (
    <aside className="search__sent" aria-labelledby="search-sent-title">
      <h2 id="search-sent-title" className="search__heading">
        {t("SEARCH", "SENT")}
      </h2>
      {exchange ? null : <p className="search__hint">{t("SEARCH", "SENT_EMPTY")}</p>}

      <Pane title={t("SEARCH", "DSL")} copy={dsl} testId="search-dsl">
        {dsl ?? "—"}
      </Pane>
      {exchange && filter === null ? (
        <p className="search__hint">{t("SEARCH", "NO_FILTER")}</p>
      ) : null}

      <Pane title={t("SEARCH", "REQUEST")} testId="search-curl" wrap>
        {exchange ? curlLine(exchange.url, apiKey, exchange.body, location.origin) : "—"}
      </Pane>

      <Pane title={t("SEARCH", "RESPONSE")} testId="search-response">
        {exchange
          ? exchange.error
            ? exchange.error
            : exchange.status === null
              ? t("SEARCH", "PENDING")
              : `HTTP ${exchange.status}\n${JSON.stringify(responseShape(exchange.response), null, 2)}`
          : "—"}
      </Pane>

      <div className="search__udc">
        <h3 className="search__pane-title">{t("SEARCH", "UDC_TITLE")}</h3>
        <p>{t("SEARCH", "UDC_TEXT")}</p>
        {exchange ? (
          <>
            <Link className="search__udc-link" to={udcEventsPath(filter)} data-testid="search-udc">
              {t("SEARCH", "UDC_LINK")}
            </Link>
            <details className="search__udc-filter">
              <summary>{t("SEARCH", "UDC_FILTER")}</summary>
              <pre className="search__code">{JSON.stringify(toUdcFilter(filter), null, 2)}</pre>
            </details>
          </>
        ) : null}
      </div>
    </aside>
  );
}

function Pane({
  title,
  copy,
  testId,
  wrap = false,
  children,
}: {
  title: string;
  copy?: string | null;
  testId: string;
  /** Wrap long lines (the curl command) instead of scrolling sideways. */
  wrap?: boolean;
  children: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="search__pane">
      <div className="search__pane-head">
        <h3 className="search__pane-title">{title}</h3>
        {copy ? (
          <button
            type="button"
            className="btn btn--ghost search__copy"
            onClick={() => {
              void navigator.clipboard?.writeText(copy).then(() => setCopied(true));
            }}
          >
            {copied ? t("SEARCH", "COPIED") : t("SEARCH", "COPY")}
          </button>
        ) : null}
      </div>
      <pre
        className={wrap ? "search__code search__code--wrap" : "search__code"}
        data-testid={testId}
      >
        {children}
      </pre>
    </div>
  );
}
