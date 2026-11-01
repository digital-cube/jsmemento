import type {} from "@fastify/cookie";
import fastifyRateLimit from "@fastify/rate-limit";
import { ok } from "@memento/core";
import type { FastifyPluginAsync, FastifyRequest } from "fastify";
import type { Redis } from "ioredis";
import { clearSessionCookie, sessionCookie, setSessionCookie } from "../auth.js";
import type { LimitsConfig } from "../config.js";
import type { Database } from "../db/client.js";
import type { TenantRow, UserRow } from "../db/schema.js";
import { MementoError } from "../errors.js";
import type { AccountMails } from "../mail/account-mails.js";
import {
  checkLogin,
  ForgotSchema,
  getUserById,
  issueToken,
  parseInput,
  primaryTenant,
  registerUser,
  resetPassword,
  serializeAccountTenant,
  serializeUser,
  startPasswordReset,
  TokenSchema,
  updateUser,
  verifyEmail,
} from "../services/accounts.js";
import { createSession, deleteSession } from "../services/sessions.js";

export interface AccountRoutesOptions {
  db: Database;
  mails: AccountMails;
  sessionDays: number;
  limits: LimitsConfig;
  rateLimit: {
    /** Requests per window per IP (and, for login, per email). Default 10. */
    max: number;
    /** Default 15 minutes. */
    timeWindowMs: number;
    /** Shared counters across processes; `null` → in memory. */
    redis: Redis | null;
  };
}

const SESSION = { auth: "session" } as const;

/**
 * Self-service accounts under `/auth` (`MEMENTO_ACCOUNTS`): register, verify, resend, login,
 * logout, forgot, reset, me. Writes need `Content-Type: application/json` (an empty body
 * is `{}`); register / login / forgot / resend / reset are rate limited per IP, login also
 * per email.
 */
