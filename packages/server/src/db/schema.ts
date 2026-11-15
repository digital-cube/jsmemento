import { sql } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import {
  bigint,
  boolean,
  check,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";
import { uuidv7 } from "./uuid.js";

/**
 * A UUID primary key. The application generates it (`uuidv7()`, time-ordered), so no insert
 * depends on the database for its id; `gen_random_uuid()` stays the column default for rows
 * written by hand in SQL (and keeps the migrations unchanged).
 */
const id = () => uuid("id").primaryKey().defaultRandom().$defaultFn(uuidv7);

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A tenant: every other row belongs to exactly one, and queries never cross the boundary. */
export const tenants = pgTable("memento_tenant", {
  id: id(),
  slug: varchar("slug", { length: 63 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
  /** Self-service plan (`free`, …); the quota defaults come from it and the config. */
  plan: varchar("plan", { length: 32 }).notNull().default("free"),
  /** Active API keys the tenant may hold; NULL → `MEMENTO_DEFAULT_MAX_KEYS`. */
  maxKeys: integer("max_keys"),
  /** Days events are kept; NULL → forever. */
  retentionDays: integer("retention_days"),
});

/** API keys: only the SHA-256 of the key is stored; `prefix` finds the row. */
export const apiKeys = pgTable(
  "memento_apikey",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    name: varchar("name", { length: 200 }).notNull(),
    prefix: varchar("prefix", { length: 16 }).notNull().unique(),
    keyHash: varchar("key_hash", { length: 64 }).notNull(),
    scopes: text("scopes").array().notNull(),
    createdAt: createdAt(),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    /** Paused by its owner (`POST /keys/:id/disable`); resume clears it. Fails auth while set. */
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
    /** Soft delete: hidden from lists, fails auth; the row stays because events point at it. */
    deletedAt: timestamp("deleted_at", { withTimezone: true }),
    /** Events the key may write per UTC day; NULL → `MEMENTO_DEFAULT_DAILY_LIMIT`. */
    dailyLimit: integer("daily_limit"),
    /** The user who created it on the service site; NULL for CLI keys. */
    createdBy: uuid("created_by").references((): AnyPgColumn => users.id, {
      onDelete: "set null",
    }),
    /** The UTC day the 80 % quota warning went out (once per day). */
    quotaWarnedOn: date("quota_warned_on", { mode: "string" }),
    /** The UTC day the quota-exceeded mail went out (once per day). */
    quotaExceededOn: date("quota_exceeded_on", { mode: "string" }),
  },
  (t) => [index("memento_apikey_tenant_idx").on(t.tenantId)],
);

/**
 * The immutable event log. A database trigger (migration 0001) rejects DELETE and any
 * UPDATE other than setting `archived_at` (soft delete).
 */
export const events = pgTable(
  "memento_event",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "restrict" }),
    occurredAt: timestamp("occurred_at", { withTimezone: true, precision: 3 }).notNull(),
    receivedAt: timestamp("received_at", { withTimezone: true, precision: 3 })
      .notNull()
      .defaultNow(),
    eventType: varchar("event_type", { length: 100 }).notNull(),
    instanceType: varchar("instance_type", { length: 64 }).notNull(),
    instanceId: varchar("instance_id", { length: 200 }).notNull(),
    actorId: varchar("actor_id", { length: 200 }),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    rendered: text("rendered"),
    /** Locale of `rendered`; NULL when it is verbatim text (pre-rendered by the producer, NOTE). */
    renderedLocale: varchar("rendered_locale", { length: 35 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /** The API key that wrote it; NULL for session writes and events from before 0005. */
    apiKeyId: uuid("api_key_id").references(() => apiKeys.id, { onDelete: "restrict" }),
  },
  (t) => [
    index("memento_event_apikey_idx")
      .on(t.tenantId, t.apiKeyId, t.occurredAt.desc())
      .where(sql`${t.apiKeyId} is not null`),
    index("memento_event_tenant_time_idx").on(t.tenantId, t.occurredAt.desc(), t.id.desc()),
    index("memento_event_entity_idx").on(
      t.tenantId,
      t.instanceType,
      t.instanceId,
      t.occurredAt.desc(),
    ),
    index("memento_event_type_idx").on(t.tenantId, t.eventType, t.occurredAt.desc()),
    index("memento_event_actor_idx")
      .on(t.tenantId, t.actorId, t.occurredAt.desc())
      .where(sql`${t.actorId} is not null`),
  ],
);

/** Read markers: `user_id` has seen `event_id`. */
export const seen = pgTable(
  "memento_seen",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    eventId: uuid("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 200 }).notNull(),
    seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index("memento_seen_user_idx").on(t.tenantId, t.userId),
  ],
);

/** Bookmarks: `user_id` starred `event_id`. */
export const stars = pgTable(
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
    starredAt: timestamp("starred_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.userId] }),
    index("memento_star_user_idx").on(t.tenantId, t.userId),
  ],
);

/** Per-tenant Handlebars template of an event type (or `_generic`) in a locale. */
export const templates = pgTable(
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
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("memento_template_key").on(t.tenantId, t.eventType, t.locale)],
);

