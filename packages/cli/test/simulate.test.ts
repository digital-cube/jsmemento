import type { AddressInfo } from "node:net";
import {
  ACTOR_TYPES,
  EVENT_TYPES,
  EventInputSchema,
  FREE_TEXT_EVENT_TYPES,
  INSTANCE_TYPES,
} from "@memento/core";
import { LookupRegistry } from "@memento/lookups";
import {
  BUNDLED_TEMPLATES_DIR,
  buildApp,
  connect,
  createApiKey,
  createTenant,
  loadConfig,
  loadTemplateDir,
  TemplateEngine,
} from "@memento/server";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BOT,
  CAST,
  MAX_OPEN,
  makeUi,
  prng,
  runCli,
  runSimulate,
  storyLine,
  TicketDesk,
} from "../src/index.js";

const at = new Date("2026-10-31T10:00:00Z");
const story = (seed: number, steps: number) => {
  const desk = new TicketDesk(seed);
  return Array.from({ length: steps }, (_, i) => desk.next(new Date(at.getTime() + i * 1000)));
};

describe("the ticket desk story", () => {
  it("is deterministic for a seed", () => {
    expect(story(42, 200)).toEqual(story(42, 200));
    expect(story(42, 50)).not.toEqual(story(43, 50));
    const random = prng(7);
    const values = Array.from({ length: 1000 }, random);
    expect(values.every((v) => v >= 0 && v < 1)).toBe(true);
    expect(new Set(values).size).toBe(1000);
  });

  it("produces only events the lookups know, valid on the wire", () => {
    for (const seed of [1, 2, 3]) {
      for (const event of story(seed, 500)) {
        expect(EventInputSchema.safeParse(event).success).toBe(true);
        expect(EVENT_TYPES).toContain(event.event_type);
        expect(INSTANCE_TYPES).toContain(event.instance_type);
        expect(ACTOR_TYPES).toContain((event.payload as { actor_type: string }).actor_type);
        expect(event.event_type).not.toBe("CPU_LOAD");
      }
    }
  });

  it("plays every scene of the cast over 500 steps", () => {
    for (const seed of [1, 2, 3, 42, 2026]) {
      const events = story(seed, 500);
      const types = new Set(events.map((e) => e.event_type));
      expect([...types].sort()).toEqual(
        [
          "NOTE",
          "TICKET_CLOSED",
          "TICKET_CREATED",
          "TICKET_MODIFIED",
          "USER_CREATED",
          "USER_LOGIN",
          "USER_LOGOUT",
        ].sort(),
      );
      const actors = new Set(events.map((e) => e.actor_id));
      for (const name of CAST) expect(actors).toContain(name);
      // The bot closes stale tickets, as an actor of type bot.
      const bot = events.filter((e) => e.actor_id === BOT);
      expect(bot.length).toBeGreaterThan(0);
      expect(bot.every((e) => e.event_type === "TICKET_CLOSED")).toBe(true);
      expect(bot.every((e) => (e.payload as { actor_type: string }).actor_type === "bot")).toBe(
        true,
      );
    }
  });

  it("keeps the story consistent: logins before actions, tickets created before use", () => {
    const desk = new TicketDesk(9);
    const online = new Set<string>();
    const known = new Set<string>(CAST);
    const open = new Set<string>();
    for (let i = 0; i < 500; i++) {
      const e = desk.next(at);
      const actor = e.actor_id as string;
      if (e.event_type === "USER_LOGIN") {
        expect(online.has(actor)).toBe(false);
        expect(known.has(actor)).toBe(true);
        online.add(actor);
        continue;
      }
      if (actor !== BOT) expect(online.has(actor)).toBe(true);
      if (e.event_type === "USER_LOGOUT") online.delete(actor);
      if (e.event_type === "USER_CREATED") {
        expect(known.has(String(e.instance_id))).toBe(false);
        known.add(String(e.instance_id));
      }
      if (e.instance_type === "ticket") {
        expect(e.instance_id).toMatch(/^T-\d+$/);
        if (e.event_type === "TICKET_CREATED") open.add(String(e.instance_id));
        else expect(open.has(String(e.instance_id))).toBe(true);
        if (e.event_type === "TICKET_CLOSED") open.delete(String(e.instance_id));
      }
      expect(open.size).toBeLessThanOrEqual(MAX_OPEN);
    }
  });

  it("renders every event with its own bundled template, in en and sr, never _generic", () => {
    const bundled = loadTemplateDir(BUNDLED_TEMPLATES_DIR);
    const engine = new TemplateEngine({ registry: new LookupRegistry() });
    for (const event of story(5, 500)) {
      const payload = event.payload as Record<string, unknown>;
      if (FREE_TEXT_EVENT_TYPES.includes(event.event_type)) {
        expect(typeof payload.text).toBe("string");
        continue;
      }
      for (const locale of ["en", "sr"]) {
        const body = bundled.get(`${event.event_type}.${locale}`);
        expect(body, `${event.event_type}.${locale}`).toBeDefined();
        const text = engine.render(
          body as string,
          {
            event: { ...event },
            payload,
            event_type: event.event_type,
            instance_type: event.instance_type,
            instance_id: String(event.instance_id),
            actor_id: event.actor_id == null ? null : String(event.actor_id),
            occurred_at: event.occurred_at as string,
          },
          [locale, "en"],
        );
        // What the template reads is there: no empty "()" or missing pieces.
        if (payload.title) expect(text).toContain(String(payload.title));
        if (payload.ip) expect(text).toContain(String(payload.ip));
        if (payload.resolution) expect(text).toContain(String(payload.resolution));
        if (payload.name) expect(text).toContain(String(payload.name));
        if (payload.changes) {
          for (const field of Object.keys(payload.changes)) expect(text).toContain(field);
        }
      }
    }
  });
});

