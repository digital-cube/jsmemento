import type { Row } from "@jsudc/core";
import { createRendererRegistry, UdcDataView, udcKeys, useI18n, useUdcClient } from "@jsudc/react";
import { Button, Spinner, useToast } from "@jsudc/react/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, useParams } from "react-router";
import { ScopeChips, StatusChip } from "../keys/KeyCells.js";
import { keyOf } from "../keys/keys.js";
import { api } from "../lib/api.js";
import { type RendererProps, type RowColumn, RowTable, rowTableRenderer } from "../lib/RowTable.js";
import { Banner, Chip, UsageBar, useDateTime } from "../lib/ui.js";
import { useUrlCondition } from "../lib/urlFilter.js";
import { ADMIN_USERS_COLLECTION, UserState, yes } from "./AdminUsers.js";

export const ADMIN_KEYS_COLLECTION = "admin_api_keys";

/** `/admin/users/:id`: the user's fields, Disable / Enable, and the keys of their tenant. */
export function AdminUserPage() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const client = useUdcClient();
  const user = useQuery<Row, Error>({
    queryKey: [...udcKeys.lists(ADMIN_USERS_COLLECTION), "read", id],
    queryFn: async () =>
      (await client.call("read", { collection: ADMIN_USERS_COLLECTION, id })).row,
    retry: false,
  });
  if (user.isPending) {
    return (
      <div className="page__center">
        <Spinner />
      </div>
    );
  }
  if (!user.data) {
    return (
      <div className="page">
        <Banner tone="bad">
          {t("ADMIN", "NOT_FOUND")} <Link to="/admin/users">{t("ADMIN", "BACK")}</Link>
        </Banner>
      </div>
    );
  }
  return <UserView user={user.data} />;
}

function UserView({ user }: { user: Row }) {
  const { t } = useI18n();
  const when = useDateTime();
  const email = String(user.email ?? "");
  return (
    <div className="page">
      <header className="keyhead" data-testid="admin-user">
        <div className="keyhead__title">
          <h1>{email}</h1>
          <UserState row={user} />
          {yes(user.is_admin) ? <Chip tone="info">admin</Chip> : null}
        </div>
        <div className="keyhead__actions">
          <Link className="btn btn--ghost" to="/admin/users">
            {t("ADMIN", "BACK")}
          </Link>
          <UserToggle user={user} />
        </div>
        <dl className="keyhead__facts">
          <div>
            <dt>{t("ADMIN", "COL_NAME")}</dt>
            <dd>{String(user.name ?? "")}</dd>
          </div>
          <div>
            <dt>{t("ADMIN", "COL_TENANT")}</dt>
            <dd>
              {String(user.tenant_name ?? "")}{" "}
              <code className="mono">{String(user.tenant ?? "")}</code>
            </dd>
          </div>
          <div>
            <dt>{t("ADMIN", "COL_VERIFIED")}</dt>
            <dd>{t("ADMIN", yes(user.email_verified) ? "YES" : "NO")}</dd>
          </div>
          <div>
            <dt>{t("ADMIN", "COL_CREATED")}</dt>
            <dd>{when(user.created_at)}</dd>
          </div>
        </dl>
      </header>
      <h2 className="section-title">{t("ADMIN", "KEYS")}</h2>
      <UserKeys email={email} />
    </div>
  );
}

function UserToggle({ user }: { user: Row }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const disabled = yes(user.disabled);
  const toggle = async () => {
    setBusy(true);
    try {
      await api("POST", `/admin/users/${user.__meta.id}/${disabled ? "enable" : "disable"}`);
      await queryClient.invalidateQueries({ queryKey: udcKeys.lists(ADMIN_USERS_COLLECTION) });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), variant: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      variant={disabled ? "primary" : "danger"}
      disabled={busy}
      onClick={toggle}
      data-testid="user-toggle"
    >
      {t("ADMIN", disabled ? "ENABLE" : "DISABLE")}
    </Button>
  );
}

/** `admin_api_keys` filtered on the user (`user eq <email>`), Disable / Enable per row. */
function UserKeys({ email }: { email: string }) {
  const ready = useUrlCondition({ field: "user", op: "eq", value: email });
  return (
    <section className="view" data-testid="admin-user-keys">
      {ready ? (
        <UdcDataView collection={ADMIN_KEYS_COLLECTION} renderers={ADMIN_KEYS_RENDERERS} />
      ) : null}
    </section>
  );
}

function AdminKeysTable(view: RendererProps) {
  const { t } = useI18n();
  const when = useDateTime();
  const columns: RowColumn[] = [
    {
      id: "name",
      label: t("KEYS", "COL_NAME"),
      sortField: "name",
      cell: (r) => <strong>{keyOf(r).name}</strong>,
    },
    {
      id: "prefix",
      label: t("KEYS", "COL_PREFIX"),
      cell: (r) => <code className="mono">mk_{keyOf(r).prefix}_…</code>,
    },
    {
      id: "scopes",
      label: t("KEYS", "COL_SCOPES"),
      cell: (r) => <ScopeChips scopes={keyOf(r).scopes} />,
    },
    {
      id: "status",
      label: t("KEYS", "COL_STATUS"),
      sortField: "status",
      cell: (r) => <StatusChip status={keyOf(r).status} />,
    },
    {
      id: "today",
      label: t("KEYS", "COL_TODAY"),
      cell: (r) => <UsageBar used={keyOf(r).used_today} limit={keyOf(r).daily_limit} />,
    },
    {
      id: "last_used",
      label: t("KEYS", "COL_LAST_USED"),
      sortField: "last_used_at",
      cell: (r) => when(r.last_used_at),
    },
    { id: "action", label: "", cell: (r) => <KeyToggle row={r} /> },
  ];
  return (
    <RowTable view={view} columns={columns} empty="—" testId="admin-keys-table" moreLabel="" />
  );
}

const ADMIN_KEYS_RENDERERS = createRendererRegistry(rowTableRenderer(AdminKeysTable));

/** Pause / resume any tenant's key (`POST /admin/keys/:id/disable|enable`). */
function KeyToggle({ row }: { row: Row }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const key = keyOf(row);
  if (key.status !== "active" && key.status !== "disabled") return null;
  const disable = key.status === "active";
  const toggle = async () => {
    setBusy(true);
    try {
      await api("POST", `/admin/keys/${key.id}/${disable ? "disable" : "enable"}`);
      await queryClient.invalidateQueries({ queryKey: udcKeys.lists(ADMIN_KEYS_COLLECTION) });
    } catch (error) {
      toast({ title: error instanceof Error ? error.message : String(error), variant: "danger" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Button
      size="sm"
      variant={disable ? "danger" : "primary"}
      disabled={busy}
      onClick={toggle}
      data-testid="admin-key-toggle"
    >
      {t("ADMIN", disable ? "DISABLE" : "ENABLE")}
    </Button>
  );
}
