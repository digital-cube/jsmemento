import { z } from "zod";

/**
 * API key scopes.
 * - `read`  — query events, entity history, describe
 * - `write` — push events
 * - `admin` — everything (implies `read` and `write`)
 */
export const SCOPES = ["read", "write", "admin"] as const;
export const ScopeSchema = z.enum(SCOPES);
export type Scope = z.infer<typeof ScopeSchema>;

/** True when the granted scopes satisfy `required`; `admin` satisfies every scope. */
export function hasScope(granted: readonly string[], required: Scope): boolean {
  return granted.includes("admin") || granted.includes(required);
}

/** Parses a comma separated scope list (`"read,write"`), de-duplicated in canonical order. */
export function parseScopes(input: string | readonly string[]): Scope[] {
  const parts = (typeof input === "string" ? input.split(",") : [...input])
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) throw new Error("at least one scope is required");
  const unknown = parts.filter((part) => !ScopeSchema.safeParse(part).success);
  if (unknown.length > 0) {
    throw new Error(`unknown scope(s): ${unknown.join(", ")} (allowed: ${SCOPES.join(", ")})`);
  }
  return SCOPES.filter((scope) => parts.includes(scope));
}
