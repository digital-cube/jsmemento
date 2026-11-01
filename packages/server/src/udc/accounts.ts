import { type ViewConfigInput, ViewConfigSchema } from "@jsudc/core";
import { and, count, eq, isNotNull, isNull, type SQL, type SQLWrapper, sql } from "drizzle-orm";
import { requireTenant } from "../context.js";
import type { Database } from "../db/client.js";
import { apiKeys, apiKeyUsage, events, tenants, tenantUsers, users } from "../db/schema.js";
import type { QuotaGuard } from "../quota.js";
import { APIKEY_INSTANCE_TYPE } from "../services/keys.js";
import type { EventRenderer } from "../templates/renderer.js";
import { ActivityCollectionSource, type ActivitySourceOptions } from "./activity.js";
import type { MementoRegistry } from "./registry.js";
import { EventCollectionSource, type EventField } from "./source.js";
import { TableCollectionSource, type TableField } from "./table.js";

/** What the self-service collections need besides the database. */
export interface AccountCollectionsOptions {
  /** Today's events per key (`used_today`) and the default daily limit. */
  quota: QuotaGuard;
}

const string = (expr: SQLWrapper, description: string): TableField => ({
  def: { type: "string", index: true, description },
  kind: "text",
  expr,
});
const time = (expr: SQLWrapper, description: string): TableField => ({
  def: { type: "datetime", index: true, description },
  kind: "time",
  expr,
});
const integer = (expr: SQLWrapper, description: string): TableField => ({
  def: { type: "integer", min: 0, index: true, description },
  kind: "number",
  expr,
});
const bool = (expr: SQL, description: string): TableField => ({
  def: { type: "bool", index: true, description },
  // `eq true/false` compares the boolean SQL with a coerced string, which Postgres casts.
  kind: "text",
  expr,
});

/** `revoked` > `expired` > `disabled` > `active`, as `keyStatus` says. */
const keyStatusSql = sql<string>`(case
  when ${apiKeys.revokedAt} is not null then 'revoked'
  when ${apiKeys.expiresAt} is not null and ${apiKeys.expiresAt} <= now() then 'expired'
  when ${apiKeys.disabledAt} is not null then 'disabled'
  else 'active' end)`;

/** Live events the key wrote in the last 24 hours (the `memento_event_apikey_idx` index). */
const events24hSql = sql<number>`(select count(*)::int from ${events}
  where ${events.tenantId} = ${apiKeys.tenantId} and ${events.apiKeyId} = ${apiKeys.id}
  and ${events.occurredAt} > now() - interval '24 hours' and ${events.archivedAt} is null)`;

/** The fields of a key, as its owner sees them. */
function apiKeyFields(defaultDailyLimit: number): Record<string, TableField> {
  return {
    name: string(apiKeys.name, "What the key is for"),
    prefix: string(apiKeys.prefix, "The 8 characters after mk_: how a key is recognized"),
    scopes: {
      def: { type: "string_array", description: "read, write" },
      kind: "text",
      expr: sql`array_to_string(${apiKeys.scopes}, ',')`,
      select: apiKeys.scopes,
      sortable: false,
    },
    status: {
      def: {
        type: "enum",
        values: ["active", "disabled", "revoked", "expired"],
        index: true,
        description: "active, disabled (paused), revoked, expired",
      },
      kind: "text",
      expr: keyStatusSql,
    },
    daily_limit: integer(
      sql`coalesce(${apiKeys.dailyLimit}, ${defaultDailyLimit}::int)`,
      "Events the key may write per UTC day",
    ),
    used_today: {
      def: { type: "integer", min: 0, description: "Events it wrote today (UTC)" },
      kind: "number",
    },
    events_24h: integer(events24hSql, "Events it wrote in the last 24 hours"),
    created_at: time(apiKeys.createdAt, "When it was created"),
    last_used_at: time(apiKeys.lastUsedAt, "When it last authenticated a request"),
    expires_at: time(apiKeys.expiresAt, "When it stops working; empty: never"),
  };
}

