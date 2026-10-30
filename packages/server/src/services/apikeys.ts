import {
  type ApiKey,
  generateApiKey,
  hashApiKey,
  parseApiKey,
  parseScopes,
  type Scope,
  timingSafeEqual,
} from "@memento/core";
import { and, eq, isNull } from "drizzle-orm";
import type { TenantContext } from "../context.js";
import type { Database } from "../db/client.js";
import { type ApiKeyRow, apiKeys, tenants } from "../db/schema.js";
import { MementoError } from "../errors.js";
import { getTenantBySlug } from "./tenants.js";

export function serializeApiKey(row: ApiKeyRow): ApiKey {
  return {
    id: row.id,
    tenant_id: row.tenantId,
    name: row.name,
    prefix: row.prefix,
    scopes: row.scopes as Scope[],
    created_at: row.createdAt.toISOString(),
    last_used_at: row.lastUsedAt?.toISOString() ?? null,
    expires_at: row.expiresAt?.toISOString() ?? null,
    revoked_at: row.revokedAt?.toISOString() ?? null,
  };
}

export interface CreateApiKeyInput {
  tenant: string;
  name: string;
  scopes: string | readonly string[];
  expiresAt?: Date;
}

/**
 * Creates a key for a tenant. The plaintext `key` is returned exactly once — only its
 * hash is stored.
 */
export async function createApiKey(
  db: Database,
  input: CreateApiKeyInput,
): Promise<{ apiKey: ApiKey; key: string }> {
  const name = input.name.trim();
  if (!name) throw new MementoError("validation_error", "key name is required");
  let scopes: Scope[];
  try {
    scopes = parseScopes(input.scopes);
  } catch (error) {
    throw new MementoError("validation_error", (error as Error).message);
  }
  const tenant = await getTenantBySlug(db, input.tenant);
  const { key, prefix } = generateApiKey();
  const [row] = await db
    .insert(apiKeys)
    .values({
      tenantId: tenant.id,
      name,
      prefix,
      keyHash: await hashApiKey(key),
      scopes,
      expiresAt: input.expiresAt ?? null,
    })
    .returning();
  return { apiKey: serializeApiKey(row as ApiKeyRow), key };
}

/** Revokes a key by prefix; revoked keys fail authentication from then on. */
export async function revokeApiKey(db: Database, prefix: string): Promise<ApiKey> {
  const [row] = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.prefix, prefix), isNull(apiKeys.revokedAt)))
    .returning();
  if (!row) throw new MementoError("not_found", `no active key with prefix "${prefix}"`);
  return serializeApiKey(row);
}

/**
 * Resolves a plaintext key to the tenant context it grants, or throws `unauthorized`.
 * Every failure gives the same message so callers cannot probe which part was wrong.
 */
export async function authenticateApiKey(
  db: Database,
  key: string,
  now: Date = new Date(),
): Promise<TenantContext> {
  const invalid = () => new MementoError("unauthorized", "invalid or expired API key");
  const parts = parseApiKey(key);
  if (!parts) throw invalid();
  const [found] = await db
    .select({ key: apiKeys, tenant: tenants })
    .from(apiKeys)
    .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
    .where(eq(apiKeys.prefix, parts.prefix))
    .limit(1);
  const hash = await hashApiKey(key);
  if (
    !found ||
    !timingSafeEqual(found.key.keyHash, hash) ||
    found.key.revokedAt ||
    (found.key.expiresAt && found.key.expiresAt <= now) ||
    !found.tenant.isActive
  ) {
    throw invalid();
  }
  // Best effort: a failed bookkeeping write must not fail the request.
  await db
    .update(apiKeys)
    .set({ lastUsedAt: now })
    .where(eq(apiKeys.id, found.key.id))
    .catch(() => undefined);
  return {
    tenantId: found.tenant.id,
    tenantSlug: found.tenant.slug,
    tenantName: found.tenant.name,
    apiKeyId: found.key.id,
    scopes: found.key.scopes as Scope[],
  };
}
