import {
  type Capabilities,
  type Condition,
  type FieldDef,
  type FilterNode,
  isCondition,
  type ListResponse,
  MAX_PAGE_LIMIT,
  type Row,
  type SchemaDoc,
  type SortKey,
  SUPPORTED_OPS,
  UdcError,
} from "@jsudc/core";
import type { Source, SourceListRequest } from "@jsudc/server";
import type { MementoEvent } from "@memento/core";
import {
  and,
  between,
  count,
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
  type SQLWrapper,
  sql,
} from "drizzle-orm";
import { requireTenant } from "../context.js";
import type { Database } from "../db/client.js";
import { escapeLike } from "../db/filter.js";
import { type EventRow, events } from "../db/schema.js";
import { localizeEvents, serializeEvent } from "../services/events.js";
import type { EventRenderer } from "../templates/renderer.js";

/** How a field's filter values are coerced before they reach SQL. */
export type FieldKind = "text" | "time" | "number" | "json";

/** A field filters and sorts can name: its UDC definition and the SQL they compare. */
export interface SqlField {
  def: FieldDef;
  kind: FieldKind;
  /** What filters and sorts compare; absent for a field that is neither (`payload`). */
  expr?: SQLWrapper;
  /** Default true; `false` for a field only null-checks make sense on (`payload`). */
  sortable?: boolean;
}

/** One field of an event collection: its UDC definition, its SQL and its value. */
export interface EventField extends SqlField {
  value: (event: MementoEvent) => unknown;
}

/** A collection of the current tenant's events, narrowed by `where` and shaped by `fields`. */
export interface EventCollectionSpec {
  fields: Record<string, EventField>;
  /** Always ANDed in (e.g. `event_type = 'CPU_LOAD'`); the tenant is added by the source. */
  where?: SQL;
  /** Default `[{ field: "occurred_at", dir: "desc" }]`: newest first. */
  defaultSort?: SortKey[];
}

export const EVENT_SOURCE_CAPABILITIES: Capabilities = {
  mutate: false,
  subscribe: false,
  total_count: true,
  schema_edit: false,
  config_edit: false,
  reindex: false,
  tree_reparent: false,
  source_yaml: false,
  paging: ["offset"],
  supported_filter_ops: [...SUPPORTED_OPS],
};

/** A numeric member of `payload`, NULL when it is missing or not a number. */
export function payloadNumber(key: string): SQL<number | null> {
  return sql<
    number | null
  >`(case when jsonb_typeof(${events.payload} -> ${key}) = 'number' then (${events.payload} ->> ${key})::numeric end)`;
}

/**
 * A read-only UDC source over `memento_event`. Every query is scoped to the tenant of the
 * request (the AsyncLocalStorage context the auth hook set) and skips archived events:
 * a key only ever sees its own tenant's live log. Pages by offset; `total` is exact.
 */
export class EventCollectionSource implements Source {
  readonly capabilities = EVENT_SOURCE_CAPABILITIES;
  private readonly schema: SchemaDoc;
  private readonly defaultSort: SortKey[];
  private readonly compiler: SqlFilterCompiler;

  constructor(
    private readonly db: Database,
    private readonly spec: EventCollectionSpec,
    private readonly renderer?: EventRenderer,
  ) {
    this.schema = schemaOf(spec.fields);
    this.compiler = new SqlFilterCompiler(spec.fields);
    this.defaultSort = spec.defaultSort ?? [{ field: "occurred_at", dir: "desc" }];
  }

  async describe(): Promise<SchemaDoc> {
    return this.schema;
  }

  async list(req: SourceListRequest): Promise<ListResponse> {
    if (req.page?.cursor) {
      throw new UdcError("validation_error", "this collection pages by offset, not by cursor");
    }
    const limit = Math.min(req.page?.limit ?? 50, MAX_PAGE_LIMIT);
    const offset = req.page?.offset ?? 0;
    const where = this.where(req.filter);
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(events)
        .where(where)
        .orderBy(
          ...this.compiler.orderBy(req.sort?.length ? req.sort : this.defaultSort, (dir) => [
            dir === "desc" ? sql`${events.id} desc` : sql`${events.id} asc`,
          ]),
        )
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(events).where(where),
    ]);
    return {
      rows: await this.toRows(rows),
      next_cursor: null,
      total: totals[0]?.total ?? 0,
    };
  }

  async read(id: string): Promise<Row> {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rows = uuid.test(id)
      ? await this.db
          .select()
          .from(events)
          .where(and(this.where(undefined), eq(events.id, id)))
          .limit(1)
      : [];
    const [row] = await this.toRows(rows);
    if (!row) throw new UdcError("not_found", `no event ${id}`);
    return row;
  }

  mutate(): Promise<Row> {
    return this.readOnly();
  }
  addField(): Promise<SchemaDoc> {
    return this.readOnly();
  }
  updateField(): Promise<SchemaDoc> {
    return this.readOnly();
  }
  softDeleteField(): Promise<SchemaDoc> {
    return this.readOnly();
  }

  private readOnly(): Promise<never> {
    return Promise.reject(
      new UdcError("unsupported_op", "events are immutable: push them with POST /events"),
    );
  }

  private where(filter: FilterNode | undefined): SQL {
    const tenant = requireTenant();
    const parts: (SQL | undefined)[] = [
      eq(events.tenantId, tenant.tenantId),
      isNull(events.archivedAt),
      this.spec.where,
    ];
    if (filter) parts.push(this.compiler.compile(filter));
    return and(...parts) as SQL;
  }

  private async toRows(rows: EventRow[]): Promise<Row[]> {
    let list = rows.map(serializeEvent);
    if (this.renderer && list.length > 0) {
      const { tenantId, locale } = requireTenant();
      list = await localizeEvents(this.renderer, tenantId, list, locale);
    }
    return list.map((event) => {
      const row: Row = { __meta: { id: event.id, version: 1 } };
      for (const [name, field] of Object.entries(this.spec.fields)) row[name] = field.value(event);
      return row;
    });
  }

  /** Compiles a UDC filter tree into a WHERE clause over this collection's fields. */
  compile(node: FilterNode): SQL {
    return this.compiler.compile(node);
  }
}

