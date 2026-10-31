import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateLookupsModule, validateTranslationsCsv } from "@memento/lookups";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { runWithTenant } from "../src/context.js";
import { events } from "../src/db/schema.js";
import {
  DEFAULT_LOOKUPS_PATH,
  GENERATED_LOOKUPS_PATH,
  initLookups,
  LOOKUPS_CODEGEN,
  type Lookups,
} from "../src/lookups.js";
import { NoopPublisher } from "../src/publisher.js";
import { authenticateApiKey } from "../src/services/apikeys.js";
import { listEvents, localizeEvents, pushEvent } from "../src/services/events.js";
import { deleteTemplate, listTemplates, saveTemplate } from "../src/services/templates.js";
import { getTenantBySlug } from "../src/services/tenants.js";
import { EventRenderer } from "../src/templates/renderer.js";
import { auth, type Fixture, push, setupApp, testDatabase } from "./helpers.js";

const handle = testDatabase();
let fx: Fixture;
let tmp: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "memento-render-"));
});
afterEach(async () => {
  await fx?.app.close();
  await rm(tmp, { recursive: true, force: true });
});
afterAll(() => handle.close());

/** The repository's own vocabulary, with candidates written to a temp dir. */
async function repoLookups(strict = false): Promise<Lookups> {
  return initLookups({
    path: DEFAULT_LOOKUPS_PATH,
    candidatesDir: join(tmp, "candidates"),
    strict,
  });
}

const get = (url: string, key = fx.keys.read) =>
  fx.app.inject({ method: "GET", url, headers: auth(key) });

const login = {
  event_type: "USER_LOGIN",
  instance_type: "user",
  instance_id: "42",
  actor_id: "igor",
};

describe("rendering on push", () => {
  beforeEach(async () => {
    fx = await setupApp(handle, { lookups: await repoLookups() });
  });

  it("renders in the default locale and in ?locale", async () => {
    expect(await push(fx.app, fx.keys.write, login)).toMatchObject({
      rendered: "User igor logged in.",
      rendered_locale: "en",
    });
    const sr = await fx.app.inject({
      method: "POST",
      url: "/memento/events?locale=sr",
      headers: auth(fx.keys.write),
      payload: login,
    });
    expect(sr.json().data).toMatchObject({
      rendered: "Korisnik igor se prijavio.",
      rendered_locale: "sr",
    });
    expect(fx.publisher.messages.at(-1)?.event.rendered).toBe("Korisnik igor se prijavio.");
  });

  it("walks the fallback chain: sr-Latn → sr, de → en, unknown type → _generic", async () => {
    const at = async (locale: string, body: Record<string, unknown>) =>
      (
        await fx.app.inject({
          method: "POST",
          url: `/memento/events?locale=${locale}`,
          headers: auth(fx.keys.write),
          payload: body,
        })
      ).json().data;
    expect(await at("sr-Latn", login)).toMatchObject({
      rendered: "Korisnik igor se prijavio.",
      rendered_locale: "sr-Latn",
    });
    expect((await at("de", login)).rendered).toBe("User igor logged in.");
    const invoice = { event_type: "INVOICE_PAID", instance_type: "invoice", instance_id: "INV-1" };
    expect((await at("sr", invoice)).rendered).toBe("INVOICE_PAID: invoice INV-1.");
    expect(
      (await at("de", { ...login, event_type: "TICKET_CLOSED", instance_type: "ticket" })).rendered,
    ).toBe("igor closed ticket 42.");
  });

  it("rejects an invalid ?locale", async () => {
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/events?locale=EN_us",
      headers: auth(fx.keys.write),
      payload: login,
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("validation_error");
  });

  it("stores NOTE text verbatim and requires it", async () => {
    const note = {
      event_type: "NOTE",
      instance_type: "ticket",
      instance_id: "T-1",
      actor_id: "igor",
    };
    expect(
      await push(fx.app, fx.keys.write, { ...note, payload: { text: "Pozvati klijenta." } }),
    ).toMatchObject({
      rendered: "Pozvati klijenta.",
      rendered_locale: null,
    });
    const missing = await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.write),
      payload: { ...note, payload: { text: "  " } },
    });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.message).toBe("NOTE needs payload.text");
    expect(await push(fx.app, fx.keys.write, { ...note, rendered: "pre" })).toMatchObject({
      rendered: "pre",
      rendered_locale: null,
    });
  });

  it("records unknown lookup values as candidates", async () => {
    await push(fx.app, fx.keys.write, login);
    await push(fx.app, fx.keys.write, {
      event_type: "INVOICE_PAID",
      instance_type: "invoice",
      instance_id: "1",
      payload: { actor_type: "service" },
    });
    await push(fx.app, fx.keys.write, {
      event_type: "INVOICE_PAID",
      instance_type: "user",
      instance_id: "2",
    });
    const yaml = await readFile(join(tmp, "candidates", "EventTypes.yaml"), "utf8");
    expect(yaml).toContain("value: INVOICE_PAID");
    expect(yaml).toContain("count: 2");
    expect(await readFile(join(tmp, "candidates", "InstanceTypes.yaml"), "utf8")).toContain(
      "value: INVOICE",
    );
    expect(await readFile(join(tmp, "candidates", "ActorTypes.yaml"), "utf8")).toContain(
      "value: SERVICE",
    );
    const csv = await readFile(join(tmp, "candidates", "translations_candidate.csv"), "utf8");
    expect(csv.split("\n")[0]).toBe("section,term,en,sr");
  });
});

