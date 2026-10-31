import { errKind } from "@jsudc/core";
import { MESSAGE_ID_HEADER } from "@jsudc/core/client";
import { type CollectionRegistry, createDispatcher, udcPlugin } from "@jsudc/server";
import { extractApiKey, hasScope, type Scope } from "@memento/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import type { Database } from "../db/client.js";
import { MementoError } from "../errors.js";
import { authenticateApiKey } from "../services/apikeys.js";

export interface UdcRoutesOptions {
  db: Database;
  registry: CollectionRegistry;
}

/** Actions that change data or schema need `write`; everything else reads. */
const WRITE_ACTIONS = new Set([
  "mutate",
  "reindex",
  "tree.reparent",
  "schema.add_field",
  "schema.update_field",
  "schema.soft_delete_field",
]);

export function scopeForAction(action: string): Scope {
  return WRITE_ACTIONS.has(action) ? "write" : "read";
}

/** The action of a `/udc/<action>` URL, `null` for any other URL. */
export function actionOf(url: string): string | null {
  const match = /\/udc\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1] as string) : null;
}

function refuse(request: FastifyRequest, reply: FastifyReply, action: string, message: string) {
  const id = request.headers[MESSAGE_ID_HEADER];
  // In-protocol, like every UDC answer: HTTP 200 with an `.err` envelope the client throws.
  return reply.code(200).send({
    kind: errKind(action),
    id: (Array.isArray(id) ? id[0] : id) ?? "",
    payload: { code: "forbidden", message },
  });
}

/**
 * The UDC collections (`POST /udc/<action>`, served by `@jsudc/server`) behind memento's
 * API key auth. A request without a valid key, or with one lacking the action's scope, is
 * answered in-protocol with a `forbidden` error; an authenticated one sets
 * `request.tenant`, which the memento plugin's `preHandler` turns into the tenant context
 * every collection source reads.
 */
export const udcRoutes: FastifyPluginAsync<UdcRoutesOptions> = async (app, { db, registry }) => {
  app.addHook("onRequest", async (request, reply) => {
    const action = actionOf(request.url);
    if (action === null) return; // the plugin's GET /healthz needs no key
    const key = extractApiKey(request.headers);
    if (!key) return refuse(request, reply, action, "missing API key");
    try {
      const tenant = await authenticateApiKey(db, key);
      const required = scopeForAction(action);
      if (!hasScope(tenant.scopes, required)) {
        return refuse(request, reply, action, `this API key lacks the "${required}" scope`);
      }
      request.tenant = tenant;
      request.log = request.log.child({ tenant: tenant.tenantSlug, api_key: tenant.apiKeyId });
    } catch (error) {
      if (error instanceof MementoError && error.status < 500) {
        return refuse(request, reply, action, error.message);
      }
      throw error;
    }
  });

  await app.register(udcPlugin, {
    dispatcher: createDispatcher(registry, { log: app.log }),
    registry,
    swagger: false,
  });
};