/** `used_today` of a page of keys, in one Redis MGET (or one SUM). */
function hydrateUsedToday(quota: QuotaGuard) {
  return async (rows: { __meta: { id: string }; [k: string]: unknown }[]) => {
    const used = await quota.usedTodayMany(rows.map((r) => r.__meta.id));
    for (const row of rows) row.used_today = used.get(row.__meta.id) ?? 0;
  };
}

/** `api_keys` (the session's tenant) or `admin_api_keys` (every tenant, with owner columns). */
export function apiKeysSource(
  db: Database,
  quota: QuotaGuard,
  defaultDailyLimit: number,
  admin = false,
): TableCollectionSource {
  const fields: Record<string, TableField> = admin
    ? {
        user: string(users.email, "Who created it (empty: a CLI key)"),
        tenant: string(tenants.slug, "The tenant it belongs to"),
        ...apiKeyFields(defaultDailyLimit),
      }
    : apiKeyFields(defaultDailyLimit);
  return new TableCollectionSource({
    fields,
    id: apiKeys.id,
    select: (selection) =>
      db
        .select(selection as never)
        .from(apiKeys)
        .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
        .leftJoin(users, eq(users.id, apiKeys.createdBy))
        .$dynamic() as never,
    count: () =>
      db
        .select({ total: count() })
        .from(apiKeys)
        .innerJoin(tenants, eq(tenants.id, apiKeys.tenantId))
        .leftJoin(users, eq(users.id, apiKeys.createdBy))
        .$dynamic(),
    scope: () =>
      admin
        ? isNull(apiKeys.deletedAt)
        : and(eq(apiKeys.tenantId, requireTenant().tenantId), isNull(apiKeys.deletedAt)),
    defaultSort: [{ field: "created_at", dir: "desc" }],
    hydrate: hydrateUsedToday(quota),
    readOnlyMessage: "keys change through POST/PATCH/DELETE /keys",
  });
}

const counter = (column: typeof apiKeyUsage.requests, description: string): TableField =>
  integer(column, description);

/** `api_key_usage`: the tenant's hourly usage rows, newest hour first. */
export function apiKeyUsageSource(db: Database): TableCollectionSource {
  return new TableCollectionSource({
    fields: {
      api_key: string(apiKeys.prefix, "The key's prefix"),
      hour: time(apiKeyUsage.hour, "The hour (UTC) the counters cover"),
      requests: counter(apiKeyUsage.requests, "Requests the key made"),
      events_written: counter(apiKeyUsage.eventsWritten, "Events it stored"),
      rows_read: counter(apiKeyUsage.rowsRead, "Rows its reads returned"),
      stream_seconds: counter(apiKeyUsage.streamSeconds, "Seconds of open /ws streams"),
      bytes_in: counter(apiKeyUsage.bytesIn, "Request bytes it sent"),
    },
    // One key and hour per row: the id joins both.
    id: sql`(${apiKeyUsage.apiKeyId}::text || '|' || to_char(${apiKeyUsage.hour} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:00:00"Z"'))`,
    select: (selection) =>
      db
        .select(selection as never)
        .from(apiKeyUsage)
        .innerJoin(apiKeys, eq(apiKeys.id, apiKeyUsage.apiKeyId))
        .$dynamic() as never,
    count: () =>
      db
        .select({ total: count() })
        .from(apiKeyUsage)
        .innerJoin(apiKeys, eq(apiKeys.id, apiKeyUsage.apiKeyId))
        .$dynamic(),
    scope: () => eq(apiKeyUsage.tenantId, requireTenant().tenantId),
    defaultSort: [{ field: "hour", dir: "desc" }],
    readOnlyMessage: "usage is counted by the server",
  });
}

