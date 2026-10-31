import { UdcDataView, udcKeys } from "@jsudc/react";
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from "react-router";
import { useSettings } from "../../connection.js";
import { COLLECTIONS, type Settings, streamFilter, withSettingsFilter } from "../../settings.js";
import { Connected } from "../../shell/AppShell.js";
import { type Health, type LiveState, useLive } from "./live.js";

/** At most one refetch per this many ms, however fast events arrive. */
const REFRESH_THROTTLE_MS = 250;

/**
 * The CPU monitor example (`/examples/cpu-monitor`): `memento cpu-monitor` pushes, the
 * `cpu_load` UDC collection serves, `UdcDataView` draws, the WebSocket stream refreshes.
 */
export function CpuMonitorPage() {
  const { settings, connection, apply } = useSettings();
  const navigate = useNavigate();
  const location = useLocation();

  // First visit: open the view narrowed to the saved instance_type (the data view reads its
  // filter from `?f=`). The view mounts only once the URL has it, so the first list is
  // already filtered; later the filter is the data view's own to change or remove.
  const [first] = useState(() => {
    const search = withSettingsFilter(location.search, settings);
    const has = new URLSearchParams(location.search).has("f");
    return has || search === location.search ? null : search;
  });
  const arrived = useRef(first === null);
  if (!arrived.current && location.search === first) arrived.current = true;
  const asked = useRef(false);
  // A passive effect, not a layout one: the router listens to history from its own layout
  // effect, which runs after this page's on the first mount.
  useEffect(() => {
    if (first === null || asked.current) return;
    asked.current = true;
    navigate({ search: first }, { replace: true });
  }, [first, navigate]);
  const ready = arrived.current;

  const applyMonitor = (next: Settings) => {
    apply(next);
    navigate({ search: withSettingsFilter(location.search, next) }, { replace: true });
  };

  return (
    <div className="page">
      <MonitorBar settings={settings} onApply={applyMonitor} />
      <Connected>
        {ready ? (
          <Monitor
            key={`${connection.baseUrl}|${connection.apiKey}|${settings.collection}|${settings.instanceType}`}
            settings={{ ...settings, baseUrl: connection.baseUrl, apiKey: connection.apiKey }}
          />
        ) : null}
      </Connected>
    </div>
  );
}

function Monitor({ settings }: { settings: Settings }) {
  const queryClient = useQueryClient();

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
    <>
      <StatusBar live={live} settings={settings} />
      <section className="view">
        <UdcDataView collection={settings.collection} />
      </section>
    </>
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

/** The page's own settings: which collection, which instance_type. Server and key are the header's. */
export function MonitorBar({
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
    onApply({ ...settings, collection: draft.collection, instanceType: draft.instanceType });
  };
  return (
    <header className="bar">
      <div className="bar__title">
        <h1>CPU monitor</h1>
        <span className="bar__sub">UDC live table · memento cpu-monitor → cpu_load</span>
      </div>
      <form className="settings" onSubmit={submit}>
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
        <button type="submit">Apply</button>
      </form>
    </header>
  );
}
