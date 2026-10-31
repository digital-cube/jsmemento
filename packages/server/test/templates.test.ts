import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EVENT_TYPES, FREE_TEXT_EVENT_TYPES } from "@memento/core";
import { compileLookups, LookupRegistry } from "@memento/lookups";
import { describe, expect, it } from "vitest";
import {
  type RenderContext,
  TemplateEngine,
  TemplateSyntaxError,
} from "../src/templates/engine.js";
import {
  BUNDLED_TEMPLATES_DIR,
  loadTemplateDir,
  localeChain,
  ULTIMATE_FALLBACK,
} from "../src/templates/renderer.js";

const registry = new LookupRegistry(
  compileLookups("EventTypes: [USER_LOGIN]\nInstanceTypes: [USER]\n"),
  new Map([
    ["EventTypes.USER_LOGIN", { en: "User login", sr: "Prijava korisnika" }],
    ["InstanceTypes.USER", { en: "User", sr: "Korisnik" }],
  ]),
);
const engine = new TemplateEngine({ registry });

function context(overrides: Partial<RenderContext> = {}): RenderContext {
  const base = {
    event_type: "USER_LOGIN",
    instance_type: "user",
    instance_id: "42",
    actor_id: "igor",
    occurred_at: "2026-10-30T10:05:00.000Z",
    payload: {},
    ...overrides,
  };
  return { event: { ...base }, ...base } as RenderContext;
}

const render = (body: string, ctx = context(), locales: string[] = ["en"]) =>
  engine.render(body, ctx, locales);

describe("TemplateEngine helpers", () => {
  it("default, eq/ne, and/or/not", () => {
    expect(render("{{default actor_id instance_id}}")).toBe("igor");
    expect(render("{{default actor_id instance_id}}", context({ actor_id: null }))).toBe("42");
    expect(
      render("{{default payload.none payload.list 'x'}}", context({ payload: { list: [] } })),
    ).toBe("x");
    expect(render("{{default payload.none}}")).toBe("");
    expect(render("{{#if (eq instance_type 'user')}}yes{{/if}}{{#if (ne 1 1)}}no{{/if}}")).toBe(
      "yes",
    );
    expect(render("{{and actor_id instance_id}} {{and actor_id payload.x}}")).toBe("true false");
    expect(render("{{or payload.x false}} {{or payload.x actor_id}}")).toBe("false true");
    expect(render("{{not payload.x}} {{not actor_id}}")).toBe("true false");
  });

  it("string helpers", () => {
    const ctx = context({ payload: { s: "šta ima", long: "abcdefghij" } });
    expect(render("{{upper payload.s}}|{{lower 'ABC'}}|{{capitalize payload.s}}", ctx)).toBe(
      "ŠTA IMA|abc|Šta ima",
    );
    expect(render("{{truncate payload.long 4}}|{{truncate payload.long 20}}", ctx)).toBe(
      "abcd…|abcdefghij",
    );
    expect(render("{{truncate payload.long}}", ctx)).toBe("abcdefghij");
    expect(render("{{upper payload.missing}}", ctx)).toBe("");
  });

  it("join lists and object keys, json", () => {
    const ctx = context({ payload: { list: ["a", 1], changes: { title: {}, status: {} }, n: 3 } });
    expect(
      render("{{join payload.list}}|{{join payload.changes ' & '}}|{{join payload.n}}", ctx),
    ).toBe("a, 1|title & status|3");
    expect(render("{{json payload.list}} {{json payload.none}}", ctx)).toBe('["a",1] null');
  });

  it("formats dates and numbers in the render locale", () => {
    const ctx = context({ payload: { n: 1234.5, bad: "soon" } });
    expect(render("{{date occurred_at}}", ctx, ["en"])).toBe("Oct 30, 2026, 10:05 AM");
    expect(render("{{date occurred_at 'short' timeZone='Europe/Belgrade'}}", ctx, ["en"])).toBe(
      "10/30/26, 11:05 AM",
    );
    expect(render("{{date occurred_at 'long'}}", ctx, ["sr-Latn"])).toContain("2026");
    expect(render("{{date payload.bad}}", ctx)).toBe("soon");
    expect(render("{{date occurred_at timeZone='Mars/Base'}}", ctx)).toBe(
      "2026-10-30T10:05:00.000Z",
    );
    expect(render("{{number payload.n}}", ctx, ["en"])).toBe("1,234.5");
    expect(render("{{number payload.n}}", ctx, ["de"])).toBe("1.234,5");
    expect(render("{{number payload.bad}}", ctx)).toBe("soon");
  });

  it("plural picks the form by the locale's rules", () => {
    const body = '{{plural payload.n one="# poruka" few="# poruke" other="# poruka"}}';
    const at = (n: unknown) => render(body, context({ payload: { n } }), ["sr"]);
    expect([at(1), at(3), at(5), at(21), at(22)]).toEqual([
      "1 poruka",
      "3 poruke",
      "5 poruka",
      "21 poruka",
      "22 poruke",
    ]);
    expect(at("x")).toBe("");
    expect(render('{{plural 2 one="# item"}}', context(), ["en"])).toBe("");
    expect(render('{{plural 2 one="# item" other="# items"}}', context(), ["en"])).toBe("2 items");
  });

  it("label translates lookup terms through the locale chain", () => {
    expect(render('{{label "EventTypes" event_type}}', context(), ["sr-Latn", "sr", "en"])).toBe(
      "Prijava korisnika",
    );
    expect(render('{{label "InstanceTypes" instance_type}}', context(), ["de", "en"])).toBe("User");
    expect(render('{{label "EventTypes" "OTHER"}}')).toBe("OTHER");
    expect(render("{{@locale}}", context(), ["sr"])).toBe("sr");
  });
});

