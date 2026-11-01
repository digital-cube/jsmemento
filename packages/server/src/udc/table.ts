import {
  type ListResponse,
  MAX_PAGE_LIMIT,
  type Row,
  type SchemaDoc,
  type SortKey,
  UdcError,
} from "@jsudc/core";
import type { Source, SourceListRequest } from "@jsudc/server";
import { and, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { EVENT_SOURCE_CAPABILITIES, type SqlField, SqlFilterCompiler, schemaOf } from "./source.js";

/** A field of a table collection: what it filters and sorts on, and how its value is read. */
export interface TableField extends SqlField {
  /** What the query selects for it; default `expr`. Absent both: filled by `hydrate`. */
  select?: SQLWrapper;
  /** The row value from the selected record; default the record's member of the same name. */
  value?: (record: Record<string, unknown>) => unknown;
}

/** A query of the table's records, before WHERE / ORDER BY / LIMIT. */
export interface TableQuery {
  where(where: SQL | undefined): TableQuery;
  orderBy(...order: SQL[]): TableQuery;
  limit(limit: number): TableQuery;
  offset(offset: number): TableQuery;
  then: PromiseLike<Record<string, unknown>[]>["then"];
}

export interface TableSpec {
  fields: Record<string, TableField>;
  /** The records, with every selected field (and `id`) as a member. */
  select: (selection: Record<string, SQLWrapper>) => TableQuery;
  /** `count(*)` over the same joins: `[{ total }]`. */
  count: () => {
    where(where: SQL | undefined): PromiseLike<{ total: number }[]>;
  };
  /** The id column (ties are broken by it, `read` looks it up). */
  id: SQLWrapper;
  /** Always ANDed in: the tenant, `deleted_at is null`, … */
  scope: () => SQL | undefined;
  defaultSort: SortKey[];
  /** Fills fields no query can (`used_today` from Redis) for one page of rows. */
  hydrate?: (rows: Row[]) => Promise<void>;
  /** What `mutate` refuses with. */
  readOnlyMessage: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ISO text of a timestamp the driver handed back as a Date or a string; `null` stays. */
export function isoOf(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * A read-only UDC source over any SQL query (accounts, keys, usage rows): the filter DSL and
 * sort keys compile over its fields' expressions like the event sources', offset paging, an
 * exact `total`. Row id = the `id` column.
 */
export class TableCollectionSource implements Source {
  readonly capabilities = EVENT_SOURCE_CAPABILITIES;
  private readonly schema: SchemaDoc;
  private readonly compiler: SqlFilterCompiler;
  private readonly selection: Record<string, SQLWrapper>;

  constructor(private readonly spec: TableSpec) {
    this.schema = schemaOf(spec.fields);
    this.compiler = new SqlFilterCompiler(spec.fields);
    this.selection = { __id: spec.id };
    for (const [name, field] of Object.entries(spec.fields)) {
      const select = field.select ?? field.expr;
      if (select) this.selection[name] = select;
    }
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
    const where = and(
      this.spec.scope(),
      req.filter ? this.compiler.compile(req.filter) : undefined,
    );
    const sort = req.sort?.length ? req.sort : this.spec.defaultSort;
    const [records, totals] = await Promise.all([
      this.spec
        .select(this.selection)
        .where(where)
        .orderBy(...this.compiler.orderBy(sort, (dir) => [sql`${this.spec.id} ${sql.raw(dir)}`]))
        .limit(limit)
        .offset(offset),
      this.spec.count().where(where),
    ]);
    return {
      rows: await this.toRows(records),
      next_cursor: null,
      total: Number(totals[0]?.total ?? 0),
    };
  }

  async read(id: string): Promise<Row> {
    const records = UUID_RE.test(id)
      ? await this.spec
          .select(this.selection)
          .where(and(this.spec.scope(), sql`${this.spec.id} = ${id}`))
          .limit(1)
      : [];
    const [row] = await this.toRows(records);
    if (!row) throw new UdcError("not_found", `no row ${id}`);
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
    return Promise.reject(new UdcError("unsupported_op", this.spec.readOnlyMessage));
  }

  private async toRows(records: Record<string, unknown>[]): Promise<Row[]> {
    const rows = records.map((record) => {
      const row: Row = { __meta: { id: String(record.__id), version: 1 } };
      for (const [name, field] of Object.entries(this.spec.fields)) {
        const raw = field.value ? field.value(record) : (record[name] ?? null);
        row[name] = field.def.type === "datetime" ? isoOf(raw) : raw;
      }
      return row;
    });
    if (this.spec.hydrate && rows.length > 0) await this.spec.hydrate(rows);
    return rows;
  }
}
