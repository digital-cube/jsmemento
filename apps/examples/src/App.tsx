import { UdcClient } from "@jsudc/core/client";
import {
  createRendererRegistry,
  createUdcQueryClient,
  UdcDataView,
  UdcI18nProvider,
  UdcProvider,
} from "@jsudc/react";
import { chartRenderer } from "@jsudc/react/chart";
import { UdcReactRouterUrlState } from "@jsudc/react/react-router";
import { tableRenderer } from "@jsudc/react/table";
import { Toaster, TooltipProvider } from "@jsudc/react/ui";
import { QueryClientProvider } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";
import { BrowserRouter, Navigate, Route, Routes, useParams } from "react-router";
import { connectionOf, SettingsProvider, useDemoKey } from "./connection.js";
import { CpuMonitorPage } from "./examples/cpu-monitor/CpuMonitor.js";
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

  const { baseUrl, apiKey } = connection;
  const client = useMemo(
    () =>
      new UdcClient({
        httpUrl: baseUrl.replace(/\/+$/, ""),
        headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
      }),
    [baseUrl, apiKey],
  );
  // One cache per server and key: another key must never see the rows of the last one.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new cache per connection
  const queryClient = useMemo(() => createUdcQueryClient(), [baseUrl, apiKey]);
  const [basename] = useState(() => routerBasename(location.pathname));

  return (
    <QueryClientProvider client={queryClient}>
      <UdcI18nProvider messages={EXAMPLES_MESSAGES}>
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
