/**
 * The tables the services query, of the database this process speaks. They are the
 * PostgreSQL tables of `./schema-postgres.ts` until `connect` opens a SQLite database, which
 * swaps in the twins of `./schema-sqlite.ts` (`useSchemaOf`) — ES module bindings are live, so
 * every importer sees the swap. Both have the same row types (`SAME_ROWS` in the SQLite
 * schema); the TypeScript type is the PostgreSQL one either way.
 *
 * Read a table (`events.occurredAt`) when a query is built, never into a module-level
 * constant: a column captured at import time stays a PostgreSQL column on SQLite.
 */
import * as pg from "./schema-postgres.js";
import * as sqlite from "./schema-sqlite.js";

export type {
  ApiKeyRow,
  ApiKeyUsageRow,
  EventRow,
  SessionRow,
  TenantRow,
  UserRow,
} from "./schema-postgres.js";

export let tenants = pg.tenants;
export let apiKeys = pg.apiKeys;
export let events = pg.events;
export let seen = pg.seen;
export let stars = pg.stars;
export let templates = pg.templates;
export let chats = pg.chats;
export let chatParticipants = pg.chatParticipants;
export let users = pg.users;
export let tenantUsers = pg.tenantUsers;
export let sessions = pg.sessions;
export let userTokens = pg.userTokens;
export let apiKeyUsage = pg.apiKeyUsage;

/** Which schema the bindings above hold. */
let current: "postgres" | "sqlite" = "postgres";

/** Points every table binding at the schema of `dialect`. */
export function useSchemaOf(dialect: "postgres" | "sqlite"): void {
  if (dialect === current) return;
  const s = (dialect === "sqlite" ? sqlite : pg) as unknown as typeof pg;
  tenants = s.tenants;
  apiKeys = s.apiKeys;
  events = s.events;
  seen = s.seen;
  stars = s.stars;
  templates = s.templates;
  chats = s.chats;
  chatParticipants = s.chatParticipants;
  users = s.users;
  tenantUsers = s.tenantUsers;
  sessions = s.sessions;
  userTokens = s.userTokens;
  apiKeyUsage = s.apiKeyUsage;
  current = dialect;
}
