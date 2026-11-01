import { randomBytes } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { and, asc, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database, Executor } from "../db/client.js";
import {
  type TenantRow,
  tenants,
  tenantUsers,
  type UserRow,
  users,
  userTokens,
} from "../db/schema.js";
import { MementoError } from "../errors.js";
import { newSecret, sha256Hex } from "./secrets.js";
import { type CreateSessionInput, createSession, deleteUserSessions } from "./sessions.js";

export const USER_LOCALES = ["en", "sr"] as const;
export type UserLocale = (typeof USER_LOCALES)[number];

export const PASSWORD_MIN = 10;
/** argon2 hashes whatever it gets: a ceiling keeps a megabyte "password" from costing CPU. */
export const PASSWORD_MAX = 1024;

export const VERIFY_TOKEN_TTL_MS = 24 * 3_600_000;
export const RESET_TOKEN_TTL_MS = 3_600_000;

export type TokenKind = "verify" | "reset";

const EmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(320)
  .pipe(z.email({ message: "invalid email address" }));
const PasswordSchema = z
  .string()
  .min(PASSWORD_MIN, { message: `password must have at least ${PASSWORD_MIN} characters` })
  .max(PASSWORD_MAX);
const NameSchema = z.string().trim().min(1, { message: "name is required" }).max(200);
const LocaleSchema = z.enum(USER_LOCALES);

export const RegisterSchema = z.object({
  email: EmailSchema,
  password: PasswordSchema,
  name: NameSchema,
  locale: LocaleSchema.optional(),
  terms: z.literal(true, { message: "the terms must be accepted" }),
});
export type RegisterInput = z.input<typeof RegisterSchema>;

export const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().max(320),
  password: z.string().max(PASSWORD_MAX),
});
export const TokenSchema = z.object({ token: z.string().min(1).max(200) });
export const ForgotSchema = z.object({ email: z.string().trim().toLowerCase().max(320) });
export const ResetSchema = z.object({
  token: z.string().min(1).max(200),
  password: PasswordSchema,
});
export const UpdateMeSchema = z.object({
  name: NameSchema.optional(),
  locale: LocaleSchema.optional(),
  password: z.object({ current: z.string().max(PASSWORD_MAX), next: PasswordSchema }).optional(),
});
export type UpdateMeInput = z.input<typeof UpdateMeSchema>;

/** Parses `body` with `schema` or throws `validation_error` with the zod issues. */
export function parseInput<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body ?? {});
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const where = first?.path.length ? `${first.path.join(".")}: ` : "";
    throw new MementoError(
      "validation_error",
      `${where}${first?.message ?? "invalid input"}`,
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** The user as `/auth/*` returns it. */
export interface UserView {
  id: string;
  email: string;
  name: string;
  locale: string;
  email_verified: boolean;
  is_admin: boolean;
  created_at: string;
}

/** The tenant as `/auth/*` returns it. */
export interface AccountTenantView {
  id: string;
  slug: string;
  name: string;
  plan: string;
  max_keys: number | null;
  retention_days: number | null;
}

export function serializeUser(row: UserRow): UserView {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    locale: row.locale,
    email_verified: row.emailVerifiedAt !== null,
    is_admin: row.isAdmin,
    created_at: row.createdAt.toISOString(),
  };
}

export function serializeAccountTenant(row: TenantRow): AccountTenantView {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    plan: row.plan,
    max_keys: row.maxKeys,
    retention_days: row.retentionDays,
  };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function hashPassword(password: string): Promise<string> {
  return argonHash(password); // argon2id, library defaults
}

/** Compares against a real hash even for an unknown user, so timing does not tell. */
const DUMMY_HASH = hashPassword("memento-dummy-password");

export async function verifyPassword(stored: string | null, password: string): Promise<boolean> {
  try {
    return await argonVerify(stored ?? (await DUMMY_HASH), password);
  } catch {
    return false;
  }
}

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

/** `t-` + 8 random base32 (lower-case) characters: a self-service tenant's slug. */
export function randomTenantSlug(): string {
  const bytes = randomBytes(8);
  let out = "t-";
  for (const byte of bytes) out += BASE32[byte & 31];
  return out;
}

/** Stores a new single-use token of `kind` for the user and returns its plaintext. */
export async function issueToken(
  db: Executor,
  userId: string,
  kind: TokenKind,
  now: Date = new Date(),
): Promise<string> {
  const token = newSecret();
  const ttl = kind === "verify" ? VERIFY_TOKEN_TTL_MS : RESET_TOKEN_TTL_MS;
  await db.insert(userTokens).values({
    userId,
    kind,
    tokenHash: sha256Hex(token),
    expiresAt: new Date(now.getTime() + ttl),
    createdAt: now,
  });
  return token;
}

/**
 * Marks a token of `kind` used and returns its user id, or throws `not_found` when it is
 * unknown, already used or expired. One UPDATE: two concurrent uses cannot both succeed.
 */
