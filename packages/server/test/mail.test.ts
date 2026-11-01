import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { loadConfig, parseMailFrom } from "../src/config.js";
import { AccountMails } from "../src/mail/account-mails.js";
import { BREVO_URL, BrevoMailer, LogMailer, MemoryMailer } from "../src/mail/mailer.js";
import { MailTemplates } from "../src/mail/templates.js";
import { randomTenantSlug } from "../src/services/accounts.js";

const log = () => ({ info: vi.fn(), error: vi.fn() });
const vars = { name: "Ana", link: "https://s.test/verify/abc", service_url: "https://s.test" };

describe("MailTemplates", () => {
  const templates = new MailTemplates();

  it.each([
    ["verify", "en", "Confirm your memento email address"],
    ["verify", "sr", "Potvrdite svoju adresu za memento"],
    ["reset", "en", "Reset your memento password"],
    ["reset", "sr", "Promena lozinke za memento"],
  ])("renders %s.%s: first line the subject, the rest the body", (kind, locale, subject) => {
    const mail = templates.render(kind, locale, vars);
    expect(mail.subject).toBe(subject);
    expect(mail.text).toContain(vars.link);
    expect(mail.text).toContain("Ana");
    expect(mail.text).toContain(vars.service_url);
    expect(mail.text).not.toContain(subject);
  });

  it("falls back to en for a locale without a file", () => {
    expect(templates.render("verify", "de", vars).subject).toBe(
      "Confirm your memento email address",
    );
  });

  it("does not escape (plain text) and refuses an unknown kind", () => {
    expect(templates.render("verify", "en", { ...vars, name: "Ana & <Bo>" }).text).toContain(
      "Ana & <Bo>",
    );
    expect(() => templates.render("nope", "en", vars)).toThrow(/no mail template "nope"/);
  });

  it("reads another directory and rejects a template the sandbox forbids", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memento-mail-"));
    await writeFile(join(dir, "hello.en.hbs"), "Hi {{name}}\nbody {{link}}");
    expect(new MailTemplates(dir).render("hello", "en", vars)).toEqual({
      subject: "Hi Ana",
      text: `body ${vars.link}\n`,
    });
    await writeFile(join(dir, "bad.en.hbs"), "{{> partial}}");
    expect(() => new MailTemplates(dir)).toThrow(/partials/);
    expect(new MailTemplates(join(dir, "missing")).has("verify")).toBe(false);
  });
});

describe("mailers", () => {
  const message = { to: "ana@example.com", subject: "S", text: "T" };

  it("LogMailer logs the full text at info", async () => {
    const logger = log();
    await new LogMailer(logger).send(message);
    expect(logger.info).toHaveBeenCalledWith({ mail: message }, "mail to ana@example.com: S");
  });

  it("BrevoMailer posts the transactional mail with the api-key header", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 201 }));
    const logger = log();
    await new BrevoMailer({
      apiKey: "xkeysib-test",
      from: { name: "memento", email: "info@example.com" },
      log: logger,
      fetch: fetch as unknown as typeof globalThis.fetch,
    }).send({ ...message, html: "<p>T</p>" });
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(BREVO_URL);
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["api-key"]).toBe("xkeysib-test");
    expect(JSON.parse(init.body as string)).toEqual({
      sender: { name: "memento", email: "info@example.com" },
      to: [{ email: "ana@example.com" }],
      subject: "S",
      textContent: "T",
      htmlContent: "<p>T</p>",
    });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it("BrevoMailer logs a refusal or a network error and does not throw", async () => {
    const logger = log();
    const refusing = new BrevoMailer({
      apiKey: "k",
      from: { name: "m", email: "m@example.com" },
      log: logger,
      fetch: (async () =>
        new Response('{"message":"sender not verified"}', {
          status: 400,
        })) as unknown as typeof fetch,
    });
    await expect(refusing.send(message)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ status: 400, detail: expect.stringContaining("not verified") }),
      "brevo refused the mail",
    );
    const broken = new BrevoMailer({
      apiKey: "k",
      from: { name: "m", email: "m@example.com" },
      log: logger,
      fetch: (async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    });
    await expect(broken.send(message)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledTimes(2);
  });

  it("AccountMails picks the user's locale and logs a template failure instead of throwing", async () => {
    const mailer = new MemoryMailer();
    const logger = log();
    const mails = new AccountMails({
      mailer,
      templates: new MailTemplates(),
      serviceUrl: "https://s.test",
      log: logger,
    });
    const user = { id: "u1", email: "ana@example.com", name: "Ana", locale: "sr" } as never;
    await mails.reset(user, "tok");
    expect(mailer.last()?.subject).toBe("Promena lozinke za memento");
    expect(mailer.last()?.text).toContain("https://s.test/reset/tok");
    const failing = new AccountMails({
      mailer,
      templates: new MailTemplates("/nonexistent"),
      serviceUrl: "https://s.test",
      log: logger,
    });
    await failing.verify(user, "tok");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });
});

describe("accounts config", () => {
  it("is off by default and exposes the limits", () => {
    const config = loadConfig({});
    expect(config.accounts).toBeNull();
    expect(config.trustProxy).toBe(false);
    expect(config.limits).toEqual({
      defaultMaxKeys: 10,
      defaultDailyLimit: 100_000,
      maxDailyLimit: null,
    });
  });

  it("needs MEMENTO_SERVICE_URL with accounts on, MEMENTO_MAIL_FROM with a Brevo key", () => {
    expect(() => loadConfig({ MEMENTO_ACCOUNTS: "true" })).toThrow(/MEMENTO_SERVICE_URL/);
    expect(() =>
      loadConfig({
        MEMENTO_ACCOUNTS: "true",
        MEMENTO_SERVICE_URL: "https://s.test",
        MEMENTO_BREVO_API_KEY: "k",
      }),
    ).toThrow(/MEMENTO_MAIL_FROM/);
  });

  it("parses every accounts variable", () => {
    const config = loadConfig({
      MEMENTO_ACCOUNTS: "yes",
      MEMENTO_SERVICE_URL: "https://service.stage.memento-service.org/",
      MEMENTO_BREVO_API_KEY: "xkeysib-1",
      MEMENTO_MAIL_FROM: "memento <info@example.com>",
      MEMENTO_TRUST_PROXY: "true",
      MEMENTO_SESSION_DAYS: "7",
      MEMENTO_DEFAULT_MAX_KEYS: "3",
      MEMENTO_DEFAULT_DAILY_LIMIT: "500",
      MEMENTO_MAX_DAILY_LIMIT: "1000",
    });
    expect(config.accounts).toEqual({
      serviceUrl: "https://service.stage.memento-service.org",
      brevoApiKey: "xkeysib-1",
      mailFrom: { name: "memento", email: "info@example.com" },
      sessionDays: 7,
    });
    expect(config.trustProxy).toBe(true);
    expect(config.limits).toEqual({
      defaultMaxKeys: 3,
      defaultDailyLimit: 500,
      maxDailyLimit: 1000,
    });
  });

  it("parses MEMENTO_MAIL_FROM forms", () => {
    expect(parseMailFrom('"Memento Team" <a@b.rs>')).toEqual({
      name: "Memento Team",
      email: "a@b.rs",
    });
    expect(parseMailFrom("a@b.rs")).toEqual({ name: "a@b.rs", email: "a@b.rs" });
    expect(() => parseMailFrom("nobody")).toThrow(/Name <address>/);
  });

  it("makes t- slugs of 8 base32 characters", () => {
    for (let i = 0; i < 50; i++) expect(randomTenantSlug()).toMatch(/^t-[a-z2-7]{8}$/);
  });
});