describe("TemplateEngine sandbox", () => {
  it.each([
    ["{{log actor_id}}", /unknown helper log/],
    ["{{exec 'rm -rf'}}", /unknown helper exec/],
    ["{{#custom actor_id}}x{{/custom}}", /unknown helper custom/],
    ["{{> partial}}", /may not use partials/],
    ["{{#> layout}}x{{/layout}}", /may not use partials/],
    ["{{* decorator}}", /may not use decorators/],
    ["{{#* inline 'x'}}y{{/inline}}", /may not use decorators/],
    ["{{actor_id", /Parse error/],
  ])("rejects %j at compile time", (body, message) => {
    expect(() => engine.compile(body)).toThrow(TemplateSyntaxError);
    expect(() => engine.compile(body)).toThrow(message);
  });

  it("blocks prototype access and never calls functions from the data", () => {
    const ctx = context({ payload: { obj: {} } });
    expect(
      render(
        "[{{payload.obj.constructor}}][{{lookup payload.obj 'constructor'}}][{{payload.__proto__}}]",
        ctx,
      ),
    ).toBe("[][][]");
    const evil = context({ payload: { fn: (() => "called") as unknown as string } });
    expect(render("[{{payload.fn}}]", evil)).toBe("[]");
  });

  it("does not HTML-escape: rendered text is plain text", () => {
    expect(render("{{payload.s}}", context({ payload: { s: '<b>"x"</b>' } }))).toBe('<b>"x"</b>');
  });

  it("caps the output and evicts the compile cache", () => {
    const small = new TemplateEngine({ registry, cacheSize: 1 });
    const long = small.render("{{payload.s}}", context({ payload: { s: "x".repeat(20_000) } }), [
      "en",
    ]);
    expect(long).toHaveLength(10_000);
    expect(long.endsWith("…")).toBe(true);
    expect(small.render("a", context(), [])).toBe("a");
    expect(small.render("b", context(), [])).toBe("b");
    expect(small.render("a", context(), [])).toBe("a");
  });

  it("rethrows unexpected compile failures as they are", () => {
    const broken = new TemplateEngine({ registry });
    // biome-ignore lint/suspicious/noExplicitAny: reach the private Handlebars instance
    (broken as any).hb.parse = () => {
      throw new TemplateSyntaxError("boom");
    };
    expect(() => broken.compile("x")).toThrow("boom");
  });
});

describe("localeChain", () => {
  it.each([
    ["sr", "en", ["sr", "en"]],
    ["en", "en", ["en"]],
    ["sr-Latn-RS", "en", ["sr-Latn-RS", "sr-Latn", "sr", "en"]],
    ["de-AT", "en-GB", ["de-AT", "de", "en-GB", "en"]],
  ])("%s (default %s)", (locale, fallback, expected) => {
    expect(localeChain(locale, fallback)).toEqual(expected);
  });
});

