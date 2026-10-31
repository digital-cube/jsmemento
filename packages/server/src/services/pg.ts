/** Postgres SQLSTATE of an error thrown by `pg` (drizzle wraps it in `cause`). */
function sqlState(error: unknown): string | undefined {
  for (let current = error; current && typeof current === "object"; ) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === "string") return code;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

export function isUniqueViolation(error: unknown): boolean {
  return sqlState(error) === "23505";
}
