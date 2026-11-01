import { ViewConfigSchema } from "@jsudc/core";
import { eq } from "drizzle-orm";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BuildAppOptions } from "../src/app.js";
import { sessions, tenants, tenantUsers, users, userTokens } from "../src/db/schema.js";
import { MemoryMailer } from "../src/mail/mailer.js";
import { setUserAdmin, setUserDisabled } from "../src/services/accounts.js";
import { createApiKey } from "../src/services/apikeys.js";
import { sha256Hex } from "../src/services/secrets.js";
import { EVENTS_FIELDS, EVENTS_VIEW, eventCollections } from "../src/udc/collections.js";
import { EventCollectionSource } from "../src/udc/source.js";
import { auth, type Fixture, push, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
const SERVICE_URL = "https://service.test";
let fx: Fixture;
let mailer: MemoryMailer;
let apps: FastifyInstance[] = [];

/** An app with accounts on, a capturing mailer and two session collections next to memento's. */
async function setup(options: Partial<BuildAppOptions> = {}) {
  mailer = new MemoryMailer();
  const registry = eventCollections({ db: handle.db });
  registry.register({
    name: "my_events",
    label: "My events",
    source: new EventCollectionSource(handle.db, { fields: EVENTS_FIELDS }),
    view: ViewConfigSchema.parse(EVENTS_VIEW),
    auth: "session",
  });
  registry.register({
    name: "all_events",
    label: "All events (admin)",
    source: new EventCollectionSource(handle.db, { fields: EVENTS_FIELDS }),
    view: ViewConfigSchema.parse(EVENTS_VIEW),
    auth: "admin",
  });
  fx = await setupApp(handle, {
    accounts: { serviceUrl: `${SERVICE_URL}/`, mailer },
    udc: registry,
    ...options,
  });
  apps.push(fx.app);
  return fx;
}

beforeEach(async () => {
  await setup();
});
afterEach(async () => {
  for (const app of apps) await app.close();
  apps = [];
});
afterAll(async () => {
  await handle.close();
});

const JSON_HEADERS = { "content-type": "application/json" };

function post(url: string, payload?: unknown, extra: Record<string, unknown> = {}) {
  return fx.app.inject({
    method: "POST",
    url: `/memento${url}`,
    headers: JSON_HEADERS,
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }),
    ...extra,
  });
}

const cookieOf = (response: LightMyRequestResponse) =>
  response.cookies.find((c) => c.name === "memento_session");

const withCookie = (value: string) => ({ cookies: { memento_session: value } });

const ANA = {
  email: "  Ana@Example.COM ",
  password: "correct horse battery",
  name: "Ana Anić",
  terms: true,
};

/** Registers Ana and returns the session cookie value. */
async function register(body: Record<string, unknown> = ANA): Promise<string> {
  const response = await post("/auth/register", body);
  expect(response.statusCode, response.body).toBe(201);
  return cookieOf(response)?.value as string;
}

const tokenFromMail = (kind: "verify" | "reset", to = "ana@example.com") => {
  const mail = mailer.last(to);
  const match = new RegExp(`${SERVICE_URL}/${kind}/([\\w-]+)`).exec(mail?.text ?? "");
  expect(match, mail?.text).not.toBeNull();
  return match?.[1] as string;
};

const me = (cookie: string) =>
  fx.app.inject({ method: "GET", url: "/memento/auth/me", ...withCookie(cookie) });

