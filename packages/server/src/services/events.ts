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
  FREE_TEXT_EVENT_TYPES,
  type MementoEvent,
  type PageMeta,
} from "@memento/core";
import { and, asc, desc, eq, gt, isNull, lt, or, type SQL } from "drizzle-orm";
import { requireTenant } from "../context.js";
import type { Database } from "../db/client.js";
import { compileFilter } from "../db/filter.js";
import { type EventRow, events } from "../db/schema.js";
import { MementoError } from "../errors.js";
import { type Lookups, recordCandidates, unknownLookups } from "../lookups.js";
import type { EventPublisher } from "../publisher.js";
import type { EventRenderer } from "../templates/renderer.js";

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
    rendered_locale: row.renderedLocale,
    archived_at: row.archivedAt?.toISOString() ?? null,
  };
}

export interface PushOptions {
  publisher: EventPublisher;
  /** Called when publishing fails; the event is stored either way. */
  onPublishError?: (error: unknown) => void;
  /** Renders `rendered` when the producer did not send it. Without one it stays `null`. */
  renderer?: EventRenderer;
  /** Locale to render in (default: the renderer's default locale). */
  locale?: string;
  /** Vocabulary: strict mode rejects unknown values, otherwise they become candidates. */
  lookups?: Lookups;
}

/** Validates, renders, stores and announces one event for the current tenant. */
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
  if (
    FREE_TEXT_EVENT_TYPES.includes(data.event_type) &&
    !data.rendered &&
    (typeof data.payload.text !== "string" || !data.payload.text.trim())
  ) {
    throw new MementoError("validation_error", `${data.event_type} needs payload.text`, [
      { path: ["payload", "text"], message: "free-text events carry their text in payload.text" },
    ]);
  }
  const lookups = options.lookups;
  if (lookups?.strict) {
    const unknown = unknownLookups(lookups, data);
    if (Object.keys(unknown).length > 0) {
      throw new MementoError(
        "validation_error",
        "unknown lookup values",
        Object.entries(unknown).map(([section, value]) => ({
          section,
          value,
          message: `"${value}" is not in ${section}`,
        })),
      );
    }
  }
  const occurredAt = data.occurred_at ? new Date(data.occurred_at) : new Date();
  let rendered: string | null = data.rendered ?? null;
  let renderedLocale: string | null = null;
  if (!rendered && options.renderer) {
    const result = await options.renderer.render(
      tenant.tenantId,
      {
        event_type: data.event_type,
        instance_type: data.instance_type,
        instance_id: data.instance_id,
        actor_id: data.actor_id ?? null,
        occurred_at: occurredAt.toISOString(),
        payload: data.payload,
      },
      options.locale,
    );
    rendered = result.text;
    renderedLocale = result.locale;
  }
  const [row] = await db
    .insert(events)
    .values({
      tenantId: tenant.tenantId,
      occurredAt,
      eventType: data.event_type,
      instanceType: data.instance_type,
      instanceId: data.instance_id,
      actorId: data.actor_id ?? null,
      payload: data.payload,
      rendered,
      renderedLocale,
    })
    .returning();
  const event = serializeEvent(row as EventRow);
  try {
    await options.publisher.publish({ tenant: tenant.tenantSlug, event });
  } catch (error) {
    options.onPublishError?.(error);
  }
  if (lookups) await recordCandidates(lookups, data);
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

export interface ListOptions {
  /** Renders `rendered` in the query's `locale`, and fills it for events stored without. */
  renderer?: EventRenderer;
}

/** Whether an event's `rendered` has to be (re)rendered for `locale`. */
function needsRendering(event: MementoEvent, locale: string | undefined): boolean {
  if (event.rendered !== null && event.rendered_locale === null) return false; // verbatim
  if (event.rendered === null) return true;
  return locale !== undefined && event.rendered_locale !== locale;
}

/**
 * Gives every event a `rendered` text in `locale`. The stored text is used when it is
 * already in that locale (or verbatim); other events are rendered with the tenant's
 * current templates. Stored rows never change: events are immutable.
 */
export async function localizeEvents(
  renderer: EventRenderer,
  tenantId: string,
  list: MementoEvent[],
  locale?: string,
): Promise<MementoEvent[]> {
  const pending = list.filter((event) => needsRendering(event, locale));
  if (pending.length === 0) return list;
  const results = await renderer.renderMany(tenantId, pending, locale);
  const byEvent = new Map(pending.map((event, i) => [event, results[i]]));
  return list.map((event) => {
    const result = byEvent.get(event);
    return result ? { ...event, rendered: result.text, rendered_locale: result.locale } : event;
  });
}

/**
 * Lists the current tenant's events, newest first by default, with keyset pagination.
 * `filter` (Filter DSL) is ANDed with the query-string filters.
 */
export async function listEvents(
  db: Database,
  input: EventQueryInput | EventQuery,
  filter: Filter | null = null,
  options: ListOptions = {},
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
  if (query.cursor && query.offset !== undefined) {
    throw new MementoError("bad_request", "use either cursor or offset, not both");
  }
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
    .limit(query.limit + 1)
    .offset(query.offset ?? 0);
  const page = rows.slice(0, query.limit);
  const last = page.at(-1);
  const more = rows.length > query.limit;
  const next =
    more && last ? encodeCursor({ occurred_at: last.occurredAt.toISOString(), id: last.id }) : null;
  const serialized = page.map(serializeEvent);
  return {
    events: options.renderer
      ? await localizeEvents(options.renderer, tenant.tenantId, serialized, query.locale)
      : serialized,
    meta:
      query.offset === undefined
        ? { limit: query.limit, count: page.length, next_cursor: next }
        : {
            limit: query.limit,
            count: page.length,
            next_cursor: next,
            offset: query.offset,
            next_offset: more ? query.offset + page.length : null,
          },
  };
}

/** The history of one entity (`user/42`, `chat/igor-marko`). */
export async function entityHistory(
  db: Database,
  entity: { instance_type: string; instance_id: string },
  input: Omit<EventQueryInput, "instance_type" | "instance_id"> = {},
  options: ListOptions = {},
): Promise<EventPage> {
  const parsed = EntityRefSchema.safeParse(entity);
  if (!parsed.success) {
    throw new MementoError("validation_error", "invalid entity", parsed.error.issues);
  }
  const ref: EntityRef = parsed.data;
  const { instance_type: _type, instance_id: _id, ...rest } = input as EventQueryInput;
  return listEvents(
    db,
    rest,
    {
      and: [
        { field: "instance_type", op: "eq", value: ref.instance_type },
        { field: "instance_id", op: "eq", value: ref.instance_id },
      ],
    },
    options,
  );
}
