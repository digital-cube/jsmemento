import type { AnyColumn, SQL, SQLWrapper } from "drizzle-orm";
import type { Database } from "./index.js";

/** What a dialect helper takes: a column of the schema or any SQL expression. */
export type Expr = AnyColumn | SQL | SQLWrapper;

/**
 * The dialect seam: everything the server says to its database that is not portable SQL.
 * Services, routes and UDC sources write their queries with drizzle's query builder and reach
 * for this interface for the rest — error classification, casts of parameters, and the
 * handful of expressions every database spells differently. One implementation per supported
 * database (`./postgres.ts`, `./sqlite.ts`); nothing outside `db/` imports a driver or a
 * dialect module.
 */
export interface Dialect {
  /** Name of the database, for logs and error messages. */
  readonly name: "postgres" | "sqlite";
  /** What this database can do that another might not. */
  readonly capabilities: DialectCapabilities;

  /** `error` (or the driver error drizzle wrapped in it) is a unique-constraint violation. */
  isUniqueViolation(error: unknown): boolean;

  /** Case-sensitive `LIKE`; `pattern` escapes `\`, `%` and `_` with a backslash (`escapeLike`). */
  like(column: Expr, pattern: string): SQL;
  /** Case-insensitive `LIKE`, with the same escaping as `like`. */
  ilike(column: Expr, pattern: string): SQL;

  /** The text of the top-level `field` of a JSON column; `null` when absent. */
  jsonText(column: Expr, field: string): SQL<string | null>;
  /** The top-level `field` of a JSON column as a number; `null` when absent or not a number. */
  jsonNumber(column: Expr, field: string): SQL<number | null>;

  /** `expr` as an integer (a `count(*)`, a `case` over counts, a parameter). */
  int(expr: Expr | number): SQL<number>;
  /** `expr` as text (an id concatenated into a string). */
  text(expr: Expr): SQL<string>;
  /** A string-array column as one comma-separated text (`read,write`). */
  joinStrings(column: Expr): SQL<string>;

  /** A timestamp parameter, typed as one (`value` a `Date` or an ISO 8601 string). */
  timestamp(value: Date | string): SQL<Date>;
  /** A calendar-day parameter, typed as one (`YYYY-MM-DD`). */
  date(value: string): SQL<string>;
  /** A UUID parameter, typed as one (where the database cannot infer it, e.g. a row value). */
  uuid(value: string): SQL<string>;
  /** The current time of the database (of the transaction). */
  now(): SQL<Date>;
  /** The moment `hours` hours before `now()`. */
  hoursAgo(hours: number): SQL<Date>;
  /** `timestamp` cut down to its minute. */
  truncateToMinute(timestamp: Expr): SQL<Date>;
  /** `timestamp`'s hour in UTC as `YYYY-MM-DDTHH:00:00Z` (the id of a usage row). */
  utcHourIso(timestamp: Expr): SQL<string>;
  /** The later of two timestamps; a NULL one is skipped (`greatest`), NULL only when both are. */
  later(a: Expr, b: Expr): SQL<Date>;

  /** Null-safe `a <> b`: true when exactly one is null, false when both are. */
  isDistinctFrom(a: Expr, b: Expr): SQL;
  /** `expr` as an ORDER BY key in direction `dir`, nulls after every value either way. */
  nullsLast(expr: Expr, dir: "asc" | "desc"): SQL;
  /**
   * The text `expr`, compared in Unicode code-point order whatever the database's or column's
   * collation (`COLLATE "C"`, `COLLATE BINARY`): `USER_LOGIN` before `_generic` before `abc`.
   * Every ORDER BY over a text column goes through it — a linguistic collation (PostgreSQL's
   * `en_US.utf8` default) ignores punctuation and case at the first level and would order the
   * same rows differently on another database.
   */
  bytewise(expr: Expr): SQL<string>;

  /** Applies every pending migration shipped with the package (idempotent). */
  migrate(db: Database, migrationsFolder: string): Promise<void>;
  /** The SQL text and parameters of `query` in this dialect — for tests and diagnostics. */
  render(query: SQL): { sql: string; params: unknown[] };
}

/** What this database can do that another might not. No flag yet: both do all the server needs. */
export type DialectCapabilities = Record<never, boolean>;

/** The driver's error `code` of `error`, or of the driver error drizzle wrapped in its `cause`. */
export const errorCode = (error: unknown): string | undefined => {
  for (let current = error; current && typeof current === "object"; ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
};
