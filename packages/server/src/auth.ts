import type {} from "@fastify/cookie";
import { extractApiKey, extractSubprotocolKey, hasScope, type Scope } from "@memento/core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { runWithTenant, type TenantContext } from "./context.js";
import type { Database } from "./db/index.js";
import { MementoError } from "./errors.js";
import { authenticateApiKey } from "./services/apikeys.js";
import {
  type AuthenticatedSession,
  authenticateSession,
  SESSION_COOKIE,
} from "./services/sessions.js";
import type { UsageMeter } from "./usage.js";

/** The credential a route takes instead of an API key: a signed-in user (`admin`: an admin). */
export type SessionAuth = "session" | "admin";

declare module "fastify" {
  interface FastifyRequest {
    /** Set by the auth hook on every authenticated request. */
    tenant?: TenantContext;
  }
  interface FastifyContextConfig {
    /** Scope a route requires (API key). Routes without one are reachable without a key. */
    scope?: Scope;
    /**
     * The route takes the session cookie (`MEMENTO_ACCOUNTS`) and never an API key:
     * `session` any signed-in user, `admin` one with `is_admin`.
     */
    auth?: SessionAuth;
    /** A mutating route that needs `Content-Type: application/json` (CSRF guard; else 415). */
    json?: boolean;
  }
}

export interface SessionOptions {
  /** Sliding lifetime of a session (and the cookie's Max-Age). */
  days: number;
}

export interface InstallAuthOptions {
  /** Enables the session credential (`config.auth`); `null`/absent: such routes answer 401. */
  sessions?: SessionOptions | null;
  /** Counts `requests` and `bytes_in` of every API-key request; absent → not metered. */
  usage?: UsageMeter | null;
}

/** The request's `Content-Length`, 0 when absent or not a number. */
export function contentLength(request: FastifyRequest): number {
  const value = Number(request.headers["content-length"] ?? 0);
  return Number.isFinite(value) && value > 0 ? value : 0;
}

/** The key of a WebSocket upgrade offered as subprotocol `bearer.<key>` (browsers). */
function websocketKey(request: FastifyRequest): string | null {
  if (request.headers.upgrade?.toLowerCase() !== "websocket") return null;
  return extractSubprotocolKey(request.headers["sec-websocket-protocol"]);
}

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** `true` when the request carries `Content-Type: application/json` (any parameters). */
export function isJsonRequest(request: FastifyRequest): boolean {
  const type = request.headers["content-type"];
  return (type ?? "").split(";")[0]?.trim().toLowerCase() === "application/json";
}

/**
 * CSRF guard of cookie-authenticated writes: a cross-site HTML form cannot send
 * `application/json`, so a mutating request without it is refused with 415.
 */
export function requireJson(request: FastifyRequest): void {
  if (SAFE_METHODS.has(request.method) || isJsonRequest(request)) return;
  throw new MementoError(
    "unsupported_media_type",
    "this request needs Content-Type: application/json",
  );
}

/**
 * Session writes with nothing to send (`POST /auth/logout`, `/keys/:id/disable`, `DELETE`)
 * must still name `application/json` (the CSRF guard): in the plugin `app` this parses an
 * empty JSON body as `{}` — and only there.
 */
export function acceptEmptyJson(app: FastifyInstance): void {
  const defaultJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (body === "" || (typeof body === "string" && body.trim() === "")) done(null, {});
    else defaultJson(request, body as string, done);
  });
}

/** The value of the session cookie, if any (needs `@fastify/cookie`). */
export function sessionCookie(request: FastifyRequest): string | null {
  return request.cookies?.[SESSION_COOKIE] || null;
}

/** Sets the session cookie: HttpOnly, SameSite=Lax, path `/`, Secure over https. */
export function setSessionCookie(
  request: FastifyRequest,
  reply: FastifyReply,
  value: string,
  days: number,
): void {
  reply.setCookie(SESSION_COOKIE, value, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: request.protocol === "https",
    maxAge: days * 86_400,
  });
}

export function clearSessionCookie(request: FastifyRequest, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    secure: request.protocol === "https",
  });
}

/**
 * Authenticates a request by its session cookie for `auth` (`session` / `admin`), sets
 * `request.tenant` and re-sends the cookie when the session slid. Throws `unauthorized`
 * (no / unknown / expired session, disabled user) or `forbidden` (`admin` for a non-admin).
 */
export async function authenticateSessionRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Database,
  auth: SessionAuth,
  options: SessionOptions | null | undefined,
): Promise<AuthenticatedSession> {
  if (!options) throw new MementoError("unauthorized", "accounts are not enabled");
  const value = sessionCookie(request);
  if (!value) throw new MementoError("unauthorized", "not signed in");
  let session: AuthenticatedSession;
  try {
    session = await authenticateSession(db, value, { days: options.days });
  } catch (error) {
    if (error instanceof MementoError && error.code === "unauthorized") {
      clearSessionCookie(request, reply);
    }
    throw error;
  }
  if (auth === "admin" && !session.user.isAdmin) {
    throw new MementoError("forbidden", "this needs an administrator");
  }
  if (session.extended) setSessionCookie(request, reply, value, options.days);
  request.tenant = session.context;
  request.log = request.log.child({ tenant: session.context.tenantSlug, user: session.user.id });
  return session;
}

/**
 * Installs auth on `app` (and every route registered in it after this call):
 * 1. `onRequest` checks the route's credential — `config.scope`: an API key
 *    (Authorization: Bearer / X-Api-Key, or the `bearer.<key>` subprotocol of a WebSocket
 *    upgrade) with that scope; `config.auth`: the `memento_session` cookie (and never a key).
 *    `config.json` / `config.auth` on a mutating route also require a JSON content type;
 * 2. `preHandler` runs the rest of the request inside that tenant's AsyncLocalStorage
 *    context, so services read the tenant from `requireTenant()`, never from input.
 */
export function installAuth(
  app: FastifyInstance,
  db: Database,
  options: InstallAuthOptions = {},
): void {
  app.decorateRequest("tenant", undefined);

  app.addHook("onRequest", async (request: FastifyRequest, reply: FastifyReply) => {
    if (request.is404) return;
    const config = request.routeOptions.config;
    if (config?.json || config?.auth) requireJson(request);
    if (config?.auth) {
      await authenticateSessionRequest(request, reply, db, config.auth, options.sessions);
      return;
    }
    const required = config?.scope;
    if (!required) return;
    const key = extractApiKey(request.headers) ?? websocketKey(request);
    if (!key) throw new MementoError("unauthorized", "missing API key");
    const tenant = await authenticateApiKey(db, key);
    if (!hasScope(tenant.scopes, required)) {
      throw new MementoError("forbidden", `this API key lacks the "${required}" scope`);
    }
    request.tenant = tenant;
    request.log = request.log.child({ tenant: tenant.tenantSlug, api_key: tenant.apiKeyId });
    if (tenant.apiKeyId) {
      options.usage?.add(tenant.apiKeyId, tenant.tenantId, {
        requests: 1,
        bytes_in: contentLength(request),
      });
    }
  });

  app.addHook("preHandler", (request, _reply, done) => {
    if (request.tenant) runWithTenant(request.tenant, done);
    else done();
  });
}
