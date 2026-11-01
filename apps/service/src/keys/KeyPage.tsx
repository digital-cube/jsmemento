import { udcKeys, useI18n } from "@jsudc/react";
import {
  Button,
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  Spinner,
  useToast,
} from "@jsudc/react/ui";
import { useQueryClient } from "@tanstack/react-query";
import { Pause, Play, Trash2 } from "lucide-react";
import { useState } from "react";
import { Link, Navigate, NavLink, useNavigate, useParams } from "react-router";
import { api } from "../lib/api.js";
import { Banner, UsageBar, useDateTime } from "../lib/ui.js";
import { ScopeChips, StatusChip } from "./KeyCells.js";
import { ActivityTab, EventsTab, SettingsTab, UsageTab } from "./KeyTabs.js";
import type { KeyRow } from "./keys.js";
import { KEYS_COLLECTION, useKey } from "./useKey.js";

export const KEY_TABS = ["activity", "events", "usage", "settings"] as const;
export type KeyTab = (typeof KEY_TABS)[number];

/**
 * `/keys/:id[/:tab]`: the key's header (name, prefix, scopes, status, dates, today's usage),
 * Pause / Resume and Delete, and the tabs Activity, Events, Usage, Settings — each its own
 * path, so the data views' URL state (`?f=`, `?w=`) belongs to one tab.
 */
export function KeyPage() {
  const { t } = useI18n();
  const { id = "", tab = "activity" } = useParams();
  const key = useKey(id);
  if (!(KEY_TABS as readonly string[]).includes(tab))
    return <Navigate to={`/keys/${id}`} replace />;
  if (key.isPending) {
    return (
      <div className="page__center">
        <Spinner />
      </div>
    );
  }
  if (!key.data) {
    return (
      <div className="page">
        <Banner tone="bad" testId="key-missing">
          {t("KEY", "NOT_FOUND")} <Link to="/keys">{t("MENU", "KEYS")}</Link>
        </Banner>
      </div>
    );
  }
  return <KeyView apiKey={key.data} tab={tab as KeyTab} />;
}

function KeyView({ apiKey, tab }: { apiKey: KeyRow; tab: KeyTab }) {
  const { t } = useI18n();
  const when = useDateTime();
  return (
    <div className="page">
      <header className="keyhead" data-testid="key-header">
        <div className="keyhead__title">
          <h1>{apiKey.name}</h1>
          <code className="mono">mk_{apiKey.prefix}_…</code>
          <ScopeChips scopes={apiKey.scopes} />
          <StatusChip status={apiKey.status} />
        </div>
        <KeyActions apiKey={apiKey} />
        <dl className="keyhead__facts">
          <div>
            <dt>{t("KEY", "CREATED")}</dt>
            <dd>{when(apiKey.created_at)}</dd>
          </div>
          <div>
            <dt>{t("KEY", "LAST_USED")}</dt>
            <dd>{apiKey.last_used_at ? when(apiKey.last_used_at) : t("APP", "NEVER")}</dd>
          </div>
          <div>
            <dt>{t("KEY", "EXPIRES")}</dt>
            <dd>{apiKey.expires_at ? when(apiKey.expires_at) : t("APP", "NEVER")}</dd>
          </div>
          <div>
            <dt>{t("KEY", "TODAY")}</dt>
            <dd>
              <UsageBar used={apiKey.used_today} limit={apiKey.daily_limit} />
            </dd>
          </div>
        </dl>
      </header>
      <nav className="tabs" aria-label={apiKey.name} data-testid="key-tabs">
        {KEY_TABS.map((name) => (
          <NavLink
            key={name}
            to={name === "activity" ? `/keys/${apiKey.id}` : `/keys/${apiKey.id}/${name}`}
            end
            className={() => (name === tab ? "tabs__tab is-active" : "tabs__tab")}
            aria-current={name === tab ? "page" : undefined}
            data-testid={`tab-${name}`}
          >
            {t("KEY", `TAB_${name.toUpperCase()}`)}
          </NavLink>
        ))}
      </nav>
      <p className="chart__note" data-testid="polling-note">
        {t("KEY", "POLLING")}
      </p>
      {tab === "activity" ? <ActivityTab apiKey={apiKey} /> : null}
      {tab === "events" ? <EventsTab apiKey={apiKey} /> : null}
      {tab === "usage" ? <UsageTab apiKey={apiKey} /> : null}
      {tab === "settings" ? <SettingsTab apiKey={apiKey} /> : null}
    </div>
  );
}

/** Pause / Resume (`POST /keys/:id/disable|enable`) and Delete (the name typed back). */
function KeyActions({ apiKey }: { apiKey: KeyRow }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const refresh = () => queryClient.invalidateQueries({ queryKey: udcKeys.lists(KEYS_COLLECTION) });

  const toggle = async (disable: boolean) => {
    setBusy(true);
    try {
      await api("POST", `/keys/${apiKey.id}/${disable ? "disable" : "enable"}`);
      toast({
        title: t("KEY", disable ? "PAUSED" : "RESUMED"),
        variant: disable ? "warning" : "success",
      });
      await refresh();
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), variant: "danger" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="keyhead__actions">
      {apiKey.status === "active" ? (
        <Button disabled={busy} onClick={() => toggle(true)} data-testid="key-pause">
          <Pause aria-hidden className="btn__icon" />
          {t("KEY", "PAUSE")}
        </Button>
      ) : null}
      {apiKey.status === "disabled" ? (
        <Button
          variant="primary"
          disabled={busy}
          onClick={() => toggle(false)}
          data-testid="key-resume"
        >
          <Play aria-hidden className="btn__icon" />
          {t("KEY", "RESUME")}
        </Button>
      ) : null}
      <Button variant="danger" onClick={() => setDeleting(true)} data-testid="key-delete">
        <Trash2 aria-hidden className="btn__icon" />
        {t("KEY", "DELETE")}
      </Button>
      <DeleteKeyDialog apiKey={apiKey} open={deleting} onClose={() => setDeleting(false)} />
    </div>
  );
}

export function DeleteKeyDialog({
  apiKey,
  open,
  onClose,
}: {
  apiKey: KeyRow;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useI18n();
  const { toast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const confirmDelete = async () => {
    setBusy(true);
    setError(null);
    try {
      await api("DELETE", `/keys/${apiKey.id}`);
      toast({ title: t("KEY", "DELETED", { name: apiKey.name }), variant: "success" });
      queryClient.removeQueries({
        queryKey: [...udcKeys.lists(KEYS_COLLECTION), "read", apiKey.id],
      });
      await queryClient.invalidateQueries({ queryKey: udcKeys.lists(KEYS_COLLECTION) });
      navigate("/keys");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <DialogContent title={t("KEY", "DELETE_TITLE", { name: apiKey.name })} role="alertdialog">
        <DialogBody>
          <div className="form">
            <p>{t("KEY", "DELETE_TEXT")}</p>
            <input
              className="input"
              value={typed}
              aria-label={t("KEY", "DELETE_TEXT")}
              placeholder={apiKey.name}
              data-testid="delete-confirm"
              onChange={(e) => setTyped(e.target.value)}
            />
            {error ? <Banner tone="bad">{error}</Banner> : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("APP", "CANCEL")}
          </Button>
          <Button
            variant="danger"
            disabled={busy || typed.trim() !== apiKey.name}
            onClick={confirmDelete}
            data-testid="delete-submit"
          >
            {t("KEY", "DELETE")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
