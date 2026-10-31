/**
 * Plain-language messages for the failures a CLI user actually meets — the database is down
 * or not migrated, the credentials are wrong — instead of a driver's stack trace.
 */

export interface FriendlyError {
  message: string;
  /** What to do about it. */
  hint?: string;
}

/** `error` and its `cause` chain (drizzle wraps the driver's error as `cause`). */
function chain(error: unknown): (Error & { code?: unknown })[] {
  const errors: (Error & { code?: unknown })[] = [];
  let current: unknown = error;
  while (current instanceof Error && errors.length < 10) {
    errors.push(current);
    current = (current as { cause?: unknown }).cause;
  }
  return errors;
}

/** Where `DATABASE_URL` points, without the password. */
export function describeDatabaseUrl(url: string | undefined): string {
  if (!url) return "the database";
  try {
    const parsed = new URL(url);
    return `${parsed.hostname}:${parsed.port || "5432"}${parsed.pathname}`;
  } catch {
    return "the database";
  }
}

/** A friendly description of an unexpected error, or `null` when it has none. */
export function friendlyError(error: unknown, databaseUrl?: string): FriendlyError | null {
  const where = describeDatabaseUrl(databaseUrl);
  for (const e of chain(error)) {
    const code = typeof e.code === "string" ? e.code : undefined;
    switch (code) {
      case "ECONNREFUSED":
      case "ENOTFOUND":
      case "EAI_AGAIN":
      case "ETIMEDOUT":
        return {
          message: `cannot connect to PostgreSQL at ${where}`,
          hint: "start it with `pnpm db:up`, or point DATABASE_URL at a running server",
        };
      case "28P01":
      case "28000":
        return {
          message: `PostgreSQL at ${where} rejected the user or password`,
          hint: "check the credentials in DATABASE_URL",
        };
      case "3D000":
        return {
          message: `the database in DATABASE_URL (${where}) does not exist`,
          hint: "create it, or fix the database name in DATABASE_URL",
        };
      case "42P01":
        return {
          message: "the database has no memento tables yet",
          hint: "run `memento migrate` first",
        };
    }
  }
  return null;
}
