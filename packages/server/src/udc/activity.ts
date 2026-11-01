import {
  type Condition,
  type FilterNode,
  isCondition,
  type ListResponse,
  MAX_PAGE_LIMIT,
  type Row,
  type SchemaDoc,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import type { Source, SourceListRequest } from "@jsudc/server";
import { EVENT_TYPES } from "@memento/core";
import { and, count, eq, gte, isNull, lt, type SQL, sql } from "drizzle-orm";
import { requireTenant } from "../context.js";
import type { Database } from "../db/client.js";
import { events } from "../db/schema.js";
import {
  coerce,
  EVENT_SOURCE_CAPABILITIES,
  type SqlField,
  SqlFilterCompiler,
  schemaOf,
} from "./source.js";

/** How far back the collection looks when the filter says nothing about `minute`. */
export const ACTIVITY_DEFAULT_WINDOW_MINUTES = 60;

/** The alias of the aggregate subquery every filter and sort of the collection reads. */
const ALIAS = "activity";
const MINUTE_MS = 60_000;

/** A column of the aggregate subquery. */
const column = (name: string): SQL => sql`${sql.identifier(ALIAS)}.${sql.identifier(name)}`;

/** The bucket of an event: its `occurred_at` cut to the minute. */
const minuteOf = sql`date_trunc('minute', ${events.occurredAt})`;

/** The field of the chart series of one event type: `CPU_LOAD` → `cpu_load`. */
export const seriesField = (eventType: string): string => eventType.toLowerCase();

/** The chart series' field for every event type outside lookups.yaml. */
export const OTHER_SERIES_FIELD = "other";

const integer = (name: string, description: string): SqlField => ({
  def: { type: "integer", min: 0, index: true, description },
  kind: "number",
  expr: column(name),
});

/**
 * `minute`, `event_type`, `count`, then one integer per event type of lookups.yaml (and
 * `other`): the bucket's count in its own type's column, 0 in the rest. The chart draws a
 * series per type from those columns (jsudc's chart takes series as fields, not as the values
 * of one); summed per minute they are the count of that type in that minute.
 */
export const ACTIVITY_FIELDS: Record<string, SqlField> = {
  minute: {
    def: { type: "datetime", index: true, description: "The minute the events happened in" },
    kind: "time",
    expr: column("minute"),
  },
  event_type: {
    def: { type: "string", index: true, description: "USER_LOGIN, CPU_LOAD, …" },
    kind: "text",
    expr: column("event_type"),
  },
  count: integer("count", "How many events of the type happened in the minute"),
  ...Object.fromEntries(
    EVENT_TYPES.map((type) => [
      seriesField(type),
      integer(seriesField(type), `count when event_type is ${type}, else 0 (its chart series)`),
    ]),
  ),
  [OTHER_SERIES_FIELD]: integer(
    OTHER_SERIES_FIELD,
    "count when event_type is not in lookups.yaml, else 0 (its chart series)",
  ),
};

export interface ActivitySourceOptions {
  /** Minutes the collection covers when the filter names no `minute`. Default 60. */
  windowMinutes?: number;
  /** The clock the default window ends at (tests pin it). */
  now?: () => Date;
}

/**
 * The `activity` collection: the current tenant's live (not archived) events counted per
 * minute and per `event_type`, computed per request —
 * `SELECT date_trunc('minute', occurred_at), event_type, count(*) … GROUP BY` as a subquery
 * the filter, sort and paging apply to. Read-only, offset-paged, `total` = number of buckets.
 */
export class ActivityCollectionSource implements Source {
  readonly capabilities = EVENT_SOURCE_CAPABILITIES;
  private readonly schema: SchemaDoc = schemaOf(ACTIVITY_FIELDS);
  private readonly compiler = new SqlFilterCompiler(ACTIVITY_FIELDS);
  private readonly defaultSort: SortKey[] = [
    { field: "minute", dir: "desc" },
    { field: "event_type", dir: "asc" },
  ];
  private readonly windowMinutes: number;
  private readonly now: () => Date;

  constructor(
    private readonly db: Database,
    options: ActivitySourceOptions = {},
  ) {
    this.windowMinutes = options.windowMinutes ?? ACTIVITY_DEFAULT_WINDOW_MINUTES;
    this.now = options.now ?? (() => new Date());
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
    const buckets = this.buckets(req.filter);
    const where = req.filter ? this.compiler.compile(req.filter) : undefined;
    const sort = req.sort?.length ? req.sort : this.defaultSort;
    const [rows, totals] = await Promise.all([
      this.db
        .select()
        .from(buckets)
        .where(where)
        .orderBy(
          ...this.compiler.orderBy(sort, (dir) => [
            sql`${column("minute")} ${sql.raw(dir)}`,
            sql`${column("event_type")} ${sql.raw(dir)}`,
          ]),
        )
        .limit(limit)
        .offset(offset),
      this.db.select({ total: count() }).from(buckets).where(where),
    ]);
    return { rows: rows.map(toRow), next_cursor: null, total: totals[0]?.total ?? 0 };
  }

  /** One bucket by its id, `<minute ISO>|<event_type>`. */
  async read(id: string): Promise<Row> {
    const bar = id.indexOf("|");
    const minute = new Date(id.slice(0, bar));
    if (bar < 0 || Number.isNaN(minute.getTime())) {
      throw new UdcError("not_found", `no activity bucket ${id}`);
    }
    const filter: FilterNode = {
      and: [
        { field: "minute", op: "eq", value: minute.toISOString() },
        { field: "event_type", op: "eq", value: id.slice(bar + 1) },
      ],
    };
    const { rows } = await this.list({ filter, page: { limit: 1 } });
    const [row] = rows;
    if (!row) throw new UdcError("not_found", `no activity bucket ${id}`);
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
      new UdcError("unsupported_op", "activity is computed from the events: push events instead"),
    );
  }

  /** The aggregate: the tenant's events in the window, per minute and type. */
  private buckets(filter: FilterNode | undefined) {
    const { tenantId } = requireTenant();
    const known = sql.join(
      EVENT_TYPES.map((type) => sql`${type}`),
      sql`, `,
    );
    return this.db
      .select({
        minute: sql<Date>`${minuteOf}`.as("minute"),
        event_type: sql<string>`${events.eventType}`.as("event_type"),
        count: sql<number>`count(*)::int`.as("count"),
        ...Object.fromEntries(
          EVENT_TYPES.map((type) => [
            seriesField(type),
            sql<number>`(case when ${events.eventType} = ${type} then count(*) else 0 end)::int`.as(
              seriesField(type),
            ),
          ]),
        ),
        [OTHER_SERIES_FIELD]:
          sql<number>`(case when ${events.eventType} in (${known}) then 0 else count(*) end)::int`.as(
            OTHER_SERIES_FIELD,
          ),
      })
      .from(events)
      .where(
        and(
          eq(events.tenantId, tenantId),
          isNull(events.archivedAt),
          ...this.occurredBounds(filter),
        ),
      )
      .groupBy(minuteOf, events.eventType)
      .as(ALIAS);
  }

  /**
   * Bounds on `occurred_at` for the inner query, so it reads the tenant's time index instead
   * of every event it has: the default window when the filter does not mention `minute`, else
   * what the filter's top-level `minute` conditions imply (each a superset; the exact condition
   * is the filter's own, applied to the buckets). A `minute` condition nested under `or` /
   * `not` gives no bound: the buckets are then cut from all of the tenant's events.
   */
  private occurredBounds(filter: FilterNode | undefined): SQL[] {
    if (!filter || !mentions(filter, "minute")) {
      const start = Math.floor(this.now().getTime() / MINUTE_MS) - (this.windowMinutes - 1);
      return [gte(events.occurredAt, new Date(start * MINUTE_MS))];
    }
    return topLevel(filter)
      .filter((c) => c.field === "minute")
      .flatMap(minuteBounds);
  }
}

