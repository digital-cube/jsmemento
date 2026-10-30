import { extractApiKey, hasScope, type Scope } from "@memento/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { runWithTenant, type TenantContext } from "./context.js";
import type { Database } from "./db/client.js";
import { MementoError } from "./errors.js";
import { authenticateApiKey } from "./services/apikeys.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on every authenticated request. */
    tenant?: TenantContext;
  }
  interface FastifyContextConfig {
    /** Scope a route requires. Routes without one are reachable without a key. */
    scope?: Scope;
  }
}

/**
 * Installs API key auth on `app` (and every route registered in it after this call):
 * 1. `onRequest` resolves the key (Authorization: Bearer / X-Api-Key) to a tenant and
 *    checks the route's `config.scope`;
 * 2. `preHandler` runs the rest of the request inside that tenant's AsyncLocalStorage
 *    context, so services read the tenant from `requireTenant()`, never from input.
 */
export function installAuth(app: FastifyInstance, db: Database): void {
  app.decorateRequest("tenant", undefined);

  app.addHook("onRequest", async (request: FastifyRequest, _reply: FastifyReply) => {
    const required = request.routeOptions.config?.scope;
    if (!required || request.is404) return;
    const key = extractApiKey(request.headers);
    if (!key) throw new MementoError("unauthorized", "missing API key");
    const tenant = await authenticateApiKey(db, key);
    if (!hasScope(tenant.scopes, required)) {
      throw new MementoError("forbidden", `this API key lacks the "${required}" scope`);
    }
    request.tenant = tenant;
    request.log = request.log.child({ tenant: tenant.tenantSlug, api_key: tenant.apiKeyId });
  });

  app.addHook("preHandler", (request, _reply, done) => {
    if (request.tenant) runWithTenant(request.tenant, done);
    else done();
  });
}