export async function consumeToken(
  db: Executor,
  token: string,
  kind: TokenKind,
  now: Date = new Date(),
): Promise<string> {
  const [row] = await db
    .update(userTokens)
    .set({ usedAt: now })
    .where(
      and(
        eq(userTokens.tokenHash, sha256Hex(token)),
        eq(userTokens.kind, kind),
        isNull(userTokens.usedAt),
        gt(userTokens.expiresAt, now),
      ),
    )
    .returning({ userId: userTokens.userId });
  if (!row) throw new MementoError("not_found", "this link is invalid, used or expired");
  return row.userId;
}

export interface Registration {
  user: UserRow;
  tenant: TenantRow;
  /** Plaintext verify token for the mail; only its hash is stored. */
  verifyToken: string;
  /** The cookie value of the session opened with the registration (`options.session`). */
  sessionValue: string | null;
}

/**
 * Registers a user in one transaction: the user (argon2id), a tenant of their own (random
 * `t-…` slug, named after the user), the `owner` membership, a `verify` token and — with
 * `options.session` — the session. `conflict` when the email is taken.
 */
export async function registerUser(
  db: Database,
  input: RegisterInput,
  options: {
    now?: Date;
    session?: Omit<CreateSessionInput, "userId" | "tenantId" | "now">;
  } = {},
): Promise<Registration> {
  const data = parseInput(RegisterSchema, input);
  const now = options.now ?? new Date();
  const passwordHash = await hashPassword(data.password);
  return db.transaction(async (tx) => {
    const [user] = await tx
      .insert(users)
      .values({
        email: data.email,
        passwordHash,
        name: data.name,
        locale: data.locale ?? "en",
        termsAcceptedAt: now,
        createdAt: now,
      })
      .onConflictDoNothing({ target: users.email })
      .returning();
    if (!user) throw new MementoError("conflict", "email already registered");
    let tenant: TenantRow | undefined;
    for (let attempt = 0; !tenant; attempt++) {
      if (attempt >= 5) throw new MementoError("internal_error", "could not pick a tenant slug");
      [tenant] = await tx
        .insert(tenants)
        .values({ slug: randomTenantSlug(), name: data.name, createdAt: now })
        .onConflictDoNothing({ target: tenants.slug })
        .returning();
    }
    await tx
      .insert(tenantUsers)
      .values({ tenantId: tenant.id, userId: user.id, role: "owner", addedAt: now });
    const verifyToken = await issueToken(tx, user.id, "verify", now);
    const session = options.session
      ? await createSession(tx, { ...options.session, userId: user.id, tenantId: tenant.id, now })
      : null;
    return { user, tenant, verifyToken, sessionValue: session?.value ?? null };
  });
}

/** The tenant a user signs in to: the one they own, else the oldest membership. */
export async function primaryTenant(db: Executor, userId: string): Promise<TenantRow | null> {
  const [row] = await db
    .select({ tenant: tenants })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenantUsers.tenantId, tenants.id))
    .where(eq(tenantUsers.userId, userId))
    .orderBy(
      sql`case when ${tenantUsers.role} = 'owner' then 0 else 1 end`,
      asc(tenantUsers.addedAt),
    )
    .limit(1);
  return row?.tenant ?? null;
}

export async function getUserById(db: Executor, id: string): Promise<UserRow | null> {
  return (await db.query.users.findFirst({ where: eq(users.id, id) })) ?? null;
}

export async function getUserByEmail(db: Executor, email: string): Promise<UserRow | null> {
  return (
    (await db.query.users.findFirst({ where: eq(users.email, normalizeEmail(email)) })) ?? null
  );
}

/**
 * Checks a sign-in. Unknown email, wrong password, disabled user, inactive tenant: one
 * `unauthorized` with one message, so the answer does not tell which.
 */
export async function checkLogin(
  db: Database,
  input: { email: string; password: string },
): Promise<{ user: UserRow; tenant: TenantRow }> {
  const data = parseInput(LoginSchema, input);
  const user = await getUserByEmail(db, data.email);
  const valid = await verifyPassword(user?.passwordHash ?? null, data.password);
  const tenant = user && valid && !user.disabledAt ? await primaryTenant(db, user.id) : null;
  if (!(user && tenant?.isActive)) {
    throw new MementoError("unauthorized", "invalid email or password");
  }
  return { user, tenant };
}