/** The conditions ANDed at the top of a filter tree. */
function topLevel(node: FilterNode): Condition[] {
  if (isCondition(node)) return [node];
  if ("and" in node) return node.and.flatMap(topLevel);
  return [];
}

/** Whether any condition of the tree names `field`. */
function mentions(node: FilterNode, field: string): boolean {
  if (isCondition(node)) return node.field === field;
  if ("and" in node) return node.and.some((n) => mentions(n, field));
  if ("or" in node) return node.or.some((n) => mentions(n, field));
  return mentions(node.not, field);
}

/**
 * What `date_trunc('minute', occurred_at) <op> T` implies for `occurred_at` itself: a bucket
 * at or after T holds only events at or after T; one before (or at) T only events before
 * T + 1 minute. A value that is no timestamp gives no bound (the filter itself refuses it).
 */
function minuteBounds(c: Condition): SQL[] {
  const at = (value: unknown): Date | null => {
    try {
      return coerce("minute", "time", value) as Date;
    } catch {
      return null;
    }
  };
  const after = (value: unknown) => {
    const t = at(value);
    return t ? [gte(events.occurredAt, t)] : [];
  };
  const before = (value: unknown) => {
    const t = at(value);
    return t ? [lt(events.occurredAt, new Date(t.getTime() + MINUTE_MS))] : [];
  };
  switch (c.op) {
    case "gt":
    case "gte":
      return after(c.value);
    case "lt":
    case "lte":
      return before(c.value);
    case "eq":
      return [...after(c.value), ...before(c.value)];
    case "between":
      return Array.isArray(c.value) && c.value.length === 2
        ? [...after(c.value[0]), ...before(c.value[1])]
        : [];
    default:
      return [];
  }
}

function toRow(bucket: Record<string, unknown>): Row {
  const minute = new Date(bucket.minute as string | Date).toISOString();
  const row: Row = { __meta: { id: `${minute}|${bucket.event_type}`, version: 1 } };
  for (const name of Object.keys(ACTIVITY_FIELDS)) {
    row[name] = name === "minute" ? minute : (bucket[name] ?? null);
  }
  return row;
}
