import type { MementoEvent } from "@memento/core";
import { type ReactNode, useMemo, useState } from "react";
import { formatDate, formatTime, type TimeFormat } from "./format.js";

export type SortField = "occurred_at" | "event_type" | "instance" | "actor_id";
export interface Sort {
  field: SortField;
  dir: "asc" | "desc";
}

export const DEFAULT_SORT: Sort = { field: "occurred_at", dir: "desc" };

const COLUMNS: { field: SortField | "rendered"; label: string }[] = [
  { field: "occurred_at", label: "When" },
  { field: "event_type", label: "Event" },
  { field: "instance", label: "Instance" },
  { field: "actor_id", label: "Actor" },
  { field: "rendered", label: "What happened" },
];

const sortValue = (event: MementoEvent, field: SortField): string =>
  field === "instance"
    ? `${event.instance_type}/${event.instance_id}`
    : field === "occurred_at"
      ? new Date(event.occurred_at).toISOString()
      : (event[field] ?? "");

/** `events` ordered by `sort`; ties keep the newest first. */
export function sortEvents(events: MementoEvent[], sort: Sort): MementoEvent[] {
  const sign = sort.dir === "asc" ? 1 : -1;
  return [...events].sort((a, b) => {
    const left = sortValue(a, sort.field);
    const right = sortValue(b, sort.field);
    if (left !== right) return left < right ? -sign : sign;
    return b.occurred_at.localeCompare(a.occurred_at);
  });
}

export interface EventTableProps extends TimeFormat {
  events: MementoEvent[];
  /** Ids to highlight as just arrived. */
  liveIds?: ReadonlySet<string>;
  /** Initial order. Default: newest first. */
  defaultSort?: Sort;
  /** Shown instead of rows when there are none. */
  empty?: ReactNode;
  caption?: string;
  /** The Instance cell's content (e.g. a link to the instance). Default: type and id. */
  renderInstance?: ((event: MementoEvent) => ReactNode) | undefined;
}

/** The events as a sortable table: when, event, instance, actor, what happened. */
export function EventTable({
  events,
  liveIds,
  defaultSort = DEFAULT_SORT,
  empty = "No events yet.",
  caption,
  renderInstance,
  locale,
  timeZone,
}: EventTableProps) {
  const [sort, setSort] = useState<Sort>(defaultSort);
  const rows = useMemo(() => sortEvents(events, sort), [events, sort]);
  const toggle = (field: SortField) =>
    setSort((current) =>
      current.field === field
        ? { field, dir: current.dir === "asc" ? "desc" : "asc" }
        : { field, dir: field === "occurred_at" ? "desc" : "asc" },
    );

  return (
    <div className="memento-table-wrap">
      <table className="memento-table">
        {caption ? <caption>{caption}</caption> : null}
        <thead>
          <tr>
            {COLUMNS.map((column) => {
              if (column.field === "rendered") {
                return (
                  <th key={column.field} scope="col">
                    {column.label}
                  </th>
                );
              }
              const field = column.field;
              const active = sort.field === field;
              return (
                <th
                  key={field}
                  scope="col"
                  aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
                >
                  <button
                    type="button"
                    className="memento-sort"
                    data-active={active || undefined}
                    onClick={() => toggle(field)}
                  >
                    {column.label}
                    <span className="memento-sort__arrow" aria-hidden="true">
                      {active ? (sort.dir === "asc" ? "▲" : "▼") : "△"}
                    </span>
                  </button>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={COLUMNS.length} className="memento-table__empty">
                {empty}
              </td>
            </tr>
          ) : (
            rows.map((event) => (
              <tr
                key={event.id}
                data-event-id={event.id}
                className={liveIds?.has(event.id) ? "memento-row--new" : undefined}
              >
                <td className="memento-cell-when">
                  <time dateTime={event.occurred_at}>
                    <span className="memento-cell-when__time">
                      {formatTime(event.occurred_at, { locale, timeZone })}
                    </span>
                    <span className="memento-cell-when__date">
                      {formatDate(event.occurred_at, { locale, timeZone })}
                    </span>
                  </time>
                </td>
                <td>
                  <span className="memento-type">{event.event_type}</span>
                </td>
                <td className="memento-cell-instance">
                  {renderInstance ? (
                    renderInstance(event)
                  ) : (
                    <>
                      <span className="memento-cell-instance__type">{event.instance_type}</span>
                      {event.instance_id}
                    </>
                  )}
                </td>
                <td>{event.actor_id ?? <span className="memento-muted">none</span>}</td>
                <td className="memento-cell-story">{event.rendered ?? ""}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
