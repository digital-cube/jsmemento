import { eq, lt } from "drizzle-orm";
import type { TenantContext } from "../context.js";
import type { Database, Executor } from "../db/index.js";
import { sessions, tenants, type UserRow, users } from "../db/schema.js";
import { MementoError } from "../errors.js";
import { newSecret, sha256Hex } from "./secrets.js";

/** The cookie a signed-in browser carries. */
export const SESSION_COOKIE = "memento_session";

/** A session's `last_seen_at` / `expires_at` are pushed out at most this often. */
export const SESSION_TOUCH_MS = 60_000;

const DAY_MS = 86_400_000;

export interface CreateSessionInput {
  userId: string;
  tenantId: string;
  days: number;
  userAgent?: string | undefined;
  ip?: string | undefined;
  now?: Date;
}

/** Opens a session; the returned `value` goes into the cookie, only its SHA-256 is stored. */
export async function createSession(
  db: Executor,
  input: CreateSessionInput,
): Promise<{ value: string; expiresAt: Date }> {
  const now = input.now ?? new Date();
  const value = newSecret();
  const expiresAt = new Date(now.getTime() + input.days * DAY_MS);
  await db.insert(sessions).values({
    id: sha256Hex(value),
    userId: input.userId,
    tenantId: input.tenantId,
    createdAt: now,
    lastSeenAt: now,
    expiresAt,
    userAgent: input.userAgent?.slice(0, 400) ?? null,
    ip: input.ip?.slice(0, 64) ?? null,
  });
  return { value, expiresAt };
}

/** Deletes the session of a cookie value (logout). */
export async function deleteSession(db: Database, value: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.id, sha256Hex(value)));
}

/** Deletes every session of a user (password reset). */
export async function deleteUserSessions(db: Database, userId: string): Promise<void> {
  await db.delete(sessions).where(eq(sessions.userId, userId));
}

/** Deletes sessions that expired before `now` (housekeeping; returns how many). */
export async function purgeExpiredSessions(db: Database, now: Date = new Date()): Promise<number> {
  const rows = await db
    .delete(sessions)
    .where(lt(sessions.expiresAt, now))
    .returning({ id: sessions.id });
  return rows.length;
}

export interface AuthenticatedSession {
  context: TenantContext;
  user: UserRow;
  sessionId: string;
  /** `true` when this request pushed the expiry out: the cookie's Max-Age is re-sent. */
  extended: boolean;
}

/**
 * Resolves a session cookie value to the tenant context it grants (scopes `admin`, no API
 * key, the user's id/email/admin flag), or throws `unauthorized`. A disabled user's session
 * is deleted. Sliding: a session last seen more than a minute ago gets its `last_seen_at`
 * and `expires_at` pushed out (one UPDATE, best effort).
 */
export async function authenticateSession(
  db: Database,
  value: string,
  options: { days: number; now?: Date },
): Promise<AuthenticatedSession> {
  const now = options.now ?? new Date();
  const id = sha256Hex(value);
  const [found] = await db
    .select({ session: sessions, user: users, tenant: tenants })
    .from(sessions)
    .innerJoin(users, eq(sessions.userId, users.id))
    .innerJoin(tenants, eq(sessions.tenantId, tenants.id))
    .where(eq(sessions.id, id))
    .limit(1);
  if (!found || found.session.expiresAt <= now) {
    throw new MementoError("unauthorized", "not signed in or the session expired");
  }
  if (found.user.disabledAt || !found.tenant.isActive) {
    await db.delete(sessions).where(eq(sessions.id, id));
    throw new MementoError("unauthorized", "not signed in or the session expired");
  }
  let extended = false;
  if (now.getTime() - found.session.lastSeenAt.getTime() > SESSION_TOUCH_MS) {
    extended = true;
    await db
      .update(sessions)
      .set({ lastSeenAt: now, expiresAt: new Date(now.getTime() + options.days * DAY_MS) })
      .where(eq(sessions.id, id))
      .catch(() => {
        extended = false;
      });
  }
  return {
    context: {
      tenantId: found.tenant.id,
      tenantSlug: found.tenant.slug,
      tenantName: found.tenant.name,
      apiKeyId: null,
      scopes: ["admin"],
      userId: found.user.id,
      userEmail: found.user.email,
      isAdmin: found.user.isAdmin,
    },
    user: found.user,
    sessionId: id,
    extended,
  };
}
