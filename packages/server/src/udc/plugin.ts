import { errKind } from "@jsudc/core";
import { MESSAGE_ID_HEADER } from "@jsudc/core/client";
import { type CollectionRegistry, createDispatcher, udcPlugin } from "@jsudc/server";
import { extractApiKey, hasScope, LocaleSchema, type Scope } from "@memento/core";
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from "fastify";
import {
  authenticateSessionRequest,
  contentLength,
  isJsonRequest,
  type SessionAuth,
  type SessionOptions,
} from "../auth.js";
import type { TenantContext } from "../context.js";
import type { Database } from "../db/client.js";
import { MementoError } from "../errors.js";
import { authenticateApiKey } from "../services/apikeys.js";
import type { UsageMeter } from "../usage.js";
import { collectionAuth } from "./registry.js";

export interface UdcRoutesOptions {
  db: Database;
  registry: CollectionRegistry;
  /**
   * The session credential (`MEMENTO_ACCOUNTS`) for collections registered with
   * `auth: "session" | "admin"` (`MementoRegistry`); `null`/absent: those refuse everyone.
   */
  sessions?: SessionOptions | null;
  /** Counts `requests`, `bytes_in` and the `rows_read` of `list` for API-key requests. */
  usage?: UsageMeter | null;
}

/** The `collection` a UDC request body names, if any. */
function collectionOf(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const name = (body as { collection?: unknown }).collection;
  return typeof name === "string" ? name : null;
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

/**
 * The header a UDC request names the locale of its rows' `rendered` text in (`en`, `sr`, …):
 * the UDC protocol has no locale of its own, and a body field would be refused by its schemas.
 * Same rules as `?locale=` of `GET /events` (docs/TEMPLATES.md).
 */
export const LOCALE_HEADER = "x-memento-locale";

export function scopeForAction(action: string): Scope {
  return WRITE_ACTIONS.has(action) ? "write" : "read";
}

/** The action of a `/udc/<action>` URL, `null` for any other URL. */
export function actionOf(url: string): string | null {
  const match = /\/udc\/([^/?#]+)/.exec(url);
  return match ? decodeURIComponent(match[1] as string) : null;
}

function refuse(
  request: FastifyRequest,
  reply: FastifyReply,
  action: string,
  message: string,
  code = "forbidden",
) {
  const id = request.headers[MESSAGE_ID_HEADER];
  // In-protocol, like every UDC answer: HTTP 200 with an `.err` envelope the client throws.
  return reply.code(200).send({
    kind: errKind(action),
    id: (Array.isArray(id) ? id[0] : id) ?? "",
    payload: { code, message },
  });
}

/**
 * The UDC collections (`POST /udc/<action>`, served by `@jsudc/server`) behind memento's
 * auth. A collection registered with `auth: "session" | "admin"` (`MementoRegistry`) takes
 * the `memento_session` cookie and never a key; every other one an API key with the
 * action's scope. A refused request is answered in-protocol with a `forbidden` error; an
 * authenticated one sets `request.tenant`, which the memento plugin's `preHandler` turns
 * into the tenant context every collection source reads — with the `X-Memento-Locale` the
 * rows are rendered in.
 */
export const udcRoutes: FastifyPluginAsync<UdcRoutesOptions> = async (
  app,
  { db, registry, sessions, usage },
) => {
  /** The API key's tenant with the action's scope checked; throws `MementoError`. */
  async function byKey(request: FastifyRequest, action: string): Promise<TenantContext> {
    const key = extractApiKey(request.headers);
    if (!key) throw new MementoError("forbidden", "missing API key");
    const tenant = await authenticateApiKey(db, key);
    const required = scopeForAction(action);
    if (!hasScope(tenant.scopes, required)) {
      throw new MementoError("forbidden", `this API key lacks the "${required}" scope`);
    }
    request.log = request.log.child({ tenant: tenant.tenantSlug, api_key: tenant.apiKeyId });
    if (tenant.apiKeyId) {
      usage?.add(tenant.apiKeyId, tenant.tenantId, {
        requests: 1,
        bytes_in: contentLength(request),
      });
    }
    return tenant;
  }

  /** The signed-in user's tenant for a session collection; never an API key. */
  async function bySession(
    request: FastifyRequest,
    reply: FastifyReply,
    auth: SessionAuth,
  ): Promise<TenantContext> {
    if (!isJsonRequest(request)) {
      throw new MementoError("forbidden", "session requests need Content-Type: application/json");
    }
    return (await authenticateSessionRequest(request, reply, db, auth, sessions)).context;
  }

  // preValidation, not onRequest: the collection (and so its credential) is in the body.
  app.addHook("preValidation", async (request, reply) => {
    const action = actionOf(request.url);
    if (action === null) return; // the plugin's GET /healthz needs no key
    const collection = collectionOf(request.body);
    const auth = collection === null ? null : collectionAuth(registry, collection);
    try {
      const tenant = auth ? await bySession(request, reply, auth) : await byKey(request, action);
      const header = request.headers[LOCALE_HEADER];
      const asked = Array.isArray(header) ? header[0] : header;
      if (asked) {
        const locale = LocaleSchema.safeParse(asked);
        if (!locale.success) {
          return refuse(
            request,
            reply,
            action,
            `invalid ${LOCALE_HEADER}: ${asked}`,
            "validation_error",
          );
        }
        request.tenant = { ...tenant, locale: locale.data };
      } else {
        request.tenant = tenant;
      }
    } catch (error) {
      if (error instanceof MementoError && error.status < 500) {
        return refuse(request, reply, action, error.message);
      }
      throw error;
    }
  });

  // The rows a key's `list` returned, read off the envelope before it is serialized.
  if (usage) {
    app.addHook("preSerialization", async (request, _reply, payload: unknown) => {
      const tenant = request.tenant;
      if (!tenant?.apiKeyId || actionOf(request.url) !== "list") return payload;
      const rows = (payload as { payload?: { rows?: unknown } } | null)?.payload?.rows;
      if (Array.isArray(rows)) {
        usage.add(tenant.apiKeyId, tenant.tenantId, { rows_read: rows.length });
      }
      return payload;
    });
  }

  await app.register(udcPlugin, {
    dispatcher: createDispatcher(registry, { log: app.log }),
    registry,
    swagger: false,
  });
};