describe("strict lookups", () => {
  it("rejects values outside the vocabulary", async () => {
    fx = await setupApp(handle, { lookups: await repoLookups(true) });
    expect((await push(fx.app, fx.keys.write, login)).rendered).toBe("User igor logged in.");
    const response = await fx.app.inject({
      method: "POST",
      url: "/memento/events",
      headers: auth(fx.keys.write),
      payload: { event_type: "INVOICE_PAID", instance_type: "invoice", instance_id: "1" },
    });
    expect(response.statusCode).toBe(422);
    expect(response.json().error).toMatchObject({
      message: "unknown lookup values",
      details: [
        { section: "EventTypes", value: "INVOICE_PAID" },
        { section: "InstanceTypes", value: "invoice" },
      ],
    });
  });
});

describe("per-tenant overrides", () => {
  beforeEach(async () => {
    fx = await setupApp(handle, { lookups: await repoLookups() });
  });

  it("a tenant template beats the bundled one, only for that tenant", async () => {
    await saveTemplate(handle.db, "acme", {
      event_type: "USER_LOGIN",
      locale: "en",
      body: "{{upper actor_id}} signed in to Acme",
    });
    expect((await push(fx.app, fx.keys.write, login)).rendered).toBe("IGOR signed in to Acme");
    expect((await push(fx.app, fx.keys.otherWrite, login)).rendered).toBe("User igor logged in.");
  });

  it("checks the locale before the source: a tenant en override does not hide bundled sr", async () => {
    await saveTemplate(handle.db, "acme", {
      event_type: "USER_LOGIN",
      locale: "en",
      body: "custom en",
    });
    const sr = await fx.app.inject({
      method: "POST",
      url: "/memento/events?locale=sr",
      headers: auth(fx.keys.write),
      payload: login,
    });
    expect(sr.json().data.rendered).toBe("Korisnik igor se prijavio.");
    const de = await fx.app.inject({
      method: "POST",
      url: "/memento/events?locale=de",
      headers: auth(fx.keys.write),
      payload: login,
    });
    expect(de.json().data.rendered).toBe("custom en");
  });

  it("a tenant _generic template covers unknown event types", async () => {
    await saveTemplate(handle.db, "acme", {
      event_type: "_generic",
      locale: "en",
      body: "[{{event_type}}] {{instance_type}}#{{instance_id}}",
    });
    const event = await push(fx.app, fx.keys.write, {
      event_type: "INVOICE_PAID",
      instance_type: "invoice",
      instance_id: "9",
    });
    expect(event.rendered).toBe("[INVOICE_PAID] invoice#9");
    expect((await push(fx.app, fx.keys.write, login)).rendered).toBe("User igor logged in.");
  });

  it("a template that fails at render time falls back to the plain format", async () => {
    await saveTemplate(handle.db, "acme", {
      event_type: "USER_LOGIN",
      locale: "en",
      body: "{{#each payload.items}}{{#if}}x{{/if}}{{/each}}",
    });
    const event = await push(fx.app, fx.keys.write, { ...login, payload: { items: [1] } });
    expect(event.rendered).toBe("USER_LOGIN: user/42");
  });
});

