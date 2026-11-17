import { ok } from "@jsmemento/core";
import { and, eq, isNull } from "drizzle-orm";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { RouteDeps } from "../app.js";
import { acceptEmptyJson } from "../auth.js";
import type { LimitsConfig } from "../config.js";
import { requireTenant, runWithTenant } from "../context.js";
import { apiKeys, tenants } from "../db/schema.js";
import { MementoError } from "../errors.js";
import type { QuotaGuard } from "../quota.js";
import { getUserById, serializeUser, setUserDisabled } from "../services/accounts.js";
import { KeyService } from "../services/keys.js";

export interface AdminRoutesOptions extends RouteDeps {
  quota: QuotaGuard;
  limits: LimitsConfig;
}

type IdParams = { Params: { id: string } };
const ADMIN = { auth: "admin" } as const;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Administration (`is_admin` users, session cookie): disable / enable a user (disabling
 * deletes every session of theirs) and pause / resume any tenant's key. Pausing a key writes
 * its `APIKEY_DISABLED` / `APIKEY_ENABLED` event into the key's own tenant, with the admin's
 * email as `actor_id`. The lists are the `admin_users` / `admin_api_keys` UDC collections.
 */
export const adminRoutes: FastifyPluginAsync<AdminRoutesOptions> = async (app, options) => {
  acceptEmptyJson(app);
  const { db, quota, limits, publisher, renderer, lookups } = options;
  const keys = new KeyService({
    db,
    quota,
    limits,
    push: {
      publisher,
      renderer,
      lookups,
      onPublishError: (error) =>
        app.log.warn({ err: error }, "lifecycle event stored but publishing failed"),
    },
  });

  const setUser = async (request: FastifyRequest<IdParams>, disabled: boolean) => {
    const { id } = request.params;
    const user = UUID_RE.test(id) ? await getUserById(db, id) : null;
    if (!user) throw new MementoError("not_found", `no user ${id}`);
    if (disabled && user.id === request.tenant?.userId) {
      throw new MementoError("conflict", "an administrator cannot disable themselves");
    }
    const updated = await setUserDisabled(db, user.email, disabled);
    request.log.info({ user: user.id, disabled }, "admin changed a user");
    return ok({ user: { ...serializeUser(updated), disabled: updated.disabledAt !== null } });
  };

  /** Runs `fn` as the admin, inside the tenant that owns key `id`. */
  const asKeyTenant = async <T>(id: string, fn: () => Promise<T>): Promise<T> => {
    const admin = requireTenant();
    const [found] = UUID_RE.test(id)
      ? await db
          .select({ tenant: tenants })
          .from(apiKeys)
          .innerJoin(tenants, eq(apiKeys.tenantId, tenants.id))
          .where(and(eq(apiKeys.id, id), isNull(apiKeys.deletedAt)))
      : [];
    if (!found) throw new MementoError("not_found", `no API key ${id}`);
    return runWithTenant(
      {
        ...admin,
        tenantId: found.tenant.id,
        tenantSlug: found.tenant.slug,
        tenantName: found.tenant.name,
      },
      fn,
    );
  };

  app.post<IdParams>("/admin/users/:id/disable", { config: ADMIN }, (request) =>
    setUser(request, true),
  );
  app.post<IdParams>("/admin/users/:id/enable", { config: ADMIN }, (request) =>
    setUser(request, false),
  );
  app.post<IdParams>("/admin/keys/:id/disable", { config: ADMIN }, async (request) =>
    ok({
      api_key: await asKeyTenant(request.params.id, () =>
        keys.setDisabled(request.params.id, true),
      ),
    }),
  );
  app.post<IdParams>("/admin/keys/:id/enable", { config: ADMIN }, async (request) =>
    ok({
      api_key: await asKeyTenant(request.params.id, () =>
        keys.setDisabled(request.params.id, false),
      ),
    }),
  );
};
