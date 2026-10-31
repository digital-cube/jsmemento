import { INSTANCE_TYPES } from "@memento/core";
import { type FormEvent, useId, useState } from "react";
import { EventTable } from "./EventTable.js";
import type { TimeFormat } from "./format.js";
import { type EventsQuery, useMementoEvents } from "./hooks.js";
import { StatusIndicator } from "./StatusIndicator.js";

/** Start of a local calendar day (`2026-10-31`) as ISO-8601, or `undefined`. */
export function dayStart(day: string, offsetDays = 0): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return undefined;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  return new Date(y, m - 1, d + offsetDays).toISOString();
}

export interface MementoSearchProps extends TimeFormat {
  /** Choices of the instance type selector. Default: the vocabulary in `lookups.yaml`. */
  instanceTypes?: readonly string[];
  /** Most results shown. Default 100. */
  limit?: number;
}

interface SearchForm {
  instanceType: string;
  instanceId: string;
  from: string;
  to: string;
}

/**
 * Search an entity's history: instance type, instance id (`prefix*` allowed) and a date
 * range. Results stay live while the range is open-ended.
 */
export function MementoSearch({
  instanceTypes = INSTANCE_TYPES,
  limit = 100,
  locale,
  timeZone,
}: MementoSearchProps) {
  const [form, setForm] = useState<SearchForm>({
    instanceType: instanceTypes[0] ?? "",
    instanceId: "",
    from: "",
    to: "",
  });
  const [query, setQuery] = useState<EventsQuery | null>(null);
  const [invalid, setInvalid] = useState<string | null>(null);
  const id = useId();
  const { events, status, loading, error, liveIds } = useMementoEvents(query ?? {}, {
    enabled: query !== null,
    live: query !== null && !query.before,
    limit,
  });

  const field =
    (name: keyof SearchForm) =>
    (event: { target: { value: string } }): void =>
      setForm((current) => ({ ...current, [name]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (form.from && form.to && form.from > form.to) {
      setInvalid("The start date is after the end date.");
      return;
    }
    setInvalid(null);
    const after = dayStart(form.from);
    // The end date is inclusive: search up to the start of the next day.
    const before = dayStart(form.to, 1);
    setQuery({
      instance_type: form.instanceType || undefined,
      instance_id: form.instanceId.trim() || undefined,
      after,
      before,
    });
  };

  return (
    <section className="memento memento-search" aria-labelledby={`${id}-title`}>
      <header className="memento-toolbar">
        <h2 id={`${id}-title`} className="memento-title">
          Search
        </h2>
        {query ? <StatusIndicator status={status} /> : null}
      </header>
      <form className="memento-filters memento-search__form" onSubmit={submit}>
        <label className="memento-field">
          <span>Instance type</span>
          <select value={form.instanceType} onChange={field("instanceType")}>
            <option value="">Any type</option>
            {instanceTypes.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
        </label>
        <label className="memento-field memento-field--grow">
          <span>Instance ID</span>
          <input
            value={form.instanceId}
            onChange={field("instanceId")}
            placeholder="42, chat-123, or igor-*"
          />
        </label>
        <label className="memento-field">
          <span>From</span>
          <input type="date" value={form.from} onChange={field("from")} />
        </label>
        <label className="memento-field">
          <span>To</span>
          <input type="date" value={form.to} onChange={field("to")} />
        </label>
        <button type="submit" className="memento-button">
          Search
        </button>
      </form>
      {invalid || error ? (
        <p className="memento-error" role="alert">
          {invalid ?? `Search failed: ${error?.message}`}
        </p>
      ) : null}
      {query ? (
        <EventTable
          events={events}
          liveIds={liveIds}
          locale={locale}
          timeZone={timeZone}
          empty={loading ? "Searching…" : "Nothing found for this search."}
        />
      ) : (
        <p className="memento-hint">Pick an instance and a date range, then search.</p>
      )}
    </section>
  );
}