describe("POST /auth/register", () => {
  it("creates the user, a tenant with its owner row, a hashed verify token and a session", async () => {
    const response = await post("/auth/register", ANA);
    expect(response.statusCode).toBe(201);
    const body = response.json();
    expect(body.data.user).toMatchObject({
      email: "ana@example.com",
      name: "Ana Anić",
      locale: "en",
      email_verified: false,
      is_admin: false,
    });
    expect(body.data.tenant).toMatchObject({
      name: "Ana Anić",
      plan: "free",
      max_keys: null,
      retention_days: null,
    });
    expect(body.data.tenant.slug).toMatch(/^t-[a-z2-7]{8}$/);

    const cookie = cookieOf(response);
    expect(cookie).toMatchObject({
      httpOnly: true,
      sameSite: "Lax",
      path: "/",
      maxAge: 30 * 86_400,
    });
    expect(cookie?.secure).toBeFalsy();
    const [session] = await handle.db.select().from(sessions);
    expect(session?.id).toBe(sha256Hex(cookie?.value as string));
    expect(session?.tenantId).toBe(body.data.tenant.id);

    const [user] = await handle.db.select().from(users);
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
    expect(user?.termsAcceptedAt).toBeInstanceOf(Date);
    const [membership] = await handle.db.select().from(tenantUsers);
    expect(membership).toMatchObject({
      tenantId: body.data.tenant.id,
      userId: user?.id,
      role: "owner",
    });

    const mail = mailer.last("ana@example.com");
    expect(mail?.subject).toBe("Confirm your memento email address");
    expect(mail?.text).toContain("Hello Ana Anić,");
    const token = tokenFromMail("verify");
    const [stored] = await handle.db.select().from(userTokens);
    expect(stored).toMatchObject({ kind: "verify", tokenHash: sha256Hex(token), usedAt: null });
    expect(stored?.tokenHash).not.toContain(token);
    const ttl = (stored?.expiresAt.getTime() ?? 0) - (stored?.createdAt.getTime() ?? 0);
    expect(ttl).toBe(24 * 3_600_000);
  });

  it("sends the Serbian mail to a user who registered in sr", async () => {
    await register({ ...ANA, locale: "sr" });
    expect(mailer.last()?.subject).toBe("Potvrdite svoju adresu za memento");
    expect(mailer.last()?.text).toContain("Zdravo Ana Anić,");
  });

  it.each([
    ["a bad email", { email: "not-an-email" }, "email"],
    ["a short password", { password: "123456789" }, "password"],
    ["an empty name", { name: "   " }, "name"],
    ["terms not accepted", { terms: false }, "terms"],
    ["terms missing", { terms: undefined }, "terms"],
    ["an unknown locale", { locale: "de" }, "locale"],
  ])("refuses %s with 422", async (_label, change, field) => {
    const response = await post("/auth/register", { ...ANA, ...change });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_error");
    expect(response.json().error.message).toMatch(new RegExp(`^${field}: `));
    expect(await handle.db.select().from(users)).toEqual([]);
  });

  it("answers 409 for an email already registered, in any case", async () => {
    await register();
    const response = await post("/auth/register", { ...ANA, email: "ANA@example.com" });
    expect(response.statusCode).toBe(409);
    expect(response.json().error).toMatchObject({
      code: "conflict",
      message: "email already registered",
    });
    expect(await handle.db.select().from(tenants).where(eq(tenants.name, "Ana Anić"))).toHaveLength(
      1,
    );
  });

  it("needs Content-Type: application/json (CSRF)", async () => {
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/auth/register",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      payload: "email=a@b.c",
    });
    expect(response.statusCode).toBe(415);
    expect(response.json().error.code).toBe("unsupported_media_type");
  });
});

describe("POST /auth/verify", () => {
  it("verifies once; a reused token is 404", async () => {
    await register();
    const token = tokenFromMail("verify");
    const first = await post("/auth/verify", { token });
    expect(first.statusCode).toBe(200);
    expect(first.json().data.user.email_verified).toBe(true);
    const again = await post("/auth/verify", { token });
    expect(again.statusCode).toBe(404);
    expect(again.json().error.code).toBe("not_found");
  });

  it("refuses an expired or unknown token with 404", async () => {
    await register();
    const token = tokenFromMail("verify");
    await handle.db.update(userTokens).set({ expiresAt: new Date(Date.now() - 1000) });
    expect((await post("/auth/verify", { token })).statusCode).toBe(404);
    expect((await post("/auth/verify", { token: "nope" })).statusCode).toBe(404);
    const [user] = await handle.db.select().from(users);
    expect(user?.emailVerifiedAt).toBeNull();
  });
});