/** `admin_users`: every self-service user with their (owned) tenant and its live keys. */
export function adminUsersSource(db: Database): TableCollectionSource {
  const liveKeys = sql<number>`(select count(*)::int from ${apiKeys}
    where ${apiKeys.tenantId} = ${tenants.id} and ${apiKeys.deletedAt} is null
    and ${apiKeys.revokedAt} is null)`;
  const join = <Q extends ReturnType<typeof base>>(q: Q) =>
    q
      .leftJoin(
        tenantUsers,
        and(eq(tenantUsers.userId, users.id), eq(tenantUsers.role, "owner")) as SQL,
      )
      .leftJoin(tenants, eq(tenants.id, tenantUsers.tenantId));
  const base = (selection: Record<string, unknown>) =>
    db
      .select(selection as never)
      .from(users)
      .$dynamic();
  return new TableCollectionSource({
    fields: {
      email: string(users.email, "Sign-in address"),
      name: string(users.name, "Display name"),
      tenant: string(tenants.slug, "The tenant they own"),
      tenant_name: string(tenants.name, "Its name"),
      email_verified: bool(sql`(${users.emailVerifiedAt} is not null)`, "Address confirmed"),
      is_admin: bool(sql`${users.isAdmin}`, "Administrator"),
      disabled: bool(sql`(${users.disabledAt} is not null)`, "Cannot sign in"),
      keys: integer(liveKeys, "Live (not deleted, not revoked) keys of their tenant"),
      created_at: time(users.createdAt, "When they registered"),
    },
    id: users.id,
    select: (selection) => join(base(selection)) as never,
    count: () => join(base({ total: count() })) as never,
    scope: () => undefined,
    defaultSort: [{ field: "created_at", dir: "desc" }],
    readOnlyMessage: "users change through POST /admin/users/:id/disable|enable",
  });
}

const API_KEY_COLUMNS = [
  { field: "name", width: 200 },
  { field: "prefix", width: 110 },
  { field: "scopes", width: 120 },
  { field: "status", width: 100 },
  { field: "daily_limit", align: "right" as const, width: 110, render: "number_format" },
  { field: "used_today", align: "right" as const, width: 110, render: "number_format" },
  { field: "events_24h", align: "right" as const, width: 110, render: "number_format" },
  { field: "created_at", width: 170, transform: "date_format:YYYY-MM-DD HH:mm" },
  { field: "last_used_at", width: 170, transform: "date_format:YYYY-MM-DD HH:mm" },
  { field: "expires_at", width: 170, transform: "date_format:YYYY-MM-DD HH:mm" },
];
const STATUS_FILTER = {
  field: "status",
  kind: "select" as const,
  options: ["active", "disabled", "revoked", "expired"],
};

export const API_KEYS_VIEW: ViewConfigInput = {
  default_renderer: "table",
  available_renderers: ["table"],
  page_size_default: 50,
  columns: API_KEY_COLUMNS,
  search: { fields: ["name", "prefix"] },
  filters: [STATUS_FILTER],
};

export const ADMIN_API_KEYS_VIEW: ViewConfigInput = {
  ...API_KEYS_VIEW,
  columns: [{ field: "user", width: 220 }, { field: "tenant", width: 130 }, ...API_KEY_COLUMNS],
  search: { fields: ["name", "prefix", "user", "tenant"] },
};

export const API_KEY_USAGE_VIEW: ViewConfigInput = {
  default_renderer: "table",
  available_renderers: ["table", "chart"],
  page_size_default: 50,
  columns: [
    { field: "hour", width: 170, transform: "date_format:YYYY-MM-DD HH:mm" },
    { field: "api_key", width: 110 },
    ...["requests", "events_written", "rows_read", "stream_seconds", "bytes_in"].map((field) => ({
      field,
      align: "right" as const,
      width: 120,
      render: "number_format",
    })),
  ],
  chart_options: {
    type: "bar",
    x_field: "hour",
    series: [
      { field: "events_written", label: "Events written", agg: "sum" },
      { field: "rows_read", label: "Rows read", agg: "sum" },
      { field: "requests", label: "Requests", agg: "sum" },
    ],
    y_axis: { left: { baseline: "zero", format: "number_format" } },
    max_rows: 2_000,
    empty_label: "No usage in this window",
  },
};

