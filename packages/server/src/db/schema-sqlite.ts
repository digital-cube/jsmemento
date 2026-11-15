/**
 * The SQLite schema of JSMemento: the tables of `./schema-postgres.ts` (read the documentation
 * there), column for column, on `drizzle-orm/sqlite-core`. `pnpm db:generate` writes its
 * migrations into `../../drizzle-sqlite`. The row types are the PostgreSQL ones (checked at
 * the end of the file), so the services see one shape whichever database they run on:
 *
 * - `uuid` → TEXT, lower-cased when bound (PostgreSQL compares UUIDs case-insensitively; the
 *   ids stay UUID v7 from the application);
 * - `varchar`, `text` → TEXT; `date` (`quota_warned_on`, …) → TEXT `YYYY-MM-DD`;
 * - `timestamp with time zone` → INTEGER, epoch milliseconds (`Date` in TypeScript);
 * - `boolean` → INTEGER 0/1; `integer`, `bigint` → INTEGER;
 * - `jsonb` (`memento_event.payload`) and `text[]` (`memento_apikey.scopes`) → TEXT holding JSON.
 *
 * The CHECK constraints, the unique indexes and the partial indexes are the PostgreSQL ones.
 * An index column has no `DESC` here: SQLite walks an index backwards for a descending scan.
 * The event immutability trigger of PostgreSQL's migration 0001 is the hand-written
 * `drizzle-sqlite/0001_event_immutability.sql`.
 */
import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  customType,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import type * as pg from "./schema-postgres.js";
import { uuidv7 } from "./uuid.js";

/** Now, in epoch milliseconds: the `defaultNow()` of these tables. */
const NOW_MS = sql`(cast(unixepoch('subsec') * 1000 as integer))`;

/** A UUID as TEXT, bound in lower case so `eq(id, 'ABC…')` matches as it does on PostgreSQL. */
const uuidText = customType<{ data: string; driverData: string }>({
  dataType: () => "text",
  toDriver: (value) => value.toLowerCase(),
});

const uuid = (name: string) => uuidText(name);
const id = () => uuid("id").primaryKey().$defaultFn(uuidv7);
const varchar = (name: string, _options: { length: number }) => text(name);
const timestamp = (name: string) => integer(name, { mode: "timestamp_ms" });
const createdAt = () => timestamp("created_at").notNull().default(NOW_MS);
const boolean = (name: string) => integer(name, { mode: "boolean" });
const json = <T>(name: string) => text(name, { mode: "json" }).$type<T>();
/** A calendar day, `YYYY-MM-DD` (PostgreSQL `date` in string mode). */
const date = (name: string) => text(name);
const counter = (name: string) => integer(name, { mode: "number" }).notNull().default(0);

export const tenants = sqliteTable("memento_tenant", {
  id: id(),
  slug: varchar("slug", { length: 63 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  plan: varchar("plan", { length: 32 }).notNull().default("free"),
  maxKeys: integer("max_keys"),
  retentionDays: integer("retention_days"),
});

export const apiKeys = sqliteTable(
  "memento_apikey",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    prefix: varchar("prefix", { length: 16 }).notNull().unique(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    scopes: json<string[]>("scopes").notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at"),
    expiresAt: timestamp("expires_at"),
    revokedAt: timestamp("revoked_at"),
    disabledAt: timestamp("disabled_at"),
    deletedAt: timestamp("deleted_at"),
    dailyLimit: integer("daily_limit"),
    createdBy: uuid("created_by").references((): AnySQLiteColumn => users.id, {
      onDelete: "set null",
    }),
    quotaWarnedOn: date("quota_warned_on"),
    quotaExceededOn: date("quota_exceeded_on"),
  },
  (t) => [index("memento_apikey_tenant_idx").on(t.tenantId)],
);

export const events = sqliteTable(
  "memento_event",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at").notNull(),
    receivedAt: timestamp("received_at").notNull().default(NOW_MS),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    instanceType: varchar("instance_type", { length: 64 }).notNull(),
    instanceId: varchar("instance_id", { length: 200 }).notNull(),
    actorId: varchar("actor_id", { length: 200 }),
    payload: json<Record<string, unknown>>("payload").notNull().default({}),
    rendered: text("rendered"),
    renderedLocale: varchar("rendered_locale", { length: 35 }),
    archivedAt: timestamp("archived_at"),
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("memento_event_apikey_idx")
      .on(t.tenantId, t.apiKeyId, t.occurredAt)
      .where(sql`${t.apiKeyId} is not null`),
    index("memento_event_tenant_time_idx").on(t.tenantId, t.occurredAt, t.id),
    index("memento_event_entity_idx").on(t.tenantId, t.instanceType, t.instanceId, t.occurredAt),
    index("memento_event_type_idx").on(t.tenantId, t.eventType, t.occurredAt),
    index("memento_event_actor_idx")
      .on(t.tenantId, t.actorId, t.occurredAt)
      .where(sql`${t.actorId} is not null`),
  ],
);

export const seen = sqliteTable(
  "memento_seen",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 200 }).notNull(),
    seenAt: timestamp("seen_at").notNull().default(NOW_MS),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index("memento_seen_user_idx").on(t.tenantId, t.userId),
  ],
);

export const stars = sqliteTable(
  "memento_star",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 200 }).notNull(),
    note: text("note"),
    starredAt: timestamp("starred_at").notNull().default(NOW_MS),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index("memento_star_user_idx").on(t.tenantId, t.userId),
  ],
);

