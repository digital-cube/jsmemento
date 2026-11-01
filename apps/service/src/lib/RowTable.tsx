import type { Row } from "@jsudc/core";
import { type RendererDefinition, type RendererProps, useI18n } from "@jsudc/react";
import { Pager, tableRenderer } from "@jsudc/react/table";
import { Spinner } from "@jsudc/react/ui";
import { MoreRows } from "@memento/ui-shell";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { ComponentType, KeyboardEvent, ReactNode } from "react";

export type { RendererProps };

/** One column of a `RowTable`: a header, how a row's cell is drawn, the field it sorts on. */
export interface RowColumn {
  id: string;
  label: string;
  cell: (row: Row) => ReactNode;
  /** The collection field a header click sorts on; none: not sortable. */
  sortField?: string;
  align?: "left" | "right" | "center";
  width?: number;
}

/**
 * A `table` renderer of this site for one `<UdcDataView>`: the data view keeps doing search,
 * chips, filter, sort and paging through the protocol; this draws the rows — chips, bars,
 * buttons — and opens a row on click. Handed to the view as `renderers={…}` under the name
 * `table`, so the collection's view config (`available_renderers: [table]`) picks it.
 */
export function rowTableRenderer(component: ComponentType<RendererProps>): RendererDefinition {
  return { ...tableRenderer, component, editMode: false };
}

export function RowTable({
  view,
  columns,
  onRowClick,
  empty,
  testId,
  moreLabel,
}: {
  /** What `<UdcDataView>` handed the renderer. */
  view: RendererProps;
  columns: readonly RowColumn[];
  onRowClick?: (row: Row) => void;
  empty: ReactNode;
  testId: string;
  moreLabel: string;
}) {
  const { t } = useI18n();
  const { data, sort, onSort, mode, page, limit, onPage } = view;
  const sorted = (field: string) => sort.find((s) => s.field === field)?.dir;
  const open = (row: Row) => onRowClick?.(row);
  const onKey = (row: Row) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === "Enter") open(row);
  };
  return (
    <div className="rowtable" data-testid={testId} aria-busy={data.isFetching}>
      <table>
        <thead>
          <tr>
            {columns.map((c) => {
              const dir = c.sortField ? sorted(c.sortField) : undefined;
              const field = c.sortField;
              return (
                <th
                  key={c.id}
                  style={{ width: c.width, textAlign: c.align }}
                  aria-sort={
                    dir === "asc" ? "ascending" : dir === "desc" ? "descending" : undefined
                  }
                >
                  {field ? (
                    <button
                      type="button"
                      className="rowtable__sort"
                      onClick={(e) => onSort(field, e.shiftKey)}
                    >
                      {c.label}
                      {dir === "asc" ? <ArrowUp aria-hidden /> : null}
                      {dir === "desc" ? <ArrowDown aria-hidden /> : null}
                    </button>
                  ) : (
                    c.label
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row) => (
            <tr
              key={row.__meta.id}
              data-testid={`${testId}-row`}
              data-id={row.__meta.id}
              className={onRowClick ? "is-link" : undefined}
              tabIndex={onRowClick ? 0 : undefined}
              onClick={onRowClick ? () => open(row) : undefined}
              onKeyDown={onRowClick ? onKey(row) : undefined}
            >
              {columns.map((c) => (
                <td key={c.id} style={{ textAlign: c.align }}>
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.isLoading ? (
        <div className="page__center">
          <Spinner />
        </div>
      ) : data.error ? (
        <p className="rowtable__error" role="alert">
          {data.error.message}
        </p>
      ) : data.rows.length === 0 ? (
        <p className="rowtable__empty" data-testid={`${testId}-empty`}>
          {empty}
        </p>
      ) : null}
      {mode === "pages" && data.total !== null && data.total > limit ? (
        <Pager page={page} limit={limit} total={data.total} onPage={onPage} />
      ) : null}
      {mode === "infinite" && data.hasNextPage ? (
        <MoreRows loading={data.isFetchingNextPage} onMore={data.fetchNextPage}>
          {moreLabel || t("APP", "LOADING")}
        </MoreRows>
      ) : null}
    </div>
  );
}