export const ADMIN_USERS_VIEW: ViewConfigInput = {
  default_renderer: "table",
  available_renderers: ["table"],
  page_size_default: 50,
  columns: [
    { field: "email", width: 240 },
    { field: "name", width: 180 },
    { field: "tenant", width: 130 },
    { field: "tenant_name", width: 180 },
    { field: "email_verified", width: 110 },
    { field: "is_admin", width: 90 },
    { field: "disabled", width: 90 },
    { field: "keys", align: "right", width: 80 },
    { field: "created_at", width: 170, transform: "date_format:YYYY-MM-DD HH:mm" },
  ],
  search: { fields: ["email", "name", "tenant"] },
};

/** The `api_key` field of the event collections: the prefix of the key that wrote it. */
export const API_KEY_EVENT_FIELD: EventField = {
  def: {
    type: "string",
    index: true,
    description: "The prefix of the API key that wrote it (empty: written by a signed-in user)",
  },
  kind: "text",
  expr: apiKeys.prefix,
  sortable: false,
  value: (e) => e.api_key,
};

export interface RegisterAccountCollectionsOptions extends AccountCollectionsOptions {
  db: Database;
  renderer?: EventRenderer | undefined;
  /** `api_key_events`' fields and view: the `events` collection's. */
  eventFields: Record<string, EventField>;
  eventsView: ViewConfigInput;
  /** `api_key_activity`'s view and window: the `activity` collection's. */
  activityView: ViewConfigInput;
  activity?: ActivitySourceOptions | undefined;
}

/**
 * The self-service collections (`MEMENTO_ACCOUNTS`), all read with the session cookie:
 * `api_keys`, `api_key_events`, `api_key_history`, `api_key_activity`, `api_key_usage` for
 * the signed-in user's tenant, `admin_users` and `admin_api_keys` for administrators.
 */
export function registerAccountCollections(
  registry: MementoRegistry,
  options: RegisterAccountCollectionsOptions,
): void {
  const { db, quota, renderer } = options;
  const defaultDailyLimit = quota.limitOf({ dailyLimit: null });
  registry.register({
    name: "api_keys",
    label: "API keys",
    auth: "session",
    source: apiKeysSource(db, quota, defaultDailyLimit),
    view: ViewConfigSchema.parse(API_KEYS_VIEW),
  });
  registry.register({
    name: "api_key_events",
    label: "Events of an API key",
    auth: "session",
    source: new EventCollectionSource(
      db,
      { fields: options.eventFields, where: isNotNull(events.apiKeyId), requiredFilter: "api_key" },
      renderer,
    ),
    view: ViewConfigSchema.parse(options.eventsView),
  });
  registry.register({
    name: "api_key_history",
    label: "History of an API key",
    auth: "session",
    // The key's own lifecycle (APIKEY_CREATED, _DISABLED, …): written by the signed-in user,
    // so not in `api_key_events` (events a key wrote). `instance_id` is the key's prefix.
    source: new EventCollectionSource(
      db,
      {
        fields: options.eventFields,
        where: eq(events.instanceType, APIKEY_INSTANCE_TYPE),
        requiredFilter: "instance_id",
      },
      renderer,
    ),
    view: ViewConfigSchema.parse(options.eventsView),
  });
  registry.register({
    name: "api_key_activity",
    label: "Activity of API keys per minute",
    auth: "session",
    source: new ActivityCollectionSource(db, { ...options.activity, byApiKey: true }),
    view: ViewConfigSchema.parse(options.activityView),
  });
  registry.register({
    name: "api_key_usage",
    label: "API key usage per hour",
    auth: "session",
    source: apiKeyUsageSource(db),
    view: ViewConfigSchema.parse(API_KEY_USAGE_VIEW),
  });
  registry.register({
    name: "admin_users",
    label: "Users",
    auth: "admin",
    source: adminUsersSource(db),
    view: ViewConfigSchema.parse(ADMIN_USERS_VIEW),
  });
  registry.register({
    name: "admin_api_keys",
    label: "All API keys",
    auth: "admin",
    source: apiKeysSource(db, quota, defaultDailyLimit, true),
    view: ViewConfigSchema.parse(ADMIN_API_KEYS_VIEW),
  });
}