describe("POST /auth/resend", () => {
  it("sends a new verify mail while unverified, nothing once verified", async () => {
    const cookie = await register();
    const response = await post("/auth/resend", undefined, withCookie(cookie));
    expect(response.statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(2);
    const token = tokenFromMail("verify");
    expect((await post("/auth/verify", { token })).statusCode).toBe(200);
    expect((await post("/auth/resend", {}, withCookie(cookie))).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(2);
  });

  it("needs a session", async () => {
    expect((await post("/auth/resend", {})).statusCode).toBe(401);
  });
});

describe("POST /auth/login and /auth/logout", () => {
  it("signs in with the right password and sets a new cookie", async () => {
    await register();
    const response = await post("/auth/login", {
      email: "ANA@example.com ",
      password: ANA.password,
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.user.email).toBe("ana@example.com");
    expect(response.json().data.tenant.slug).toMatch(/^t-/);
    const cookie = cookieOf(response)?.value as string;
    expect((await me(cookie)).statusCode).toBe(200);
    expect(await handle.db.select().from(sessions)).toHaveLength(2);
  });

  it("answers a wrong password exactly like an unknown email", async () => {
    await register();
    const wrong = await post("/auth/login", { email: ANA.email, password: "wrong password!" });
    const unknown = await post("/auth/login", { email: "nobody@example.com", password: "x" });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error).toEqual(unknown.json().error);
    expect(wrong.json().error).toEqual({
      code: "unauthorized",
      message: "invalid email or password",
    });
  });

  it("refuses a disabled user with the same 401, and drops their sessions", async () => {
    const cookie = await register();
    await setUserDisabled(handle.db, "ana@example.com", true);
    const response = await post("/auth/login", { email: ANA.email, password: ANA.password });
    expect(response.statusCode).toBe(401);
    expect(response.json().error.message).toBe("invalid email or password");
    expect((await me(cookie)).statusCode).toBe(401);
    await setUserDisabled(handle.db, "ana@example.com", false);
    expect(
      (await post("/auth/login", { email: ANA.email, password: ANA.password })).statusCode,
    ).toBe(200);
  });

  it("drops the session of a user disabled behind its back", async () => {
    const cookie = await register();
    await handle.db.update(users).set({ disabledAt: new Date() });
    expect((await me(cookie)).statusCode).toBe(401);
    expect(await handle.db.select().from(sessions)).toEqual([]);
  });

  it("logs out: 204, the row is gone and the cookie cleared", async () => {
    const cookie = await register();
    // No body at all: the content type alone is what the CSRF guard needs.
    const response = await post("/auth/logout", undefined, withCookie(cookie));
    expect(response.statusCode).toBe(204);
    const cleared = cookieOf(response);
    expect(cleared?.value).toBe("");
    expect(await handle.db.select().from(sessions)).toEqual([]);
    expect((await me(cookie)).statusCode).toBe(401);
  });

  it("refuses a logout without a JSON content type with 415", async () => {
    const cookie = await register();
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/auth/logout",
      ...withCookie(cookie),
    });
    expect(response.statusCode).toBe(415);
    expect(await handle.db.select().from(sessions)).toHaveLength(1);
  });
});

