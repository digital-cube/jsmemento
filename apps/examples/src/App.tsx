import { UdcClient } from "@jsudc/core/client";
import {
  createRendererRegistry,
  createUdcQueryClient,
  isLocale,
  LOCALE_STORAGE_KEY,
  type Locale,
  storage,
  UdcDataView,
  UdcI18nProvider,
  UdcProvider,
  udcKeys,
} from "@jsudc/react";
import { chartRenderer } from "@jsudc/react/chart";
import { UdcReactRouterUrlState } from "@jsudc/react/react-router";
import { tableRenderer } from "@jsudc/react/table";
import { Toaster, TooltipProvider } from "@jsudc/react/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { connectionOf, SettingsProvider, useDemoKey } from "./connection.js";
import { ActivityPage } from "./examples/activity/Activity.js";
import { CpuMonitorPage } from "./examples/cpu-monitor/CpuMonitor.js";
import { PlannedExamplePage } from "./examples/planned/PlannedExample.js";
import { EXAMPLES_MESSAGES } from "./i18n/messages.js";
import { defaultSettings, loadSettings, type Settings, saveSettings } from "./settings.js";
import { AppShell, Connected } from "./shell/AppShell.js";

// Module constant: the registry must not change between renders.
const renderers = createRendererRegistry(tableRenderer, chartRenderer);

/** The first example: where `/` leads. */
export const FIRST_EXAMPLE = "/examples/cpu-monitor";

/**
 * The router's base: `/en` when the page was opened under `/en/` (the server serves the
 * site there too, so the links people already have keep working), `/` otherwise.
 */
export function routerBasename(pathname: string): string {
  return /^\/en(\/|$)/.test(pathname) ? "/en" : "/";
}

/**
 * The header the UDC client names the page's language in: memento renders the rows'
 * `rendered` text in it (`X-Memento-Locale`, docs/TEMPLATES.md).
 */
export const LOCALE_HEADER = "x-memento-locale";

/** The language the visitor picked last (the header's EN / SR), `en` the first time. */
export function storedLocale(): Locale {
  const stored = storage.get(LOCALE_STORAGE_KEY);
  return isLocale(stored) ? stored : "en";
}

/** `/udc/:collection`: any collection the server lists, as a plain data view. */
function CollectionPage() {
  const { collection = "" } = useParams();
  return (
    <div className="page">
      <Connected>
        <section className="view">
          {/* Keyed: another collection starts from a fresh view, not the old one's state. */}
          <UdcDataView key={collection} collection={collection} />
        </section>
      </Connected>
    </div>
  );
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() =>
    loadSettings(localStorage, defaultSettings()),
  );
  // No key of the visitor's own: ask the server for its read-only demo key.
  const demo = useDemoKey(settings.baseUrl, !settings.apiKey);
  const connection = connectionOf(settings, demo);
  const apply = useCallback((next: Settings) => {
    saveSettings(localStorage, next);
    setSettings(next);
  }, []);

  // The header's language: the strings of the site and the `rendered` text of every row.
  const [locale, setLocale] = useState<Locale>(storedLocale);
  const changeLocale = useCallback((next: Locale) => {
    storage.set(LOCALE_STORAGE_KEY, next);
    setLocale(next);
  }, []);

  const { baseUrl, apiKey } = connection;
  const client = useMemo(
    () =>
      new UdcClient({
        httpUrl: baseUrl.replace(/\/+$/, ""),
        headers: {
          ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
          [LOCALE_HEADER]: locale,
        },
      }),
    [baseUrl, apiKey, locale],
  );
  // One cache per server and key: another key must never see the rows of the last one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new cache per connection
  const queryClient = useMemo(() => createUdcQueryClient(), [baseUrl, apiKey]);
  // Another language: every list is fetched again through the new client, so the rows'
  // `rendered` text comes back in it (the lists' cache keys do not name the locale).
  const shownLocale = useRef(locale);
  useEffect(() => {
    if (shownLocale.current === locale) return;
    shownLocale.current = locale;
    void queryClient.invalidateQueries({ queryKey: [...udcKeys.all, "list"] });
  }, [locale, queryClient]);
  const [basename] = useState(() => routerBasename(location.pathname));

  return (
    <QueryClientProvider client={queryClient}>
      <UdcI18nProvider messages={EXAMPLES_MESSAGES} locale={locale} onLocaleChange={changeLocale}>
        <UdcProvider client={client} renderers={renderers}>
          <TooltipProvider>
            <Toaster>
              <SettingsProvider value={{ settings, connection, apply }}>
                <BrowserRouter basename={basename}>
                  <UdcReactRouterUrlState>
                    <Routes>
                      <Route element={<AppShell />}>
                        <Route index element={<Navigate to={FIRST_EXAMPLE} replace />} />
                        <Route path="examples/cpu-monitor" element={<CpuMonitorPage />} />
                        <Route path="examples/activity" element={<ActivityPage />} />
                        {/* Every example of menu.yaml not built yet: a "planned" page. */}
                        <Route path="examples/:slug" element={<PlannedExamplePage />} />
                        <Route path="udc/:collection" element={<CollectionPage />} />
                        <Route path="*" element={<Navigate to="/" replace />} />
                      </Route>
                    </Routes>
                  </UdcReactRouterUrlState>
                </BrowserRouter>
              </SettingsProvider>
            </Toaster>
          </TooltipProvider>
        </UdcProvider>
      </UdcI18nProvider>
    </QueryClientProvider>
  );
}