export const templates = sqliteTable(
  "memento_template",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    locale: varchar("locale", { length: 35 }).notNull(),
    body: text("body").notNull(),
    createdAt: createdAt(),
    updatedAt: timestamp("updated_at").notNull().default(NOW_MS),
  },
  (t) => [uniqueIndex("memento_template_key").on(t.tenantId, t.eventType, t.locale)],
);

export const chats = sqliteTable(
  "memento_chat",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    instanceId: varchar("instance_id", { length: 200 }).notNull(),
    kind: varchar("kind", { length: 16 }).$type<"direct" | "room">().notNull().default("room"),
    name: varchar("name", { length: 200 }),
    createdAt: createdAt(),
    lastMessageAt: timestamp("last_message_at"),
    archivedAt: timestamp("archived_at"),
  },
  (t) => [
    uniqueIndex("memento_chat_instance_key").on(t.tenantId, t.instanceId),
    check("memento_chat_kind_check", sql`${t.kind} in ('direct', 'room')`),
  ],
);

export const chatParticipants = sqliteTable(
  "memento_chat_participant",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 200 }).notNull(),
    addedAt: timestamp("added_at").notNull().default(NOW_MS),
    lastSeenEventId: uuid("last_seen_event_id"),
    lastSeenAt: timestamp("last_seen_at"),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    index("memento_chat_participant_user_idx").on(t.tenantId, t.userId),
  ],
);

export const users = sqliteTable(
  "memento_user",
  {
    id: id(),
    email: varchar("email", { length: 320 }).notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    locale: varchar("locale", { length: 8 }).$type<"en" | "sr">().notNull().default("en"),
    emailVerifiedAt: timestamp("email_verified_at"),
    termsAcceptedAt: timestamp("terms_accepted_at").notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: createdAt(),
    disabledAt: timestamp("disabled_at"),
  },
  (t) => [check("memento_user_locale_check", sql`${t.locale} in ('en', 'sr')`)],
);

export const tenantUsers = sqliteTable(
  "memento_tenant_user",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).$type<"owner" | "member">().notNull(),
    addedAt: timestamp("added_at").notNull().default(NOW_MS),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("memento_tenant_user_user_idx").on(t.userId),
    check("memento_tenant_user_role_check", sql`${t.role} in ('owner', 'member')`),
  ],
);

export const sessions = sqliteTable(
  "memento_session",
  {
    id: varchar("id", { length: 64 }).primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    createdAt: createdAt(),
    expiresAt: timestamp("expires_at").notNull(),
    lastSeenAt: timestamp("last_seen_at").notNull().default(NOW_MS),
    userAgent: varchar("user_agent", { length: 400 }),
    ip: varchar("ip", { length: 64 }),
  },
  (t) => [
    index("memento_session_user_idx").on(t.userId),
    index("memento_session_expires_idx").on(t.expiresAt),
  ],
);

export const userTokens = sqliteTable(
  "memento_user_token",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).$type<"verify" | "reset">().notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at").notNull(),
    usedAt: timestamp("used_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("memento_user_token_user_idx").on(t.userId),
    check("memento_user_token_kind_check", sql`${t.kind} in ('verify', 'reset')`),
  ],
);

export const apiKeyUsage = sqliteTable(
  "memento_apikey_usage",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull(),
    hour: timestamp("hour").notNull(),
    requests: counter("requests"),
    eventsWritten: counter("events_written"),
    rowsRead: counter("rows_read"),
    streamSeconds: counter("stream_seconds"),
    bytesIn: counter("bytes_in"),
  },
  (t) => [
    primaryKey({ columns: [t.apiKeyId, t.hour] }),
    index("memento_apikey_usage_tenant_idx").on(t.tenantId, t.hour),
  ],
);

// --- one row shape for both databases ----------------------------------------------------

/** `true` when `A` and `B` are the same type. */
type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

interface SqliteTables {
  tenants: typeof tenants;
  apiKeys: typeof apiKeys;
  events: typeof events;
  seen: typeof seen;
  stars: typeof stars;
  templates: typeof templates;
  chats: typeof chats;
  chatParticipants: typeof chatParticipants;
  users: typeof users;
  tenantUsers: typeof tenantUsers;
  sessions: typeof sessions;
  userTokens: typeof userTokens;
  apiKeyUsage: typeof apiKeyUsage;
}

/**
 * Compiles only while every table here reads (and writes) the rows its PostgreSQL twin does —
 * the services are typed against those — and while both schemas have the same tables.
 */
export const SAME_ROWS: {
  [K in keyof SqliteTables]: K extends keyof typeof pg
    ? (typeof pg)[K] extends { $inferSelect: infer P; $inferInsert: infer I }
      ? Same<P, SqliteTables[K]["$inferSelect"]> extends true
        ? Same<I, SqliteTables[K]["$inferInsert"]>
        : false
      : never
    : never;
} = {
  tenants: true,
  apiKeys: true,
  events: true,
  seen: true,
  stars: true,
  templates: true,
  chats: true,
  chatParticipants: true,
  users: true,
  tenantUsers: true,
  sessions: true,
  userTokens: true,
  apiKeyUsage: true,
};

/** Every PostgreSQL table has its twin here (a table added there and not here fails to compile). */
export const SAME_TABLES: Same<
  Exclude<
    {
      [K in keyof typeof pg]: (typeof pg)[K] extends { $inferSelect: unknown } ? K : never;
    }[keyof typeof pg],
    undefined
  >,
  keyof SqliteTables
> = true;