describe("rendering on read", () => {
  beforeEach(async () => {
    fx = await setupApp(handle, { lookups: await repoLookups() });
  });

  it("?locale re-renders stored events; verbatim text is never translated", async () => {
    await push(fx.app, fx.keys.write, { ...login, occurred_at: "2026-10-30T10:00:00Z" });
    await push(fx.app, fx.keys.write, {
      event_type: "CHAT_MESSAGE_SENT",
      instance_type: "chat",
      instance_id: "c1",
      actor_id: "igor",
      rendered: "Igor wrote something",
      occurred_at: "2026-10-30T11:00:00Z",
    });
    const sr = (await get("/memento/events?locale=sr&order=asc")).json().data;
    expect(
      sr.map((e: { rendered: string; rendered_locale: string | null }) => [
        e.rendered,
        e.rendered_locale,
      ]),
    ).toEqual([
      ["Korisnik igor se prijavio.", "sr"],
      ["Igor wrote something", null],
    ]);
    const stored = (await get("/memento/events?order=asc")).json().data;
    expect(stored[0]).toMatchObject({ rendered: "User igor logged in.", rendered_locale: "en" });

    const body = { locale: "sr", filter: { field: "event_type", op: "eq", value: "USER_LOGIN" } };
    const queried = await fx.app.inject({
      method: "POST",
      url: "/memento/events/query",
      headers: auth(fx.keys.read),
      payload: body,
    });
    expect(queried.json().data[0].rendered).toBe("Korisnik igor se prijavio.");
    const history = (await get("/memento/entities/user/42/events?locale=sr")).json().data;
    expect(history[0].rendered).toBe("Korisnik igor se prijavio.");
    expect((await get("/memento/events?locale=bad_LOCALE")).statusCode).toBe(422);
  });

  it("keeps the stored text when it is already in the asked locale (snapshot at push time)", async () => {
    await push(fx.app, fx.keys.write, login);
    await saveTemplate(handle.db, "acme", {
      event_type: "USER_LOGIN",
      locale: "en",
      body: "new wording",
    });
    await saveTemplate(handle.db, "acme", {
      event_type: "USER_LOGIN",
      locale: "sr",
      body: "nova verzija",
    });
    const [en] = (await get("/memento/events?locale=en")).json().data;
    expect(en.rendered).toBe("User igor logged in.");
    const [sr] = (await get("/memento/events?locale=sr")).json().data;
    expect(sr.rendered).toBe("nova verzija");
  });

  it("fills `rendered` for events stored without it (before Phase 2)", async () => {
    const tenant = await getTenantBySlug(handle.db, "acme");
    await handle.db.insert(events).values({
      tenantId: tenant.id,
      occurredAt: new Date(),
      eventType: "TICKET_CREATED",
      instanceType: "ticket",
      instanceId: "T-1",
      actorId: "igor",
      payload: { title: "Old" },
    });
    const [event] = (await get("/memento/events")).json().data;
    expect(event).toMatchObject({
      rendered: 'igor created ticket T-1: "Old".',
      rendered_locale: "en",
    });
  });

  it("localizeEvents is a no-op when nothing needs rendering", async () => {
    const renderer = new EventRenderer({ db: handle.db });
    const list = [
      {
        id: "x",
        occurred_at: "2026-10-30T10:00:00.000Z",
        received_at: "2026-10-30T10:00:00.000Z",
        event_type: "USER_LOGIN",
        instance_type: "user",
        instance_id: "1",
        actor_id: null,
        payload: {},
        rendered: "kept",
        rendered_locale: "en",
        archived_at: null,
      },
    ];
    expect(await localizeEvents(renderer, "00000000-0000-0000-0000-000000000000", list)).toBe(list);
    expect(await localizeEvents(renderer, "00000000-0000-0000-0000-000000000000", list, "en")).toBe(
      list,
    );
  });
});

describe("services without a renderer", () => {
  it("push and list keep Phase 1 behaviour (no rendering, no lookups)", async () => {
    fx = await setupApp(handle);
    const context = await authenticateApiKey(handle.db, fx.keys.admin);
    await runWithTenant(context, async () => {
      const event = await pushEvent(handle.db, login, { publisher: new NoopPublisher() });
      expect(event).toMatchObject({ rendered: null, rendered_locale: null });
      const page = await listEvents(handle.db, { locale: "sr" });
      expect(page.events[0]?.rendered).toBeNull();
    });
  });

  it("a plugin without lookups still renders with the bundled templates", async () => {
    fx = await setupApp(handle, { defaultLocale: "sr" });
    expect((await push(fx.app, fx.keys.write, login)).rendered).toBe("Korisnik igor se prijavio.");
  });
});