export const accountRoutes: FastifyPluginAsync<AccountRoutesOptions> = async (app, options) => {
  const { db, mails, sessionDays, limits } = options;

  // `POST /auth/logout` and `/auth/resend` carry no body, but must name application/json
  // (the CSRF guard): accept an empty JSON body as `{}` here — and only here.
  const defaultJson = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (body === "" || (typeof body === "string" && body.trim() === "")) done(null, {});
    else defaultJson(request, body as string, done);
  });

  await app.register(fastifyRateLimit, {
    global: false,
    ...(options.rateLimit.redis ? { redis: options.rateLimit.redis } : {}),
    nameSpace: "memento-auth-",
    errorResponseBuilder: (_request, context) =>
      new MementoError("rate_limited", `too many requests, retry in ${context.after}`),
  });
  const limit = {
    rateLimit: { max: options.rateLimit.max, timeWindow: options.rateLimit.timeWindowMs },
  };
  // The per-IP limit is the route's `config.rateLimit`; login also counts per email (the
  // body is parsed by then), with a limiter of its own so the two do not share a counter.
  const emailLimiter = app.createRateLimit({
    max: options.rateLimit.max,
    timeWindow: options.rateLimit.timeWindowMs,
    keyGenerator: (request: FastifyRequest) => {
      const email = (request.body as { email?: unknown } | undefined)?.email;
      return `login-email:${typeof email === "string" ? email.trim().toLowerCase() : ""}`;
    },
  });
  const perEmail = async (request: FastifyRequest) => {
    const result = await emailLimiter(request);
    if (!result.isAllowed && result.isExceeded) {
      throw new MementoError(
        "rate_limited",
        `too many sign-in attempts for this email, retry in ${Math.ceil(result.ttl / 60_000)} min`,
      );
    }
  };

  const startSession = async (
    request: FastifyRequest,
    reply: Parameters<typeof setSessionCookie>[1],
    user: UserRow,
    tenant: TenantRow,
  ) => {
    const { value } = await createSession(db, {
      userId: user.id,
      tenantId: tenant.id,
      days: sessionDays,
      userAgent: request.headers["user-agent"],
      ip: request.ip,
    });
    setSessionCookie(request, reply, value, sessionDays);
  };

  /** The signed-in user of a `config.auth` route (set by the auth hook). */
  const currentUser = async (request: FastifyRequest): Promise<UserRow> => {
    const id = request.tenant?.userId;
    const user = id ? await getUserById(db, id) : null;
    if (!user) throw new MementoError("unauthorized", "not signed in");
    return user;
  };

  app.post("/auth/register", { config: { json: true, ...limit } }, async (request, reply) => {
    const registration = await registerUser(db, request.body as never, {
      session: { days: sessionDays, userAgent: request.headers["user-agent"], ip: request.ip },
    });
    if (registration.sessionValue) {
      setSessionCookie(request, reply, registration.sessionValue, sessionDays);
    }
    void mails.verify(registration.user, registration.verifyToken);
    return reply.status(201).send(
      ok({
        user: serializeUser(registration.user),
        tenant: serializeAccountTenant(registration.tenant),
      }),
    );
  });

  app.post("/auth/verify", { config: { json: true } }, async (request) => {
    const { token } = parseInput(TokenSchema, request.body);
    return ok({ user: serializeUser(await verifyEmail(db, token)) });
  });

  app.post("/auth/resend", { config: { ...SESSION, ...limit } }, async (request) => {
    const user = await currentUser(request);
    if (!user.emailVerifiedAt) void mails.verify(user, await issueToken(db, user.id, "verify"));
    return ok({ sent: !user.emailVerifiedAt });
  });

  app.post(
    "/auth/login",
    { config: { json: true, ...limit }, preHandler: perEmail },
    async (request, reply) => {
      const { user, tenant } = await checkLogin(db, request.body as never);
      await startSession(request, reply, user, tenant);
      return ok({ user: serializeUser(user), tenant: serializeAccountTenant(tenant) });
    },
  );

  app.post("/auth/logout", { config: SESSION }, async (request, reply) => {
    const value = sessionCookie(request);
    if (value) await deleteSession(db, value);
    clearSessionCookie(request, reply);
    return reply.status(204).send();
  });

  app.post("/auth/forgot", { config: { json: true, ...limit } }, async (request) => {
    const { email } = parseInput(ForgotSchema, request.body);
    const started = await startPasswordReset(db, email);
    if (started) void mails.reset(started.user, started.token);
    return ok({ sent: true });
  });

  app.post("/auth/reset", { config: { json: true, ...limit } }, async (request, reply) => {
    const user = await resetPassword(db, request.body as never);
    // Every session of the user is gone, this browser's included.
    clearSessionCookie(request, reply);
    return ok({ user: serializeUser(user) });
  });

  app.get("/auth/me", { config: SESSION }, async (request) => {
    const user = await currentUser(request);
    const tenant = await primaryTenantOf(request);
    return ok({
      user: serializeUser(user),
      tenant: serializeAccountTenant(tenant),
      limits: {
        default_max_keys: limits.defaultMaxKeys,
        default_daily_limit: limits.defaultDailyLimit,
        max_daily_limit: limits.maxDailyLimit,
      },
    });
  });

  app.patch("/auth/me", { config: SESSION }, async (request) => {
    const user = await currentUser(request);
    return ok({ user: serializeUser(await updateUser(db, user.id, request.body as never)) });
  });

  /** The session's tenant row (the context carries id/slug/name, `/me` needs the plan too). */
  async function primaryTenantOf(request: FastifyRequest): Promise<TenantRow> {
    const id = request.tenant?.tenantId;
    const row = id
      ? await db.query.tenants.findFirst({ where: (t, { eq }) => eq(t.id, id) })
      : null;
    const tenant =
      row ?? (request.tenant?.userId ? await primaryTenant(db, request.tenant.userId) : null);
    if (!tenant) throw new MementoError("unauthorized", "not signed in");
    return tenant;
  }
};