describe("GET/PATCH /auth/me", () => {
  it("returns the user, the tenant and the limits with the cookie", async () => {
    const cookie = await register();
    const response = await me(cookie);
    expect(response.statusCode).toBe(200);
    expect(response.json().data).toEqual({
      user: {
        id: expect.any(String),
        email: "ana@example.com",
        name: "Ana Anić",
        locale: "en",
        email_verified: false,
        is_admin: false,
        created_at: expect.any(String),
      },
      tenant: {
        id: expect.any(String),
        slug: expect.stringMatching(/^t-/),
        name: "Ana Anić",
        plan: "free",
        max_keys: null,
        retention_days: null,
      },
      limits: { default_max_keys: 10, default_daily_limit: 100_000, max_daily_limit: null },
    });
  });

  it("is 401 without a cookie, with an unknown one and with an expired one", async () => {
    const cookie = await register();
    expect((await fx.app.inject({ method: "GET", url: "/memento/auth/me" })).statusCode).toBe(401);
    expect((await me("forged")).statusCode).toBe(401);
    await handle.db.update(sessions).set({ expiresAt: new Date(Date.now() - 1000) });
    const expired = await me(cookie);
    expect(expired.statusCode).toBe(401);
    expect(cookieOf(expired)?.value).toBe("");
  });

  it("slides: a session seen over a minute ago is pushed out and the cookie re-sent", async () => {
    const cookie = await register();
    expect(cookieOf(await me(cookie))).toBeUndefined();
    const old = new Date(Date.now() - 5 * 86_400_000);
    await handle.db
      .update(sessions)
      .set({ lastSeenAt: old, expiresAt: new Date(Date.now() + 86_400_000) });
    const response = await me(cookie);
    expect(cookieOf(response)).toMatchObject({ value: cookie, maxAge: 30 * 86_400 });
    const [session] = await handle.db.select().from(sessions);
    expect(session?.lastSeenAt.getTime()).toBeGreaterThan(old.getTime());
    expect(session?.expiresAt.getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
  });

  it("changes the name and locale", async () => {
    const cookie = await register();
    const response = await fx.app.inject({
      method: "PATCH",
      url: "/memento/auth/me",
      headers: JSON_HEADERS,
      payload: { name: "Ana B.", locale: "sr" },
      ...withCookie(cookie),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().data.user).toMatchObject({ name: "Ana B.", locale: "sr" });
  });

  it("changes the password only with the current one", async () => {
    const cookie = await register();
    const patch = (password: unknown) =>
      fx.app.inject({
        method: "PATCH",
        url: "/memento/auth/me",
        headers: JSON_HEADERS,
        payload: { password },
        ...withCookie(cookie),
      });
    const wrong = await patch({ current: "not the password", next: "a brand new password" });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.message).toMatch(/^password\.current: /);
    expect((await patch({ current: ANA.password, next: "short" })).statusCode).toBe(422);
    expect((await patch({ current: ANA.password, next: "a brand new password" })).statusCode).toBe(
      200,
    );
    expect(
      (await post("/auth/login", { email: ANA.email, password: ANA.password })).statusCode,
    ).toBe(401);
    expect(
      (await post("/auth/login", { email: ANA.email, password: "a brand new password" }))
        .statusCode,
    ).toBe(200);
  });

  it("needs a JSON content type for PATCH", async () => {
    const cookie = await register();
    const response = await fx.app.inject({
      method: "PATCH",
      url: "/memento/auth/me",
      headers: { "content-type": "text/plain" },
      payload: "name=x",
      ...withCookie(cookie),
    });
    expect(response.statusCode).toBe(415);
  });
});

describe("POST /auth/forgot and /auth/reset", () => {
  it("is 200 for an unknown email and sends nothing", async () => {
    const response = await post("/auth/forgot", { email: "nobody@example.com" });
    expect(response.statusCode).toBe(200);
    expect(mailer.sent).toEqual([]);
  });

  it("is 200 for a disabled user and sends nothing", async () => {
    await register();
    await setUserDisabled(handle.db, ANA.email, true);
    expect((await post("/auth/forgot", { email: ANA.email })).statusCode).toBe(200);
    expect(mailer.sent).toHaveLength(1); // the verify mail of the registration only
  });

  it("resets the password once, deletes every session, and older reset links die", async () => {
    const cookie = await register();
    expect((await post("/auth/forgot", { email: "ANA@example.com" })).statusCode).toBe(200);
    const older = tokenFromMail("reset");
    expect(mailer.last()?.subject).toBe("Reset your memento password");
    expect((await post("/auth/forgot", { email: ANA.email })).statusCode).toBe(200);
    const token = tokenFromMail("reset");
    expect(token).not.toBe(older);
    const [stored] = await handle.db
      .select()
      .from(userTokens)
      .where(eq(userTokens.tokenHash, sha256Hex(token)));
    expect((stored?.expiresAt.getTime() ?? 0) - (stored?.createdAt.getTime() ?? 0)).toBe(3_600_000);

    expect(
      (await post("/auth/reset", { token: older, password: "a brand new password" })).statusCode,
    ).toBe(404);
    expect((await post("/auth/reset", { token, password: "short" })).statusCode).toBe(422);
    const response = await post("/auth/reset", { token, password: "a brand new password" });
    expect(response.statusCode).toBe(200);
    expect(await handle.db.select().from(sessions)).toEqual([]);
    expect((await me(cookie)).statusCode).toBe(401);
    expect(
      (await post("/auth/reset", { token, password: "another new password" })).statusCode,
    ).toBe(404);
    expect(
      (await post("/auth/login", { email: ANA.email, password: "a brand new password" }))
        .statusCode,
    ).toBe(200);
  });
});

describe("credentials do not cross", () => {
  it("an API key route refuses the cookie, a session route refuses the key", async () => {
    const cookie = await register();
    const events = await fx.app.inject({
      method: "GET",
      url: "/memento/events",
      ...withCookie(cookie),
    });
    expect(events.statusCode).toBe(401);
    expect(events.json().error.message).toBe("missing API key");
    const byKey = await fx.app.inject({
      method: "GET",
      url: "/memento/auth/me",
      headers: auth(fx.keys.admin),
    });
    expect(byKey.statusCode).toBe(401);
  });
});

describe("UDC collections registered with auth", () => {
  async function udc(
    collection: string,
    headers: Record<string, string>,
    extra: Record<string, unknown> = {},
  ) {
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/udc/list",
      headers: { "x-udc-message-id": "m1", ...JSON_HEADERS, ...headers },
      payload: { collection },
      ...extra,
    });
    expect(response.statusCode).toBe(200);
    // biome-ignore lint/suspicious/noExplicitAny: protocol payloads
    return response.json() as { kind: string; payload: Record<string, any> };
  }

  it("a session collection lists the session's tenant with the cookie and refuses a key", async () => {
    const cookie = await register();
    const [membership] = await handle.db.select().from(tenantUsers);
    const [tenant] = await handle.db
      .select()
      .from(tenants)
      .where(eq(tenants.id, membership?.tenantId as string));
    // An event of acme (key) must not show up in Ana's tenant.
    await push(fx.app, fx.keys.write, {
      event_type: "NOTE",
      instance_type: "server",
      instance_id: "acme-only",
      payload: { text: "acme only" },
      occurred_at: "2026-10-31T10:00:00Z",
    });
    const own = await createApiKey(handle.db, {
      tenant: tenant?.slug as string,
      name: "ana-write",
      scopes: "write",
    });
    await push(fx.app, own.key, {
      event_type: "NOTE",
      instance_type: "server",
      instance_id: "ana-only",
      payload: { text: "ana only" },
      occurred_at: "2026-10-31T10:00:01Z",
    });
    const mine = await udc("my_events", {}, withCookie(cookie));
    expect(mine.kind, JSON.stringify(mine.payload)).toBe("udc.list.ok");
    expect(mine.payload.rows.map((r: { instance_id: string }) => r.instance_id)).toEqual([
      "ana-only",
    ]);

    const byKey = await udc("my_events", auth(fx.keys.admin));
    expect(byKey.kind).toBe("udc.list.err");
    expect(byKey.payload.code).toBe("forbidden");
  });

  it("a key collection refuses the cookie", async () => {
    const cookie = await register();
    const answer = await udc("events", {}, withCookie(cookie));
    expect(answer.kind).toBe("udc.list.err");
    expect(answer.payload.message).toBe("missing API key");
  });

  it("an admin collection needs an admin user", async () => {
    const cookie = await register();
    expect((await udc("all_events", {}, withCookie(cookie))).payload.code).toBe("forbidden");
    await setUserAdmin(handle.db, ANA.email, true);
    expect((await udc("all_events", {}, withCookie(cookie))).kind).toBe("udc.list.ok");
  });

  it("a session collection refuses a cookie request without a JSON content type", async () => {
    const cookie = await register();
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/udc/list",
      headers: { "x-udc-message-id": "m1", "content-type": "text/plain" },
      payload: JSON.stringify({ collection: "my_events" }),
      ...withCookie(cookie),
    });
    expect(response.json().kind).toBe("udc.list.err");
  });
});

