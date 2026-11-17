import type { Condition, Filter, FilterField } from "@jsmemento/core";
import {
  type AnyColumn,
  and,
  between,
  eq,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  not,
  notInArray,
  or,
  type SQL,
} from "drizzle-orm";
import { MementoError } from "../errors.js";
import { dialect } from "./index.js";
import { events } from "./schema.js";

/** The column of a filter field, of the connected dialect's schema (read per query). */
function columnOf(field: FilterField): AnyColumn {
  switch (field) {
    case "event_type":
      return events.eventType;
    case "instance_type":
      return events.instanceType;
    case "instance_id":
      return events.instanceId;
    case "actor_id":
      return events.actorId;
    case "occurred_at":
      return events.occurredAt;
    case "received_at":
      return events.receivedAt;
  }
}

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
  const column = columnOf(c.field);
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
      return dialect.like(column, `${escapeLike(String(c.value))}%`);
    case "contains":
      return dialect.ilike(column, `%${escapeLike(String(c.value))}%`);
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