/**
 * Chat instances (`instance_type = "chat"`, `instance_id = "chat-<id>"`). The chat row is
 * metadata only: messages, read markers and joins are ordinary events of that instance.
 */
export const chats = pgTable(
  "memento_chat",
  {
    id: id(),
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    instanceId: varchar("instance_id", { length: 200 }).notNull(),
    /** `direct`: exactly two participants, fixed. `room`: members can be added. */
    kind: varchar("kind", { length: 16 }).$type<"direct" | "room">().notNull().default("room"),
    name: varchar("name", { length: 200 }),
    createdAt: createdAt(),
    /** `occurred_at` of the newest message (denormalized, for listing chats by activity). */
    lastMessageAt: timestamp("last_message_at", { withTimezone: true, precision: 3 }),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("memento_chat_instance_key").on(t.tenantId, t.instanceId),
    check("memento_chat_kind_check", sql`${t.kind} in ('direct', 'room')`),
  ],
);

/** Who is in a chat, and how far each participant has read (the seen watermark). */
export const chatParticipants = pgTable(
  "memento_chat_participant",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    chatId: uuid("chat_id")
      .notNull()
      .references(() => chats.id, { onDelete: "cascade" }),
    userId: varchar("user_id", { length: 200 }).notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    /** Last CHAT_MESSAGE_SENT event the participant has read up to (inclusive). */
    lastSeenEventId: uuid("last_seen_event_id"),
    /** `occurred_at` of that message: watermarks only move forward in (occurred_at, id). */
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true, precision: 3 }),
  },
  (t) => [
    primaryKey({ columns: [t.chatId, t.userId] }),
    index("memento_chat_participant_user_idx").on(t.tenantId, t.userId),
  ],
);

/** A person who signs in to the service site (self-service accounts, `MEMENTO_ACCOUNTS`). */
export const users = pgTable(
  "memento_user",
  {
    id: id(),
    /** Stored trimmed and lower-cased. */
    email: varchar("email", { length: 320 }).notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    name: varchar("name", { length: 200 }).notNull(),
    locale: varchar("locale", { length: 8 }).$type<"en" | "sr">().notNull().default("en"),
    emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
    termsAcceptedAt: timestamp("terms_accepted_at", { withTimezone: true }).notNull(),
    isAdmin: boolean("is_admin").notNull().default(false),
    createdAt: createdAt(),
    disabledAt: timestamp("disabled_at", { withTimezone: true }),
  },
  (t) => [check("memento_user_locale_check", sql`${t.locale} in ('en', 'sr')`)],
);

/** Which users belong to which tenant. Registration makes the `owner` row. */
export const tenantUsers = pgTable(
  "memento_tenant_user",
  {
    tenantId: uuid("tenant_id")
      .notNull()
      .references(() => tenants.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: varchar("role", { length: 16 }).$type<"owner" | "member">().notNull(),
    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.tenantId, t.userId] }),
    index("memento_tenant_user_user_idx").on(t.userId),
    check("memento_tenant_user_role_check", sql`${t.role} in ('owner', 'member')`),
  ],
);

/** A signed-in browser: `id` is the SHA-256 hex of the `memento_session` cookie value. */
export const sessions = pgTable(
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
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
    userAgent: varchar("user_agent", { length: 400 }),
    ip: varchar("ip", { length: 64 }),
  },
  (t) => [
    index("memento_session_user_idx").on(t.userId),
    index("memento_session_expires_idx").on(t.expiresAt),
  ],
);

/** Single-use mail tokens (`verify` the address, `reset` the password); only the hash is kept. */
export const userTokens = pgTable(
  "memento_user_token",
  {
    id: id(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    kind: varchar("kind", { length: 16 }).$type<"verify" | "reset">().notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull().unique(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt: timestamp("used_at", { withTimezone: true }),
    createdAt: createdAt(),
  },
  (t) => [
    index("memento_user_token_user_idx").on(t.userId),
    check("memento_user_token_kind_check", sql`${t.kind} in ('verify', 'reset')`),
  ],
);

const counter = (name: string) => bigint(name, { mode: "number" }).notNull().default(0);

/**
 * What a key did per hour (UTC): the usage meter's counters, flushed every few seconds with
 * `INSERT … ON CONFLICT DO UPDATE SET col = col + excluded.col`.
 */
export const apiKeyUsage = pgTable(
  "memento_apikey_usage",
  {
    apiKeyId: uuid("api_key_id")
      .notNull()
      .references(() => apiKeys.id, { onDelete: "cascade" }),
    tenantId: uuid("tenant_id").notNull(),
    /** Truncated to the hour, UTC. */
    hour: timestamp("hour", { withTimezone: true }).notNull(),
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

export type TenantRow = typeof tenants.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type ApiKeyUsageRow = typeof apiKeyUsage.$inferSelect;
export type UserRow = typeof users.$inferSelect;
export type SessionRow = typeof sessions.$inferSelect;