describe("template management", () => {
  beforeEach(async () => {
    fx = await setupApp(handle);
  });

  it("creates, refuses duplicates, replaces, lists and deletes", async () => {
    const input = { event_type: "USER_LOGIN", locale: "en", body: "v1 {{actor_id}}" };
    const first = await saveTemplate(handle.db, "acme", input);
    expect(first).toMatchObject({
      created: true,
      template: { event_type: "USER_LOGIN", locale: "en", body: "v1 {{actor_id}}" },
    });
    await expect(saveTemplate(handle.db, "acme", input)).rejects.toMatchObject({
      code: "conflict",
    });
    const second = await saveTemplate(
      handle.db,
      "acme",
      { ...input, body: "v2" },
      { replace: true },
    );
    expect(second).toMatchObject({
      created: false,
      template: { id: first.template.id, body: "v2" },
    });
    expect(Date.parse(second.template.updated_at)).toBeGreaterThanOrEqual(
      Date.parse(first.template.updated_at),
    );
    await saveTemplate(handle.db, "acme", { event_type: "_generic", locale: "sr", body: "x" });
    expect(
      (await listTemplates(handle.db, "acme")).map((t) => `${t.event_type}.${t.locale}`),
    ).toEqual(["USER_LOGIN.en", "_generic.sr"]);
    expect(await listTemplates(handle.db, "globex")).toEqual([]);
    expect((await deleteTemplate(handle.db, "acme", "USER_LOGIN", "en")).body).toBe("v2");
    await expect(deleteTemplate(handle.db, "acme", "USER_LOGIN", "en")).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("validates input and the template body", async () => {
    await expect(
      saveTemplate(handle.db, "acme", { event_type: "user_login", locale: "en", body: "x" }),
    ).rejects.toMatchObject({ code: "validation_error", message: "invalid template" });
    await expect(
      saveTemplate(handle.db, "acme", {
        event_type: "USER_LOGIN",
        locale: "en",
        body: "{{> evil}}",
      }),
    ).rejects.toMatchObject({
      code: "validation_error",
      message: "invalid template: templates may not use partials",
    });
    await expect(
      saveTemplate(handle.db, "nope", { event_type: "USER_LOGIN", locale: "en", body: "x" }),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(deleteTemplate(handle.db, "acme", "USER_LOGIN", "EN")).rejects.toThrow();
  });
});

describe("the repository's vocabulary", () => {
  it("lookups.yaml and i18n/translations.csv load without errors or warnings", async () => {
    const lookups = await initLookups({ path: DEFAULT_LOOKUPS_PATH, candidatesDir: null });
    expect(lookups.recorder).toBeNull();
    expect(lookups.warnings).toEqual([]);
    expect(lookups.registry.sectionNames()).toEqual(["EventTypes", "InstanceTypes", "ActorTypes"]);
    const csv = await readFile(
      join(DEFAULT_LOOKUPS_PATH, "..", "i18n", "translations.csv"),
      "utf8",
    );
    expect(validateTranslationsCsv(csv, lookups.registry).ok).toBe(true);
  });

  it("the generated @memento/core lookups match lookups.yaml (run `memento lookups codegen`)", async () => {
    const lookups = await initLookups({ path: DEFAULT_LOOKUPS_PATH, candidatesDir: null });
    expect(await readFile(GENERATED_LOOKUPS_PATH, "utf8")).toBe(
      generateLookupsModule(lookups.registry, LOOKUPS_CODEGEN),
    );
  });

  it("config resolves lookup paths, candidate recording and strict mode", async () => {
    expect(loadConfig({}).lookups).toEqual({
      path: DEFAULT_LOOKUPS_PATH,
      translationsPath: undefined,
      candidatesDir: undefined,
      strict: false,
    });
    expect(loadConfig({}).defaultLocale).toBe("en");
    const custom = loadConfig({
      MEMENTO_LOOKUPS_PATH: "/etc/memento/lookups.yaml",
      MEMENTO_TRANSLATIONS_PATH: "/etc/memento/t.csv",
      MEMENTO_CANDIDATES_DIR: "/var/lib/memento",
      MEMENTO_LOOKUPS_STRICT: "true",
      MEMENTO_DEFAULT_LOCALE: "sr",
    });
    expect(custom.lookups).toEqual({
      path: "/etc/memento/lookups.yaml",
      translationsPath: "/etc/memento/t.csv",
      candidatesDir: "/var/lib/memento",
      strict: true,
    });
    expect(custom.defaultLocale).toBe("sr");
    expect(loadConfig({ MEMENTO_RECORD_CANDIDATES: "no" }).lookups.candidatesDir).toBeNull();
    expect(() => loadConfig({ MEMENTO_DEFAULT_LOCALE: "English" })).toThrow();
  });

  it("initLookups defaults translations and candidates next to the YAML", async () => {
    await mkdir(join(tmp, "i18n"));
    await writeFile(join(tmp, "lookups.yaml"), "EventTypes: [A_B]\n");
    await writeFile(join(tmp, "i18n", "translations.csv"), "section,term,sr\nEventTypes,A_B,Ab\n");
    const lookups = await initLookups({ path: join(tmp, "lookups.yaml"), locales: ["sr"] });
    expect(lookups.registry.label("EventTypes", "A_B", ["sr"])).toBe("Ab");
    expect(lookups.recorder?.dir).toBe(join(tmp, "var", "candidates"));
    await lookups.recorder?.record("EventTypes", "NEW");
    expect(
      await readFile(join(tmp, "var", "candidates", "translations_candidate.csv"), "utf8"),
    ).toBe("section,term,sr\nEventTypes,NEW,NEW\n");
  });
});
