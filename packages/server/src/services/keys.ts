import {
  type ApiKey,
  ApiKeyCreateSchema,
  ApiKeyUpdateSchema,
  type EventInput,
  type MementoEvent,
} from "@jsmemento/core";
import { and, count, eq, isNull } from "drizzle-orm";
import type { LimitsConfig } from "../config.js";
import { requireTenant } from "../context.js";
import type { Database } from "../db/index.js";
import { type ApiKeyRow, apiKeys, tenants } from "../db/schema.js";
import { MementoError } from "../errors.js";
import type { QuotaGuard } from "../quota.js";
import { parseInput } from "./accounts.js";
import { createApiKey, serializeApiKey } from "./apikeys.js";
import { type PushOptions, pushEvent } from "./events.js";

/** The event types the service writes for a key's lifecycle (lookups.yaml). */
export const APIKEY_EVENT_TYPES = {
  created: "APIKEY_CREATED",
  disabled: "APIKEY_DISABLED",
  enabled: "APIKEY_ENABLED",
  deleted: "APIKEY_DELETED",
  limitChanged: "APIKEY_LIMIT_CHANGED",
} as const;
export const APIKEY_INSTANCE_TYPE = "api_key";

export interface KeyServiceOptions {
  db: Database;
  quota: QuotaGuard;
  limits: LimitsConfig;
  /** How lifecycle events are stored (renderer, publisher, lookups). No quota: a session. */
  push: Omit<PushOptions, "quota">;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The keys a signed-in user manages (`/keys`, session credential): always the session's
 * tenant, never a deleted key. Every change writes an `APIKEY_*` event into that tenant,
 * `actor_id` = the user's email, `instance_id` = the key's prefix.
 */
export class KeyService {
  constructor(private readonly options: KeyServiceOptions) {}

  /** A key as the routes return it: status, effective daily limit, today's usage. */
  async view(row: ApiKeyRow): Promise<ApiKey> {
    return serializeApiKey(row, {
      usedToday: await this.options.quota.usedToday(row.id),
      defaultDailyLimit: this.options.limits.defaultDailyLimit,
    });
  }

  /** The current tenant's key `id` (not deleted); `not_found` for anyone else's. */
  async get(id: string): Promise<ApiKeyRow> {
    const { tenantId } = requireTenant();
    const row = UUID_RE.test(id)
      ? await this.options.db.query.apiKeys.findFirst({
          where: and(eq(apiKeys.id, id), eq(apiKeys.tenantId, tenantId), isNull(apiKeys.deletedAt)),
        })
      : undefined;
    if (!row) throw new MementoError("not_found", `no API key ${id}`);
    return row;
  }

  /** `POST /keys`: `limit_reached` when the tenant already holds `max_keys` live keys. */
  async create(body: unknown): Promise<{ apiKey: ApiKey; key: string }> {
    const input = parseInput(ApiKeyCreateSchema, body);
    const context = requireTenant();
    const { db, limits } = this.options;
    this.checkLimit(input.daily_limit);
    const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, context.tenantId) });
    if (!tenant) throw new MementoError("not_found", "tenant not found");
    const maxKeys = tenant.maxKeys ?? limits.defaultMaxKeys;
    const [live] = await db
      .select({ n: count() })
      .from(apiKeys)
      .where(
        and(eq(apiKeys.tenantId, tenant.id), isNull(apiKeys.deletedAt), isNull(apiKeys.revokedAt)),
      );
    if ((live?.n ?? 0) >= maxKeys) {
      throw new MementoError(
        "limit_reached",
        `this account may hold ${maxKeys} API keys: delete one first`,
        { max_keys: maxKeys },
      );
    }
    const created = await createApiKey(db, {
      tenant: tenant.slug,
      name: input.name,
      scopes: input.scopes,
      ...(input.expires_at ? { expiresAt: new Date(input.expires_at) } : {}),
      dailyLimit: input.daily_limit ?? null,
      createdBy: context.userId ?? null,
    });
    const row = await this.get(created.apiKey.id);
    await this.lifecycle(row, APIKEY_EVENT_TYPES.created);
    return { apiKey: await this.view(row), key: created.key };
  }

  /** `PATCH /keys/:id`: rename and/or set the daily limit (`null` → the default). */
  async update(id: string, body: unknown): Promise<ApiKey> {
    const input = parseInput(ApiKeyUpdateSchema, body);
    const row = await this.get(id);
    const set: Partial<ApiKeyRow> = {};
    if (input.name !== undefined) set.name = input.name;
    const limitChanged = input.daily_limit !== undefined && input.daily_limit !== row.dailyLimit;
    if (input.daily_limit !== undefined) {
      this.checkLimit(input.daily_limit);
      set.dailyLimit = input.daily_limit;
    }
    if (Object.keys(set).length === 0) return this.view(row);
    const updated = await this.save(row.id, set);
    if (limitChanged) {
      await this.lifecycle(updated, APIKEY_EVENT_TYPES.limitChanged, {
        daily_limit: updated.dailyLimit,
        previous: row.dailyLimit,
      });
    }
    return this.view(updated);
  }

  /** Pause (`disabled: true`) or resume a key; a no-op change writes no event. */
  async setDisabled(id: string, disabled: boolean): Promise<ApiKey> {
    const row = await this.get(id);
    if (Boolean(row.disabledAt) === disabled) return this.view(row);
    const updated = await this.save(row.id, { disabledAt: disabled ? new Date() : null });
    await this.lifecycle(
      updated,
      disabled ? APIKEY_EVENT_TYPES.disabled : APIKEY_EVENT_TYPES.enabled,
    );
    return this.view(updated);
  }

  /** Soft delete: the row stays (events point at it), hidden from every list, fails auth. */
  async delete(id: string): Promise<void> {
    const row = await this.get(id);
    const updated = await this.save(row.id, { deletedAt: new Date() });
    await this.lifecycle(updated, APIKEY_EVENT_TYPES.deleted);
  }

  /** `daily_limit` ≥ 1 and at most `MEMENTO_MAX_DAILY_LIMIT` when one is configured. */
  private checkLimit(limit: number | null | undefined): void {
    const ceiling = this.options.limits.maxDailyLimit;
    if (limit != null && ceiling !== null && limit > ceiling) {
      throw new MementoError("validation_error", `daily_limit: at most ${ceiling}`, [
        { path: ["daily_limit"], message: `at most ${ceiling}` },
      ]);
    }
  }

  private async save(id: string, set: Partial<ApiKeyRow>): Promise<ApiKeyRow> {
    const [row] = await this.options.db
      .update(apiKeys)
      .set(set)
      .where(eq(apiKeys.id, id))
      .returning();
    if (!row) throw new MementoError("not_found", `no API key ${id}`);
    return row;
  }

  private lifecycle(
    row: ApiKeyRow,
    eventType: string,
    extra: Record<string, unknown> = {},
  ): Promise<MementoEvent> {
    const context = requireTenant();
    const input: EventInput = {
      event_type: eventType,
      instance_type: APIKEY_INSTANCE_TYPE,
      instance_id: row.prefix,
      actor_id: context.userEmail ?? null,
      payload: { name: row.name, scopes: row.scopes, ...extra },
    };
    return pushEvent(this.options.db, input, this.options.push);
  }
}
