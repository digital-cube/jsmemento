import { type ViewConfigInput, ViewConfigSchema } from "@jsudc/core";
import { CollectionRegistry } from "@jsudc/server";
import { eq } from "drizzle-orm";
import type { Database } from "../db/client.js";
import { events } from "../db/schema.js";
import type { EventRenderer } from "../templates/renderer.js";
import { EventCollectionSource, type EventField, payloadNumber } from "./source.js";

/** The memento event types the CPU monitor demo pushes. */
export const CPU_LOAD_EVENT_TYPE = "CPU_LOAD";

const occurredAt: EventField = {
  def: { type: "datetime", index: true, description: "When it happened at the producer" },
  kind: "time",
  expr: events.occurredAt,
  value: (e) => e.occurred_at,
};
const text = (
  expr: EventField["expr"],
  value: EventField["value"],
  description: string,
): EventField => ({ def: { type: "string", index: true, description }, kind: "text", expr, value });

const instanceType = text(events.instanceType, (e) => e.instance_type, "user, ticket, server, …");
const instanceId = text(events.instanceId, (e) => e.instance_id, "Which instance");
const rendered: EventField = {
  def: { type: "text", description: "Human-readable text of the event" },
  kind: "text",
  expr: events.rendered,
  value: (e) => e.rendered,
};

/** Every event of the tenant: the generic activity log. */
export const EVENTS_FIELDS: Record<string, EventField> = {
  occurred_at: occurredAt,
  event_type: text(events.eventType, (e) => e.event_type, "USER_LOGIN, CPU_LOAD, …"),
  instance_type: instanceType,
  instance_id: instanceId,
  actor_id: text(events.actorId, (e) => e.actor_id, "Who did it"),
  rendered,
  payload: {
    def: { type: "json", description: "Event-specific data" },
    kind: "json",
    expr: events.payload,
    sortable: false,
    value: (e) => e.payload,
  },
  received_at: {
    def: { type: "datetime", description: "When memento stored it" },
    kind: "time",
    expr: events.receivedAt,
    value: (e) => e.received_at,
  },
};

const load = (key: string, description: string): EventField => ({
  def: { type: "decimal", min: 0, index: true, description },
  kind: "number",
  expr: payloadNumber(key),
  value: (e) => {
    const v = e.payload[key];
    return typeof v === "number" && Number.isFinite(v) ? v : null;
  },
});

/** `CPU_LOAD` events only, with the load averages lifted out of `payload` into columns. */
export const CPU_LOAD_FIELDS: Record<string, EventField> = {
  occurred_at: occurredAt,
  instance_type: instanceType,
  instance_id: instanceId,
  load_1min: load("load_1min", "Load average over 1 minute"),
  load_5min: load("load_5min", "Load average over 5 minutes"),
  load_15min: load("load_15min", "Load average over 15 minutes"),
  rendered,
};

/** Seconds matter here: the CPU monitor stores one sample a second. */
const occurredAtColumn = {
  field: "occurred_at",
  width: 190,
  transform: "date_format:YYYY-MM-DD HH:mm:ss",
};

const loadColumn = (field: string) => ({
  field,
  align: "right" as const,
  width: 110,
  render: "number_format",
  render_options: { decimals: 2 },
});

export const EVENTS_VIEW: ViewConfigInput = {
  default_renderer: "table",
  available_renderers: ["table"],
  page_size_default: 50,
  columns: [
    occurredAtColumn,
    { field: "event_type", width: 170 },
    { field: "instance_type", width: 120 },
    { field: "instance_id", width: 160 },
    { field: "actor_id", width: 120 },
    { field: "rendered", width: 420 },
  ],
  search: { fields: ["rendered", "instance_id", "actor_id"] },
};

export const CPU_LOAD_VIEW: ViewConfigInput = {
  default_renderer: "table",
  available_renderers: ["table", "chart"],
  page_size_default: 50,
  columns: [
    occurredAtColumn,
    { field: "instance_type", width: 120 },
    { field: "instance_id", width: 150 },
    loadColumn("load_1min"),
    loadColumn("load_5min"),
    loadColumn("load_15min"),
    { field: "rendered", width: 420 },
  ],
  search: { fields: ["instance_id", "rendered"] },
  filters: [{ field: "instance_type", kind: "select", options: ["server"] }],
  chart_options: {
    type: "line",
    x_field: "occurred_at",
    series: [
      { field: "load_1min", label: "1 min" },
      { field: "load_5min", label: "5 min" },
      { field: "load_15min", label: "15 min" },
    ],
    y_axis: { left: { baseline: "zero" } },
    max_rows: 600,
  },
};

export interface EventCollectionsOptions {
  db: Database;
  /** Fills `rendered` for events stored without it, as the REST list does. */
  renderer?: EventRenderer;
}

/** The registry memento serves under `/udc`: `events` and `cpu_load`. */
export function eventCollections({ db, renderer }: EventCollectionsOptions): CollectionRegistry {
  const registry = new CollectionRegistry();
  registry.register({
    name: "events",
    label: "Events",
    source: new EventCollectionSource(db, { fields: EVENTS_FIELDS }, renderer),
    view: ViewConfigSchema.parse(EVENTS_VIEW),
  });
  registry.register({
    name: "cpu_load",
    label: "CPU load",
    source: new EventCollectionSource(
      db,
      { fields: CPU_LOAD_FIELDS, where: eq(events.eventType, CPU_LOAD_EVENT_TYPE) },
      renderer,
    ),
    view: ViewConfigSchema.parse(CPU_LOAD_VIEW),
  });
  return registry;
}
