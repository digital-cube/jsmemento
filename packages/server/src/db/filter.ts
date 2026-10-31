import type { Condition, Filter, FilterField } from "@memento/core";
import {
  and,
  between,
  eq,
  gt,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";
import { MementoError } from "../errors.js";
import { events } from "./schema.js";

const COLUMNS: Record<FilterField, PgColumn> = {
  event_type: events.eventType,
  instance_type: events.instanceType,
  instance_id: events.instanceId,
  actor_id: events.actorId,
  occurred_at: events.occurredAt,
  received_at: events.receivedAt,
};

const TIME_FIELDS = new Set<FilterField>(["occurred_at", "received_at"]);

/** Escapes LIKE metacharacters so `CHAT_` matches a literal underscore. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

function toValue(field: FilterField, value: string | number | boolean): unknown {
  if (!TIME_FIELDS.has(field)) return String(value);
  const date = new Date(typeof value === "boolean" ? Number.NaN : value);
  if (Number.isNaN(date.getTime())) {
    throw new MementoError("validation_error", `${field} needs a timestamp, got ${String(value)}`);
  }
  return date;
}

function condition(c: Condition): SQL {
  const column = COLUMNS[c.field];
  switch (c.op) {
    case "eq":
      return eq(column, toValue(c.field, c.value));
    case "ne":
      return ne(column, toValue(c.field, c.value));
    case "lt":
      return lt(column, toValue(c.field, c.value));
    case "lte":
      return lte(column, toValue(c.field, c.value));
    case "gt":
      return gt(column, toValue(c.field, c.value));
    case "gte":
      return gte(column, toValue(c.field, c.value));
    case "prefix":
      return like(column, `${escapeLike(String(c.value))}%`);
    case "contains":
      return ilike(column, `%${escapeLike(String(c.value))}%`);
    case "in":
      return inArray(
        column,
        c.value.map((v) => toValue(c.field, v)),
      );
    case "nin":
      return notInArray(
        column,
        c.value.map((v) => toValue(c.field, v)),
      );
    case "between":
      return between(column, toValue(c.field, c.value[0]), toValue(c.field, c.value[1]));
    case "is_null":
      return c.value ? isNull(column) : isNotNull(column);
  }
}

/** Compiles a Filter DSL tree into a WHERE clause over `memento_event`. */
export function compileFilter(filter: Filter): SQL {
  if ("and" in filter) return and(...filter.and.map(compileFilter)) as SQL;
  if ("or" in filter) return or(...filter.or.map(compileFilter)) as SQL;
  if ("not" in filter) return not(compileFilter(filter.not));
  return condition(filter);
}
