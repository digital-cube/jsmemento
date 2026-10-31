import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import {
  bundledStep,
  bundledTemplate,
  chosenType,
  GENERIC_TEMPLATE,
  lookupChain,
  overrideCommand,
  payloadEntries,
  payloadKeys,
  sourceParts,
  TEMPLATE_FILES,
  TEMPLATE_TYPES,
  templatesFrom,
} from "../src/examples/rendering/templates.js";
import { defaultSettings, STORAGE_KEY } from "../src/settings.js";
import { FakeSocket, uuid } from "./fake-socket.js";
import { type FeedEvent, udcServer } from "./udc-server.js";

const settings = { ...defaultSettings({} as ImportMetaEnv), apiKey: "mk_k" };
const TEMPLATES_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "packages",
  "server",
  "templates",
);
const FILES = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".hbs"));
const read = (file: string) => readFileSync(join(TEMPLATES_DIR, file), "utf8").replace(/\n+$/, "");

let n = 0;
function ev(
  event_type: string,
  instance: string,
  actor_id: string | null,
  payload: Record<string, unknown>,
  en: string,
  sr: string,
): FeedEvent {
  n += 1;
  const [instance_type = "", instance_id = ""] = instance.split("/");
  return {
    id: uuid(n),
    event_type,
    instance_type,
    instance_id,
    actor_id,
    occurred_at: new Date(Date.UTC(2026, 9, 31, 10, 0, n)).toISOString(),
    rendered: { en, sr },
    payload,
  };
}

function story(): FeedEvent[] {
  n = 0;
  return [
    ev(
      "TICKET_CREATED",
      "ticket/T-3",
      "ana",
      { title: "Login broken", priority: "high", actor_type: "user" },
      'ana created ticket T-3: "Login broken".',
      'Korisnik ana je kreirao tiket T-3: "Login broken".',
    ),
    ev(
      "TICKET_CLOSED",
      "ticket/T-2",
      "marko",
      { resolution: "duplicate", actor_type: "user" },
      "marko closed ticket T-2 (resolution: duplicate).",
      "Korisnik marko je zatvorio tiket T-2 (rešenje: duplicate).",
    ),
    ev(
      "TICKET_CLOSED",
      "ticket/T-3",
      "ana",
      { resolution: "fixed", actor_type: "user" },
      "ana closed ticket T-3 (resolution: fixed).",
      "Korisnik ana je zatvorio tiket T-3 (rešenje: fixed).",
    ),
  ];
}