/** The UDC schema of a field map: every field, in declaration order. */
export function schemaOf(fields: Record<string, SqlField>): SchemaDoc {
  const defs = Object.fromEntries(Object.entries(fields).map(([n, f]) => [n, f.def]));
  return { version: "v1", core_fields: [], fields: defs, field_order: Object.keys(defs) };
}

/**
 * Turns the UDC filter DSL and sort keys into Drizzle SQL over a map of fields, each with the
 * expression it compares: columns of `memento_event` or of an aggregate's subquery alike.
 */
export class SqlFilterCompiler {
  constructor(private readonly fields: Record<string, SqlField>) {}

  private field(name: string): SqlField & { expr: SQLWrapper } {
    const field = this.fields[name];
    if (!field?.expr) {
      throw new UdcError("validation_error", `field "${name}" cannot be filtered or sorted`, {
        field: name,
      });
    }
    return field as SqlField & { expr: SQLWrapper };
  }

  /** ORDER BY for `sort`, nulls last, then `tiebreak` (given the last key's direction). */
  orderBy(sort: SortKey[], tiebreak: (dir: "asc" | "desc") => SQL[]): SQL[] {
    const keys = sort.map(({ field, dir }) => {
      const { expr, sortable } = this.field(field);
      if (sortable === false) {
        throw new UdcError("validation_error", `field "${field}" cannot be sorted`, { field });
      }
      return dir === "desc" ? sql`${expr} desc nulls last` : sql`${expr} asc nulls last`;
    });
    return [...keys, ...tiebreak(sort.at(-1)?.dir === "desc" ? "desc" : "asc")];
  }

  /** Compiles a UDC filter tree into a WHERE clause over this collection's fields. */
  compile(node: FilterNode): SQL {
    if (!isCondition(node)) {
      if ("and" in node) return and(...node.and.map((n) => this.compile(n))) ?? sql`true`;
      if ("or" in node) return or(...node.or.map((n) => this.compile(n))) ?? sql`false`;
      return not(this.compile(node.not));
    }
    return this.condition(node);
  }

  private condition(c: Condition): SQL {
    const { expr, kind } = this.field(c.field);
    if (kind === "json" && c.op !== "is_null" && c.op !== "is_not_null") {
      throw new UdcError("validation_error", `${c.field} allows only is_null / is_not_null`);
    }
    const one = () => coerce(c.field, kind, c.value);
    const many = (): unknown[] => {
      if (!Array.isArray(c.value)) {
        throw new UdcError("validation_error", `"${c.op}" on ${c.field} needs an array`);
      }
      return c.value.map((v) => coerce(c.field, kind, v));
    };
    const text = (pattern: (v: string) => string): SQL => {
      if (kind !== "text") {
        throw new UdcError("validation_error", `"${c.op}" needs a text field, not ${c.field}`);
      }
      const value = pattern(escapeLike(String(c.value ?? "")));
      return c.case_insensitive ? ilike(expr as never, value) : like(expr as never, value);
    };
    // drizzle's operators take any SQL expression; the casts only quiet the column typing.
    const e = expr as never;
    switch (c.op) {
      case "eq":
        return eq(e, one());
      case "neq":
        return ne(e, one());
      case "gt":
        return gt(e, one());
      case "gte":
        return gte(e, one());
      case "lt":
        return lt(e, one());
      case "lte":
        return lte(e, one());
      case "in": {
        const values = many();
        return values.length ? inArray(e, values) : sql`false`;
      }
      case "not_in": {
        const values = many();
        return values.length ? notInArray(e, values) : sql`true`;
      }
      case "between": {
        const values = many();
        if (values.length !== 2) {
          throw new UdcError("validation_error", `"between" on ${c.field} needs [low, high]`);
        }
        return between(e, values[0], values[1]);
      }
      case "contains":
        return text((v) => `%${v}%`);
      case "starts_with":
        return text((v) => `${v}%`);
      case "ends_with":
        return text((v) => `%${v}`);
      case "is_null":
        return isNull(e);
      case "is_not_null":
        return isNotNull(e);
    }
  }
}

export function coerce(field: string, kind: FieldKind, value: unknown): unknown {
  if (kind === "time") {
    const date =
      typeof value === "string" || typeof value === "number"
        ? new Date(value)
        : new Date(Number.NaN);
    if (Number.isNaN(date.getTime())) {
      throw new UdcError("validation_error", `${field} needs a timestamp, got ${String(value)}`);
    }
    return date;
  }
  if (kind === "number") {
    const number = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
    if (typeof number !== "number" || !Number.isFinite(number)) {
      throw new UdcError("validation_error", `${field} needs a number, got ${String(value)}`);
    }
    return number;
  }
  if (value === null || value === undefined || typeof value === "object") {
    throw new UdcError("validation_error", `${field} needs a value, got ${String(value)}`);
  }
  return String(value);
}
