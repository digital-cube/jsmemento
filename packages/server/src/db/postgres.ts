import { ilike, like, type SQL, sql } from "drizzle-orm";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { PgDialect } from "drizzle-orm/pg-core";
import pg from "pg";
import { type Dialect, errorCode } from "./dialect.js";
import type { Database, DatabaseHandle } from "./index.js";
import * as schema from "./schema-postgres.js";

/** SQLSTATE of a unique violation. */
const UNIQUE_VIOLATION = "23505";

const renderer = new PgDialect();

/**
 * PostgreSQL: SQLSTATE codes, `::` casts, `jsonb` operators, `ILIKE`, `date_trunc`, `to_char`,
 * `greatest`, `array_to_string`, `is distinct from`, `nulls last`. PostgreSQL's `LIKE` escapes
 * with a backslash by default, so the patterns `escapeLike` writes need no `ESCAPE` clause.
 */
export const postgresDialect: Dialect = {
  name: "postgres",
  capabilities: {},

  isUniqueViolation: (error) => errorCode(error) === UNIQUE_VIOLATION,

  like: (column, pattern) => like(column as never, pattern),
  ilike: (column, pattern) => ilike(column as never, pattern),

  jsonText: (column, field) => sql<string | null>`(${column} ->> ${field})`,
  jsonNumber: (column, field) =>
    sql<
      number | null
    >`(case when jsonb_typeof(${column} -> ${field}) = 'number' then (${column} ->> ${field})::numeric end)`,

  int: (expr) => sql<number>`${expr}::int`,
  text: (expr) => sql<string>`${expr}::text`,
  joinStrings: (column) => sql<string>`array_to_string(${column}, ',')`,

  timestamp: (value) =>
    sql<Date>`${typeof value === "string" ? value : value.toISOString()}::timestamptz`,
  date: (value) => sql<string>`${value}::date`,
  uuid: (value) => sql<string>`${value}::uuid`,
  now: () => sql<Date>`now()`,
  hoursAgo(hours) {
    if (!Number.isInteger(hours)) throw new Error(`not a whole number of hours: ${hours}`);
    return sql<Date>`now() - interval ${sql.raw(`'${hours} hours'`)}`;
  },
  truncateToMinute: (timestamp) => sql<Date>`date_trunc('minute', ${timestamp})`,
  utcHourIso: (timestamp) =>
    sql<string>`to_char(${timestamp} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"')`,
  later: (a, b) => sql<Date>`greatest(${a}, ${b})`,

  isDistinctFrom: (a, b) => sql`${a} is distinct from ${b}`,
  nullsLast: (expr, dir) =>
    dir === "desc" ? sql`${expr} desc nulls last` : sql`${expr} asc nulls last`,

  async migrate(db, migrationsFolder) {
    // Every PostgreSQL `Database` this package opens is a node-postgres one (`openPostgres`).
    await migrate(db as NodePgDatabase<typeof schema>, { migrationsFolder });
  },
  render(query: SQL) {
    const { sql: text, params } = renderer.sqlToQuery(query);
    return { sql: text, params };
  },
};

/** Opens a node-postgres pool on `url`. */
export function openPostgres(url: string, options: { max?: number }): DatabaseHandle {
  const pool = new pg.Pool({ connectionString: url, max: options.max ?? 10 });
  const db: Database = drizzle(pool, { schema });
  return { db, dialect: postgresDialect, close: () => pool.end() };
}