beforeEach(() => {
  FakeSocket.all = [];
  localStorage.clear();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(() => vi.unstubAllGlobals());

describe("the bundled templates", () => {
  it("are every .hbs file of packages/server/templates, as the server ships them", () => {
    expect(Object.keys(TEMPLATE_FILES)).toHaveLength(FILES.length);
    const stems = new Set(FILES.map((f) => f.split(".")[0] as string));
    stems.delete("_generic");
    expect([...TEMPLATE_TYPES]).toEqual([...stems].sort());
    for (const file of FILES) {
      const [type = "", locale = ""] = file.split(".");
      const pair = type === "_generic" ? GENERIC_TEMPLATE : bundledTemplate(type);
      expect(pair?.[locale as "en" | "sr"], file).toBe(read(file));
    }
    // NOTE is free text: no template of its own.
    expect(bundledTemplate("NOTE")).toBeNull();
    expect(TEMPLATE_TYPES).not.toContain("NOTE");
  });

  it("are keyed by event type and locale, whatever the path", () => {
    expect(
      templatesFrom({
        "/x/TICKET_CLOSED.en.hbs": "closed\n",
        "/x/TICKET_CLOSED.sr.hbs": "zatvoren",
        "/x/_generic.en.hbs": "generic",
        "/x/USER_LOGIN.de.hbs": "angemeldet",
        "/x/readme.md": "no",
      }),
    ).toEqual({
      TICKET_CLOSED: { en: "closed", sr: "zatvoren" },
      _generic: { en: "generic", sr: null },
    });
  });

  it("name the payload keys they read, inside {{…}} only", () => {
    expect(payloadKeys(bundledTemplate("TICKET_CLOSED")?.en ?? null)).toEqual(["resolution"]);
    expect(payloadKeys(bundledTemplate("CHAT_MESSAGE_SENT")?.sr ?? null)).toEqual([
      "sender_user_id",
      "content",
    ]);
    expect(payloadKeys(bundledTemplate("USER_CREATED")?.en ?? null)).toEqual(["name", "username"]);
    expect(payloadKeys(bundledTemplate("USER_LOGOUT")?.en ?? null)).toEqual([]);
    expect(payloadKeys("payload.no {{event.payload.yes}} {{#if payload.yes}}{{/if}}")).toEqual([
      "yes",
    ]);
    expect(payloadKeys(null)).toEqual([]);
    // Every `payload.x` token of every template is one of its keys.
    for (const type of TEMPLATE_TYPES) {
      const source = bundledTemplate(type)?.en ?? "";
      const tokens = [...source.matchAll(/payload\.(\w+)/g)].map((m) => m[1]);
      expect(new Set(payloadKeys(source)), type).toEqual(new Set(tokens));
    }
  });

  it("are cut into text, tags and payload references for display", () => {
    expect(sourceParts("Hi {{payload.name}}{{#if x}}!{{/if}}")).toEqual([
      { kind: "text", text: "Hi " },
      { kind: "tag", text: "{{" },
      { kind: "payload", text: "payload.name" },
      { kind: "tag", text: "}}" },
      { kind: "tag", text: "{{#if x}}" },
      { kind: "text", text: "!" },
      { kind: "tag", text: "{{/if}}" },
    ]);
  });

  it("are looked up along the locale chain, then _generic", () => {
    expect(lookupChain("T", "sr")).toEqual(["T.sr", "T.en", "_generic.sr", "_generic.en"]);
    expect(lookupChain("T", "sr-Latn-RS")).toEqual([
      "T.sr-Latn-RS",
      "T.sr-Latn",
      "T.sr",
      "T.en",
      "_generic.sr-Latn-RS",
      "_generic.sr-Latn",
      "_generic.sr",
      "_generic.en",
    ]);
    expect(lookupChain("T", "en")).toEqual(["T.en", "_generic.en"]);
    expect(bundledStep("TICKET_CLOSED", "sr")).toBe("TICKET_CLOSED.sr");
    expect(bundledStep("NOTE", "sr")).toBe("_generic.sr");
    expect(overrideCommand("demo", "TICKET_CLOSED", "sr")).toBe(
      "pnpm memento create-template --tenant demo --event-type TICKET_CLOSED --locale sr --file TICKET_CLOSED.sr.hbs",
    );
    expect(overrideCommand(null, "X", "en")).toContain("--tenant <tenant>");
  });

  it("open on TICKET_CREATED unless the URL names a type with a template", () => {
    expect(chosenType(null)).toBe("TICKET_CREATED");
    expect(chosenType("NOTE")).toBe("TICKET_CREATED");
    expect(chosenType("TICKET_CLOSED")).toBe("TICKET_CLOSED");
  });

  it("mark the payload members a template reads", () => {
    expect(payloadEntries({ resolution: "fixed", actor_type: "user" }, ["resolution"])).toEqual([
      { key: "resolution", text: '"resolution": "fixed"', used: true },
      { key: "actor_type", text: '"actor_type": "user"', used: false },
    ]);
    expect(payloadEntries([1], [])).toEqual([]);
    expect(payloadEntries({ a: { b: 1 } }, [])[0]?.text).toBe('"a": {\n    "b": 1\n  }');
  });
});

describe("the page", () => {
  it("lists exactly the types with a template, with the tenant's counts, the empty ones greyed", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: story() }).fetch);
    history.replaceState(null, "", "/examples/rendering");
    render(<App />);
    const tabs = await screen.findByTestId("rendering-types");
    const all = within(tabs).getAllByRole("tab");
    expect(all.map((b) => b.dataset.type)).toEqual([...TEMPLATE_TYPES]);
    expect(within(tabs).getByRole("tab", { selected: true }).dataset.type).toBe("TICKET_CREATED");
    const tab = (type: string) => all.find((b) => b.dataset.type === type) as HTMLElement;
    await waitFor(() =>
      expect(within(tab("TICKET_CLOSED")).getByTestId("type-count").textContent).toBe("2"),
    );
    await waitFor(() =>
      expect(within(tab("USER_LOGIN")).getByTestId("type-count").textContent).toBe("0"),
    );
    expect(tab("USER_LOGIN").className).toContain("is-empty");
    expect(tab("TICKET_CLOSED").className).not.toContain("is-empty");
  });

  it("shows the latest event, both templates and the server's sentence from two locale reads", async () => {
    const server = udcServer({ feed: story() });
    vi.stubGlobal("fetch", server.fetch);
    history.replaceState(null, "", "/examples/rendering?type=TICKET_CLOSED");
    render(<App />);

    const en = await screen.findByTestId("rendered-en");
    await waitFor(() => expect(en.textContent).toBe("ana closed ticket T-3 (resolution: fixed)."));
    await waitFor(() =>
      expect(screen.getByTestId("rendered-sr").textContent).toBe(
        "Korisnik ana je zatvorio tiket T-3 (rešenje: fixed).",
      ),
    );
    // The same (latest) event, read once per locale.
    const latest = uuid(3);
    expect(server.reads).toEqual(
      expect.arrayContaining([
        { id: latest, locale: "en" },
        { id: latest, locale: "sr" },
      ]),
    );
    expect(server.reads.every((r) => r.id === latest)).toBe(true);

    expect(screen.getByTestId("template-en").textContent).toBe(read("TICKET_CLOSED.en.hbs"));
    expect(screen.getByTestId("template-sr").textContent).toBe(read("TICKET_CLOSED.sr.hbs"));
    expect(
      within(screen.getByTestId("template-en"))
        .getAllByTestId("template-payload")
        .map((m) => m.textContent),
    ).toEqual(["payload.resolution", "payload.resolution"]);

    // The payload pane lights up exactly the keys the templates read.
    const payload = screen.getByTestId("rendering-payload");
    expect(payload.textContent).toContain('"actor_type": "user"');
    expect(
      within(payload)
        .getAllByTestId("payload-used")
        .map((m) => m.dataset.key),
    ).toEqual(["resolution"]);
    expect(screen.getByTestId("rendering-actor").textContent).toBe("ana");
    expect(
      within(screen.getByTestId("rendering-event")).getByRole("link", { name: "ticket/T-3" }),
    ).toBeTruthy();

    // Lookup chain and the override command for this type.
    expect(screen.getByTestId("chain-sr").textContent).toContain("TICKET_CLOSED.sr");
    expect(screen.getByTestId("override-command").textContent).toContain(
      "--event-type TICKET_CLOSED --locale sr",
    );
    expect(screen.getByTestId("generic-en").textContent).toBe(read("_generic.en.hbs"));
  });

  it("follows the picked type in the URL and says so when the tenant has none of it", async () => {
    vi.stubGlobal("fetch", udcServer({ feed: story() }).fetch);
    history.replaceState(null, "", "/examples/rendering");
    render(<App />);
    await waitFor(() =>
      expect(screen.getByTestId("rendered-en").textContent).toBe(
        'ana created ticket T-3: "Login broken".',
      ),
    );
    fireEvent.click(await screen.findByRole("tab", { name: /USER_LOGIN/ }));
    expect(location.search).toBe("?type=USER_LOGIN");
    expect((await screen.findByTestId("rendering-none")).textContent).toContain("USER_LOGIN");
    expect(screen.getByTestId("rendered-sr").textContent).toBe("no event to render");
    expect(screen.getByTestId("template-sr").textContent).toBe(read("USER_LOGIN.sr.hbs"));
    // The stream follows the picked type.
    await waitFor(() => expect(FakeSocket.all.at(-1)?.url).toContain("event_type=USER_LOGIN"));
  });
});
