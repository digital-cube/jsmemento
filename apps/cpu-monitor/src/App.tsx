import { UdcClient } from "@jsudc/core/client";
import {
  createRendererRegistry,
  createUdcQueryClient,
  UdcDataView,
  UdcI18nProvider,
  UdcProvider,
  udcKeys,
} from "@jsudc/react";
import { chartRenderer } from "@jsudc/react/chart";
import { tableRenderer } from "@jsudc/react/table";
import { Toaster, TooltipProvider } from "@jsudc/react/ui";
import { QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type Health, type LiveState, useLive } from "./live.js";
import {
  COLLECTIONS,
  defaultSettings,
  loadSettings,
  type Settings,
  saveSettings,
  streamFilter,
  withSettingsFilter,
} from "./settings.js";

// Module constant: the registry must not change between renders.
const renderers = createRendererRegistry(tableRenderer, chartRenderer);
/** At most one refetch per this many ms, however fast events arrive. */
const REFRESH_THROTTLE_MS = 250;

export function App() {
  const [settings, setSettings] = useState<Settings>(() =>
    loadSettings(localStorage, defaultSettings()),
  );
  const queryClient = useMemo(() => createUdcQueryClient(), []);

  const apply = (next: Settings) => {
    saveSettings(localStorage, next);
    history.replaceState(
      history.state,
      "",
      `${location.pathname}${withSettingsFilter(location.search, next)}`,
    );
    setSettings(next);
  };

  // First load: open the view narrowed to the saved instance_type.
  const once = useRef(false);
  if (!once.current) {
    once.current = true;
    if (!new URLSearchParams(location.search).has("f")) {
      history.replaceState(
        history.state,
        "",
        `${location.pathname}${withSettingsFilter(location.search, settings)}`,
      );
    }
  }

  return (
    <QueryClientProvider client={queryClient}>
      <div className="shell">
        <SettingsBar settings={settings} onApply={apply} />
        {settings.apiKey ? (
          <Monitor
            key={`${settings.baseUrl}|${settings.apiKey}|${settings.collection}|${settings.instanceType}`}
            settings={settings}
          />
        ) : (
          <p className="hint">
            Paste an API key with the <code>read</code> scope (
            <code>memento create-key --tenant demo --scopes read</code>) and press Connect.
          </p>
        )}
      </div>
    </QueryClientProvider>
  );
}

function Monitor({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();
  const client = useMemo(
    () =>
      new UdcClient({
        httpUrl: settings.baseUrl.replace(/\/+$/, ""),
        headers: { authorization: `Bearer ${settings.apiKey}` },
      }),
    [settings.baseUrl, settings.apiKey],
  );

  // Every stream event refetches the collection's lists (throttled): the rows always come
  // from UDC, the WebSocket only says that there is something new.
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refresh = useCallback(() => {
    if (pending.current) return;
    pending.current = setTimeout(() => {
      pending.current = null;
      void queryClient.invalidateQueries({ queryKey: udcKeys.lists(settings.collection) });
    }, REFRESH_THROTTLE_MS);
  }, [queryClient, settings.collection]);
  useEffect(
    () => () => {
      if (pending.current) clearTimeout(pending.current);
    },
    [],
  );

  const live = useLive({
    baseUrl: settings.baseUrl,
    apiKey: settings.apiKey,
    filter: streamFilter(settings),
    onEvent: refresh,
  });

  return (
    <UdcProvider client={client} renderers={renderers}>
      <UdcI18nProvider>
        <TooltipProvider>
          <Toaster>
            <StatusBar live={live} settings={settings} />
            <main className="view">
              <UdcDataView collection={settings.collection} />
            </main>
          </Toaster>
        </TooltipProvider>
      </UdcI18nProvider>
    </UdcProvider>
  );
}

const HEALTH_LABEL: Record<Health, string> = {
  live: "Live",
  connecting: "Connecting…",
  offline: "Offline",
};

export function StatusBar({ live, settings }: { live: LiveState; settings: Settings }) {
  const last = live.lastEventAt
    ? new Date(live.lastEventAt).toLocaleTimeString(undefined, { hour12: false })
    : "—";
  const why =
    live.serverUp === false
      ? "server unreachable"
      : live.stream === "offline"
        ? "stream reconnecting"
        : live.stream === "live"
          ? "stream connected"
          : "connecting to stream";
  return (
    <div className="status" role="status" aria-live="polite">
      <span className="health" data-health={live.health} title={why}>
        <span className="health__dot" aria-hidden="true" />
        {HEALTH_LABEL[live.health]}
      </span>
      <span className="status__item">
        collection <strong>{settings.collection}</strong>
      </span>
      <span className="status__item">
        last event <strong className="num">{last}</strong>
      </span>
      <span className="status__item">
        <strong className="num">{live.rate.toFixed(1)}</strong> events/s
      </span>
      <span className="status__why">{why}</span>
    </div>
  );
}

export function SettingsBar({
  settings,
  onApply,
}: {
  settings: Settings;
  onApply: (next: Settings) => void;
}) {
  const [draft, setDraft] = useState(settings);
  useEffect(() => setDraft(settings), [settings]);
  const set = (key: keyof Settings) => (e: { target: { value: string } }) =>
    setDraft((d) => ({ ...d, [key]: e.target.value }));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onApply({ ...draft, apiKey: draft.apiKey.trim(), baseUrl: draft.baseUrl.trim() });
  };
  return (
    <header className="bar">
      <div className="brand">
        <span className="brand__mark">memento</span>
        <span className="brand__sub">CPU monitor · UDC live table</span>
      </div>
      <form className="settings" onSubmit={submit}>
        <label>
          API base URL
          <input value={draft.baseUrl} onChange={set("baseUrl")} spellCheck={false} />
        </label>
        <label className="settings__key">
          API key
          <input
            value={draft.apiKey}
            onChange={set("apiKey")}
            placeholder="mk_ab12cd34_…"
            type="password"
            spellCheck={false}
            autoComplete="off"
          />
        </label>
        <label>
          Collection
          <select value={draft.collection} onChange={set("collection")}>
            {COLLECTIONS.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
        </label>
        <label>
          instance_type
          <input
            value={draft.instanceType}
            onChange={set("instanceType")}
            placeholder="all"
            spellCheck={false}
          />
        </label>
        <button type="submit">Connect</button>
      </form>
    </header>
  );
}
