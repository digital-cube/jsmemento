import { createRendererRegistry, useI18n } from "@jsudc/react";
import { useNavigate } from "react-router";
import { type RendererProps, type RowColumn, RowTable, rowTableRenderer } from "../lib/RowTable.js";
import { useDateTime } from "../lib/ui.js";
import { ScopeChips, StatusChip, UsageBar } from "./KeyCells.js";
import { keyOf } from "./keys.js";

/**
 * The `api_keys` table: name, prefix, scopes as chips, status as a chip, used today / daily
 * limit as a bar, last used, created; a row opens `/keys/:id`.
 */
function KeysTable(view: RendererProps) {
  const { t } = useI18n();
  const navigate = useNavigate();
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
      sortField: "prefix",
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
      cell: (r) => {
        const k = keyOf(r);
        return <UsageBar used={k.used_today} limit={k.daily_limit} />;
      },
    },
    {
      id: "last_used",
      label: t("KEYS", "COL_LAST_USED"),
      sortField: "last_used_at",
      cell: (r) => when(r.last_used_at),
    },
    {
      id: "created",
      label: t("KEYS", "COL_CREATED"),
      sortField: "created_at",
      cell: (r) => when(r.created_at),
    },
  ];
  return (
    <RowTable
      view={view}
      columns={columns}
      onRowClick={(row) => navigate(`/keys/${row.__meta.id}`)}
      empty={t("KEYS", "EMPTY")}
      testId="keys-table"
      moreLabel={t("KEYS", "MORE")}
    />
  );
}

/** `renderers` of the keys' `<UdcDataView>`: this table under the name `table`. */
export const KEYS_RENDERERS = createRendererRegistry(rowTableRenderer(KeysTable));