describe("bundled templates", () => {
  const bundled = loadTemplateDir(BUNDLED_TEMPLATES_DIR);
  const templated = EVENT_TYPES.filter((type) => !FREE_TEXT_EVENT_TYPES.includes(type));

  it("cover every templated event type of the vocabulary in en and sr, plus _generic", () => {
    for (const type of [...templated, "_generic"]) {
      for (const locale of ["en", "sr"]) expect(bundled.has(`${type}.${locale}`)).toBe(true);
    }
    expect(bundled.has("NOTE.en")).toBe(false);
  });

  it("all compile in the sandbox, as does the ultimate fallback", () => {
    for (const body of [...bundled.values(), ULTIMATE_FALLBACK])
      expect(() => engine.compile(body)).not.toThrow();
  });

  it("render with and without optional fields", () => {
    const t = (key: string, ctx: RenderContext) =>
      engine.render(bundled.get(key) as string, ctx, [key.split(".")[1] as string, "en"]);
    const ticket = (type: string, actor: string | null, payload: Record<string, unknown> = {}) =>
      context({
        event_type: type,
        instance_type: "ticket",
        instance_id: "T-7",
        actor_id: actor,
        payload,
      });

    expect(t("USER_LOGIN.en", context({ payload: { ip: "10.0.0.1" } }))).toBe(
      "User igor logged in from 10.0.0.1.",
    );
    expect(t("USER_LOGIN.sr", context({ actor_id: null }))).toBe("Korisnik 42 se prijavio.");
    expect(t("USER_LOGOUT.sr", context())).toBe("Korisnik igor se odjavio.");
    expect(t("USER_CREATED.en", context({ payload: { name: "Marko" } }))).toBe(
      "igor created user Marko.",
    );
    expect(t("USER_CREATED.sr", context({ actor_id: null }))).toBe("Kreiran je korisnik 42.");
    expect(
      t("TICKET_CREATED.en", ticket("TICKET_CREATED", "igor", { title: "Login broken" })),
    ).toBe('igor created ticket T-7: "Login broken".');
    expect(t("TICKET_CREATED.sr", ticket("TICKET_CREATED", null))).toBe("Kreiran je tiket T-7.");
    expect(
      t(
        "TICKET_MODIFIED.en",
        ticket("TICKET_MODIFIED", "igor", { changes: { title: 1, status: 2 } }),
      ),
    ).toBe("igor modified ticket T-7 (changed: title, status).");
    expect(t("TICKET_MODIFIED.sr", ticket("TICKET_MODIFIED", null, { changes: ["status"] }))).toBe(
      "Izmenjen je tiket T-7 (izmenjeno: status).",
    );
    expect(t("TICKET_CLOSED.en", ticket("TICKET_CLOSED", null, { resolution: "fixed" }))).toBe(
      "Ticket T-7 was closed (resolution: fixed).",
    );
    expect(
      t("TICKET_CLOSED.sr", ticket("TICKET_CLOSED", "igor", { resolution: "popravljeno" })),
    ).toBe("Korisnik igor je zatvorio tiket T-7 (rešenje: popravljeno).");
    const chat = (type: string, actor: string | null, payload: Record<string, unknown> = {}) =>
      context({
        event_type: type,
        instance_type: "chat",
        instance_id: "igor-marko",
        actor_id: actor,
        payload,
      });
    expect(
      t("CHAT_MESSAGE_SENT.sr", chat("CHAT_MESSAGE_SENT", "igor", { content: "Pozdrav!" })),
    ).toBe('Korisnik igor je poslao poruku: "Pozdrav!"');
    expect(t("CHAT_MESSAGE_SENT.en", chat("CHAT_MESSAGE_SENT", null))).toBe("A message was sent");
    expect(
      t("CHAT_MESSAGE_SEEN.en", chat("CHAT_MESSAGE_SEEN", "marko", { message_id: "m1" })),
    ).toBe("marko saw message m1 in chat igor-marko.");
    expect(t("CHAT_MESSAGE_SEEN.sr", chat("CHAT_MESSAGE_SEEN", null))).toBe(
      "Viđene su poruke u četu igor-marko.",
    );
    expect(t("_generic.en", context())).toBe("User login: user 42 (by igor).");
    expect(
      t(
        "_generic.sr",
        context({ event_type: "INVOICE_PAID", instance_type: "invoice", actor_id: null }),
      ),
    ).toBe("INVOICE_PAID: invoice 42.");
  });

  it("loads only well-named .hbs files", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memento-tpl-"));
    try {
      await writeFile(join(dir, "USER_LOGIN.sr-Latn.hbs"), "  Zdravo  \n");
      await writeFile(join(dir, "lower.en.hbs"), "x");
      await writeFile(join(dir, "README.md"), "x");
      expect([...loadTemplateDir(dir)]).toEqual([["USER_LOGIN.sr-Latn", "Zdravo"]]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
