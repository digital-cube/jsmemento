import type { Row } from "@jsudc/core";
import { createRendererRegistry, UdcDataView, useI18n } from "@jsudc/react";
import { useNavigate } from "react-router";
import { type RendererProps, type RowColumn, RowTable, rowTableRenderer } from "../lib/RowTable.js";
import { Chip, useDateTime } from "../lib/ui.js";

export const ADMIN_USERS_COLLECTION = "admin_users";

/** `bool` cells of `admin_users`: the server serves them as booleans. */
const yes = (v: unknown) => v === true || v === "true";

function UsersTable(view: RendererProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
  const when = useDateTime();
  const flag = (on: boolean, tone: "ok" | "info" = "ok") => (
    <Chip tone={on ? tone : "muted"}>{t("ADMIN", on ? "YES" : "NO")}</Chip>
  );
  const columns: RowColumn[] = [
    {
      id: "email",
      label: t("ADMIN", "COL_EMAIL"),
      sortField: "email",
      cell: (r) => <strong>{String(r.email ?? "")}</strong>,
    },
    {
      id: "name",
      label: t("ADMIN", "COL_NAME"),
      sortField: "name",
      cell: (r) => String(r.name ?? ""),
    },
    {
      id: "tenant",
      label: t("ADMIN", "COL_TENANT"),
      sortField: "tenant",
      cell: (r) => <code className="mono">{String(r.tenant ?? "")}</code>,
    },
    { id: "verified", label: t("ADMIN", "COL_VERIFIED"), cell: (r) => flag(yes(r.email_verified)) },
    { id: "admin", label: t("ADMIN", "COL_ADMIN"), cell: (r) => flag(yes(r.is_admin), "info") },
    { id: "state", label: t("ADMIN", "COL_STATE"), cell: (r) => <UserState row={r} /> },
    {
      id: "keys",
      label: t("ADMIN", "COL_KEYS"),
      sortField: "keys",
      align: "right",
      cell: (r) => String(r.keys ?? 0),
    },
    {
      id: "created",
      label: t("ADMIN", "COL_CREATED"),
      sortField: "created_at",
      cell: (r) => when(r.created_at),
    },
  ];
  return (
    <RowTable
      view={view}
      columns={columns}
      onRowClick={(row) => navigate(`/admin/users/${row.__meta.id}`)}
      empty="—"
      testId="users-table"
      moreLabel=""
    />
  );
}

export function UserState({ row }: { row: Row }) {
  const { t } = useI18n();
  const disabled = yes(row.disabled);
  return (
    <Chip tone={disabled ? "bad" : "ok"}>{t("ADMIN", disabled ? "DISABLED" : "ENABLED")}</Chip>
  );
}

export const USERS_RENDERERS = createRendererRegistry(rowTableRenderer(UsersTable));

/** `/admin/users` (administrators): every user; a row opens `/admin/users/:id`. */
export function AdminUsersPage() {
  const { t } = useI18n();
  return (
    <div className="page">
      <header className="bar">
        <div className="bar__title">
          <h1>{t("ADMIN", "USERS")}</h1>
          <span className="bar__sub">{t("ADMIN", "USERS_SUB")}</span>
        </div>
      </header>
      <section className="view" data-testid="admin-users">
        <UdcDataView collection={ADMIN_USERS_COLLECTION} renderers={USERS_RENDERERS} />
      </section>
    </div>
  );
}

export { yes };
