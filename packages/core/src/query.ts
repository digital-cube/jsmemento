import { z } from "zod";
import { TimestampSchema } from "./common.js";
import { and, type Filter, matchCondition } from "./filter.js";
import { LocaleSchema } from "./template.js";

export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;

const booleanish = z
  .union([z.boolean(), z.enum(["true", "false", "1", "0"])])
  .transform((value) => value === true || value === "true" || value === "1");

/**
 * Query string of `GET /memento/events`. `event_type`, `instance_type`, `instance_id`
 * and `actor_id` accept a trailing `*` for prefix matching.
 */
export const EventQuerySchema = z.object({
  event_type: z.string().min(1).max(100).optional(),
  instance_type: z.string().min(1).max(64).optional(),
  instance_id: z.string().min(1).max(200).optional(),
  actor_id: z.string().min(1).max(200).optional(),
  /** occurred_at >= after */
  after: TimestampSchema.optional(),
  /** occurred_at < before */
  before: TimestampSchema.optional(),
  limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
  cursor: z.string().min(1).optional(),
  order: z.enum(["asc", "desc"]).default("desc"),
  include_archived: booleanish.default(false),
  /** Render `rendered` in this locale (fallback chain: sr-Latn → sr → default locale). */
  locale: LocaleSchema.optional(),
});
export type EventQueryInput = z.input<typeof EventQuerySchema>;
export type EventQuery = z.output<typeof EventQuerySchema>;

/** Translates the flat query string into the Filter DSL. */
export function eventQueryToFilter(query: EventQuery): Filter | null {
  return and(
    query.event_type ? matchCondition("event_type", query.event_type) : null,
    query.instance_type ? matchCondition("instance_type", query.instance_type) : null,
    query.instance_id ? matchCondition("instance_id", query.instance_id) : null,
    query.actor_id ? matchCondition("actor_id", query.actor_id) : null,
    query.after ? { field: "occurred_at", op: "gte", value: query.after } : null,
    query.before ? { field: "occurred_at", op: "lt", value: query.before } : null,
  );
}

/** Keyset position: the `(occurred_at, id)` of the last row of the previous page. */
export interface Cursor {
  occurred_at: string;
  id: string;
}

const CursorSchema = z.tuple([TimestampSchema, z.uuid()]);

export function encodeCursor(cursor: Cursor): string {
  return btoa(JSON.stringify([cursor.occurred_at, cursor.id]))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** `null` for anything that is not a cursor this library produced. */
export function decodeCursor(token: string): Cursor | null {
  try {
    const json = atob(token.replaceAll("-", "+").replaceAll("_", "/"));
    const parsed = CursorSchema.safeParse(JSON.parse(json));
    return parsed.success ? { occurred_at: parsed.data[0], id: parsed.data[1] } : null;
  } catch {
    return null;
  }
}
