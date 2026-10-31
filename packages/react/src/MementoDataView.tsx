import { EVENT_TYPES, INSTANCE_TYPES } from "@memento/core";
import { useId, useState } from "react";
import { EventTable, type Sort } from "./EventTable.js";
import type { TimeFormat } from "./format.js";
import { type EventsQuery, useMementoEvents } from "./hooks.js";
import { StatusIndicator } from "./StatusIndicator.js";

/** `USER_LOGIN`, `USER_LOGOUT`, `CHAT_…` → `USER_*`, `CHAT_*` (families with 2+ members). */
export function eventTypeFamilies(types: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const type of types) {
    const head = type.split("_")[0] as string;
    if (head !== type) counts.set(head, (counts.get(head) ?? 0) + 1);
  }
  return [...counts].filter(([, n]) => n > 1).map(([head]) => `${head}_*`);
}

export interface MementoDataViewProps extends TimeFormat {
  title?: string;
  /** Choices of the event filter. Default: the vocabulary in `lookups.yaml`. */
  eventTypes?: readonly string[];
  /** Choices of the instance type filter. Default: the vocabulary in `lookups.yaml`. */
  instanceTypes?: readonly string[];
  /** Filter the view starts with. */
  initialFilter?: { event_type?: string; instance_type?: string };
  /** Fixed filters the user cannot change (e.g. one `instance_id`). */
  scope?: Pick<EventsQuery, "instance_id" | "actor_id">;
  /** Events loaded at first. Default 50. */
  limit?: number;
  /** Stream new events into the table. Default `true`. */
  live?: boolean;
  defaultSort?: Sort;
}

/** A live table of events with event type and instance type filters. */
export function MementoDataView({
  title = "Events",
  eventTypes = EVENT_TYPES,
  instanceTypes = INSTANCE_TYPES,
  initialFilter = {},
  scope = {},
  limit = 50,
  live = true,
  defaultSort,
  locale,
  timeZone,
}: MementoDataViewProps) {
  const [eventType, setEventType] = useState(initialFilter.event_type ?? "");
  const [instanceType, setInstanceType] = useState(initialFilter.instance_type ?? "");
  const id = useId();
  const { events, status, loading, error, liveIds, reload } = useMementoEvents(
    { ...scope, event_type: eventType, instance_type: instanceType },
    { limit, live },
  );
  const families = eventTypeFamilies(eventTypes);
  const known = (value: string, options: readonly string[]) => !value || options.includes(value);

  return (
    <section className="memento memento-dataview" aria-labelledby={`${id}-title`}>
      <header className="memento-toolbar">
        <h2 id={`${id}-title`} className="memento-title">
          {title}
        </h2>
        <div className="memento-filters">
          <label className="memento-field">
            <span>Event</span>
            <select value={eventType} onChange={(e) => setEventType(e.target.value)}>
              <option value="">All events</option>
              {families.length > 0 ? (
                <optgroup label="Families">
                  {families.map((family) => (
                    <option key={family} value={family}>
                      {family}
                    </option>
                  ))}
                </optgroup>
              ) : null}
              <optgroup label="Event types">
                {eventTypes.map((type) => (
                  <option key={type} value={type}>
                    {type}
                  </option>
                ))}
              </optgroup>
              {known(eventType, [...eventTypes, ...families]) ? null : (
                <option value={eventType}>{eventType}</option>
              )}
            </select>
          </label>
          <label className="memento-field">
            <span>Instance type</span>
            <select value={instanceType} onChange={(e) => setInstanceType(e.target.value)}>
              <option value="">All types</option>
              {instanceTypes.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
              {known(instanceType, instanceTypes) ? null : (
                <option value={instanceType}>{instanceType}</option>
              )}
            </select>
          </label>
        </div>
        <StatusIndicator status={status} />
      </header>
      {error ? (
        <p className="memento-error" role="alert">
          Could not load events: {error.message}{" "}
          <button type="button" className="memento-link" onClick={reload}>
            Try again
          </button>
        </p>
      ) : null}
      <EventTable
        events={events}
        liveIds={liveIds}
        locale={locale}
        timeZone={timeZone}
        {...(defaultSort ? { defaultSort } : {})}
        empty={loading ? "Loading events…" : "No events match these filters yet."}
      />
    </section>
  );
}