/** Marks the email of the token's user verified; `not_found` for a bad token. */
export async function verifyEmail(db: Database, token: string, now = new Date()): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const userId = await consumeToken(tx, token, "verify", now);
    const [user] = await tx
      .update(users)
      .set({
        emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, ${now.toISOString()}::timestamptz)`,
      })
      .where(eq(users.id, userId))
      .returning();
    if (!user) throw new MementoError("not_found", "this link is invalid, used or expired");
    return user;
  });
}

/**
 * Starts a password reset: deletes the user's older unused reset tokens and issues a new
 * one. `null` (nothing to send) for an unknown or disabled email.
 */
export async function startPasswordReset(
  db: Database,
  email: string,
  now = new Date(),
): Promise<{ user: UserRow; token: string } | null> {
  const user = await getUserByEmail(db, email);
  if (!user || user.disabledAt) return null;
  const token = await db.transaction(async (tx) => {
    await tx
      .delete(userTokens)
      .where(
        and(
          eq(userTokens.userId, user.id),
          eq(userTokens.kind, "reset"),
          isNull(userTokens.usedAt),
        ),
      );
    return issueToken(tx, user.id, "reset", now);
  });
  return { user, token };
}

/** Sets a new password from a reset token, uses the token up and signs the user out everywhere. */
export async function resetPassword(
  db: Database,
  input: { token: string; password: string },
  now = new Date(),
): Promise<UserRow> {
  const data = parseInput(ResetSchema, input);
  const passwordHash = await hashPassword(data.password);
  const user = await db.transaction(async (tx) => {
    const userId = await consumeToken(tx, data.token, "reset", now);
    const [row] = await tx
      .update(users)
      .set({ passwordHash })
      .where(eq(users.id, userId))
      .returning();
    if (!row) throw new MementoError("not_found", "this link is invalid, used or expired");
    return row;
  });
  await deleteUserSessions(db, user.id);
  return user;
}

/** `PATCH /auth/me`: name, locale, and a password change that needs the current password. */
export async function updateUser(
  db: Database,
  userId: string,
  input: UpdateMeInput,
): Promise<UserRow> {
  const data = parseInput(UpdateMeSchema, input);
  const user = await getUserById(db, userId);
  if (!user) throw new MementoError("not_found", "user not found");
  const changes: Partial<typeof users.$inferInsert> = {};
  if (data.name !== undefined) changes.name = data.name;
  if (data.locale !== undefined) changes.locale = data.locale;
  if (data.password) {
    if (!(await verifyPassword(user.passwordHash, data.password.current))) {
      throw new MementoError(
        "validation_error",
        "password.current: the current password is wrong",
        [{ path: ["password", "current"], message: "the current password is wrong" }],
      );
    }
    changes.passwordHash = await hashPassword(data.password.next);
  }
  if (Object.keys(changes).length === 0) return user;
  const [row] = await db.update(users).set(changes).where(eq(users.id, userId)).returning();
  return row as UserRow;
}

// --- Operator side (the CLI) ------------------------------------------------------------

export interface UserListing {
  email: string;
  name: string;
  tenant: string | null;
  verified: boolean;
  admin: boolean;
  disabled: boolean;
  created_at: string;
}

/** Every user with the slug of their primary tenant (owned first, else oldest), newest first. */
export async function listUsers(db: Database): Promise<UserListing[]> {
  const rows = await db.select().from(users).orderBy(desc(users.createdAt));
  const memberships = await db
    .select({ userId: tenantUsers.userId, slug: tenants.slug })
    .from(tenantUsers)
    .innerJoin(tenants, eq(tenantUsers.tenantId, tenants.id))
    .orderBy(
      sql`case when ${tenantUsers.role} = 'owner' then 0 else 1 end`,
      asc(tenantUsers.addedAt),
    );
  const primary = new Map<string, string>();
  for (const m of memberships) if (!primary.has(m.userId)) primary.set(m.userId, m.slug);
  return rows.map((user) => ({
    email: user.email,
    name: user.name,
    tenant: primary.get(user.id) ?? null,
    verified: user.emailVerifiedAt !== null,
    admin: user.isAdmin,
    disabled: user.disabledAt !== null,
    created_at: user.createdAt.toISOString(),
  }));
}

async function updateByEmail(
  db: Database,
  email: string,
  changes: Partial<typeof users.$inferInsert>,
): Promise<UserRow> {
  const [row] = await db
    .update(users)
    .set(changes)
    .where(eq(users.email, normalizeEmail(email)))
    .returning();
  if (!row) throw new MementoError("not_found", `no user "${normalizeEmail(email)}"`);
  return row;
}

export function setUserAdmin(db: Database, email: string, isAdmin: boolean): Promise<UserRow> {
  return updateByEmail(db, email, { isAdmin });
}

/** Disables (and signs out) or re-enables a user. */
export async function setUserDisabled(
  db: Database,
  email: string,
  disabled: boolean,
): Promise<UserRow> {
  const user = await updateByEmail(db, email, { disabledAt: disabled ? new Date() : null });
  if (disabled) await deleteUserSessions(db, user.id);
  return user;
}

/** Marks a user's email verified without a mail (stage smoke tests). Idempotent. */
export async function markUserVerified(db: Database, email: string): Promise<UserRow> {
  const [row] = await db
    .update(users)
    .set({ emailVerifiedAt: sql`coalesce(${users.emailVerifiedAt}, now())` })
    .where(eq(users.email, normalizeEmail(email)))
    .returning();
  if (!row) throw new MementoError("not_found", `no user "${normalizeEmail(email)}"`);
  return row;
}
