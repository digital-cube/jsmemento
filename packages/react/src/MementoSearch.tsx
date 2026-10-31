import { INSTANCE_TYPES, type MementoEvent } from "@memento/core";
import { type FormEvent, type ReactNode, useEffect, useId, useState } from "react";
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

/** What the form holds: the values a search is made of, as typed (dates as `YYYY-MM-DD`). */
export interface MementoSearchValues {
  /** Empty: any type. */
  instanceType: string;
  /** Exact, or a prefix with a trailing `*`. Empty: any instance. */
  instanceId: string;
  /** First local calendar day, inclusive. Empty: open start. */
  from: string;
  /** Last local calendar day, inclusive. Empty: open-ended (results stay live). */
  to: string;
}

/**
 * The events query of a search: the type and id as they are, the days as the instants the
 * range starts and ends (`to` is inclusive, so it ends at the start of the next day).
 */
export function searchQuery(values: MementoSearchValues): EventsQuery {
  return {
    instance_type: values.instanceType || undefined,
    instance_id: values.instanceId.trim() || undefined,
    after: dayStart(values.from),
    before: dayStart(values.to, 1),
  };
}

export interface MementoSearchProps extends TimeFormat {
  /** Choices of the instance type selector. Default: the vocabulary in `lookups.yaml`. */
  instanceTypes?: readonly string[];
  /** Most results shown. Default 100. */
  limit?: number;
  /**
   * The search shown, when the caller keeps it (e.g. in the page's URL): `null` for none
   * yet. The form follows it when it changes. Leave it out to let the component keep it.
   */
  search?: MementoSearchValues | null;
  /** Called with the values of every valid search the form submits. */
  onSearch?: (values: MementoSearchValues) => void;
  /** The Instance cell of a result (e.g. a link to the instance). Default: type and id. */
  renderInstance?: (event: MementoEvent) => ReactNode;
}

const emptyForm = (instanceTypes: readonly string[]): MementoSearchValues => ({
  instanceType: instanceTypes[0] ?? "",
  instanceId: "",
  from: "",
  to: "",
});

/**
 * Search an entity's history: instance type, instance id (`prefix*` allowed) and a date
 * range, sent as a Filter DSL tree to `POST /events/query`. Results stay live while the
 * range is open-ended.
 */
export function MementoSearch({
  instanceTypes = INSTANCE_TYPES,
  limit = 100,
  search,
  onSearch,
  renderInstance,
  locale,
  timeZone,
}: MementoSearchProps) {
  const controlled = search !== undefined;
  const [own, setOwn] = useState<MementoSearchValues | null>(null);
  const submitted = controlled ? search : own;
  const [form, setForm] = useState<MementoSearchValues>(
    () => submitted ?? emptyForm(instanceTypes),
  );
  const [invalid, setInvalid] = useState<string | null>(null);
  const id = useId();
  const query = submitted ? searchQuery(submitted) : null;
  const { events, status, loading, error, liveIds } = useMementoEvents(query ?? {}, {
    enabled: query !== null,
    live: query !== null && !query.before,
    limit,
    endpoint: "query",
  });

  // A search kept by the caller changed (browser back, a link): the form shows it.
  const submittedKey = controlled ? JSON.stringify(search) : null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: follows the value, not its identity.
  useEffect(() => {
    if (submittedKey === null) return;
    setForm((JSON.parse(submittedKey) as MementoSearchValues | null) ?? emptyForm(instanceTypes));
  }, [submittedKey]);

  const field =
    (name: keyof MementoSearchValues) =>
    (event: { target: { value: string } }): void =>
      setForm((current) => ({ ...current, [name]: event.target.value }));

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (form.from && form.to && form.from > form.to) {
      setInvalid("The start date is after the end date.");
      return;
    }
    setInvalid(null);
    const values = { ...form, instanceId: form.instanceId.trim() };
    if (!controlled) setOwn(values);
    onSearch?.(values);
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
          renderInstance={renderInstance}
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
