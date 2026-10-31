import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from "drizzle-orm/pg-core";

const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();

/** A tenant: every other row belongs to exactly one, and queries never cross the boundary. */
export const tenants = pgTable("memento_tenant", {
  id: uuid("id").primaryKey().defaultRandom(),
  slug: varchar("slug", { length: 63 }).notNull().unique(),
  name: varchar("name", { length: 200 }).notNull(),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: createdAt(),
});

/** API keys: only the SHA-256 of the key is stored; `prefix` finds the row. */
export const apiKeys = pgTable(
  "memento_apikey",
  {
    id: uuid("id").primaryKey().defaultRandom(),
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
    id: uuid("id").primaryKey().defaultRandom(),
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
  },
  (t) => [
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
    id: uuid("id").primaryKey().defaultRandom(),
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
    id: uuid("id").primaryKey().defaultRandom(),
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

export type TenantRow = typeof tenants.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type EventRow = typeof events.$inferSelect;