const handle = connect(loadConfig().testDatabaseUrl, { max: 2 });
type FastifyInstance = Awaited<ReturnType<typeof buildApp>>;
let app: FastifyInstance | null = null;
let url: string;
let keys: { read: string; write: string };
let out: string[];
let err: string[];
const io = {
  out: (line: string) => void out.push(line),
  err: (line: string) => void err.push(line),
};
const ui = makeUi(false, null);

describe("memento simulate", () => {
  beforeEach(async () => {
    out = [];
    err = [];
    await handle.pool.query(
      "truncate memento_seen, memento_star, memento_template, memento_chat_participant, memento_chat, memento_event, memento_apikey, memento_tenant cascade",
    );
    await createTenant(handle.db, { slug: "demo", name: "Demo" });
    const key = async (scopes: string) =>
      (await createApiKey(handle.db, { tenant: "demo", name: scopes, scopes })).key;
    keys = { read: await key("read"), write: await key("write") };
    app = await buildApp({ db: handle.db, logger: false });
    await app.listen({ host: "127.0.0.1", port: 0 });
    url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}/memento`;
  });
  afterEach(async () => {
    await app?.close();
    app = null;
  });
  afterAll(() => handle.close());

  const cli = (argv: string[]) =>
    runCli(["simulate", "--url", url, ...argv], { db: () => handle.db, io, timeZone: "UTC" });

  it("pushes one scene with --once and logs it as a rendered line", async () => {
    expect(await cli(["--key", keys.write, "--tenant", "demo", "--seed", "1", "--once"])).toBe(0);
    expect(out).toHaveLength(1);
    // Seed 1 starts, like every story, with somebody logging in.
    expect(out[0]).toMatch(
      /^\[\d\d:\d\d:\d\d\] {2}USER_LOGIN +user\/\w+ {2}User \w+ logged in from 10\.0\.\d+\.\d+\. {2}→ /,
    );
    expect(err[0]).toContain("● simulate: a ticket desk (seed 1), one event every 3s");
    expect(err.at(-1)).toBe("simulate stopped: 1 pushed, 0 failed");
  });

  it("plays the same story for a seed, in the events UDC collection", async () => {
    expect(
      await runCli(
        [
          "--json",
          "simulate",
          "--url",
          url,
          "--key",
          keys.write,
          "--seed",
          "42",
          "--interval",
          "0.01",
          "--count",
          "25",
          "--locale",
          "sr",
        ],
        { db: () => handle.db, io },
      ),
    ).toBe(0);
    const stored = out.map((line) => JSON.parse(line));
    const expected = story(42, 25);
    expect(stored.map((e) => [e.event_type, e.instance_id, e.actor_id])).toEqual(
      expected.map((e) => [e.event_type, e.instance_id, e.actor_id]),
    );
    const templated = stored.find((e) => e.event_type !== "NOTE");
    expect(templated.rendered).toMatch(/Korisnik|Kreiran|Zatvoren|Izmenjen/);

    const response = await (app as FastifyInstance).inject({
      method: "POST",
      url: "/memento/udc/list",
      headers: { authorization: `Bearer ${keys.read}` },
      payload: { collection: "events", page: { limit: 100 } },
    });
    expect(response.json().payload.total).toBe(25);
  });

  it("retries the same scene after a failed push, stops on a refused key", async () => {
    let calls = 0;
    const flaky: typeof fetch = async (input, init) => {
      calls += 1;
      if (calls === 2) throw new Error("ECONNREFUSED");
      return fetch(input, init);
    };
    const summary = await runSimulate(
      { url, apiKey: keys.write, interval: 1, seed: 3, count: 3 },
      { io, ui, json: true, fetch: flaky, sleep: async () => {} },
    );
    expect(summary).toEqual({ seed: 3, pushed: 2, failed: 1 });
    expect(err).toContain("● reconnected after 1 failed push(es)");
    const pushed = out.map((line) => JSON.parse(line).instance_id);
    expect(pushed).toEqual(story(3, 2).map((e) => e.instance_id));

    expect(await cli(["--key", keys.read, "--once"])).toBe(1);
    expect(err.at(-1)).toBe('error: push refused: this API key lacks the "write" scope');
    expect(await cli(["--once"])).toBe(1);
    expect(err.at(-1)).toContain("no API key");
    expect(await cli(["--key", keys.write, "--interval", "0"])).toBe(1);
  });

  it("stops when the signal aborts and prints a random seed", async () => {
    const stop = new AbortController();
    const summary = await runSimulate(
      { url, apiKey: keys.write, interval: 60 },
      { io, ui, json: false, signal: stop.signal, sleep: async () => stop.abort() },
    );
    expect(summary.pushed).toBe(1);
    expect(err[0]).toContain(`(seed ${summary.seed})`);
    expect(err[0]).toContain("(Ctrl+C to stop)");
  });

  it("formats a story line", () => {
    const line = storyLine(
      {
        id: "e1",
        occurred_at: "2026-10-31T10:00:00Z",
        event_type: "NOTE",
        instance_type: "ticket",
        instance_id: "T-1",
        rendered: "Fix is in review.",
      } as never,
      ui,
      "UTC",
    );
    expect(line).toBe("[10:00:00]  NOTE             ticket/T-1  Fix is in review.  → e1");
  });
});