describe("rate limits", () => {
  it("answers 429 rate_limited after 10 logins from one IP", async () => {
    for (let i = 0; i < 10; i++) {
      const response = await post("/auth/login", { email: `u${i}@example.com`, password: "x" });
      expect(response.statusCode).toBe(401);
    }
    const blocked = await post("/auth/login", { email: "u11@example.com", password: "x" });
    expect(blocked.statusCode).toBe(429);
    expect(blocked.json().error.code).toBe("rate_limited");
    // Another IP still gets through.
    const other = await post(
      "/auth/login",
      { email: "x@example.com", password: "x" },
      { remoteAddress: "10.0.0.2" },
    );
    expect(other.statusCode).toBe(401);
  });

  it("limits logins per email across IPs", async () => {
    for (let i = 0; i < 10; i++) {
      const response = await post(
        "/auth/login",
        { email: "Target@example.com", password: "x" },
        { remoteAddress: `10.0.1.${i}` },
      );
      expect(response.statusCode).toBe(401);
    }
    const blocked = await post(
      "/auth/login",
      { email: "target@example.com ", password: "x" },
      { remoteAddress: "10.0.2.1" },
    );
    expect(blocked.statusCode).toBe(429);
  });

  it("limits register per IP, and X-Forwarded-For only counts with trustProxy", async () => {
    const attempt = (i: number, xff: string) =>
      post(
        "/auth/register",
        { ...ANA, email: `bad-${i}` },
        { headers: { ...JSON_HEADERS, "x-forwarded-for": xff } },
      );
    for (let i = 0; i < 10; i++) expect((await attempt(i, `192.0.2.${i}`)).statusCode).toBe(422);
    expect((await attempt(10, "192.0.2.99")).statusCode).toBe(429);

    await setup({ trustProxy: true });
    for (let i = 0; i < 12; i++) expect((await attempt(i, `192.0.2.${i}`)).statusCode).toBe(422);
  });
});

