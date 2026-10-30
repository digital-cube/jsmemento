import {
  type Cursor,
  decodeCursor,
  type EntityRef,
  EntityRefSchema,
  type EventInput,
  EventInputSchema,
  type EventQuery,
  type EventQueryInput,
  EventQuerySchema,
  encodeCursor,
  eventQueryToFilter,
  type Filter,
  type MementoEvent,
  type PageMeta,
} from "@memento/core";
import { and, asc, desc, eq, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import { requireTenant } from "../context.js";
import type { Database } from "../db/client.js";
import { compileFilter } from "../db/filter.js";
import { type EventRow, events } from "../db/schema.js";
import { MementoError } from "../errors.js";
import type { EventPublisher } from "../publisher.js";

export function serializeEvent(row: EventRow): MementoEvent {
  return {
    id: row.id,
    occurred_at: row.occurredAt.toISOString(),
    received_at: row.receivedAt.toISOString(),
    event_type: row.eventType,
    instance_type: row.instanceType,
    instance_id: row.instanceId,
    actor_id: row.actorId,
    payload: row.payload,
    rendered: row.rendered,
    archived_at: row.archivedAt?.toISOString() ?? null,
  };
}

export interface PushOptions {
  publisher: EventPublisher;
  /** Called when publishing fails; the event is stored either way. */
  onPublishError?: (error: unknown) => void;
}

/** Validates, stores and announces one event for the current tenant. */
export async function pushEvent(
  db: Database,
  input: EventInput,
  options: PushOptions,
): Promise<MementoEvent> {
  const tenant = requireTenant();
  const parsed = EventInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new MementoError("validation_error", "invalid event", parsed.error.issues);
  }
  const data = parsed.data;
  const [row] = await db
    .insert(events)
    .values({
      tenantId: tenant.tenantId,
      occurredAt: data.occurred_at ? new Date(data.occurred_at) : new Date(),
      eventType: data.event_type,
      instanceType: data.instance_type,
      instanceId: data.instance_id,
      actorId: data.actor_id ?? null,
      payload: data.payload,
      rendered: data.rendered ?? null,
    })
    .returning();
  const event = serializeEvent(row as EventRow);
  try {
    await options.publisher.publish({ tenant: tenant.tenantSlug, event });
  } catch (error) {
    options.onPublishError?.(error);
  }
  return event;
}

export interface EventPage {
  events: MementoEvent[];
  meta: PageMeta;
}

function afterCursor(cursor: Cursor, order: "asc" | "desc"): SQL {
  const at = new Date(cursor.occurred_at);
  const past = order === "desc" ? lt : gt;
  return or(
    past(events.occurredAt, at),
    and(eq(events.occurredAt, at), past(events.id, cursor.id)),
  ) as SQL;
}

/**
 * Lists the current tenant's events, newest first by default, with keyset pagination.
 * `filter` (Filter DSL) is ANDed with the query-string filters.
 */
export async function listEvents(
  db: Database,
  input: EventQueryInput | EventQuery,
  filter: Filter | null = null,
): Promise<EventPage> {
  const tenant = requireTenant();
  const parsed = EventQuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new MementoError("validation_error", "invalid query", parsed.error.issues);
  }
  const query = parsed.data;
  const where: (SQL | undefined)[] = [eq(events.tenantId, tenant.tenantId)];
  if (!query.include_archived) where.push(isNull(events.archivedAt));
  const queryFilter = eventQueryToFilter(query);
  if (queryFilter) where.push(compileFilter(queryFilter));
  if (filter) where.push(compileFilter(filter));
  if (query.cursor) {
    const cursor = decodeCursor(query.cursor);
    if (!cursor) throw new MementoError("bad_request", "invalid cursor");
    where.push(afterCursor(cursor, query.order));
  }
  const direction = query.order === "desc" ? desc : asc;
  const rows = await db
    .select()
    .from(events)
    .where(and(...where))
    .orderBy(direction(events.occurredAt), direction(events.id))
    .limit(query.limit + 1);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const next =
    rows.length > query.limit && last
      ? encodeCursor({ occurred_at: last.occurredAt.toISOString(), id: last.id })
      : null;
  return {
    events: page.map(serializeEvent),
    meta: { limit: query.limit, count: page.length, next_cursor: next },
  };
}

/** The history of one entity (`user/42`, `chat/igor-marko`). */
export async function entityHistory(
  db: Database,
  entity: { instance_type: string; instance_id: string },
  input: Omit<EventQueryInput, "instance_type" | "instance_id"> = {},
): Promise<EventPage> {
  const parsed = EntityRefSchema.safeParse(entity);
  if (!parsed.success) {
    throw new MementoError("validation_error", "invalid entity", parsed.error.issues);
  }
  const ref: EntityRef = parsed.data;
  const { instance_type: _type, instance_id: _id, ...rest } = input as EventQueryInput;
  return listEvents(db, rest, {
    and: [
      { field: "instance_type", op: "eq", value: ref.instance_type },
      { field: "instance_id", op: "eq", value: ref.instance_id },
    ],
  });
}