describe("MEMENTO_ACCOUNTS off", () => {
  it("serves none of it: every /auth route is 404 and a session collection refuses the cookie", async () => {
    const registry = eventCollections({ db: handle.db });
    registry.register({
      name: "my_events",
      source: new EventCollectionSource(handle.db, { fields: EVENTS_FIELDS }),
      view: ViewConfigSchema.parse(EVENTS_VIEW),
      auth: "session",
    });
    const off = await setupApp(handle, { udc: registry });
    apps.push(off.app);
    for (const [method, url] of [
      ["POST", "/auth/register"],
      ["POST", "/auth/verify"],
      ["POST", "/auth/resend"],
      ["POST", "/auth/login"],
      ["POST", "/auth/logout"],
      ["POST", "/auth/forgot"],
      ["POST", "/auth/reset"],
      ["GET", "/auth/me"],
      ["PATCH", "/auth/me"],
    ] as const) {
      const response = await off.app.inject({
        method,
        url: `/memento${url}`,
        headers: JSON_HEADERS,
        payload: method === "GET" ? undefined : "{}",
      });
      expect(response.statusCode, `${method} ${url}`).toBe(404);
    }
    const answer = await off.app.inject({
      method: "POST",
      url: "/memento/udc/list",
      headers: { "x-udc-message-id": "m1", ...JSON_HEADERS },
      payload: { collection: "my_events" },
      cookies: { memento_session: "anything" },
    });
    expect(answer.json().kind).toBe("udc.list.err");
  });
});
